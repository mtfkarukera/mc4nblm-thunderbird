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
 * Applique une liste de patterns RegEx sur le message brut et remplace
 * les occurrences par "[REDACTED]" avant tout logging.
 *
 * @param  {string|any} message - Le message d'erreur brut (converti en string si nécessaire).
 * @returns {string}             - Le message d'erreur assaini, sans token ni cookie.
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

// Dernière capture (stockée en mémoire pour téléchargement local)
let lastCaptureData = null;    // base64 PDF ou texte Markdown
let lastCaptureFilename = null;
let lastCaptureFormat = null;  // "pdf" ou "md"

// =====================================================================
// INJECTION DYNAMIQUE DES SCRIPTS (Lazy Loading)
// =====================================================================

/**
 * Pipelines d'injection par format.
 * Chaque pipeline définit la liste ordonnée des scripts à injecter
 * dans l'onglet actif avant d'envoyer le message CAPTURE_CONTENT.
 * Les formats sans pipeline (url, direct, drive, screenshot, selection)
 * n'ont pas besoin de content scripts.
 */
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

/**
 * Sentinelles globales des scripts injectés.
 * Chaque script positionne une variable globale (window.xxx) à son chargement.
 * isScriptInjected() interroge ces sentinelles via executeScript
 * pour éviter les doubles injections — sans jamais utiliser eval().
 */
const INJECTION_SENTINELS = {
    "lib/Readability.js": "Readability",
    "lib/jspdf.umd.min.js": "jspdf",
    "src/content/serializer.js": "nwcserializer",
    "src/content/pdf_generator.js": "nwcpdfgen",
    "src/content/md_generator.js": "nwcmdgen",
};

/**
 * Erreur levée lorsque browser.scripting.executeScript échoue sur un onglet
 * (page restreinte : about:, chrome:, moz-extension:, etc.).
 *
 * @class
 * @extends {Error}
 * @param {number} tabId  - ID de l'onglet ciblé.
 * @param {string} file   - Fichier dont l'injection a échoué.
 * @param {string} detail - Message d'erreur brut du navigateur.
 */
class InjectionError extends Error {
    constructor(tabId, file, detail) {
        super(`Injection échouée sur onglet ${tabId} — ${file} : ${detail}`);
        this.name = "InjectionError";
        this.tabId = tabId;
        this.file = file;
    }
}

/**
 * Vérifie si un script est déjà actif dans l'onglet via sa sentinelle globale.
 * Utilise browser.scripting.executeScript avec une fonction pure (zéro eval).
 *
 * @param  {number} tabId      - ID de l'onglet à vérifier.
 * @param  {string} scriptFile - Chemin relatif du script (clé de INJECTION_SENTINELS).
 * @returns {Promise<boolean>}  - true si le script est déjà injecté, false sinon.
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
 * Injecte une liste de scripts dans l'ordre strict dans un onglet donné.
 * Promise.all est interdit ici : la séquence doit être strictement linéaire
 * (Readability → jsPDF → serializer → pdf_generator).
 * Ignore silencieusement les scripts déjà présents (déduplication par sentinelle).
 *
 * @param  {number}   tabId   - ID de l'onglet cible.
 * @param  {string[]} scripts - Liste ordonnée de chemins de scripts à injecter.
 * @returns {Promise<void>}
 * @throws  {InjectionError}  - Si l'injection d'un script échoue (page restreinte).
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
 * Devine le MIME type d'un fichier Drive hébergé à partir du titre de l'onglet Firefox.
 * Format attendu du titre : "nomfichier.ext - Google Drive".
 * Fallback à 'application/pdf' si l'extension est inconnue ou absente.
 *
 * @param  {string} title - Titre de l'onglet tel que retourné par tabs.query().
 * @returns {string}       - MIME type détecté (ex: 'image/png') ou 'application/pdf'.
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
 * Détecte si une URL pointe vers un fichier directement importable dans NotebookLM.
 * Combine l'analyse de l'extension URL (heuristique rapide) et une requête HEAD
 * pour confirmer le Content-Type réel. Retourne directImport: false pour toute
 * URL non HTTP(S) ou dont le type est non supporté.
 *
 * @param  {string} url - URL complète à analyser.
 * @returns {Promise<{directImport: boolean, mimeType?: string, label?: string, category?: string, isLocal?: boolean}>}
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
            console.warn('[MC] detectFileType — HEAD request échouée:', e.message);
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
        console.warn('[MC] contextMenus non disponible:', e.message);
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
                console.warn('[MC] Content script inaccessible pour GET_SELECTION_HTML — fallback texte brut.');
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
                console.warn('[MC] openPopup() indisponible — notification de repli émise:', e.message);
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

/**
 * Routeur central des messages inter-scripts (popup → background → content).
 * Tous les handlers retournent `true` pour signaler une réponse asynchrone.
 *
 * Handlers disponibles :
 * - GET_AUTH_STATUS     : vérifie la présence de cookies NotebookLM (connexion personnelle).
 * - GET_ACCOUNTS        : liste les comptes Google détectés + index actif.
 * - SET_ACCOUNT         : définit le compte actif (index authuser).
 * - GET_NOTEBOOKS       : liste les carnets du compte actif via RPC.
 * - CREATE_NOTEBOOK     : crée un nouveau carnet vide et retourne son ID.
 * - FETCH_IMAGE         : proxy CORS — télécharge une image et retourne un data URI Base64.
 * - DOWNLOAD_CAPTURE    : génère un Blob local depuis lastCaptureData et lance le téléchargement.
 * - DETECT_FILE_TYPE    : HEAD request pour détecter si une URL pointe vers un fichier importable.
 * - DETECT_MIME         : HEAD request minimale — retourne {isBinary, mime} pour la popup.
 * - START_CAPTURE       : point d'entrée principal — déclenche l'un des 7 pipelines d'import.
 *
 * @param  {Object}   message    - Message reçu (doit contenir message.action).
 * @param  {Object}   sender     - Metadata de l'expéditeur (tab, frameId, etc.).
 * @param  {Function} sendResponse - Callback Firefox pour la réponse synchrone.
 * @returns {true}               - Indique systématiquement une réponse asynchrone.
 */
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
                console.error('[MC] GET_ACCOUNTS:', sanitizeErrorMessage(err.message));
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
                console.error('[MC] GET_NOTEBOOKS:', sanitizeErrorMessage(err.message));
                sendResponse({
                    status: "error",
                    i18nKey: "errGetNotebooks",
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
                console.error('[MC] CREATE_NOTEBOOK:', sanitizeErrorMessage(err.message));
                sendResponse({
                    status: "error",
                    i18nKey: "errCreateNotebook",
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
                console.warn('[MC] DETECT_MIME — requête échouée:', e?.message);
                sendResponse({ isBinary: false, mime: '' });
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

                    // Générer le .md de la sélection pour téléchargement local
                    const mdContent = [
                      `Source: ${sel.pageUrl}`,
                      `Titre: ${sel.pageTitle}`,
                      `Date de capture: ${new Date().toLocaleString()}`,
                      '',
                      '---',
                      '',
                      sel.text
                    ].join('\n');

                    lastCaptureData = mdContent;
                    lastCaptureFilename = `${cleanTitle}.md`;
                    lastCaptureFormat = 'md';

                    const notebookUrl = `https://notebooklm.google.com/notebook/${finalNotebookId}`;
                    notifyUI("STATUS_UPDATE", {
                        i18nKey: "statusImportedSelection",
                        status: "success",
                        linkUrl: notebookUrl,
                        showDownload: true
                    });

                    browser.notifications.create({
                        type: "basic",
                        iconUrl: browser.runtime.getURL("icons/icon.svg"),
                        title: browser.i18n.getMessage("extensionName"),
                        message: browser.i18n.getMessage("notifSuccessMsg").replace("{title}", cleanTitle).replace("{format}", "Sélection")
                    });
                } catch (err) {
                    console.error('[MC] Pipeline SELECTION:', sanitizeErrorMessage(err.message));
                    notifyUI("STATUS_UPDATE", {
                        status: "error",
                        i18nKey: "errSelectionFailed",
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
                                    i18nKey: "errInjectionFailed"
                                });
                                return true;
                            }
                            throw err;
                        }
                    }
                }

                executeCaptureAndUploadWorkflow(message.notebookId, format, message.intentNote)
                    .catch(err => {
                        console.error('[MC] Pipeline WORKFLOW:', sanitizeErrorMessage(err.message));
                        notifyUI("STATUS_UPDATE", {
                            status: "error",
                            i18nKey: "errWorkflowFailed",
                            code: "UNKNOWN"
                        });
                    });
            })();
        }
    }

    return true;
});

/**
 * Émet un message vers la popup (si elle est encore ouverte) pour mettre à jour l'UI.
 * Les erreurs de livraison sont silencieusement ignorées : la popup peut être fermée.
 *
 * @param  {string} action  - Type du message (ex: "STATUS_UPDATE").
 * @param  {Object} payload - Corps du message (i18nKey, status, linkUrl, etc.).
 * @returns {void}
 */
function notifyUI(action, payload) {
    browser.runtime.sendMessage({ type: action, ...payload }).catch(() => {
        // La popup est sûrement fermée, on ignore l'erreur
    });
}

/**
 * Orchestre le workflow complet de capture et d'upload pour les formats
 * PDF, Markdown, URL, Screenshot, Import Direct et Google Drive.
 * Gère la création à la volée d'un carnet si notebookId === "CREATE_NEW".
 * Émet des STATUS_UPDATE vers la popup à chaque étape du pipeline.
 *
 * @param  {string}      targetNotebookId - ID du carnet cible, ou "CREATE_NEW".
 * @param  {string}      format           - Format d'import : "pdf" | "md" | "url" | "screenshot" | "direct" | "drive".
 * @param  {string|null} [intentNote]     - Annotation d'intention optionnelle (§8 AGENTS.md).
 * @returns {Promise<void>}
 * @throws  {Error} - Si l'onglet actif est absent, le carnet introuvable, ou l'upload échoue.
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

        // CAPTURE_CONTENT : action distincte de START_CAPTURE (popup→background)
        // pour lever l'ambiguïté sur les deux flux de messagerie.
        const response = await browser.tabs.sendMessage(activeTab.id, {
            action: "CAPTURE_CONTENT",
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
 * Réutilise le protocole resumable 3 étapes : enregistrement RPC (o4cbdc)
 * → initialisation de session upload → upload + finalisation.
 * Utilisé pour les formats Screenshot (PNG) et Import Direct (tous types binaires).
 *
 * @param  {string} notebookId       - ID du carnet cible.
 * @param  {Blob}   blob             - Blob binaire du fichier à uploader.
 * @param  {string} filename         - Nom du fichier avec extension (ex: "capture.png").
 * @param  {number} [authuserIndex=0] - Index du compte Google actif.
 * @returns {Promise<true>}           - Résout à true si l'upload est terminé avec succès.
 * @throws  {Error}                   - Si l'authentification est absente, SOURCE_ID manquant,
 *                                      x-goog-upload-url absent, ou HTTP 4xx/5xx.
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

    return true;
}

/**
 * Extraie récursivement la première string d'une structure imbriquée de tableaux.
 * Utilisé pour parser le SOURCE_ID depuis les réponses RPC [[[[id]]]] ou [[[id]]].
 *
 * @param  {any} data - Structure imbriquée (string, Array, ou autre).
 * @returns {string|null} - Première string trouvée, ou null si aucune.
 */
function extractFirstStringFromResult(data) {
    if (typeof data === 'string') return data;
    if (Array.isArray(data) && data.length > 0) {
        return extractFirstStringFromResult(data[0]);
    }
    return null;
}