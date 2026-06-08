// background.js — Routeur central (Thunderbird MV2 — Background persistant)
// NotebookLM Clipper for Thunderbird — v1.0.0
//
// Responsabilités :
//   - Enregistrement du MessageDisplayScript email_bridge.js au démarrage
//   - Routage des messages popup ↔ background (handler switch)
//   - Orchestration des 4 pipelines d'import (PDF, MD, URL, Attachment)
//   - Maintien de l'état en mémoire (session, tokens, compte actif)
//
// Dépendances chargées AVANT ce script dans background.scripts :
//   src/background/api/auth.js   → window.NtcAuth
//   src/background/api/rpc_client.js → window.NtcRpc

'use strict';

// ─────────────────────────────────────────────
// STATE EN MÉMOIRE
// ─────────────────────────────────────────────

let _activeAuthuserIndex = 0;
let _csrfToken = null;  // SNlM0e — refetché avant chaque capture
let _sessionId = null;  // FdrFJe
let _lastCapturePdfB64 = null;  // Dernier PDF généré (pour téléchargement local)
let _lastCaptureMdText = null;  // Dernier MD généré (pour téléchargement local)
let _pendingPdfResolve = null;  // Résolution Promise en attente de PDF_READY
let _pendingPdfReject = null;   // Rejet Promise en attente de CAPTURE_ERROR

const STORAGE_KEYS = {
  AUTH_READY: 'ntc_auth_ready',
  ACTIVE_AUTHUSER: 'ntc_active_authuser',
  LAST_NOTEBOOK: 'ntc_last_notebook_id',
};

// ─────────────────────────────────────────────
// ENREGISTREMENT DU MESSAGE DISPLAY SCRIPT
// ─────────────────────────────────────────────

(async () => {
  // Enregistrement du MessageDisplayScript — API TB 128+ (messenger.scripting.messageDisplay)
  try {
    if (messenger.scripting &&
      messenger.scripting.messageDisplay &&
      typeof messenger.scripting.messageDisplay.registerScripts === 'function') {
      // TB 128+ — API moderne
      await messenger.scripting.messageDisplay.registerScripts([{
        id: 'ntc-email-scripts',
        js: [
          'lib/jspdf.umd.min.js',
          'src/content/email_pdf_generator.js',
          'src/content/email_bridge.js'
        ],
        runAt: 'document_idle',
      }]);
      console.warn('[NTC] Scripts enregistrés via scripting.messageDisplay \u2713');
    } else if (messenger.messageDisplayScripts &&
      typeof messenger.messageDisplayScripts.register === 'function') {
      // TB 115-127 — API legacy
      await messenger.messageDisplayScripts.register({
        js: [
          { file: 'lib/jspdf.umd.min.js' },
          { file: 'src/content/email_pdf_generator.js' },
          { file: 'src/content/email_bridge.js' }
        ]
      });
      console.warn('[NTC] Scripts enregistrés via messageDisplayScripts (legacy) \u2713');
    } else {
      console.error('[NTC] Aucune API d\'enregistrement de messageDisplayScript disponible');
    }
  } catch (_e) {
    console.error('[NTC] Impossible d\'enregistrer les messageDisplayScripts :', _e.message);
  }

  // Restaurer le compte actif depuis le storage et démarrer la rotation si déjà connecté
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.ACTIVE_AUTHUSER);
    if (stored[STORAGE_KEYS.ACTIVE_AUTHUSER] !== undefined) {
      _activeAuthuserIndex = stored[STORAGE_KEYS.ACTIVE_AUTHUSER];
    }

    const cookieMap = await NtcAuth.collectGoogleCookies();
    const { valid } = NtcAuth.validateCookies(cookieMap);
    if (valid) {
      NtcAuth.startCookieRotationSchedule();
      console.warn('[NTC] Rotation des cookies démarrée au lancement (déjà authentifié) ✓');
    }
  } catch (err) {
    console.error('[NTC] Erreur initialisation auth au lancement :', err.message);
  }

  console.warn('[NTC] background.js initialisé ✓');
})();

// ─────────────────────────────────────────────
// HELPER : NOTIFIER LA POPUP
// ─────────────────────────────────────────────

/**
 * Envoie un message TYPE STATUS_UPDATE à la popup.
 * La popup écoute sur message.type (pas message.action).
 *
 * @param {Object} payload - Données à transmettre.
 */
function notifyUI(payload) {
  browser.runtime.sendMessage({ type: 'STATUS_UPDATE', ...payload })
    .catch(() => { /* Popup fermée — normal */ });
}

// ─────────────────────────────────────────────
// HELPERS EMAIL
// ─────────────────────────────────────────────

/**
 * Récupère le mailTab actif et l'en-tête du message affiché.
 *
 * @returns {Promise<{ mailTab: object, header: object }>}
 * @throws  {Error} code NO_EMAIL_DISPLAYED si aucun email n'est sélectionné.
 */
async function getActiveMailTabAndHeader() {
  const mailTabs = await messenger.mailTabs.query({ active: true, currentWindow: true });
  const mailTab = mailTabs[0];

  if (!mailTab) {
    const err = new Error('NO_EMAIL_DISPLAYED');
    err.code = 'NO_EMAIL_DISPLAYED';
    throw err;
  }

  const header = await messenger.messageDisplay.getDisplayedMessage(mailTab.id);
  if (!header) {
    const err = new Error('NO_EMAIL_DISPLAYED');
    err.code = 'NO_EMAIL_DISPLAYED';
    throw err;
  }

  return { mailTab, header };
}

/**
 * Construit l'objet grounding depuis l'en-tête du message.
 *
 * @param  {object} header - Retour de getDisplayedMessage().
 * @returns {{ subject: string, from: string, to: string, date: string }}
 */
function extractDomain(author) {
  const match = (author ?? '').match(/<([^@>]+@([^>]+))>/);
  return match ? match[2] : '';
}

function buildGrounding(header) {
  const subject = header.subject || '(no subject)';
  const from = header.author || '(unknown)';
  const to = (header.recipients || []).join(', ') || '(unknown)';
  const date = header.date ? new Date(header.date).toISOString() : '(unknown)';
  return {
    subject,
    from,
    to,
    date,
    author: from,
    recipients: to,
    title: subject,
    url: null,
    site: extractDomain(header.author)
  };
}

/**
 * Traverse récursivement le MIME tree et extrait le corps texte/HTML.
 *
 * @param  {Array}  parts          - parts du message (fullMessage.parts).
 * @param  {{ html: string, text: string }} acc - Accumulateur.
 * @returns {{ html: string, text: string }}
 */
function extractEmailBody(parts, acc) {
  const result = acc || { html: '', text: '' };
  if (!parts || !Array.isArray(parts)) return result;

  for (const part of parts) {
    if (part.contentType === 'text/html' && !result.html) result.html = part.body || '';
    if (part.contentType === 'text/plain' && !result.text) result.text = part.body || '';
    if (part.parts) extractEmailBody(part.parts, result);
  }
  return result;
}

/**
 * Extrait les URLs uniques du corps d'un email.
 *
 * @param  {string} body - Texte brut ou HTML de l'email.
 * @returns {string[]}   - Tableau d'URLs dédupliquées.
 */
function extractUrls(body) {
  const matches = body.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  return [...new Set(matches)];
}

/**
 * Filtre les pièces jointes supportées par NotebookLM (par MIME type et taille).
 * PJ > 200 MB sont exclues avec un log.
 *
 * @param  {Array} attachments - Retour de messenger.messages.listAttachments().
 * @returns {Array} - Pièces jointes filtrées, avec { name, partName, contentType, size }.
 */
function filterSupportedAttachments(attachments) {
  const MAX_SIZE = 200 * 1024 * 1024; // 200 MB

  const SUPPORTED_MIME = new Set([
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.ms-powerpoint',
    'application/vnd.ms-excel',
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg',
    'audio/flac', 'audio/aac', 'audio/x-aiff',
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/x-ms-wmv', 'video/3gpp', 'video/webm',
  ]);

  const EXT_TO_MIME = {
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'md': 'text/markdown',
    'markdown': 'text/markdown',
    'csv': 'text/csv',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'doc': 'application/msword',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'ppt': 'application/vnd.ms-powerpoint',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls': 'application/vnd.ms-excel',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'heic': 'image/heic',
    'heif': 'image/heif',
    'mp3': 'audio/mpeg',
    'm4a': 'audio/mp4',
    'wav': 'audio/wav',
    'webm': 'audio/webm',
    'ogg': 'audio/ogg',
    'flac': 'audio/flac',
    'aac': 'audio/aac',
    'aiff': 'audio/x-aiff',
    'aif': 'audio/x-aiff',
    'mp4': 'video/mp4',
    'mpeg': 'video/mpeg',
    'mpg': 'video/mpeg',
    'mov': 'video/quicktime',
    'avi': 'video/avi',
    'flv': 'video/x-flv',
    'wmv': 'video/x-ms-wmv',
    '3gp': 'video/3gpp',
  };

  const filtered = [];
  for (const att of attachments || []) {
    if (att.size && att.size > MAX_SIZE) {
      console.warn('[NTC] PJ trop grande (> 200 MB) :', att.name);
      continue;
    }

    let mime = (att.contentType || '').toLowerCase().split(';')[0].trim();
    if (!SUPPORTED_MIME.has(mime) || mime === 'application/octet-stream' || !mime) {
      const extMatch = (att.name || '').match(/\.([^.]+)$/);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (EXT_TO_MIME[ext]) {
          mime = EXT_TO_MIME[ext];
        }
      } else {
        // Pas d'extension — fallback sur text/plain si la taille est raisonnable (< 10 MB)
        if (att.size && att.size < 10 * 1024 * 1024) {
          mime = 'text/plain';
        }
      }
    }

    if (SUPPORTED_MIME.has(mime)) {
      filtered.push({
        ...att,
        contentType: mime
      });
    }
  }

  return filtered;
}

// ─────────────────────────────────────────────
// HANDLERS — AUTHENTIFICATION
// ─────────────────────────────────────────────

async function handleGetAuthStatus() {
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  return { authReady: valid };
}

async function handleConnectAuth() {
  NtcAuth.openAuthWebContentTab(async () => {
    // Callback appelé quand la connexion est détectée et l'onglet fermé
    const cookieMap = await NtcAuth.collectGoogleCookies();
    const { valid } = NtcAuth.validateCookies(cookieMap);
    if (!valid) { notifyUI({ status: 'error', code: 'AUTH_EXPIRED' }); return; }

    try {
      const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
      _csrfToken = tokens.csrfToken;
      _sessionId = tokens.sessionId;
    } catch (e) {
      console.warn('[NTC] fetchCSRFTokens après auth :', e.message);
    }

    NtcAuth.startCookieRotationSchedule();
    notifyUI({ status: 'auth_ready' });
  });
  return { started: true };
}

// ─────────────────────────────────────────────
// HANDLERS — MÉTADONNÉES EMAIL
// ─────────────────────────────────────────────

async function handleGetActiveEmailMeta() {
  const { header } = await getActiveMailTabAndHeader();
  const grounding = buildGrounding(header);

  const fullMessage = await messenger.messages.getFull(header.id);
  const body = extractEmailBody(fullMessage.parts);

  if (!body.text && !body.html) {
    const err = new Error('EMPTY_EMAIL_BODY');
    err.code = 'EMPTY_EMAIL_BODY';
    throw err;
  }

  const detectedUrls = extractUrls(body.html || body.text);

  const rawAttachments = await messenger.messages.listAttachments(header.id);
  const attachments = filterSupportedAttachments(rawAttachments);

  return {
    ...grounding,
    attachments,
    detectedUrls,
    hasPdf: true,  // Email → PDF toujours disponible
    hasMd: true,  // Email → MD toujours disponible
    hasUrl: detectedUrls.length > 0,
    messageId: header.id,
  };
}

// ─────────────────────────────────────────────
// HANDLERS — CARNETS
// ─────────────────────────────────────────────

async function handleGetNotebooks() {
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  console.warn('[NTC-BG] handleGetNotebooks — cookies valides?', valid, 'nb cookies:', Object.keys(cookieMap).join(', '));
  if (!valid) { const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e; }

  let csrfOk = false;
  try {
    const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
    _csrfToken = tokens.csrfToken;
    _sessionId = tokens.sessionId;
    csrfOk = !!_csrfToken;
    console.warn('[NTC-BG] fetchCSRFTokens — csrfToken présent?', csrfOk, 'sessionId présent?', !!_sessionId);
  } catch (err) {
    console.error('[NTC-BG] fetchCSRFTokens ÉCHEC :', err.message);
    // Retourner un "notebook" diagnostic visible dans la popup
    return { notebooks: [{ id: '__diag__', title: '\u274C CSRF: ' + err.message }] };
  }

  try {
    const result = await NtcRpc.listNotebooks(_csrfToken, _activeAuthuserIndex);
    console.warn('[NTC-BG] listNotebooks résultat :', result.notebooks.length, 'carnets');
    if (result.notebooks.length === 0) {
      // Aucun carnet retourné — ajouter une entrée diagnostic
      result.notebooks.push({
        id: '__diag__',
        title: '\u26A0\uFE0F 0 carnets. CSRF: ' + (csrfOk ? 'OK' : 'NULL') + ', authuser: ' + _activeAuthuserIndex
      });
    }
    return result;
  } catch (err) {
    console.error('[NTC-BG] listNotebooks ÉCHEC :', err.message);
    return { notebooks: [{ id: '__diag__', title: '\u274C RPC: ' + err.message }] };
  }
}

async function handleCreateNotebook(message) {
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) { const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e; }

  const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
  _csrfToken = tokens.csrfToken;
  _sessionId = tokens.sessionId;

  return NtcRpc.createNotebook(_csrfToken, message.title, _activeAuthuserIndex);
}

// ─────────────────────────────────────────────
// HANDLERS — COMPTES
// ─────────────────────────────────────────────

async function handleGetAccounts() {
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) return { accounts: [] };
  const accounts = await NtcAuth.detectGoogleAccounts();
  return { accounts };
}

async function handleSetAccount(message) {
  _activeAuthuserIndex = message.index;
  await browser.storage.local.set({ [STORAGE_KEYS.ACTIVE_AUTHUSER]: message.index });
  return { ok: true };
}

// ─────────────────────────────────────────────
// HANDLERS — PIPELINES D'IMPORT
// ─────────────────────────────────────────────

/**
 * Récupère un message d'erreur détaillé contenant des informations RPC de debug
 * si elles sont disponibles.
 *
 * @param {Error} err - L'erreur interceptée.
 * @returns {string} Le détail d'erreur enrichi.
 */
function getRichErrorDetail(err) {
  const debug = NtcRpc.getLastDebugInfo ? NtcRpc.getLastDebugInfo() : null;
  if (debug) {
    const rawSnippet = debug.rawText ? debug.rawText.slice(0, 150).replace(/\r?\n/g, '↵') : 'null';
    return `${err.message} | Chunks:${debug.chunksLength} | Err:${debug.error} | Raw:${rawSnippet}`;
  }
  return err.message;
}

async function handleStartCapture(message) {
  notifyUI({ status: 'capturing' });

  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) {
    notifyUI({ status: 'error', code: 'AUTH_EXPIRED' });
    return;
  }

  try {
    const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
    _csrfToken = tokens.csrfToken;
    _sessionId = tokens.sessionId;
  } catch (e) {
    notifyUI({ status: 'error', code: e.code || 'UNKNOWN', detail: getRichErrorDetail(e) });
    return;
  }

  // Délégation aux sous-handlers selon le format demandé
  try {
    switch (message.format) {
      case 'pdf': await handlePdfCapture(message); break;
      case 'md': await handleMdCapture(message); break;
      case 'url': await handleUrlCapture(message); break;
      case 'attachment': await handleAttachmentCapture(message); break;
      default:
        notifyUI({ status: 'error', code: 'UNKNOWN' });
    }
  } catch (e) {
    console.error('[NTC] Capture error :', e.message);
    notifyUI({ status: 'error', code: e.code || 'UNKNOWN', detail: getRichErrorDetail(e) });
  }
}

// ── Pipeline PDF (Phase 3) ──────────────────
async function handlePdfCapture(message) {
  notifyUI({ status: 'capturing', statusKey: 'statusCapturing' });

  let mailTab, header;
  try {
    const active = await getActiveMailTabAndHeader();
    mailTab = active.mailTab;
    header = active.header;
  } catch (err) {
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: err.message });
    return;
  }
  // 1. Les scripts sont déjà pré-enregistrés au démarrage, rien à injecter ici.
  console.warn('[NTC-BG] Capture PDF en cours, vérification du bridge...');
  // 2. Vérifier que le bridge est opérationnel et prêt
  try {
    const checkResult = await browser.tabs.sendMessage(mailTab.id, {
      action: 'PING_BRIDGE'
    });
    if (!checkResult || !checkResult.pdfReady) {
      console.error('[NTC-BG] Le générateur PDF n\'est pas accessible après injection. Réponse:', JSON.stringify(checkResult));
      notifyUI({ status: 'error', code: 'INJECTION_FAILED', detail: 'pdfReady false après injection' });
      return;
    }
  } catch (pingErr) {
    console.error('[NTC-BG] Impossible de contacter le bridge après injection :', pingErr.message);
    notifyUI({ status: 'error', code: 'INJECTION_FAILED', detail: pingErr.message });
    return;
  }

  // 3. Lancer la capture via message
  let captureResult;
  try {
    captureResult = await new Promise((resolve, reject) => {
      _pendingPdfResolve = resolve;
      _pendingPdfReject = reject;

      browser.tabs.sendMessage(mailTab.id, {
        action: 'CAPTURE_EMAIL_PDF',
        grounding: buildGrounding(header),
        intentNote: message.intentNote
      }).catch(err => {
        _pendingPdfResolve = null;
        _pendingPdfReject = null;
        reject(err);
      });

      // Timeout de sécurité (30s)
      setTimeout(() => {
        if (_pendingPdfResolve === resolve) {
          _pendingPdfResolve = null;
          _pendingPdfReject = null;
          const err = new Error('TIMEOUT');
          err.code = 'TIMEOUT';
          reject(err);
        }
      }, 30000);
    });
  } catch (err) {
    console.error('[NTC-BG] Échec de la capture PDF :', err.message);
    notifyUI({ status: 'error', code: err.code || 'INJECTION_FAILED', detail: err.message });
    return;
  }

  // 3. Uploader le PDF généré
  notifyUI({ status: 'capturing', statusKey: 'statusUploading' });

  try {
    const base64Data = captureResult.pdfBase64.split(',')[1];
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const pdfBlob = new Blob([byteArray], { type: 'application/pdf' });

    const filename = NtcUtils.sanitizeFilename(`${captureResult.title || 'email'}.pdf`);

    await NtcRpc.uploadFileSource(
      _csrfToken,
      pdfBlob,
      filename,
      message.notebookId,
      _activeAuthuserIndex,
      'application/pdf'
    );

    // Mémoriser le dernier carnet sélectionné
    await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      showDownload: true
    });
  } catch (err) {
    console.error('[NTC-BG] Échec de l\'upload du PDF :', err.message);
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: getRichErrorDetail(err) });
  }
}

// ── Pipeline MD (Phase 4) ───────────────────────
async function handleMdCapture(message) {
  notifyUI({ status: 'capturing', statusKey: 'statusCapturing' });

  let header;
  try {
    const active = await getActiveMailTabAndHeader();
    header = active.header;
  } catch (err) {
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: err.message });
    return;
  }

  try {
    const fullMessage = await messenger.messages.getFull(header.id);
    const body = extractEmailBody(fullMessage.parts);
    const grounding = buildGrounding(header);

    const mdLines = [];
    if (message.intentNote) {
      mdLines.push(`> **Intention de recherche :** ${message.intentNote}`);
      mdLines.push('');
    }

    const dateStr = grounding.date ? new Date(grounding.date).toLocaleString() : '(unknown)';
    mdLines.push(`> **Email** | **De :** ${grounding.from} | **Objet :** ${grounding.subject} | **Date :** ${dateStr}`);
    mdLines.push('');
    mdLines.push('---');
    mdLines.push('');

    if (body.html) {
      mdLines.push(NtcUtils.htmlToMarkdown(body.html));
    } else if (body.text) {
      mdLines.push(body.text);
    } else {
      mdLines.push('_(contenu non disponible)_');
    }

    const mdText = mdLines.join('\n').replace(/\r\n/g, '\n');
    _lastCaptureMdText = mdText;

    const filename = NtcUtils.sanitizeFilename(`${grounding.subject || 'email'}.md`);

    notifyUI({ status: 'capturing', statusKey: 'statusUploading' });
    await NtcRpc.addTextSource(
      _csrfToken,
      mdText,
      filename,
      message.notebookId,
      _activeAuthuserIndex
    );

    // Mémoriser le dernier carnet sélectionné
    await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      showDownload: true
    });
  } catch (err) {
    console.error('[NTC-BG] \u00c9chec de l\'import Markdown :', err.message);
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: getRichErrorDetail(err) });
  }
}

// ── Pipeline URL (Phase 4) ──────────────────────
async function handleUrlCapture(message) {
  notifyUI({ status: 'capturing', statusKey: 'statusUploading' });

  try {
    await NtcRpc.addUrlSource(
      _csrfToken,
      message.selectedUrl,
      message.notebookId,
      _activeAuthuserIndex
    );

    // Mémoriser le dernier carnet sélectionné
    await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      showDownload: false
    });
  } catch (err) {
    console.error('[NTC-BG] Échec de l\'import URL :', err.message);
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: getRichErrorDetail(err) });
  }
}

// ── Pipeline Attachment (Phase 4) ───────────────
async function handleAttachmentCapture(message) {
  const attachments = message.attachments || [];
  const total = attachments.length;
  if (total === 0) {
    notifyUI({ status: 'error', code: 'UNKNOWN', detail: 'Aucune pièce jointe sélectionnée' });
    return;
  }

  const errors = [];
  for (let i = 0; i < total; i++) {
    const att = attachments[i];
    notifyUI({
      status: 'info',
      batchProgress: { current: i + 1, total }
    });

    try {
      const fileBlob = await messenger.messages.getAttachmentFile(message.messageId, att.partName);
      const filename = NtcUtils.sanitizeFilename(`⚡ ${att.name}`);

      await NtcRpc.uploadFileSource(
        _csrfToken,
        fileBlob,
        filename,
        message.notebookId,
        _activeAuthuserIndex,
        att.contentType
      );
    } catch (err) {
      console.error('[NTC-BG] Échec import PJ :', att.name, err.message);
      errors.push({ name: att.name, error: getRichErrorDetail(err) });
    }
  }

  // Mémoriser le dernier carnet sélectionné
  await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

  if (errors.length === 0) {
    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      showDownload: false
    });
  } else if (errors.length === total) {
    notifyUI({
      status: 'error',
      code: 'UNKNOWN',
      detail: `Toutes les pièces jointes ont échoué : ${errors.map(e => `${e.name} (${e.error})`).join(', ')}`
    });
  } else {
    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      showDownload: false,
      warnings: errors.map(e => e.name)
    });
  }
}


// ─────────────────────────────────────────────
// HANDLERS — PDF_READY / CAPTURE_ERROR (Phase 3)
// ─────────────────────────────────────────────

function handlePdfReady(message) {
  if (_pendingPdfResolve) {
    _lastCapturePdfB64 = message.pdfBase64;
    _pendingPdfResolve({ pdfBase64: message.pdfBase64, title: message.title });
    _pendingPdfResolve = null;
    _pendingPdfReject = null;
  }
}

function handleCaptureError(message) {
  if (_pendingPdfReject) {
    const err = new Error(message.detail || 'Capture failed');
    err.code = message.code || 'UNKNOWN';
    _pendingPdfReject(err);
    _pendingPdfResolve = null;
    _pendingPdfReject = null;
  } else {
    notifyUI({ status: 'error', code: message.code || 'UNKNOWN', detail: message.detail });
  }
}

// ─────────────────────────────────────────────
// HANDLERS — TÉLÉCHARGEMENT
// ─────────────────────────────────────────────

async function handleDownloadCapture(message) {
  if (message.fileType === 'pdf' && _lastCapturePdfB64) {
    const byteStr = atob(_lastCapturePdfB64.split(',')[1]);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    await browser.downloads.download({ url, filename: `${message.title || 'email'}.pdf` });
  } else if (message.fileType === 'md' && _lastCaptureMdText) {
    const blob = new Blob([_lastCaptureMdText], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    await browser.downloads.download({ url, filename: `${message.title || 'email'}.md` });
  }
}

// ─────────────────────────────────────────────
// ROUTEUR PRINCIPAL
// ─────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, _sender) => {
  // Les messages PDF_READY et CAPTURE_ERROR viennent du MessageDisplayScript
  if (message.action === 'PDF_READY') { handlePdfReady(message); return; }
  if (message.action === 'CAPTURE_ERROR') { handleCaptureError(message); return; }
  if (message.action === 'PING') { return Promise.resolve({ ok: true }); }

  // Messages de la popup — retournent une Promise (return true nécessaire si async)
  if (message.action === 'GET_AUTH_STATUS') return handleGetAuthStatus();
  if (message.action === 'CONNECT_AUTH') return handleConnectAuth();
  if (message.action === 'GET_ACTIVE_EMAIL_META') return handleGetActiveEmailMeta();
  if (message.action === 'GET_NOTEBOOKS') return handleGetNotebooks();
  if (message.action === 'CREATE_NOTEBOOK') return handleCreateNotebook(message);
  if (message.action === 'GET_ACCOUNTS') return handleGetAccounts();
  if (message.action === 'SET_ACCOUNT') return handleSetAccount(message);
  if (message.action === 'START_CAPTURE') { handleStartCapture(message); return true; }
  if (message.action === 'DOWNLOAD_CAPTURE') return handleDownloadCapture(message);
});