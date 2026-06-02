// background.js : Event Page MV3, Routeur central Asynchrone
import { getPersonalAuthCookies, fetchCSRFToken } from './api/auth_personal.js';
import { createPersonalNotebook, uploadPersonalSource, addTextSource, addUrlSource, addYouTubeSource, addDriveSource, RpcApiChangedError } from './api/rpc_client.js';

/**
 * Taille Max de PDF imposée par Google : 200 MB
 * Un octet Base64 pèse plus lourd (ratio ~1.37), cette limite mathématique garantit le quota réel.
 */
const MAX_BASE64_SIZE_BYTES = 200 * 1024 * 1024 * 1.37;

const BINARY_MIME_PREFIXES = [
  'application/pdf',
  'audio/',
  'video/',
  'image/',
  'application/msword',
  'application/vnd.openxmlformats',
  'application/vnd.ms-',
  'application/epub'
];

/**
 * Modèles RegEx pour détecter et masquer les données sensibles
 * (cookies de session Google et jeton CSRF) dans les logs d'erreurs.
 */
const SENSITIVE_PATTERNS = [
    /SID=[^;]+/gi,
    /HSID=[^;]+/gi,
    /SSID=[^;]+/gi,
    /SAPISID=[^;]+/gi,
    /__Secure-1PSID=[^;]+/gi,
    /__Secure-3PSID=[^;]+/gi,
    /SNlM0e[^"]+/gi,
    /at=[^&]+/gi        // Token CSRF encodé dans les payloads
];

/**
 * Purge un message d'erreur de toute donnée d'authentification sensible.
 * @param {string|any} message - Le message d'erreur brut
 * @returns {string} - Le message d'erreur sécurisé
 */
function sanitizeErrorMessage(message) {
    if (typeof message !== "string") {
        message = String(message);
    }

    return SENSITIVE_PATTERNS.reduce(
        (msg, pattern) => msg.replace(pattern, "[REDACTED]"),
        message
    );
}

/**
 * Interface générique et sécurisée pour effectuer tout appel RPC ou processus asynchrone délicat.
 * Intercepte les erreurs pour ne jamais exposer de données sensibles tout en notifiant l'utilisateur.
 * @param {Function} rpcFn - Fonction asynchrone à isoler (reçoit notebookId en argument)
 * @param {string} notebookId - ID du carnet ciblé
 * @param {Function} sendResponse - Le callback de messagerie Firefox (MV3)
 */
async function safeRpcCall(rpcFn, notebookId, sendResponse) {
    try {
        const result = await rpcFn(notebookId);
        sendResponse({ status: "success", data: result });
    } catch (err) {

        const rawMessage = err.message || "";

        // Cas 1 : L'API Google a changé de structure
        if (err instanceof RpcApiChangedError) {
            console.error(`[NotebookLM][API_CHANGED] RPC: ${err.rpcId}`);
            sendResponse({
                status: "error",
                i18nKey: "apiChanged",
                code: "API_CHANGED"
            });

            // Cas 2 : Session expirée (cookies périmés HTTP 401/403)
        } else if (rawMessage.includes("401") || rawMessage.includes("403")) {
            console.warn(`[NotebookLM][AUTH_EXPIRED]`);
            await browser.storage.local.remove(['nblm_personal_cookie', 'nblm_csrf']).catch(() => { });
            sendResponse({
                status: "error",
                i18nKey: "sessionExpired",
                code: "AUTH_EXPIRED"
            });

            // Cas 3 : Upload resumable — URL de session absente
        } else if (rawMessage.includes("x-goog-upload-url")) {
            console.error(`[NotebookLM][UPLOAD_SESSION_MISSING]`, sanitizeErrorMessage(rawMessage));
            sendResponse({
                status: "error",
                i18nKey: "uploadSessionFailed",
                code: "UPLOAD_SESSION_MISSING"
            });

            // Cas 4 : Erreur réseau / Timeout
        } else if (err.name === "AbortError" || rawMessage.toLowerCase().includes("timeout")) {
            console.warn(`[NotebookLM][TIMEOUT]`);
            sendResponse({
                status: "error",
                i18nKey: "timeout",
                code: "TIMEOUT"
            });

            // Cas 5 : Toute autre erreur inattendue
        } else {
            const safeLog = sanitizeErrorMessage(rawMessage);
            console.error(`[NotebookLM][UNKNOWN]`, safeLog);
            sendResponse({
                status: "error",
                i18nKey: "unexpectedError",
                code: "UNKNOWN"
            });
        }
    }
}

// Dernière capture (stockée en mémoire pour téléchargement local)
let lastCaptureData = null;    // base64 PDF ou texte Markdown
let lastCaptureFilename = null;
let lastCaptureFormat = null;  // "pdf" ou "md"

// =====================================================================
// INJECTION DYNAMIQUE DES SCRIPTS (Lazy Loading)
// =====================================================================
const INJECTION_PIPELINE = {
    pdf: [
        "lib/Readability.js",
        "lib/jspdf.umd.min.js",
        "src/content/serializer.js",
        "src/content/pdf_generator.js",
    ],
    md: [
        "lib/Readability.js",
        "src/content/serializer.js",
        "src/content/md_generator.js",
    ],
    screenshot: [],
    url: [],
    direct: [],
    drive: [],
    selection: [],
};

const INJECTION_SENTINELS = {
    "lib/Readability.js": "Readability",
    "lib/jspdf.umd.min.js": "jspdf",
    "src/content/serializer.js": "nwcserializer",
    "src/content/pdf_generator.js": "nwcpdfgen",
    "src/content/md_generator.js": "nwcmdgen",
};

/** Levée quand browser.scripting.executeScript échoue. */
class InjectionError extends Error {
    constructor(tabId, file, detail) {
        super(`Injection échouée sur onglet ${tabId} — ${file} : ${detail}`);
        this.name = "InjectionError";
        this.tabId = tabId;
        this.file = file;
    }
}

/**
 * Retourne true si le script est déjà actif dans l'onglet.
 */
async function isScriptInjected(tabId, scriptFile) {
    const globalVar = INJECTION_SENTINELS[scriptFile];
    if (!globalVar) return false;

    try {
        const [{ result }] = await browser.scripting.executeScript({
            target: { tabId },
            func: (varName) => typeof window[varName] !== "undefined",
            args: [globalVar]
        });
        return result === true;
    } catch {
        return false;
    }
}

/**
 * Injecte une liste de scripts dans l'ordre dans un onglet.
 * Ignore silencieusement les scripts déjà présents.
 */
async function injectScriptsSequentially(tabId, scripts) {
    for (const file of scripts) {
        const alreadyInjected = await isScriptInjected(tabId, file);
        if (alreadyInjected) continue;

        try {
            await browser.scripting.executeScript({
                target: { tabId },
                files: [file],
            });
        } catch (err) {
            throw new InjectionError(tabId, file, err.message);
        }
    }
}

/**
 * Devine le MIME type d'un fichier Drive à partir du titre de l'onglet Firefox.
 * Format attendu : "nomfichier.ext - Google Drive"
 */
function guessMimeFromTitle(title) {
    const EXTENSION_MAP = {
        'pdf': 'application/pdf', 'txt': 'text/plain', 'md': 'text/markdown',
        'csv': 'text/csv', 'epub': 'application/epub+zip',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'video/mp4',
    };
    const cleaned = title.replace(/\s*-\s*Google Drive\s*$/i, '').trim();
    const dotIndex = cleaned.lastIndexOf('.');
    if (dotIndex > 0) {
        const ext = cleaned.substring(dotIndex + 1).toLowerCase();
        if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];
    }
    return 'application/pdf';
}

/**
 * Types de fichiers supportés pour l'Import Direct.
 * Liste complète des formats acceptés par NotebookLM.
 * Mapping MIME type → { label, extension, category }
 */
const DIRECT_IMPORT_TYPES = {
    // Documents
    'application/pdf': { label: 'PDF', ext: '.pdf', category: 'document' },
    'text/plain': { label: 'TXT', ext: '.txt', category: 'document' },
    'text/markdown': { label: 'MD', ext: '.md', category: 'document' },
    'text/csv': { label: 'CSV', ext: '.csv', category: 'document' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'DOCX', ext: '.docx', category: 'document' },
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': { label: 'PPTX', ext: '.pptx', category: 'document' },
    'application/epub+zip': { label: 'EPUB', ext: '.epub', category: 'document' },
    // Images
    'image/png': { label: 'PNG', ext: '.png', category: 'image' },
    'image/jpeg': { label: 'JPEG', ext: '.jpg', category: 'image' },
    'image/gif': { label: 'GIF', ext: '.gif', category: 'image' },
    'image/bmp': { label: 'BMP', ext: '.bmp', category: 'image' },
    'image/webp': { label: 'WebP', ext: '.webp', category: 'image' },
    'image/avif': { label: 'AVIF', ext: '.avif', category: 'image' },
    'image/tiff': { label: 'TIFF', ext: '.tiff', category: 'image' },
    'image/x-icon': { label: 'ICO', ext: '.ico', category: 'image' },
    'image/jp2': { label: 'JP2', ext: '.jp2', category: 'image' },
    'image/heic': { label: 'HEIC', ext: '.heic', category: 'image' },
    'image/heif': { label: 'HEIF', ext: '.heif', category: 'image' },
    // Audio
    'audio/mpeg': { label: 'MP3', ext: '.mp3', category: 'audio' },
    'audio/wav': { label: 'WAV', ext: '.wav', category: 'audio' },
    'audio/x-wav': { label: 'WAV', ext: '.wav', category: 'audio' },
    'audio/ogg': { label: 'OGG', ext: '.ogg', category: 'audio' },
    'audio/aac': { label: 'AAC', ext: '.aac', category: 'audio' },
    'audio/mp4': { label: 'M4A', ext: '.m4a', category: 'audio' },
    'audio/x-m4a': { label: 'M4A', ext: '.m4a', category: 'audio' },
    'audio/aiff': { label: 'AIFF', ext: '.aiff', category: 'audio' },
    'audio/x-aiff': { label: 'AIFF', ext: '.aiff', category: 'audio' },
    'audio/midi': { label: 'MIDI', ext: '.mid', category: 'audio' },
    'audio/x-midi': { label: 'MIDI', ext: '.mid', category: 'audio' },
    'audio/opus': { label: 'OPUS', ext: '.opus', category: 'audio' },
    'audio/amr': { label: 'AMR', ext: '.amr', category: 'audio' },
    'audio/x-ms-wma': { label: 'WMA', ext: '.wma', category: 'audio' },
    'audio/x-pn-realaudio': { label: 'RA', ext: '.ra', category: 'audio' },
    'audio/basic': { label: 'AU', ext: '.au', category: 'audio' },
    // Vidéo
    'video/mp4': { label: 'MP4', ext: '.mp4', category: 'video' },
    'video/mpeg': { label: 'MPEG', ext: '.mpeg', category: 'video' },
    'video/x-msvideo': { label: 'AVI', ext: '.avi', category: 'video' },
    'video/3gpp': { label: '3GP', ext: '.3gp', category: 'video' },
    'video/3gpp2': { label: '3G2', ext: '.3g2', category: 'video' },
};

/**
 * Mapping extension → MIME type pour la détection par URL (fichiers locaux surtout).
 */
const EXT_TO_MIME = {
    // Documents
    'pdf': 'application/pdf', 'txt': 'text/plain', 'md': 'text/markdown',
    'csv': 'text/csv', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'epub': 'application/epub+zip',
    // Images
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'jpe': 'image/jpeg',
    'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp', 'avif': 'image/avif',
    'tif': 'image/tiff', 'tiff': 'image/tiff', 'ico': 'image/x-icon',
    'jp2': 'image/jp2', 'heic': 'image/heic', 'heif': 'image/heif',
    // Audio
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'aac': 'audio/aac',
    'm4a': 'audio/mp4', 'aif': 'audio/aiff', 'aifc': 'audio/aiff', 'aiff': 'audio/aiff',
    'mid': 'audio/midi', 'opus': 'audio/opus', 'amr': 'audio/amr', 'wma': 'audio/x-ms-wma',
    'ra': 'audio/x-pn-realaudio', 'ram': 'audio/x-pn-realaudio', 'au': 'audio/basic',
    'snd': 'audio/basic', 'cda': 'audio/mpeg',
    // Vidéo
    'mp4': 'video/mp4', 'mpeg': 'video/mpeg', 'avi': 'video/x-msvideo',
    '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
};

/** Regex d'extensions pour la détection rapide par URL */
const SUPPORTED_EXT_REGEX = /\.(pdf|txt|md|docx|csv|pptx|epub|avif|bmp|gif|ico|jp2|png|webp|tif|tiff|heic|heif|jpe?g|3g2|3gp|aac|aif|aifc|aiff|amr|au|avi|cda|m4a|mid|mp3|mp4|mpeg|ogg|opus|ra|ram|snd|wav|wma)$/i;

/**
 * Détecte si une URL pointe vers un fichier directement importable.
 * Combine l'analyse de l'extension URL + requête HEAD pour confirmer le MIME type.
 */
async function detectFileType(url) {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://'))) {
        return { directImport: false };
    }

    const isLocal = url.startsWith('file://');

    // 1. Heuristique rapide : extension URL
    const urlPath = new URL(url).pathname.toLowerCase();
    const extMatch = urlPath.match(SUPPORTED_EXT_REGEX);

    // 2. Pour les URLs HTTP, confirmer via HEAD request
    let detectedMime = null;
    if (!isLocal && url.startsWith('http')) {
        try {
            const headResp = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            const contentType = headResp.headers.get('content-type') || '';
            detectedMime = contentType.split(';')[0].trim().toLowerCase();
        } catch (e) {
            console.warn('[Background] HEAD request échouée:', e.message);
        }
    }

    // 3. Tenter de résoudre à partir de l'extension si HEAD n'a rien donné
    if (!detectedMime && extMatch) {
        detectedMime = EXT_TO_MIME[extMatch[1].toLowerCase()];
    }

    // 4. Vérifier si le type est supporté
    if (detectedMime && DIRECT_IMPORT_TYPES[detectedMime]) {
        const typeInfo = DIRECT_IMPORT_TYPES[detectedMime];
        return {
            directImport: true,
            mimeType: detectedMime,
            label: typeInfo.label,
            category: typeInfo.category,
            isLocal: isLocal
        };
    }

    return { directImport: false };
}

// ═══ Menu Contextuel : Capture de sélection ═══
browser.runtime.onInstalled.addListener(async () => {
    browser.storage.local.remove('nwc_pending_selection');

    try {
        await browser.contextMenus.removeAll();
        browser.contextMenus.create({
            id: "nwc-clip-selection",
            title: browser.i18n.getMessage("notifSelectionTitle"),
            contexts: ["selection"]
        });
    } catch (e) {
        console.warn("[Background] contextMenus non disponible:", e.message);
    }
});

if (browser.contextMenus?.onClicked) {
    browser.contextMenus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId === "nwc-clip-selection" && info.selectionText) {
            let selectionHtml = null;
            try {
                const response = await browser.tabs.sendMessage(tab.id, {
                    action: "GET_SELECTION_HTML"
                });
                if (response?.html) {
                    selectionHtml = response.html;
                }
            } catch (e) {
                console.warn("[Background] Content script inaccessible, fallback texte brut.");
            }

            await browser.storage.local.set({
                nwc_pending_selection: {
                    text: info.selectionText,
                    html: selectionHtml,
                    pageUrl: info.pageUrl || tab.url,
                    pageTitle: tab.title,
                    timestamp: Date.now()
                }
            });

            try {
                await browser.action.openPopup();
            } catch (e) {
                console.warn("[Background] openPopup() échoué:", e.message);
                browser.notifications.create("nwc-selection-ready", {
                    type: "basic",
                    iconUrl: browser.runtime.getURL("icons/icon.svg"),
                    title: browser.i18n.getMessage("notifSelectionCaptured"),
                    message: browser.i18n.getMessage("notifSelectionMsg")
                });
            }
        }
    });
}

// Routeur Principal recevant les messages de la Popup et du Content Script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === "GET_AUTH_STATUS") {
        browser.cookies.getAll({ url: "https://notebooklm.google.com/" }).then(cookies => {
            if (cookies && cookies.length > 0) {
                sendResponse({ status: "CONNECTE", type: "PERSONAL" });
            } else {
                sendResponse({ status: "DECONNECTE", type: null });
            }
        }).catch(() => {
            sendResponse({ status: "DECONNECTE", type: null });
        });
        return true;
    }

    if (message.action === "GET_ACCOUNTS") {
        (async () => {
            try {
                const { getPersonalAuthCookies, detectGoogleAccounts } = await import('./api/auth_personal.js');
                const cookieString = await getPersonalAuthCookies();
                const accounts = await detectGoogleAccounts(cookieString);

                const data = await browser.storage.local.get('nblm_active_authuser');
                const activeIndex = data.nblm_active_authuser !== undefined ? data.nblm_active_authuser : 0;

                sendResponse({ accounts, activeIndex });
            } catch (err) {
                console.error("[Background] Échec GET_ACCOUNTS: ", err.message);
                sendResponse({ error: err.message, accounts: [] });
            }
        })();
        return true;
    }

    if (message.action === "SET_ACCOUNT") {
        browser.storage.local.set({ nblm_active_authuser: message.index }).then(() => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (message.action === "GET_NOTEBOOKS") {
        (async () => {
            try {
                const { getPersonalAuthCookies, fetchCSRFToken } = await import('./api/auth_personal.js');
                const cookieString = await getPersonalAuthCookies();

                const data = await browser.storage.local.get('nblm_active_authuser');
                const activeIndex = data.nblm_active_authuser !== undefined ? data.nblm_active_authuser : 0;

                await fetchCSRFToken(cookieString, activeIndex);
                const { listPersonalNotebooks } = await import('./api/rpc_client.js');
                const notebooks = await listPersonalNotebooks(activeIndex);

                sendResponse({ notebooks });
            } catch (err) {
                console.error("[NotebookLM][GET_NOTEBOOKS]", sanitizeErrorMessage(err.message));
                sendResponse({
                    status: "error",
                    i18nKey: "errGetNotebooks",   // ✅ CORRECTION 1
                    code: "UNKNOWN"
                });
            }
        })();
        return true;
    }

    // Création de carnet à la volée
    if (message.action === "CREATE_NOTEBOOK") {
        (async () => {
            try {
                const cookieString = await getPersonalAuthCookies();
                const data = await browser.storage.local.get('nblm_active_authuser');
                const activeIndex = data.nblm_active_authuser !== undefined ? data.nblm_active_authuser : 0;

                await fetchCSRFToken(cookieString, activeIndex);

                const notebookId = await createPersonalNotebook(message.title, activeIndex);
                sendResponse({ notebookId });
            } catch (err) {
                console.error("[NotebookLM][CREATE_NOTEBOOK]", sanitizeErrorMessage(err.message));
                sendResponse({
                    status: "error",
                    i18nKey: "errCreateNotebook",  // ✅ CORRECTION 2
                    code: "UNKNOWN"
                });
            }
        })();
        return true;
    }

    // Proxy CORS pour télécharger les images sans bloquer jsPDF
    if (message.action === "FETCH_IMAGE") {
        (async () => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                const response = await fetch(message.url, { signal: controller.signal });
                clearTimeout(timeout);
                if (!response.ok) {
                    sendResponse({ error: `HTTP ${response.status}` });
                    return;
                }
                const blob = await response.blob();
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ data: reader.result });
                };
                reader.onerror = () => sendResponse({ error: "FileReader échoué" });
                reader.readAsDataURL(blob);
            } catch (err) {
                sendResponse({ error: err.message });
            }
        })();
        return true;
    }

    // Téléchargement local de la dernière capture (PDF ou Markdown)
    if (message.action === "DOWNLOAD_CAPTURE") {
        if (!lastCaptureData) {
            sendResponse({ error: "Aucune capture disponible" });
            return true;
        }
        (async () => {
            try {
                let blobUrl;
                let ext;

                if (lastCaptureFormat === "md") {
                    const blob = new Blob([lastCaptureData], { type: 'text/markdown; charset=utf-8' });
                    blobUrl = URL.createObjectURL(blob);
                    ext = '.md';
                } else {
                    const base64 = lastCaptureData.split(',')[1];
                    const byteChars = atob(base64);
                    const byteArr = new Uint8Array(byteChars.length);
                    for (let i = 0; i < byteChars.length; i++) {
                        byteArr[i] = byteChars.charCodeAt(i);
                    }
                    const blob = new Blob([byteArr], { type: 'application/pdf' });
                    blobUrl = URL.createObjectURL(blob);
                    ext = '.pdf';
                }

                const platformInfo = await browser.runtime.getPlatformInfo();
                const isMobile = platformInfo.os === 'android';

                await browser.downloads.download({
                    url: blobUrl,
                    filename: (lastCaptureFilename || 'capture') + ext,
                    saveAs: !isMobile
                });
                setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                sendResponse({ ok: true });
            } catch (err) {
                sendResponse({ error: err.message });
            }
        })();
        return true;
    }

    // Détection du type de fichier pour l'Import Direct
    if (message.action === "DETECT_FILE_TYPE") {
        detectFileType(message.url).then(result => {
            sendResponse(result);
        }).catch(() => {
            sendResponse({ directImport: false });
        });
        return true;
    }

    if (message.action === "DETECT_MIME") {
        (async () => {
            const { url } = message;
            try {
                const resp = await fetch(url, {
                    method: 'HEAD',
                    signal: AbortSignal.timeout(5000)
                });
                if (!resp.ok) {
                    sendResponse({ isBinary: false, mime: '' });
                    return;
                }
                const mime = resp.headers.get('content-type') ?? '';
                const isBinary = BINARY_MIME_PREFIXES.some(p => mime.startsWith(p));
                sendResponse({ isBinary, mime });
            } catch (e) {
                console.warn('[MC] DETECT_MIME failed:', e?.message);
                sendResponse({ isBinary: false, mime: '' });
            }
        })();
        return true;
    }

    if (message.action === "DOWNLOAD_SELECTION_MD") {
        (async () => {
            const { selectionHtml, title, url, intentNote } = message;
            try {
                const tabs = await browser.tabs.query({
                    active: true,
                    currentWindow: true
                });
                if (!tabs.length) {
                    sendResponse({ mdBlob: '' });
                    return;
                }
                const tabId = tabs[0].id;

                // Injection minimale : uniquement md_generator.js
                // (pas de Readability ni serializer nécessaires pour un fragment HTML)
                await injectScriptsSequentially(tabId, [
                    'src/content/md_generator.js'
                ]);

                const results = await browser.scripting.executeScript({
                    target: { tabId },
                    func: (html, note) => {
                        if (typeof window.ClipperMarkdownGenerator === 'undefined') {
                            return '';
                        }
                        return window.ClipperMarkdownGenerator.generate(html, note || null);
                    },
                    args: [selectionHtml, intentNote ?? '']
                });

                const md = results?.[0]?.result ?? '';
                sendResponse({ mdBlob: md });
            } catch (e) {
                console.warn('[MC] DOWNLOAD_SELECTION_MD failed:', e?.message);
                sendResponse({ mdBlob: '' });
            }
        })();
        return true;
    }

    if (message.action === "START_CAPTURE") {
        // Import de sélection : pipeline simplifié (texte → addTextSource)
        if (message.format === 'selection' && message.selectionData) {
            (async () => {
                try {
                    const sel = message.selectionData;
                    const cookieString = await getPersonalAuthCookies();
                    const data = await browser.storage.local.get('nblm_active_authuser');
                    const activeIndex = data.nblm_active_authuser !== undefined ? data.nblm_active_authuser : 0;
                    await fetchCSRFToken(cookieString, activeIndex);

                    let finalNotebookId = message.notebookId;
                    if (finalNotebookId === "CREATE_NEW") {
                        notifyUI("STATUS_UPDATE", { i18nKey: "statusCreatingNb", status: "info" });
                        const title = `Capture - ${new Date().toLocaleDateString()}`;
                        finalNotebookId = await createPersonalNotebook(title, activeIndex);
                    }
                    if (!finalNotebookId) throw new Error("Échec de la récupération de l'ID du carnet.");

                    notifyUI("STATUS_UPDATE", { i18nKey: "statusUploadSelection", status: "info" });

                    const cleanTitle = (sel.pageTitle || 'Sélection')
                        .replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 80);
                    const sourceTitle = `📋 ${cleanTitle}`;

                    const content = [
                        `Source: ${sel.pageUrl}`,
                        `Titre: ${sel.pageTitle}`,
                        `Date de capture: ${new Date().toLocaleString()}`,
                        '',
                        '---',
                        '',
                        sel.text
                    ].join('\n');

                    await addTextSource(finalNotebookId, sourceTitle, content, activeIndex);

                    const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
                    notifyUI("STATUS_UPDATE", {
                        i18nKey: "statusImportedSelection",
                        status: "success",
                        linkUrl: notebookUrl,
                        showDownload: false
                    });

                    browser.notifications.create({
                        type: "basic",
                        iconUrl: browser.runtime.getURL("icons/icon.svg"),
                        title: browser.i18n.getMessage("extensionName"),
                        message: browser.i18n.getMessage("notifSuccessMsg").replace("{title}", cleanTitle).replace("{format}", "Sélection")
                    });
                } catch (err) {
                    console.error("[NotebookLM][SELECTION]", sanitizeErrorMessage(err.message));
                    notifyUI("STATUS_UPDATE", {
                        status: "error",
                        i18nKey: "errSelectionFailed",  // ✅ CORRECTION 3
                        code: "UNKNOWN"
                    });
                }
            })();
        } else {
            // Formats classiques : PDF, MD, URL, Screenshot, Direct
            (async () => {
                const format = message.format || "pdf";
                const scripts = INJECTION_PIPELINE[format] ?? [];

                if (scripts.length > 0) {
                    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                    if (tabs.length > 0) {
                        try {
                            await injectScriptsSequentially(tabs[0].id, scripts);
                        } catch (err) {
                            if (err instanceof InjectionError) {
                                sendResponse({
                                    status: "error",
                                    code: "INJECTION_FAILED",
                                    i18nKey: "errInjectionFailed"  // ✅ CORRECTION 5
                                });
                                return true;
                            }
                            throw err;
                        }
                    }
                }

                executeCaptureAndUploadWorkflow(message.notebookId, format, message.intentNote)
                    .catch(err => {
                        console.error("[NotebookLM][WORKFLOW]", sanitizeErrorMessage(err.message));
                        notifyUI("STATUS_UPDATE", {
                            status: "error",
                            i18nKey: "errWorkflowFailed",  // ✅ CORRECTION 4
                            code: "UNKNOWN"
                        });
                    });
            })();
        }
    }

    return true;
});

/**
 * Mise à jour de l'interface visuelle (Popup si elle est encore active)
 */
function notifyUI(action, payload) {
    browser.runtime.sendMessage({ type: action, ...payload }).catch(() => {
        // La popup est sûrement fermée, on ignore l'erreur
    });
}

/**
 * Moteur de Séquence Stricte — PDF, Markdown ou URL
 */
async function executeCaptureAndUploadWorkflow(targetNotebookId, format, intentNote = null) {

    notifyUI("STATUS_UPDATE", { i18nKey: "statusFetchSession", status: "info" });

    const cookieString = await getPersonalAuthCookies();
    const data = await browser.storage.local.get('nblm_active_authuser');
    const activeIndex = data.nblm_active_authuser !== undefined ? data.nblm_active_authuser : 0;

    await fetchCSRFToken(cookieString, activeIndex);

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error("Aucun onglet actif trouvé.");

    const activeTab = tabs[0];
    const pageTitle = activeTab.title || "Capture";
    const pageUrl = activeTab.url;

    const cleanTitle = pageTitle
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);

    let finalNotebookId = targetNotebookId;
    if (finalNotebookId === "CREATE_NEW") {
        notifyUI("STATUS_UPDATE", { i18nKey: "statusCreatingNb", status: "info" });
        const title = `Capture - ${new Date().toLocaleDateString()}`;
        finalNotebookId = await createPersonalNotebook(title, activeIndex);
    }
    if (!finalNotebookId) throw new Error("Échec de la récupération de l'ID du carnet.");

    if (format === "screenshot") {
        notifyUI("STATUS_UPDATE", { i18nKey: "statusScreenshot", status: "info" });

        const dataUrl = await browser.tabs.captureVisibleTab(null, { format: 'png' });

        const base64 = dataUrl.split(',')[1];
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        const pngBlob = new Blob([bytes], { type: 'image/png' });
        const screenshotFilename = `${cleanTitle}.png`;

        notifyUI("STATUS_UPDATE", { i18nKey: "statusUploadScreenshot", status: "info" });
        await uploadFileBlob(finalNotebookId, pngBlob, screenshotFilename, activeIndex);

        const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
        notifyUI("STATUS_UPDATE", {
            i18nKey: "statusImportedScreenshot",
            status: "success",
            linkUrl: notebookUrl,
            showDownload: false
        });

    } else if (format === "direct") {
        notifyUI("STATUS_UPDATE", { i18nKey: "statusDownloadFile", status: "info" });

        let fileResponse;
        try {
            fileResponse = await fetch(pageUrl, { credentials: 'include' });
        } catch (fetchErr) {
            throw new Error(`Impossible de récupérer le fichier. Le serveur bloque le téléchargement.`);
        }
        if (!fileResponse.ok) throw new Error(`Échec téléchargement: HTTP ${fileResponse.status}`);

        const fileBlob = await fileResponse.blob();
        const mimeType = fileBlob.type || 'application/octet-stream';

        const typeInfo = DIRECT_IMPORT_TYPES[mimeType];
        const ext = typeInfo ? typeInfo.ext : '';
        const directFilename = `${cleanTitle}${ext}`;

        if (fileBlob.size > 200 * 1024 * 1024) {
            throw new Error("Upload refusé : Le fichier dépasse la limite de 200 MB.");
        }

        notifyUI("STATUS_UPDATE", { i18nKey: "statusUploadFile", i18nSubs: { ext: ext.replace('.', '').toUpperCase() || 'fichier' }, status: "info" });
        await uploadFileBlob(finalNotebookId, fileBlob, directFilename, activeIndex);

        const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
        notifyUI("STATUS_UPDATE", {
            i18nKey: "statusImportedFile",
            status: "success",
            linkUrl: notebookUrl,
            showDownload: false
        });

    } else if (format === "drive") {
        notifyUI("STATUS_UPDATE", { i18nKey: "statusDrive", status: "info" });

        let fileId, mimeType = '';

        const workspaceMatch = pageUrl.match(/\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9-_]+)/);
        if (workspaceMatch) {
            fileId = workspaceMatch[2];
            const typeStr = workspaceMatch[1];
            if (typeStr === 'document') mimeType = 'application/vnd.google-apps.document';
            else if (typeStr === 'spreadsheets') mimeType = 'application/vnd.google-apps.spreadsheet';
            else if (typeStr === 'presentation') mimeType = 'application/vnd.google-apps.presentation';
        }

        if (!fileId) {
            const driveMatch = pageUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
            if (driveMatch) {
                fileId = driveMatch[1];
                mimeType = guessMimeFromTitle(pageTitle);
            }
        }

        if (!fileId) {
            throw new Error("URL Google Drive non reconnue ou invalide.");
        }

        let driveTitle = pageTitle
            .replace(/ - Google (Docs|Sheets|Slides|Drive)$/i, '')
            .trim();

        await addDriveSource(finalNotebookId, fileId, mimeType, driveTitle, activeIndex);

        const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
        notifyUI("STATUS_UPDATE", {
            i18nKey: "statusImportedDrive",
            status: "success",
            linkUrl: notebookUrl,
            showDownload: false
        });

    } else if (format === "url") {
        const isYouTube = /(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/.test(pageUrl);

        if (isYouTube) {
            notifyUI("STATUS_UPDATE", { i18nKey: "statusYoutube", status: "info" });
            await addYouTubeSource(finalNotebookId, pageUrl, activeIndex);
        } else {
            notifyUI("STATUS_UPDATE", { i18nKey: "statusSendUrl", status: "info" });
            await addUrlSource(finalNotebookId, pageUrl, activeIndex);
        }

        const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
        notifyUI("STATUS_UPDATE", {
            i18nKey: isYouTube ? "statusImportedYoutube" : "statusImportedUrl",
            status: "success",
            linkUrl: notebookUrl,
            showDownload: false
        });

    } else {
        // ═══ Pipelines PDF / Markdown : content script requis ═══
        notifyUI("STATUS_UPDATE", { i18nKey: "statusDomCapture", status: "info" });

        const response = await browser.tabs.sendMessage(activeTab.id, {
            action: "START_CAPTURE",
            format: format,
            intentNote: intentNote ?? null
        });
        if (response?.status !== "SUCCESS") throw new Error("Erreur Content Script : " + response?.error);

        const capturedData = response.payload;
        const capturedFormat = response.format || format;

        lastCaptureData = capturedData;
        lastCaptureFilename = cleanTitle;
        lastCaptureFormat = capturedFormat;

        if (capturedFormat === "md") {
            notifyUI("STATUS_UPDATE", { i18nKey: "statusSendMarkdown", status: "info" });
            await addTextSource(finalNotebookId, cleanTitle, capturedData, activeIndex);

            const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
            notifyUI("STATUS_UPDATE", {
                i18nKey: "statusImportedMarkdown",
                status: "success",
                linkUrl: notebookUrl,
                showDownload: true
            });

        } else {
            notifyUI("STATUS_UPDATE", { i18nKey: "statusCheckQuota", status: "info" });

            if (capturedData.length > MAX_BASE64_SIZE_BYTES) {
                throw new Error("Upload refusé : Le fichier PDF dépasse la limite de 200 MB.");
            }

            notifyUI("STATUS_UPDATE", { i18nKey: "statusSendPdf", status: "info" });
            await uploadPersonalSource(finalNotebookId, capturedData, cleanTitle, activeIndex);

            const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
            notifyUI("STATUS_UPDATE", {
                i18nKey: "statusImportedPdf",
                status: "success",
                linkUrl: notebookUrl,
                showDownload: true
            });
        }
    }

    const formatLabels = { pdf: "PDF", md: "Markdown", url: "URL", screenshot: "Screenshot", direct: "Import direct" };
    browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
        title: browser.i18n.getMessage("extensionName"),
        message: browser.i18n.getMessage("notifSuccessMsg").replace("{title}", cleanTitle).replace("{format}", formatLabels[format] || format)
    });
}

/**
 * Upload générique d'un Blob (fichier binaire) vers NotebookLM.
 * Réutilise le protocole resumable 3 étapes (o4cbdc → start → upload+finalize).
 *
 * @param {string} notebookId - ID du carnet cible.
 * @param {Blob} blob - Blob binaire du fichier.
 * @param {string} filename - Nom du fichier avec extension.
 * @param {number} authuserIndex - Index du compte Google actif.
 */
async function uploadFileBlob(notebookId, blob, filename, authuserIndex = 0) {

    const data = await browser.storage.local.get(['nblm_personal_cookie', 'nblm_csrf']);
    if (!data.nblm_personal_cookie || !data.nblm_csrf) {
        throw new Error("Authentification personnelle non finalisée.");
    }

    const { sendBatchExecute } = await import('./api/rpc_client.js');
    const registerRpcId = "o4cbdc";
    const registerParams = [
        [[filename]],
        notebookId,
        [2],
        [1, null, null, null, null, null, null, null, null, null, [1]]
    ];

    const registerResult = await sendBatchExecute(registerRpcId, registerParams, authuserIndex);

    const sourceId = extractFirstStringFromResult(registerResult);
    if (!sourceId) {
        throw new Error("Échec enregistrement source: impossible d'obtenir SOURCE_ID.");
    }

    const uploadStartUrl = `https://notebooklm.google.com/upload/_/?authuser=${authuserIndex}`;
    const startBody = JSON.stringify({
        "PROJECT_ID": notebookId,
        "SOURCE_NAME": filename,
        "SOURCE_ID": sourceId
    });

    const startResponse = await fetch(uploadStartUrl, {
        method: 'POST',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Cookie': data.nblm_personal_cookie,
            'Origin': 'https://notebooklm.google.com',
            'Referer': 'https://notebooklm.google.com/',
            'x-goog-authuser': String(authuserIndex),
            'x-goog-upload-command': 'start',
            'x-goog-upload-header-content-length': String(blob.size),
            'x-goog-upload-protocol': 'resumable'
        },
        body: startBody
    });

    if (!startResponse.ok) {
        throw new Error(`Échec démarrage upload: HTTP ${startResponse.status}`);
    }

    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
        throw new Error("Échec: pas de x-goog-upload-url dans la réponse serveur.");
    }

    const finalizeResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Cookie': data.nblm_personal_cookie,
            'Origin': 'https://notebooklm.google.com',
            'Referer': 'https://notebooklm.google.com/',
            'x-goog-authuser': String(authuserIndex),
            'x-goog-upload-command': 'upload, finalize',
            'x-goog-upload-offset': '0'
        },
        body: blob
    });

    if (!finalizeResponse.ok) {
        throw new Error(`Échec upload fichier: HTTP ${finalizeResponse.status}`);
    }

    console.log(`[NotebookLM RPC] ✅ Fichier uploadé (${Math.round(blob.size / 1024)} Ko).`);
    return true;
}

/**
 * Utilitaire : extraire la première string d'une structure imbriquée
 */
function extractFirstStringFromResult(data) {
    if (typeof data === 'string') return data;
    if (Array.isArray(data) && data.length > 0) {
        return extractFirstStringFromResult(data[0]);
    }
    return null;
}