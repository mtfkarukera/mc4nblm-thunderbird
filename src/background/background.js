// background.js — Routeur central (Thunderbird 128+ ESR — Event Page Manifest V3)
// Magic Clipper for Gemini Notebook
// Auteur : MTF Karukera
//
// Responsabilités :
//   - Enregistrement idempotent du MessageDisplayScript email_bridge.js (TB 128+ MV3)
//   - Routage cloisonné des messages popup ↔ background ↔ onglet email
//   - Orchestration des 3 pipelines d'import (PDF, MD, Attachment)
//   - Gestion des alarmes MV3 (rotation cookies & purge mémoire à 5 min)
//
// Dépendances chargées AVANT ce script dans background.scripts :
//   src/shared/utils.js              → var NtcUtils
//   src/background/api/auth.js       → window.NtcAuth
//   src/background/api/rpc_client.js → window.NtcRpc

'use strict';

// ─────────────────────────────────────────────
// ÉTAT EN MÉMOIRE (ÉPHÉMÈRE EVENT PAGE MV3)
// ─────────────────────────────────────────────

let _activeAuthuserIndex = 0;
let _authuserLoaded = false;
let _lastCapturePdfB64 = null;  // Dernier PDF généré (maintenu en RAM tant que l'écran succès est actif)
let _lastCaptureMdText = null;  // Dernier MD généré (maintenu en RAM tant que l'écran succès est actif)
let _lastCaptureTitle = null;   // Sujet brut du dernier email capturé
let _pendingPdfCapture = null;  // { resolve, reject, captureId, tabId }
let _captureInProgress = false; // Verrou global : une seule capture à la fois
let _pdfTimeoutId = null;       // Timeout de sécurité PDF (30s)

/** Map des URLs blob: en cours de téléchargement : downloadId -> objectUrl */
const _activeDownloadUrls = new Map();

/** Alarme MV3 de purge automatique des buffers mémoire (5 minutes) */
const PURGE_ALARM_NAME = 'ntc-purge-capture';
const PURGE_DELAY_MINUTES = 5;

const STORAGE_KEYS = NtcUtils.STORAGE_KEYS;

// ─────────────────────────────────────────────
// QUOTAS GEMINI NOTEBOOK ET CONFIGURATION MIME
// ─────────────────────────────────────────────

const MAX_SIZE = 200 * 1024 * 1024; // Quota officiel Gemini Notebook : 200 Mo
const MAX_WORDS = 500000;           // Quota officiel Gemini Notebook : 500 000 mots

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
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi', 'video/x-flv',
  'video/x-ms-wmv', 'video/3gpp', 'video/webm',
]);

const EXT_TO_MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  aiff: 'audio/x-aiff',
  aif: 'audio/x-aiff',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mov: 'video/quicktime',
  avi: 'video/avi',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
};

// Fichiers du bridge PDF — ordre d'injection STRICT (AGENTS.md §4.5)
const MESSAGE_SCRIPTS = [
  'lib/jspdf.umd.min.js',
  'src/content/email_pdf_generator.js',
  'src/content/email_bridge.js',
];

// ─────────────────────────────────────────────
// HELPERS STOCKAGE & CONSENTEMENT
// ─────────────────────────────────────────────

async function getActiveAuthuserIndex() {
  if (_authuserLoaded) return _activeAuthuserIndex;
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.ACTIVE_AUTHUSER);
    if (stored[STORAGE_KEYS.ACTIVE_AUTHUSER] !== undefined) {
      _activeAuthuserIndex = NtcUtils.sanitizeAuthuserIndex(stored[STORAGE_KEYS.ACTIVE_AUTHUSER]);
    }
    _authuserLoaded = true;
  } catch (_e) {
    _activeAuthuserIndex = 0;
  }
  return _activeAuthuserIndex;
}

async function hasDataConsent() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.DATA_CONSENT);
    return stored[STORAGE_KEYS.DATA_CONSENT] === true;
  } catch (_e) {
    return false;
  }
}

/**
 * Envoie un message TYPE STATUS_UPDATE à la popup.
 *
 * @param {Object} payload - Données à transmettre.
 */
function notifyUI(payload) {
  browser.runtime.sendMessage({ type: 'STATUS_UPDATE', ...payload })
    .catch(() => { /* Popup fermée — cas nominal */ });
}

// ─────────────────────────────────────────────
// CENTRALISATION DE L'AUTHENTIFICATION
// ─────────────────────────────────────────────

async function clearAuthSession() {
  try {
    await NtcAuth.clearAuthSession();
  } catch (_e) {
    // Ignorer
  }
}

/**
 * Vérifie le consentement explicite, la présence des cookies Google et
 * récupère un jeton CSRF SNlM0e frais pour le compte actif.
 *
 * @returns {Promise<{ csrfToken: string, authuserIndex: number }>}
 * @throws {Error} AUTH_EXPIRED si consentement absent, cookies absents ou session expirée.
 */
async function ensureAuthenticated() {
  const consent = await hasDataConsent();
  if (!consent) {
    throw NtcUtils.ntcError('AUTH_EXPIRED', 'AUTH_EXPIRED');
  }

  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) {
    await clearAuthSession();
    throw NtcUtils.ntcError('AUTH_EXPIRED', 'AUTH_EXPIRED');
  }

  const authuserIndex = await getActiveAuthuserIndex();
  try {
    const tokens = await NtcAuth.fetchCSRFTokens(authuserIndex);
    return { csrfToken: tokens.csrfToken, authuserIndex };
  } catch (err) {
    if (err.code === 'AUTH_EXPIRED') {
      await clearAuthSession();
    }
    throw err;
  }
}

// Enregistrement synchrone au top-level des callbacks de l'onglet WebContent d'auth (MV3)
NtcAuth.setAuthTabCallbacks({
  onSuccess: async () => {
    try {
      const authuserIndex = await getActiveAuthuserIndex();
      await NtcAuth.fetchCSRFTokens(authuserIndex);
      await NtcAuth.startCookieRotationSchedule();
      notifyUI({ status: 'auth_ready' });
    } catch (err) {
      console.error('[NTC] Validation CSRF après connexion échouée :', err.message);
      notifyUI({
        status: 'error',
        code: err.code === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : 'UNKNOWN',
        detail: err.message,
      });
    }
  },
  onClosed: () => {
    notifyUI({ status: 'auth_closed' });
  },
});

// ─────────────────────────────────────────────
// ENREGISTREMENT DES SCRIPTS EMAIL (MV3 TB 128+)
// ─────────────────────────────────────────────

async function injectMessageScripts(tabId) {
  await messenger.scripting.executeScript({
    target: { tabId },
    files: MESSAGE_SCRIPTS,
  });
}

/**
 * Helper universel MV3 pour lire le premier message affiché dans un onglet
 * (remplace getDisplayedMessage déprécié en MV3 au profit de getDisplayedMessages).
 *
 * @param {number} tabId
 * @returns {Promise<object|null>}
 */
async function getDisplayedMessageHeader(tabId) {
  const list = await messenger.messageDisplay.getDisplayedMessages(tabId);
  if (list && Array.isArray(list.messages) && list.messages.length > 0) {
    return list.messages[0];
  }
  return null;
}

/**
 * Enregistre les scripts d'affichage email (API MV3 TB 128+) et rattrape les
 * onglets déjà ouverts lors de l'installation ou du démarrage de Thunderbird.
 */
async function initExtensionStartup() {
  try {
    if (
      messenger.scripting &&
      messenger.scripting.messageDisplay &&
      typeof messenger.scripting.messageDisplay.registerScripts === 'function'
    ) {
      await messenger.scripting.messageDisplay
        .unregisterScripts({ ids: ['ntc-email-scripts'] })
        .catch(() => {});
      await messenger.scripting.messageDisplay.registerScripts([{
        id: 'ntc-email-scripts',
        js: MESSAGE_SCRIPTS,
        runAt: 'document_idle',
      }]);
      NtcUtils.log('Scripts enregistrés via scripting.messageDisplay');
    }
  } catch (err) {
    console.error('[NTC] Impossible d\'enregistrer les scripts messageDisplay :', err.message);
  }

  // Rattrapage des onglets mail/messageDisplay déjà ouverts ou restaurés
  try {
    const openTabs = await messenger.tabs.query({});
    for (const tab of openTabs) {
      if (!['mail', 'messageDisplay'].includes(tab.type)) continue;
      try {
        if (tab.type === 'mail') {
          const displayed = await getDisplayedMessageHeader(tab.id);
          if (!displayed) continue;
        }
        await injectMessageScripts(tab.id);
      } catch (_tabErr) {
        // Onglet sans document email actif — ignorer
      }
    }
  } catch (err) {
    console.error('[NTC] Rattrapage des onglets message échoué :', err.message);
  }

  // Si le consentement est déjà accordé et la session valide, activer l'alarme RotateCookies
  try {
    if (await hasDataConsent()) {
      const cookieMap = await NtcAuth.collectGoogleCookies();
      if (NtcAuth.validateCookies(cookieMap).valid) {
        await NtcAuth.startCookieRotationSchedule();
      }
    }
  } catch (err) {
    NtcUtils.log('Vérification auth initiale ignorée :', err.message);
  }
}

// Listeners de cycle de vie enregistrés de façon synchrone au top-level (requis en MV3)
browser.runtime.onInstalled.addListener(() => {
  initExtensionStartup().catch(() => {});
});
browser.runtime.onStartup.addListener(() => {
  initExtensionStartup().catch(() => {});
});

// ─────────────────────────────────────────────
// ALARMES MV3 & PURGE MÉMOIRE
// ─────────────────────────────────────────────

function purgeCaptureBuffers() {
  _lastCapturePdfB64 = null;
  _lastCaptureMdText = null;
  _lastCaptureTitle = null;
  browser.alarms.clear(PURGE_ALARM_NAME).catch(() => {});
}

function schedulePurge() {
  browser.alarms.create(PURGE_ALARM_NAME, { delayInMinutes: PURGE_DELAY_MINUTES });
}

function cancelPurge() {
  browser.alarms.clear(PURGE_ALARM_NAME).catch(() => {});
}

// Routeur top-level synchrone des alarmes MV3
browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === NtcAuth.ROTATE_ALARM_NAME) {
    NtcAuth.rotateCookiesIfNeeded().catch(() => {});
  } else if (alarm.name === PURGE_ALARM_NAME) {
    purgeCaptureBuffers();
  }
});

// ─────────────────────────────────────────────
// HELPERS EMAIL & MIME
// ─────────────────────────────────────────────

async function getActiveMessageTabAndHeader() {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw NtcUtils.ntcError('NO_EMAIL_DISPLAYED', 'NO_EMAIL_DISPLAYED');
  }

  const header = await getDisplayedMessageHeader(tab.id);
  if (!header) {
    throw NtcUtils.ntcError('NO_EMAIL_DISPLAYED', 'NO_EMAIL_DISPLAYED');
  }

  return { tab, header };
}

function extractDomain(author) {
  const src = author ?? '';
  const match = src.match(/<[^@>\s]+@([^>\s]+)>/) || src.match(/[^@\s<,;]+@([^\s>,;]+)/);
  return match ? match[1] : '';
}

function buildGrounding(header) {
  const subject = header.subject || browser.i18n.getMessage('labelNoSubject') || '(no subject)';
  const from = header.author || browser.i18n.getMessage('labelUnknown') || '(unknown)';
  const to = (header.recipients || []).join(', ') || browser.i18n.getMessage('labelUnknown') || '(unknown)';
  const date = header.date ? new Date(header.date).toISOString() : null;
  return {
    subject,
    from,
    to,
    date,
    author: from,
    recipients: to,
    title: subject,
    url: null,
    site: extractDomain(header.author),
  };
}

/**
 * Détermine si une partie MIME est une pièce jointe explicite (à exclure du corps).
 */
function isMimeAttachmentPart(part) {
  if (!part) return false;
  if (part.name) return true;
  if (part.headers && part.headers['content-disposition']) {
    const disp = String(part.headers['content-disposition'][0] || '').toLowerCase();
    if (disp.startsWith('attachment')) return true;
  }
  return false;
}

/**
 * Traverse récursivement l'arbre MIME d'un courriel pour en extraire le corps texte/HTML,
 * en ignorant les pièces jointes MIME et en gérant les courriels mono-partie.
 *
 * @param  {object} fullMessage - Objet retourné par messenger.messages.getFull().
 * @returns {{ html: string, text: string }}
 */
function extractEmailBodyFromFull(fullMessage) {
  const acc = { html: '', text: '' };
  if (!fullMessage) return acc;

  function walkParts(parts, depth) {
    if (depth > 20 || !Array.isArray(parts)) return;
    for (const part of parts) {
      if (isMimeAttachmentPart(part)) continue;
      const ct = (part.contentType || '').toLowerCase().split(';')[0].trim();
      if (ct === 'text/html' && part.body) {
        acc.html = (acc.html ? acc.html + '\n' : '') + part.body;
      } else if (ct === 'text/plain' && part.body) {
        acc.text = (acc.text ? acc.text + '\n' : '') + part.body;
      }
      if (part.parts) {
        walkParts(part.parts, depth + 1);
      }
    }
  }

  if (Array.isArray(fullMessage.parts) && fullMessage.parts.length > 0) {
    walkParts(fullMessage.parts, 0);
  } else if (typeof fullMessage.body === 'string' && fullMessage.body) {
    const rootCt = (fullMessage.contentType || '').toLowerCase().split(';')[0].trim();
    if (rootCt === 'text/html') {
      acc.html = fullMessage.body;
    } else {
      acc.text = fullMessage.body;
    }
  }

  return acc;
}

function filterSupportedAttachments(attachments) {
  const filtered = [];
  for (const att of attachments || []) {
    let mime = (att.contentType || '').toLowerCase().split(';')[0].trim();
    let unknownType = false;
    if (!SUPPORTED_MIME.has(mime) || mime === 'application/octet-stream' || !mime) {
      const extMatch = (att.name || '').match(/\.([^.]+)$/);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (EXT_TO_MIME[ext]) {
          mime = EXT_TO_MIME[ext];
        }
      } else if (att.size && att.size < 10 * 1024 * 1024) {
        mime = 'text/plain';
        unknownType = true;
      }
    }

    if (!SUPPORTED_MIME.has(mime)) continue;

    if (att.size && att.size > MAX_SIZE) {
      NtcUtils.log('PJ supérieure au quota 200 Mo détectée');
      filtered.push({ ...att, contentType: mime, tooLarge: true });
      continue;
    }

    const entry = { ...att, contentType: mime };
    if (unknownType) entry.unknownType = true;
    filtered.push(entry);
  }

  return filtered;
}

// ─────────────────────────────────────────────
// HANDLERS — AUTHENTIFICATION & CONSENTEMENT
// ─────────────────────────────────────────────

async function handleGetAuthStatus() {
  const consent = await hasDataConsent();
  if (!consent) {
    return { authReady: false, dataConsent: false };
  }
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (valid) {
    await NtcAuth.startCookieRotationSchedule();
  }
  return { authReady: valid, dataConsent: true };
}

async function handleConnectAuth(message) {
  if (message && message.consent === true) {
    await browser.storage.local.set({ [STORAGE_KEYS.DATA_CONSENT]: true });
  }

  const consent = await hasDataConsent();
  if (!consent) {
    return { started: false, error: 'CONSENT_REQUIRED' };
  }

  // Si les cookies Google sont déjà valides dans Thunderbird (ex: mise à jour depuis v1.5.x),
  // valider directement la session sans rouvrir inutilement un onglet WebContent
  try {
    const cookieMap = await NtcAuth.collectGoogleCookies();
    if (NtcAuth.validateCookies(cookieMap).valid) {
      const authuserIndex = await getActiveAuthuserIndex();
      await NtcAuth.fetchCSRFTokens(authuserIndex);
      await NtcAuth.startCookieRotationSchedule();
      notifyUI({ status: 'auth_ready' });
      return { started: true, alreadyAuthenticated: true };
    }
  } catch (_e) {
    // Session absente ou expirée : ouvrir l'onglet WebContent de connexion
  }

  await NtcAuth.openAuthWebContentTab();
  return { started: true };
}

async function handleDisconnectAuth() {
  await browser.storage.local.set({ [STORAGE_KEYS.DATA_CONSENT]: false });
  await clearAuthSession();
  purgeCaptureBuffers();
  return { ok: true };
}

// ─────────────────────────────────────────────
// HANDLERS — MÉTADONNÉES EMAIL
// ─────────────────────────────────────────────

async function handleGetActiveEmailMeta() {
  const { header } = await getActiveMessageTabAndHeader();
  const grounding = buildGrounding(header);

  const [fullMessage, rawAttachments] = await Promise.all([
    messenger.messages.getFull(header.id),
    messenger.messages.listAttachments(header.id),
  ]);

  const body = extractEmailBodyFromFull(fullMessage);
  const attachments = filterSupportedAttachments(rawAttachments);
  const hasBody = Boolean((body.text && body.text.trim()) || (body.html && body.html.trim()));

  // Un courriel dépourvu de texte MAIS comportant des pièces jointes supportées reste importable !
  if (!hasBody && attachments.length === 0) {
    throw NtcUtils.ntcError('EMPTY_EMAIL_BODY', 'EMPTY_EMAIL_BODY');
  }

  return {
    ...grounding,
    attachments,
    hasPdf: hasBody,
    hasMd: hasBody,
    messageId: header.id,
  };
}

// ─────────────────────────────────────────────
// HANDLERS — CARNETS & COMPTES
// ─────────────────────────────────────────────

async function handleGetNotebooks() {
  const { csrfToken, authuserIndex } = await ensureAuthenticated();
  const result = await NtcRpc.listNotebooks(csrfToken, authuserIndex);
  NtcUtils.log('listNotebooks :', result.notebooks.length, 'carnets');
  return result;
}

async function handleCreateNotebook(message) {
  const title = typeof message.title === 'string' ? message.title.trim() : '';
  if (!title || title.length > 100) {
    throw NtcUtils.ntcError('INVALID_TITLE', 'INVALID_TITLE');
  }

  const { csrfToken, authuserIndex } = await ensureAuthenticated();
  return NtcRpc.createNotebook(csrfToken, title, authuserIndex);
}

async function handleGetAccounts() {
  if (!(await hasDataConsent())) return { accounts: [] };
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) return { accounts: [] };
  const accounts = await NtcAuth.detectGoogleAccounts();
  return { accounts };
}

async function handleSetAccount(message) {
  const index = message.index;
  if (!Number.isInteger(index) || index < 0 || index > 4) {
    console.error('[NTC-BG] SET_ACCOUNT : index invalide');
    return { error: 'INVALID_ACCOUNT_INDEX' };
  }
  _activeAuthuserIndex = index;
  _authuserLoaded = true;
  await browser.storage.local.set({ [STORAGE_KEYS.ACTIVE_AUTHUSER]: index });
  return { ok: true };
}

// ─────────────────────────────────────────────
// HANDLERS — PIPELINES D'IMPORT
// ─────────────────────────────────────────────

function getRichErrorDetail(err) {
  if (!err) return null;
  if (!NtcUtils.DEBUG) {
    // Ne pas renvoyer le code brut (ex: AUTH_EXPIRED) comme détail redondant en production
    if (err.code && err.message === err.code) return null;
    return err.message || null;
  }
  const debug = NtcRpc.getLastDebugInfo ? NtcRpc.getLastDebugInfo() : null;
  if (debug) {
    const rawSnippet = debug.rawText ? debug.rawText.slice(0, 150).replace(/\r?\n/g, '↵') : 'null';
    return `${err.message} | Chunks:${debug.chunksLength} | Err:${debug.error} | Raw:${rawSnippet}`;
  }
  return err.message;
}

async function handleStartCapture(message) {
  if (_captureInProgress) {
    notifyUI({
      status: 'error',
      code: 'UNKNOWN',
      detail: browser.i18n.getMessage('errorPdfCaptureInProgress') || 'Capture already in progress',
    });
    return;
  }
  if (!message.notebookId || typeof message.notebookId !== 'string') {
    notifyUI({ status: 'error', code: 'UNKNOWN', detail: browser.i18n.getMessage('errNoNotebook') || 'No notebook selected' });
    return;
  }

  _captureInProgress = true;
  cancelPurge();
  // Purger tout buffer d'une capture précédente dès le démarrage
  _lastCapturePdfB64 = null;
  _lastCaptureMdText = null;
  _lastCaptureTitle = null;

  try {
    notifyUI({ status: 'capturing' });

    let authCtx;
    try {
      authCtx = await ensureAuthenticated();
    } catch (authErr) {
      notifyUI({ status: 'error', code: authErr.code || 'UNKNOWN', detail: getRichErrorDetail(authErr) });
      return;
    }

    try {
      switch (message.format) {
        case 'pdf':
          await handlePdfCapture(message, authCtx);
          break;
        case 'md':
          await handleMdCapture(message, authCtx);
          break;
        case 'attachment':
          await handleAttachmentCapture(message, authCtx);
          break;
        default:
          notifyUI({ status: 'error', code: 'UNKNOWN' });
      }
    } catch (err) {
      console.error('[NTC] Erreur pipeline capture :', err.code || err.message);
      if (err.code === 'AUTH_EXPIRED') {
        await clearAuthSession();
      }
      notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: getRichErrorDetail(err) });
    }
  } finally {
    _captureInProgress = false;
    if (_lastCapturePdfB64 || _lastCaptureMdText) {
      schedulePurge();
    }
  }
}

// ── Pipeline PDF ──────────────────────────────
async function handlePdfCapture(message, authCtx) {
  if (_pendingPdfCapture) {
    notifyUI({
      status: 'error',
      code: 'INJECTION_FAILED',
      detail: browser.i18n.getMessage('errorPdfCaptureInProgress') || 'Capture already in progress',
    });
    return;
  }
  notifyUI({ status: 'capturing', statusKey: 'statusCapturing' });

  let tab;
  let header;
  try {
    const active = await getActiveMessageTabAndHeader();
    tab = active.tab;
    header = active.header;
  } catch (err) {
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: err.message });
    return;
  }

  // Si un messageId précis a été figé à l'ouverture de la popup, vérifier qu'il est toujours affiché
  if (Number.isInteger(message.messageId) && header.id !== message.messageId) {
    notifyUI({ status: 'error', code: 'NO_EMAIL_DISPLAYED' });
    return;
  }

  async function pingBridge() {
    return browser.tabs.sendMessage(tab.id, { action: 'PING_BRIDGE' });
  }

  let checkResult = null;
  try {
    checkResult = await pingBridge();
  } catch (_pingErr) {
    NtcUtils.log('Bridge absent dans l\'onglet', tab.id, '— injection one-shot');
    try {
      await injectMessageScripts(tab.id);
      checkResult = await pingBridge();
    } catch (injectErr) {
      console.error('[NTC-BG] Injection à la demande échouée :', injectErr.message);
      notifyUI({ status: 'error', code: 'INJECTION_FAILED', detail: injectErr.message });
      return;
    }
  }

  if (!checkResult || !checkResult.pdfReady) {
    notifyUI({ status: 'error', code: 'INJECTION_FAILED', detail: 'pdfReady false' });
    return;
  }

  const captureId = crypto.randomUUID();
  let captureResult;
  try {
    captureResult = await new Promise((resolve, reject) => {
      _pendingPdfCapture = { resolve, reject, captureId, tabId: tab.id };

      try {
        browser.tabs.sendMessage(tab.id, {
          action: 'CAPTURE_EMAIL_PDF',
          captureId,
          grounding: buildGrounding(header),
          intentNote: message.intentNote,
          labels: {
            pdfLabelIntention: browser.i18n.getMessage('pdfLabelIntention'),
            pdfLabelEmail: browser.i18n.getMessage('pdfLabelEmail'),
            pdfLabelSubject: browser.i18n.getMessage('pdfLabelSubject'),
            pdfLabelFrom: browser.i18n.getMessage('pdfLabelFrom'),
            pdfLabelTo: browser.i18n.getMessage('pdfLabelTo'),
            pdfLabelDate: browser.i18n.getMessage('pdfLabelDate'),
          },
        }).catch((err) => {
          _pendingPdfCapture = null;
          clearTimeout(_pdfTimeoutId);
          _pdfTimeoutId = null;
          reject(err);
        });
      } catch (syncErr) {
        _pendingPdfCapture = null;
        clearTimeout(_pdfTimeoutId);
        _pdfTimeoutId = null;
        reject(syncErr);
        return;
      }

      _pdfTimeoutId = setTimeout(() => {
        _pdfTimeoutId = null;
        if (_pendingPdfCapture && _pendingPdfCapture.captureId === captureId) {
          _pendingPdfCapture = null;
          reject(NtcUtils.ntcError('TIMEOUT', 'TIMEOUT'));
        }
      }, 30000);
    });
  } catch (err) {
    console.error('[NTC-BG] Échec génération PDF :', err.code || err.message);
    const mappedCode = err.code || 'INJECTION_FAILED';
    notifyUI({ status: 'error', code: mappedCode, detail: getRichErrorDetail(err) });
    return;
  }

  notifyUI({ status: 'capturing', statusKey: 'statusUploading' });

  const pdfBlob = NtcUtils.base64ToBlob(captureResult.pdfBase64, 'application/pdf');
  if (pdfBlob.size > MAX_SIZE) {
    _lastCapturePdfB64 = null;
    throw NtcUtils.ntcError('ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TOO_LARGE');
  }

  _lastCaptureTitle = captureResult.title || 'email';
  const filename = `${NtcUtils.sanitizeFilename(captureResult.title || 'email')}.pdf`;

  await NtcRpc.uploadFileSource(
    authCtx.csrfToken,
    pdfBlob,
    filename,
    message.notebookId,
    authCtx.authuserIndex,
    'application/pdf'
  );

  await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

  notifyUI({
    status: 'success',
    notebookId: message.notebookId,
    authuserIndex: authCtx.authuserIndex,
    showDownload: true,
    hasNonLatinGlyphs: Boolean(captureResult.hasNonLatinGlyphs),
  });
}

// ── Pipeline Markdown ─────────────────────────
async function handleMdCapture(message, authCtx) {
  notifyUI({ status: 'capturing', statusKey: 'statusCapturing' });

  let header;
  if (Number.isInteger(message.messageId)) {
    try {
      header = await messenger.messages.get(message.messageId);
    } catch (_e) {
      header = null;
    }
  }
  if (!header) {
    const active = await getActiveMessageTabAndHeader();
    header = active.header;
  }

  const fullMessage = await messenger.messages.getFull(header.id);
  const body = extractEmailBodyFromFull(fullMessage);
  const grounding = buildGrounding(header);

  let convertedBody = '';
  if (body.html && body.html.trim()) {
    convertedBody = NtcUtils.htmlToMarkdown(body.html);
  }
  if (!convertedBody.trim() && body.text && body.text.trim()) {
    convertedBody = body.text.trim();
  }

  if (!convertedBody.trim()) {
    throw NtcUtils.ntcError('EMPTY_EMAIL_BODY', 'EMPTY_EMAIL_BODY');
  }

  const wordCount = convertedBody.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORDS) {
    throw NtcUtils.ntcError('WORD_LIMIT_EXCEEDED', 'WORD_LIMIT_EXCEEDED');
  }

  const labelIntention = browser.i18n.getMessage('mdLabelIntention') || 'Intention de recherche';
  const labelEmail = browser.i18n.getMessage('mdLabelEmail') || 'Email';
  const labelFrom = browser.i18n.getMessage('mdLabelFrom') || 'De';
  const labelSubject = browser.i18n.getMessage('mdLabelSubject') || 'Objet';
  const labelDate = browser.i18n.getMessage('mdLabelDate') || 'Date';

  const uiLang = browser.i18n.getUILanguage() || 'en';
  const isFr = uiLang.toLowerCase().startsWith('fr');
  const colon = isFr ? ' :' : ':';

  const mdLines = [];
  if (message.intentNote) {
    mdLines.push(`> **${labelIntention}${colon}** ${message.intentNote}`);
    mdLines.push('');
  }

  const dateStr = grounding.date
    ? new Date(grounding.date).toLocaleString()
    : (browser.i18n.getMessage('labelDateUnknown') || '-');
  mdLines.push(`> **${labelEmail}** | **${labelFrom}${colon}** ${grounding.from} | **${labelSubject}${colon}** ${grounding.subject} | **${labelDate}${colon}** ${dateStr}`);
  mdLines.push('');
  mdLines.push('---');
  mdLines.push('');
  mdLines.push(convertedBody);

  const mdText = mdLines.join('\n').replace(/\r\n/g, '\n');
  const mdByteLength = new TextEncoder().encode(mdText).byteLength;
  if (mdByteLength > MAX_SIZE) {
    throw NtcUtils.ntcError('ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TOO_LARGE');
  }

  _lastCaptureMdText = mdText;
  _lastCaptureTitle = grounding.subject || 'email';

  const filename = `${NtcUtils.sanitizeFilename(grounding.subject || 'email')}.md`;

  notifyUI({ status: 'capturing', statusKey: 'statusUploading' });
  await NtcRpc.addTextSource(
    authCtx.csrfToken,
    mdText,
    filename,
    message.notebookId,
    authCtx.authuserIndex
  );

  await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });

  notifyUI({
    status: 'success',
    notebookId: message.notebookId,
    authuserIndex: authCtx.authuserIndex,
    showDownload: true,
  });
}

// ── Pipeline Pièces Jointes (Séquentiel strict) ──
async function handleAttachmentCapture(message, authCtx) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const total = attachments.length;
  if (total === 0) {
    notifyUI({
      status: 'error',
      code: 'UNKNOWN',
      detail: browser.i18n.getMessage('errorNoAttachmentSelected') || 'No attachment selected',
    });
    return;
  }

  const errors = [];
  let successCount = 0;

  for (let i = 0; i < total; i++) {
    const att = attachments[i];
    notifyUI({
      status: 'info',
      batchProgress: { current: i + 1, total },
    });

    try {
      const fileBlob = await messenger.messages.getAttachmentFile(message.messageId, att.partName);

      if (!fileBlob || fileBlob.size === 0) {
        errors.push({
          name: att.name || `attachment-${i + 1}`,
          error: browser.i18n.getMessage('errorEmptyAttachment') || 'Empty file',
        });
        continue;
      }

      if (fileBlob.size > MAX_SIZE) {
        errors.push({
          name: att.name || `attachment-${i + 1}`,
          error: browser.i18n.getMessage('errorAttachmentTooLarge') || 'Exceeds 200 MB',
        });
        continue;
      }

      const cleanName = (att.name || 'attachment').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const filename = NtcUtils.sanitizeFilename(`[PJ] ${cleanName}`);

      await NtcRpc.uploadFileSource(
        authCtx.csrfToken,
        fileBlob,
        filename,
        message.notebookId,
        authCtx.authuserIndex,
        att.contentType
      );
      successCount++;
    } catch (err) {
      NtcUtils.log('Échec import PJ index', i, 'code:', err.code || err.message);
      // Si la session Google a expiré, interrompre immédiatement le lot séquentiel
      if (err.code === 'AUTH_EXPIRED') {
        await clearAuthSession();
        notifyUI({
          status: 'error',
          code: 'AUTH_EXPIRED',
          detail: getRichErrorDetail(err),
        });
        return;
      }
      errors.push({
        name: att.name || `attachment-${i + 1}`,
        error: getRichErrorDetail(err),
      });
    }
  }

  if (successCount > 0) {
    await browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: message.notebookId });
  }

  if (errors.length === 0) {
    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      authuserIndex: authCtx.authuserIndex,
      showDownload: false,
    });
  } else if (errors.length === total) {
    const details = errors.map(e => `${e.name} (${e.error})`).join(', ');
    notifyUI({
      status: 'error',
      code: 'UNKNOWN',
      detail: browser.i18n.getMessage('errorAllAttachmentsFailed', [details]) || details,
    });
  } else {
    notifyUI({
      status: 'success',
      notebookId: message.notebookId,
      authuserIndex: authCtx.authuserIndex,
      showDownload: false,
      warnings: errors.map(e => e.name),
    });
  }
}

// ─────────────────────────────────────────────
// HANDLERS — PDF_READY / CAPTURE_ERROR
// ─────────────────────────────────────────────

function handlePdfReady(message, senderTabId) {
  if (
    _pendingPdfCapture &&
    _pendingPdfCapture.captureId === message.captureId &&
    _pendingPdfCapture.tabId === senderTabId
  ) {
    clearTimeout(_pdfTimeoutId);
    _pdfTimeoutId = null;
    _lastCapturePdfB64 = message.pdfBase64;
    const pending = _pendingPdfCapture;
    _pendingPdfCapture = null;
    pending.resolve({
      pdfBase64: message.pdfBase64,
      hasNonLatinGlyphs: Boolean(message.hasNonLatinGlyphs),
      title: message.title,
    });
  } else {
    NtcUtils.log('PDF_READY ignoré : captureId expiré ou onglet non concordant');
  }
}

function handleCaptureError(message, senderTabId) {
  if (
    _pendingPdfCapture &&
    _pendingPdfCapture.captureId === message.captureId &&
    _pendingPdfCapture.tabId === senderTabId
  ) {
    clearTimeout(_pdfTimeoutId);
    _pdfTimeoutId = null;
    const pending = _pendingPdfCapture;
    _pendingPdfCapture = null;
    const err = NtcUtils.ntcError(
      message.code || 'UNKNOWN',
      message.detail || browser.i18n.getMessage('errorCaptureFailed') || 'Capture failed'
    );
    pending.reject(err);
  } else {
    // Capture déjà résolue ou expirée : ignorer silencieusement sans écraser l'UI courante
    NtcUtils.log('CAPTURE_ERROR ignorée : captureId expiré');
  }
}

// ─────────────────────────────────────────────
// HANDLERS — TÉLÉCHARGEMENT LOCAL
// ─────────────────────────────────────────────

function revokeDownloadUrl(downloadId) {
  const url = _activeDownloadUrls.get(downloadId);
  if (url) {
    URL.revokeObjectURL(url);
    _activeDownloadUrls.delete(downloadId);
  }
}

// Listener top-level synchrone MV3 pour révoquer proprement les URLs blob:
browser.downloads.onChanged.addListener((delta) => {
  if (!delta || !_activeDownloadUrls.has(delta.id) || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    revokeDownloadUrl(delta.id);
  }
});

async function handleDownloadCapture(message) {
  const baseTitle = NtcUtils.sanitizeFilename(_lastCaptureTitle || 'email');

  let blob = null;
  let ext = null;
  if (message.fileType === 'pdf' && _lastCapturePdfB64) {
    blob = NtcUtils.base64ToBlob(_lastCapturePdfB64, 'application/pdf');
    ext = 'pdf';
  } else if (message.fileType === 'md' && _lastCaptureMdText) {
    blob = new Blob([_lastCaptureMdText], { type: 'text/markdown;charset=utf-8' });
    ext = 'md';
  }
  if (!blob) return { ok: false };

  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: `${baseTitle}.${ext}`,
    });
    _activeDownloadUrls.set(downloadId, url);

    // Vérification immédiate post-download (évite la course si un petit .md finit instantanément)
    const items = await browser.downloads.search({ id: downloadId }).catch(() => []);
    if (items[0] && (items[0].state === 'complete' || items[0].state === 'interrupted')) {
      revokeDownloadUrl(downloadId);
    } else {
      // Garde-fou de révocation à 5 minutes
      setTimeout(() => revokeDownloadUrl(downloadId), 300000);
    }
    return { ok: true };
  } catch (err) {
    URL.revokeObjectURL(url);
    console.error('[NTC] Téléchargement échoué :', err.message);
    return { ok: false };
  }
}

// ─────────────────────────────────────────────
// ROUTEUR PRINCIPAL (CLOISONNEMENT STRICT)
// ─────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender) => {
  // Rejeter tout message hors extension ou mal formé
  if (!sender || sender.id !== browser.runtime.id || !message || typeof message !== 'object') {
    return false;
  }

  // KeepAlive de la popup (maintient l'Event Page MV3 éveillée pendant l'upload et sur l'écran de succès)
  if (message.action === 'PING') {
    return Promise.resolve({ ok: true });
  }

  // Messages émanant exclusivement d'un onglet email (MessageDisplayScript)
  if (message.action === 'PDF_READY') {
    if (sender.tab && typeof sender.tab.id === 'number') {
      handlePdfReady(message, sender.tab.id);
    }
    return false;
  }
  if (message.action === 'CAPTURE_ERROR') {
    if (sender.tab && typeof sender.tab.id === 'number') {
      handleCaptureError(message, sender.tab.id);
    }
    return false;
  }

  // Toutes les actions de pilotage ci-dessous sont strictement réservées à la popup (sans sender.tab)
  if (sender.tab) {
    return false;
  }

  switch (message.action) {
    case 'GET_AUTH_STATUS':
      return handleGetAuthStatus();
    case 'CONNECT_AUTH':
      return handleConnectAuth(message);
    case 'DISCONNECT_AUTH':
      return handleDisconnectAuth();
    case 'GET_ACTIVE_EMAIL_META':
      return handleGetActiveEmailMeta();
    case 'GET_NOTEBOOKS':
      return handleGetNotebooks();
    case 'CREATE_NOTEBOOK':
      return handleCreateNotebook(message);
    case 'GET_ACCOUNTS':
      return handleGetAccounts();
    case 'SET_ACCOUNT':
      return handleSetAccount(message);
    case 'START_CAPTURE':
      handleStartCapture(message).catch((err) => {
        console.error('[NTC] Erreur non interceptée dans START_CAPTURE :', err.message);
      });
      return Promise.resolve({ started: true });
    case 'DOWNLOAD_CAPTURE':
      return handleDownloadCapture(message);
    case 'PURGE_CAPTURE':
      purgeCaptureBuffers();
      return Promise.resolve({ ok: true });
    default:
      return false;
  }
});
