// background.js — Routeur central (Thunderbird MV2 — Background persistant)
// NotebookLM Clipper for Thunderbird
//
// Responsabilités :
//   - Enregistrement du MessageDisplayScript email_bridge.js au démarrage
//   - Routage des messages popup ↔ background (handler switch)
//   - Orchestration des 3 pipelines d'import (PDF, MD, Attachment)
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
// _sessionId (FdrFJe) : supprimé au sprint 2 (v1.0.5) — jamais consommé
let _lastCapturePdfB64 = null;  // Dernier PDF généré (pour téléchargement local)
let _lastCaptureMdText = null;  // Dernier MD généré (pour téléchargement local)
let _lastCaptureTitle = null;   // Sujet brut du dernier email capturé (nom de téléchargement)
let _pendingPdfResolve = null;  // Résolution Promise en attente de PDF_READY
let _pendingPdfReject = null;   // Rejet Promise en attente de CAPTURE_ERROR
let _captureInProgress = false; // Verrou global : une seule capture à la fois (P1.1a)

// Clés de storage : source unique dans NtcUtils (revue 2026-06-10)
const STORAGE_KEYS = NtcUtils.STORAGE_KEYS;

function clearAuthSession() {
  _csrfToken = null;
  try {
    NtcAuth.stopCookieRotationSchedule();
  } catch (_e) {}
}

// ─────────────────────────────────────────────
// ENREGISTREMENT DU MESSAGE DISPLAY SCRIPT
// ─────────────────────────────────────────────

// Fichiers du bridge PDF — ordre d'injection STRICT (AGENTS.md §4.5)
const MESSAGE_SCRIPTS = [
  'lib/jspdf.umd.min.js',
  'src/content/email_pdf_generator.js',
  'src/content/email_bridge.js'
];

/**
 * Injection one-shot du bridge dans un onglet message (hotfix recettage R9.3).
 *
 * ⚠️ Les scripts ENREGISTRÉS (registerScripts/messageDisplayScripts) ne
 * s'appliquent qu'aux messages affichés APRÈS l'enregistrement (doc officielle
 * scripting.messageDisplay). Un onglet/fenêtre message déjà ouvert ou restauré
 * au démarrage n'a donc PAS le bridge → injection manuelle requise.
 * `scripting.executeScript` : TB 102+, permissions scripting + messagesRead
 * (déjà déclarées) — messagesModify inutile.
 *
 * Les sentinelles (__ntc_email_bridge) rendent la ré-injection inoffensive.
 *
 * @param {number} tabId
 */
async function injectMessageScripts(tabId) {
  await messenger.scripting.executeScript({
    target: { tabId },
    files: MESSAGE_SCRIPTS,
  });
}

(async () => {
  // Enregistrement du MessageDisplayScript — API TB 128+ (messenger.scripting.messageDisplay)
  try {
    if (messenger.scripting &&
      messenger.scripting.messageDisplay &&
      typeof messenger.scripting.messageDisplay.registerScripts === 'function') {
      // TB 128+ — API moderne
      await messenger.scripting.messageDisplay.registerScripts([{
        id: 'ntc-email-scripts',
        js: MESSAGE_SCRIPTS,
        runAt: 'document_idle',
      }]);
      NtcUtils.log('Scripts enregistrés via scripting.messageDisplay \u2713');
    } else if (messenger.messageDisplayScripts &&
      typeof messenger.messageDisplayScripts.register === 'function') {
      // TB 115-127 — API legacy (requiert messagesModify, non déclarée :
      // peut échouer — le fallback d'injection à la demande prend le relais)
      await messenger.messageDisplayScripts.register({
        js: MESSAGE_SCRIPTS.map(file => ({ file }))
      });
      NtcUtils.log('Scripts enregistrés via messageDisplayScripts (legacy) \u2713');
    } else {
      console.error('[NTC] Aucune API d\'enregistrement de messageDisplayScript disponible');
    }
  } catch (_e) {
    console.error('[NTC] Impossible d\'enregistrer les messageDisplayScripts :', _e.message);
  }

  // Rattrapage au démarrage (hotfix R9.3) : les onglets/fenêtres message DÉJÀ
  // ouverts (ex. restaurés) n'ont pas reçu les scripts enregistrés — les
  // scripts enregistrés ne s'appliquent qu'aux messages affichés APRÈS
  // l'enregistrement (pattern officiel doc scripting.messageDisplay).
  try {
    const openTabs = await messenger.tabs.query({});
    for (const tab of openTabs) {
      if (!['mail', 'messageDisplay'].includes(tab.type)) continue;
      try {
        if (tab.type === 'mail') {
          // Un onglet 3-pane peut afficher 0 ou plusieurs messages
          const displayed = await messenger.messageDisplay.getDisplayedMessage(tab.id);
          if (!displayed) continue;
        }
        await injectMessageScripts(tab.id);
        NtcUtils.log('Rattrapage bridge → onglet', tab.id, `(${tab.type})`);
      } catch (_tabErr) {
        // Onglet sans document de message accessible — ignorer
      }
    }
  } catch (err) {
    console.error('[NTC] Rattrapage des onglets message échoué :', err.message);
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
      NtcUtils.log('Rotation des cookies démarrée au lancement (déjà authentifié) ✓');
    }
  } catch (err) {
    console.error('[NTC] Erreur initialisation auth au lancement :', err.message);
  }

  NtcUtils.log('background.js initialisé ✓');
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
 * Récupère l'onglet actif affichant un message et l'en-tête de ce message.
 *
 * Sprint 3 (v1.0.6) : utilise `messenger.tabs.query()` (et plus
 * `mailTabs.query()`, qui ne retourne QUE les onglets 3-pane — un email
 * ouvert dans son propre onglet ou sa propre fenêtre déclenchait un faux
 * NO_EMAIL_DISPLAYED, constat terrain 2026-06-11).
 * `messageDisplay.getDisplayedMessage(tabId)` couvre les trois contextes :
 * onglet 3-pane, onglet message, fenêtre message autonome.
 *
 * @returns {Promise<{ tab: object, header: object }>}
 * @throws  {Error} code NO_EMAIL_DISPLAYED si l'onglet actif n'affiche pas d'email.
 */
async function getActiveMessageTabAndHeader() {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    const err = new Error('NO_EMAIL_DISPLAYED');
    err.code = 'NO_EMAIL_DISPLAYED';
    throw err;
  }

  const header = await messenger.messageDisplay.getDisplayedMessage(tab.id);
  if (!header) {
    const err = new Error('NO_EMAIL_DISPLAYED');
    err.code = 'NO_EMAIL_DISPLAYED';
    throw err;
  }

  return { tab, header };
}

/**
 * Construit l'objet grounding depuis l'en-tête du message.
 *
 * @param  {object} header - Retour de getDisplayedMessage().
 * @returns {{ subject: string, from: string, to: string, date: string }}
 */
function extractDomain(author) {
  // Format « Nom <a@b.com> » puis fallback « a@b.com » nu (revue 2026-06-10)
  const src = author ?? '';
  const match = src.match(/<[^@>\s]+@([^>\s]+)>/) || src.match(/[^@\s<,;]+@([^\s>,;]+)/);
  return match ? match[1] : '';
}

function buildGrounding(header) {
  const subject = header.subject || '(no subject)';
  const from = header.author || '(unknown)';
  const to = (header.recipients || []).join(', ') || '(unknown)';
  // null si absente — les consommateurs affichent un libellé i18n.
  // Jamais de chaîne sentinelle type '(unknown)' → "Invalid Date" (revue 2026-06-10).
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
 * Filtre les pièces jointes supportées par NotebookLM (par MIME type et taille).
 *
 * Revue 2026-06-10 — plus de filtrage silencieux :
 *   - PJ > 200 MB → retournée avec { tooLarge: true } (affichée grisée)
 *   - PJ sans extension ni MIME reconnu (< 10 MB) → { unknownType: true,
 *     contentType: 'text/plain' } (décochée par défaut, opt-in explicite)
 *   - Format non supporté → masquée
 *
 * @param  {Array} attachments - Retour de messenger.messages.listAttachments().
 * @returns {Array} - PJ avec { name, partName, contentType, size, tooLarge?, unknownType? }.
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
    // 'video/quicktime' (.mov) — ajouté en revue 2026-06-10 ;
    // 'video/mov' retiré (type MIME inexistant)
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi', 'video/x-flv',
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
    // 1. Résoudre le MIME d'abord (audit 2026-06-10) : une PJ d'un format
    //    non supporté reste masquée même si elle est aussi trop volumineuse.
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
        // Pas d'extension ni MIME reconnu : proposé explicitement à
        // l'utilisateur (décoché par défaut) — import en text/plain
        // uniquement sur opt-in (revue 2026-06-10).
        mime = 'text/plain';
        unknownType = true;
      }
    }

    // 2. Format non supporté → masquée
    if (!SUPPORTED_MIME.has(mime)) continue;

    // 3. PJ trop volumineuse : affichée grisée, jamais importable
    if (att.size && att.size > MAX_SIZE) {
      NtcUtils.log('PJ trop grande (> 200 MB) :', att.name);
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

    // Sprint 2 (v1.0.5) : auth_ready UNIQUEMENT si le token CSRF est
    // récupérable (compte avec accès NotebookLM effectif). Sinon, erreur
    // immédiate — plus de faux état "prêt" qui n'échouerait qu'à la
    // première capture (AGENTS.md §10).
    try {
      const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
      _csrfToken = tokens.csrfToken;
    } catch (e) {
      console.error('[NTC] fetchCSRFTokens après auth :', e.message);
      notifyUI({ status: 'error', code: e.code === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : 'UNKNOWN', detail: e.message });
      return;
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
  const { header } = await getActiveMessageTabAndHeader();
  const grounding = buildGrounding(header);

  const fullMessage = await messenger.messages.getFull(header.id);
  const body = extractEmailBody(fullMessage.parts);

  if (!body.text && !body.html) {
    const err = new Error('EMPTY_EMAIL_BODY');
    err.code = 'EMPTY_EMAIL_BODY';
    throw err;
  }

  const rawAttachments = await messenger.messages.listAttachments(header.id);
  const attachments = filterSupportedAttachments(rawAttachments);

  return {
    ...grounding,
    attachments,
    hasPdf: true,  // Email → PDF toujours disponible
    hasMd: true,  // Email → MD toujours disponible
    messageId: header.id,
  };
}

// ─────────────────────────────────────────────
// HANDLERS — CARNETS
// ─────────────────────────────────────────────

async function handleGetNotebooks() {
  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  NtcUtils.log('handleGetNotebooks — cookies valides?', valid, 'nb cookies:', Object.keys(cookieMap).join(', '));
  if (!valid) { const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e; }

  // fetchCSRFTokens lève AUTH_EXPIRED si le token est introuvable (revue 2026-06-10).
  // Plus d'entrées diagnostic __diag__ en production : les erreurs remontent
  // à la popup qui affiche le bon message (mode DEBUG : diag gérés par NtcRpc).
  const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
  _csrfToken = tokens.csrfToken;
  NtcUtils.log('fetchCSRFTokens — csrfToken présent?', !!_csrfToken);

  const result = await NtcRpc.listNotebooks(_csrfToken, _activeAuthuserIndex);
  NtcUtils.log('listNotebooks résultat :', result.notebooks.length, 'carnets');
  return result;
}

async function handleCreateNotebook(message) {
  // Sprint 2 (v1.0.5) : garde sur le titre — trimé, non vide, ≤ 100 caractères.
  // (L'UI désactive déjà le bouton sur titre vide — défense en profondeur.)
  const title = (message.title || '').trim();
  if (!title || title.length > 100) {
    const e = new Error('INVALID_TITLE'); e.code = 'INVALID_TITLE'; throw e;
  }

  const cookieMap = await NtcAuth.collectGoogleCookies();
  const { valid } = NtcAuth.validateCookies(cookieMap);
  if (!valid) { const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e; }

  const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
  _csrfToken = tokens.csrfToken;

  return NtcRpc.createNotebook(_csrfToken, title, _activeAuthuserIndex);
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
 * Récupère un message d'erreur détaillé contenant des informations RPC de debug.
 * Mode DEBUG uniquement (revue 2026-06-10) : en production, le détail enrichi
 * exposerait des fragments de réponses RPC brutes dans l'UI.
 *
 * @param {Error} err - L'erreur interceptée.
 * @returns {string} Le détail d'erreur (enrichi en DEBUG, sobre sinon).
 */
function getRichErrorDetail(err) {
  if (!NtcUtils.DEBUG) return err.message;
  const debug = NtcRpc.getLastDebugInfo ? NtcRpc.getLastDebugInfo() : null;
  if (debug) {
    const rawSnippet = debug.rawText ? debug.rawText.slice(0, 150).replace(/\r?\n/g, '↵') : 'null';
    return `${err.message} | Chunks:${debug.chunksLength} | Err:${debug.error} | Raw:${rawSnippet}`;
  }
  return err.message;
}

async function handleStartCapture(message) {
  // P1.1a — Verrou global : une seule capture à la fois (PDF, MD, Attachment)
  if (_captureInProgress) {
    notifyUI({ status: 'error', code: 'UNKNOWN', detail: browser.i18n.getMessage('errorPdfCaptureInProgress') || 'A capture is already in progress' });
    return;
  }
  _captureInProgress = true;

  try {
    notifyUI({ status: 'capturing' });

    const cookieMap = await NtcAuth.collectGoogleCookies();
    const { valid } = NtcAuth.validateCookies(cookieMap);
    if (!valid) {
      clearAuthSession();
      notifyUI({ status: 'error', code: 'AUTH_EXPIRED' });
      return;
    }

    try {
      const tokens = await NtcAuth.fetchCSRFTokens(_activeAuthuserIndex);
      _csrfToken = tokens.csrfToken;
    } catch (e) {
      if (e.code === 'AUTH_EXPIRED') {
        clearAuthSession();
      }
      notifyUI({ status: 'error', code: e.code || 'UNKNOWN', detail: getRichErrorDetail(e) });
      return;
    }

    // Délégation aux sous-handlers selon le format demandé
    try {
      switch (message.format) {
        case 'pdf': await handlePdfCapture(message); break;
        case 'md': await handleMdCapture(message); break;
        case 'attachment': await handleAttachmentCapture(message); break;
        default:
          notifyUI({ status: 'error', code: 'UNKNOWN' });
      }
    } catch (e) {
      console.error('[NTC] Capture error :', e.message);
      if (e.code === 'AUTH_EXPIRED') {
        clearAuthSession();
      }
      notifyUI({ status: 'error', code: e.code || 'UNKNOWN', detail: getRichErrorDetail(e) });
    }
  } finally {
    _captureInProgress = false;
  }
}

// ── Pipeline PDF (Phase 3) ──────────────────
async function handlePdfCapture(message) {
  if (_pendingPdfResolve) {
    const err = new Error('Une capture PDF est déjà en cours.');
    err.code = 'INJECTION_FAILED';
    notifyUI({ status: 'error', code: err.code, detail: err.message });
    return;
  }
  notifyUI({ status: 'capturing', statusKey: 'statusCapturing' });

  let tab, header;
  try {
    const active = await getActiveMessageTabAndHeader();
    tab = active.tab;
    header = active.header;
  } catch (err) {
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: err.message });
    return;
  }
  // 1. Vérifier que le bridge est joignable — avec FALLBACK d'injection à la
  //    demande (hotfix R9.3) : les scripts pré-enregistrés ne couvrent que les
  //    messages affichés APRÈS l'enregistrement ; un onglet message déjà
  //    ouvert/restauré n'a pas le bridge → on l'injecte puis on re-ping.
  NtcUtils.log('Capture PDF en cours, vérification du bridge...');

  async function pingBridge() {
    return browser.tabs.sendMessage(tab.id, { action: 'PING_BRIDGE' });
  }

  let checkResult = null;
  try {
    checkResult = await pingBridge();
  } catch (_pingErr) {
    // Bridge absent (« Receiving end does not exist ») → injection à la demande
    NtcUtils.log('Bridge absent dans l\'onglet', tab.id, '— injection à la demande');
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
    console.error('[NTC-BG] Générateur PDF inaccessible après injection. Réponse:', JSON.stringify(checkResult));
    notifyUI({ status: 'error', code: 'INJECTION_FAILED', detail: 'pdfReady false après injection' });
    return;
  }

  // 3. Lancer la capture via message
  let captureResult;
  try {
    captureResult = await new Promise((resolve, reject) => {
      _pendingPdfResolve = resolve;
      _pendingPdfReject = reject;

      browser.tabs.sendMessage(tab.id, {
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

    // Sujet brut mémorisé côté background pour le téléchargement local
    // (la popup n'envoie plus de titre tronqué — revue 2026-06-10)
    _lastCaptureTitle = captureResult.title || 'email';
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

    // P1.7 — Auto-purge des données de capture après 5 minutes
    setTimeout(() => {
      _lastCapturePdfB64 = null;
      _lastCaptureMdText = null;
      _lastCaptureTitle = null;
    }, 300000);
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
    const active = await getActiveMessageTabAndHeader();
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

    // grounding.date est null si absente (revue 2026-06-10) — libellé i18n
    const dateStr = grounding.date
      ? new Date(grounding.date).toLocaleString()
      : (browser.i18n.getMessage('labelDateUnknown') || '—');
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
    _lastCaptureTitle = grounding.subject || 'email';

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

    // P1.7 — Auto-purge des données de capture après 5 minutes
    setTimeout(() => {
      _lastCapturePdfB64 = null;
      _lastCaptureMdText = null;
      _lastCaptureTitle = null;
    }, 300000);
  } catch (err) {
    console.error('[NTC-BG] \u00c9chec de l\'import Markdown :', err.message);
    notifyUI({ status: 'error', code: err.code || 'UNKNOWN', detail: getRichErrorDetail(err) });
  }
}

// ── Pipeline URL — SUPPRIMÉ (revue 2026-06-10, backend jamais câblé côté UI) ──

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

      // P1.6 — Guard 0-byte files + null
      if (!fileBlob || fileBlob.size === 0) {
        errors.push({ name: att.name, error: 'Empty or inaccessible file' });
        continue;
      }
      // Remplacer le préfixe ⚡ par [PJ] et enlever les accents du nom de fichier
      let cleanName = (att.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const filename = NtcUtils.sanitizeFilename(`[PJ] ${cleanName}`);

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

    // P1.7 — Auto-purge des données de capture après 5 minutes
    setTimeout(() => {
      _lastCapturePdfB64 = null;
      _lastCaptureMdText = null;
      _lastCaptureTitle = null;
    }, 300000);
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

/**
 * Révoque l'object URL une fois le téléchargement terminé ou interrompu
 * (revue 2026-06-10 — le background MV2 est persistant : sans revoke, fuite mémoire).
 */
function revokeWhenDownloadDone(downloadId, url) {
  function onChanged(delta) {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      URL.revokeObjectURL(url);
      browser.downloads.onChanged.removeListener(onChanged);
    }
  }
  browser.downloads.onChanged.addListener(onChanged);
}

/**
 * Télécharge localement la dernière capture (PDF ou MD).
 * Le nom de fichier vient du sujet brut mémorisé à la capture
 * (_lastCaptureTitle), assaini — jamais du texte tronqué de la popup
 * (revue 2026-06-10).
 */
async function handleDownloadCapture(message) {
  const title = NtcUtils.sanitizeFilename(_lastCaptureTitle || 'email');

  let blob = null;
  let ext = null;
  if (message.fileType === 'pdf' && _lastCapturePdfB64) {
    const byteStr = atob(_lastCapturePdfB64.split(',')[1]);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    blob = new Blob([bytes], { type: 'application/pdf' });
    ext = 'pdf';
  } else if (message.fileType === 'md' && _lastCaptureMdText) {
    blob = new Blob([_lastCaptureMdText], { type: 'text/markdown' });
    ext = 'md';
  }
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await browser.downloads.download({ url, filename: `${title}.${ext}` });
    revokeWhenDownloadDone(downloadId, url);

    // P1.7 — Clear capture data after download to free memory
    if (message.fileType === 'pdf') _lastCapturePdfB64 = null;
    if (message.fileType === 'md') _lastCaptureMdText = null;
  } catch (err) {
    // Téléchargement refusé/annulé : révoquer immédiatement (audit 2026-06-10)
    URL.revokeObjectURL(url);
    console.error('[NTC] Téléchargement échoué :', err.message);
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