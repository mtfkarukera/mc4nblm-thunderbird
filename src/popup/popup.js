// popup.js — Logique UI de la popup Thunderbird MV2
// NotebookLM Clipper for Thunderbird
//
// Dépend de utils.js chargé avant lui (expose var NtcUtils → t())
// Utilise browser.runtime.sendMessage pour communiquer avec background.js

'use strict';

// Gestion des erreurs globales : assurée par pre_loader.js (écouteur 'error'
// en phase capture + window.__ntcRenderErrorScreen). Le doublon window.onerror
// a été supprimé en revue 2026-06-10.

// ─────────────────────────────────────────────
// ALIAS UTIL (avec fallback défensif)
// ─────────────────────────────────────────────

/** @type {Function} Alias vers NtcUtils.t() — fallback sur clé brute si NtcUtils absent */
const t = (typeof NtcUtils !== 'undefined' && NtcUtils && NtcUtils.t)
  ? (key, subs) => NtcUtils.t(key, subs)
  : (key) => {
    console.error('[NTC] NtcUtils non chargé — fallback pour clé :', key);
    return key;
  };

// ─────────────────────────────────────────────
// STATE DE LA POPUP
// ─────────────────────────────────────────────

let _currentNotebookId  = null;
let _currentMessageId   = null;
let _pingInterval       = null;
let _currentFormat      = null;  // 'pdf' | 'md' | 'attachment'

// Clés de storage : source unique dans NtcUtils (revue 2026-06-10)
const STORAGE_KEYS = (typeof NtcUtils !== 'undefined' && NtcUtils.STORAGE_KEYS) || {
  AUTH_READY: 'ntc_auth_ready',
  ACTIVE_AUTHUSER: 'ntc_active_authuser',
  LAST_NOTEBOOK: 'ntc_last_notebook_id',
};

// ─────────────────────────────────────────────
// GESTION DES ÉTATS
// ─────────────────────────────────────────────

/**
 * Affiche uniquement l'état demandé, masque tous les autres.
 *
 * @param {'authRequired'|'loading'|'ready'|'capturing'|'success'|'error'} name
 */
function showState(name) {
  const idMap = {
    authRequired : 'state-auth-required',
    loading      : 'state-loading',
    ready        : 'state-ready',
    capturing    : 'state-capturing',
    success      : 'state-success',
    error        : 'state-error',
  };

  for (const [key, id] of Object.entries(idMap)) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('hidden', key !== name);
    } else {
      console.warn('[NTC] État introuvable dans le DOM :', id);
    }
  }

  stopKeepAlive();
  if (name === 'capturing') startKeepAlive();
}

// ─────────────────────────────────────────────
// INTERNATIONALISATION
// ─────────────────────────────────────────────

/**
 * Applique les traductions via attributs data-i18n sur tout le DOM.
 * Doit être appelée une seule fois au chargement.
 */
function applyI18n() {
  // Contenu textuel
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  // Attribut placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  // Attribut title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
}

// ─────────────────────────────────────────────
// KEEPALIVE (maintien popup ouverte lors d'upload long)
// ─────────────────────────────────────────────

function startKeepAlive() {
  if (_pingInterval) return;
  _pingInterval = setInterval(() => {
    browser.runtime.sendMessage({ action: 'PING' }).catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (_pingInterval) {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }
}

// ─────────────────────────────────────────────
// MÉTADONNÉES EMAIL
// ─────────────────────────────────────────────

/**
 * Tronque une chaîne à maxLen caractères avec ellipse.
 */
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

/**
 * Charge les métadonnées de l'email actif depuis le background et
 * met à jour l'UI.
 */
async function loadEmailMeta() {
  showState('loading');
  let meta;
  try {
    meta = await browser.runtime.sendMessage({ action: 'GET_ACTIVE_EMAIL_META' });
  } catch (e) {
    const { code, detail } = classifyError(e);
    showError(code, detail);
    return;
  }

  if (meta && meta.error) { showError(meta.code || 'UNKNOWN', meta.detail || meta.message); return; }

  // Remplir les métadonnées
  const subEl = document.getElementById('meta-subject');
  if (subEl) subEl.textContent = truncate(meta.subject, 60);

  const fromEl = document.getElementById('meta-from');
  if (fromEl) fromEl.textContent = truncate(meta.from, 45);

  const dateEl = document.getElementById('meta-date');
  if (dateEl) {
    // meta.date est null si absente (revue 2026-06-10) — libellé i18n
    dateEl.textContent = meta.date
      ? new Date(meta.date).toLocaleString()
      : t('labelDateUnknown');
  }

  _currentMessageId = meta.messageId;

  // Section PJ
  renderAttachments(meta.attachments || []);

  // Charger les carnets — loadNotebooks retourne false si elle a basculé
  // l'UI vers un autre état (ex: authRequired sur AUTH_EXPIRED) :
  // ne pas écraser cet état avec 'ready' (audit release 2026-06-10).
  const notebooksOk = await loadNotebooks();
  if (notebooksOk === false) return;
  showState('ready');
}

// ─────────────────────────────────────────────
// PIÈCES JOINTES
// ─────────────────────────────────────────────

/**
 * Rend la liste des pièces jointes filtrées dans l'UI.
 *
 * @param {Array} attachments - Retour filtré du background.
 */
function renderAttachments(attachments) {
  const section = document.getElementById('attachments-section');
  const list    = document.getElementById('attachment-list');
  if (!section || !list) return;

  // Vider la liste (createElement — pas d'innerHTML)
  while (list.firstChild) list.removeChild(list.firstChild);

  if (attachments.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  attachments.forEach(att => {
    const li       = document.createElement('li');
    li.className   = 'attachment-item' + (att.tooLarge ? ' disabled' : '');

    const cb       = document.createElement('input');
    cb.type        = 'checkbox';
    cb.id          = `att-${att.partName}`;
    cb.dataset.partName    = att.partName;
    cb.dataset.name        = att.name;
    cb.dataset.contentType = att.contentType;
    // PJ > 200 MB : visible mais jamais importable (revue 2026-06-10)
    if (att.tooLarge) {
      cb.disabled = true;
      li.title    = t('errorAttachmentTooLarge');
    } else {
      cb.addEventListener('change', onAttachmentCheckboxChange);
    }

    const label    = document.createElement('label');
    label.htmlFor  = `att-${att.partName}`;
    label.className = 'attachment-name';
    label.textContent = att.name;

    const size     = document.createElement('span');
    size.className = 'attachment-size' + (att.tooLarge ? ' too-large' : '');
    if (att.size) {
      size.textContent = att.size > 1024 * 1024
        ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(att.size / 1024)} KB`;
    }

    li.appendChild(cb);
    li.appendChild(label);
    li.appendChild(size);

    // PJ sans type reconnu : décochée par défaut, import texte sur opt-in
    // explicite — badge informatif (revue 2026-06-10).
    if (att.unknownType && !att.tooLarge) {
      const flag = document.createElement('span');
      flag.className   = 'attachment-flag';
      flag.textContent = t('attachmentUnknownType');
      li.appendChild(flag);
    }

    list.appendChild(li);
  });
}

/**
 * Met à jour le bouton d'import PJ en fonction du nombre de cases cochées.
 */
function onAttachmentCheckboxChange() {
  const checked  = document.querySelectorAll('#attachment-list input[type="checkbox"]:checked');
  const btn      = document.getElementById('btn-import-attachments');
  const intentWr = document.getElementById('intent-wrapper');
  if (!btn || !intentWr) return;

  if (checked.length > 0) {
    btn.classList.remove('hidden');
    btn.disabled      = false;
    btn.textContent   = t('btnImportSelection', [String(checked.length)]);
    intentWr.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    btn.disabled = true;
    intentWr.classList.remove('hidden');
  }
}

// ─────────────────────────────────────────────
// CARNETS
// ─────────────────────────────────────────────

let _notebooks  = [];
let _searchTerm = '';

async function loadNotebooks() {
  const list = document.getElementById('notebook-list');
  if (!list) return;
  list.setAttribute('data-empty', t('loadingNotebooks'));

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ action: 'GET_NOTEBOOKS' });
  } catch (err) {
    const { code } = classifyError(err);
    // Session expirée → écran de reconnexion, pas un "aucun carnet trouvé"
    // trompeur (revue 2026-06-10, amélioration 11). Retourne false pour
    // que l'appelant n'écrase pas cet état avec 'ready'.
    if (code === 'AUTH_EXPIRED') {
      showState('authRequired');
      return false;
    }
    console.error('[NTC-UI] Échec du chargement des carnets :', err.message);
    list.setAttribute('data-empty', t(ERROR_KEYS[code] || 'errorUnknown'));
    return true;
  }

  _notebooks = (resp && resp.notebooks) ? resp.notebooks : [];

  // Tenter de restaurer le dernier carnet sélectionné
  const stored = await browser.storage.local.get(STORAGE_KEYS.LAST_NOTEBOOK);
  if (stored[STORAGE_KEYS.LAST_NOTEBOOK]) {
    _currentNotebookId = stored[STORAGE_KEYS.LAST_NOTEBOOK];
  }

  renderNotebooks(_notebooks);
  return true;
}

/**
 * Rend la liste filtrée des carnets.
 *
 * @param {Array} notebooks
 */
function renderNotebooks(notebooks) {
  const list    = document.getElementById('notebook-list');
  if (!list) return;
  const term    = _searchTerm.toLowerCase();
  const filtered = term
    ? notebooks.filter(nb => nb.title.toLowerCase().includes(term))
    : notebooks;

  while (list.firstChild) list.removeChild(list.firstChild);
  list.setAttribute('data-empty', t('noNotebookFound'));

  filtered.forEach(nb => {
    const li = document.createElement('li');
    // Entrées diagnostic (mode DEBUG) : affichées mais jamais sélectionnables
    // (revue 2026-06-10, bug 6 — défense en profondeur).
    const isDiag = nb.id === '__diag__';
    li.className  = 'notebook-item'
      + (isDiag ? ' diag' : '')
      + (!isDiag && nb.id === _currentNotebookId ? ' selected' : '');
    li.role       = 'option';
    li.dataset.id = nb.id;
    li.textContent = nb.title;
    li.setAttribute('aria-selected', !isDiag && nb.id === _currentNotebookId ? 'true' : 'false');
    if (isDiag) {
      li.setAttribute('aria-disabled', 'true');
    } else {
      li.addEventListener('click', () => selectNotebook(nb.id, nb.title, li));
    }
    list.appendChild(li);
  });
}

function selectNotebook(id, _title, liEl) {
  if (id === '__diag__') return;  // jamais sélectionnable (bug 6)
  _currentNotebookId = id;
  document.querySelectorAll('.notebook-item').forEach(el => {
    el.classList.toggle('selected', el === liEl);
    el.setAttribute('aria-selected', el === liEl ? 'true' : 'false');
  });
  browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: id });
}

// ─────────────────────────────────────────────
// ERREURS
// ─────────────────────────────────────────────

/** Mapping code d'erreur → clé i18n */
const ERROR_KEYS = {
  AUTH_EXPIRED             : 'errorAuthExpired',
  API_CHANGED              : 'errorApiChanged',
  UPLOAD_SESSION_MISSING   : 'errorUploadSessionMissing',
  TIMEOUT                  : 'errorTimeout',
  INJECTION_FAILED         : 'errorInjectionFailed',
  NO_EMAIL_DISPLAYED       : 'errorNoEmailDisplayed',
  EMPTY_EMAIL_BODY         : 'errorEmptyEmailBody',
  ATTACHMENT_TOO_LARGE     : 'errorAttachmentTooLarge',
  UNKNOWN                  : 'errorUnknown',
};

/**
 * Normalise une erreur reçue du background via runtime.sendMessage.
 *
 * ⚠️ Gecko ne sérialise QUE err.message lors d'un rejet de sendMessage —
 * les propriétés custom (err.code) sont perdues. Le background encode donc
 * le code d'erreur dans le message (ex: new Error('AUTH_EXPIRED')), et on
 * mappe ici par message (revue 2026-06-10, bug 1).
 *
 * @param {Error} e - Erreur intercptée côté popup.
 * @returns {{ code: string, detail: string|null }}
 */
function classifyError(e) {
  if (e && e.code && ERROR_KEYS[e.code]) {
    return { code: e.code, detail: e.detail || null };
  }
  if (e && e.message && ERROR_KEYS[e.message]) {
    return { code: e.message, detail: null };
  }
  return { code: 'UNKNOWN', detail: e ? e.message : null };
}

/**
 * Affiche l'état erreur avec le bon message et les boutons adaptés.
 *
 * @param {string} code - Code d'erreur normalisé.
 */
function showError(code, detail) {
  const key = ERROR_KEYS[code] || ERROR_KEYS.UNKNOWN;
  const errEl = document.getElementById('error-message');
  if (errEl) {
    let msg = t(key);
    if (detail) {
      msg += `\n(${detail})`;
    }
    errEl.textContent = msg;
  }

  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    btnReconnect.classList.toggle('hidden', code !== 'AUTH_EXPIRED');
  }

  showState('error');
}

// ─────────────────────────────────────────────
// SUCCÈS
// ─────────────────────────────────────────────

/**
 * Affiche l'état succès avec le lien carnet et les boutons optionnels.
 *
 * @param {object} payload - { notebookId, showDownload, fileType, warnings }
 */
function showSuccess(payload) {
  const btnOpen = document.getElementById('btn-open-notebook');
  if (btnOpen) {
    if (payload.notebookId) {
      browser.storage.local.get(STORAGE_KEYS.ACTIVE_AUTHUSER).then(stored => {
        const index = stored[STORAGE_KEYS.ACTIVE_AUTHUSER] !== undefined ? stored[STORAGE_KEYS.ACTIVE_AUTHUSER] : 0;
        btnOpen.href = NtcUtils.buildNotebookUrl(payload.notebookId, index);
      }).catch(() => {
        btnOpen.href = NtcUtils.buildNotebookUrl(payload.notebookId);
      });
      btnOpen.classList.remove('hidden');
    } else {
      btnOpen.classList.add('hidden');
    }
  }

  const btnDownload = document.getElementById('btn-download');
  if (btnDownload) {
    btnDownload.classList.toggle('hidden', !payload.showDownload);
    if (payload.showDownload) {
      btnDownload.dataset.fileType = payload.fileType || 'pdf';
    }
  }

  // Avertissements d'import partiel
  const warningsEl = document.getElementById('warnings-container');
  if (warningsEl) {
    warningsEl.classList.add('hidden');
    while (warningsEl.firstChild) warningsEl.removeChild(warningsEl.firstChild);

    if (payload.warnings && payload.warnings.length > 0) {
      const msg = document.createElement('p');
      msg.textContent = t('warningPartialImport', [String(payload.warnings.length)]);
      warningsEl.appendChild(msg);
      warningsEl.classList.remove('hidden');
    }
  }

  showState('success');
}

// ─────────────────────────────────────────────
// PROGRESSION BATCH PJ
// ─────────────────────────────────────────────

function updateBatchProgress(current, total) {
  const batchEl  = document.getElementById('batch-progress');
  const fill     = document.getElementById('progress-bar-fill');
  const label    = document.getElementById('batch-progress-label');
  if (!batchEl || !fill || !label) return;

  batchEl.classList.remove('hidden');
  const pct = Math.round((current / total) * 100);
  fill.style.width = `${pct}%`;
  label.textContent = t('statusBatchProgress', [String(current), String(total)]);
}

// ─────────────────────────────────────────────
// IMPORT — DÉCLENCHEMENT
// ─────────────────────────────────────────────

function getIntentNote() {
  const ta = document.getElementById('intent-note');
  return ta ? ta.value.trim() || null : null;
}

/**
 * Lance un import email (PDF ou MD).
 *
 * @param {string} format - 'pdf' | 'md'
 */
function startEmailCapture(format) {
  if (!_currentNotebookId) {
    document.getElementById('error-message').textContent = t('errNoNotebook');
    showState('error');
    return;
  }

  _currentFormat = format;
  showState('capturing');

  browser.runtime.sendMessage({
    action     : 'START_CAPTURE',
    format,
    notebookId : _currentNotebookId,
    intentNote : getIntentNote(),
  });
}



/**
 * Lance un import de pièces jointes sélectionnées.
 */
function startAttachmentCapture() {
  if (!_currentNotebookId) {
    document.getElementById('error-message').textContent = t('errNoNotebook');
    showState('error');
    return;
  }

  const checked = [...document.querySelectorAll('#attachment-list input[type="checkbox"]:checked')];
  if (checked.length === 0) return;

  const attachments = checked.map(cb => ({
    partName   : cb.dataset.partName,
    name       : cb.dataset.name,
    contentType: cb.dataset.contentType,
  }));

  _currentFormat = 'attachment';
  showState('capturing');

  browser.runtime.sendMessage({
    action      : 'START_CAPTURE',
    format      : 'attachment',
    notebookId  : _currentNotebookId,
    messageId   : _currentMessageId,
    attachments,
  });
}

// ─────────────────────────────────────────────
// ÉCOUTE DES STATUS_UPDATE (background → popup)
// ─────────────────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== 'STATUS_UPDATE') return;

  switch (message.status) {
    case 'auth_ready':
      loadEmailMeta();
      break;

    case 'capturing':
    case 'uploading':
      showState('capturing');
      if (message.statusKey) {
        document.getElementById('capturing-status').textContent = t(message.statusKey);
      }
      break;

    case 'info':
      if (message.batchProgress) {
        updateBatchProgress(message.batchProgress.current, message.batchProgress.total);
      }
      break;

    case 'success':
      showSuccess({
        notebookId  : message.notebookId || _currentNotebookId,
        showDownload: !!message.showDownload,
        fileType    : _currentFormat,
        warnings    : message.warnings,
      });
      break;

    case 'error':
      showError(message.code || 'UNKNOWN', message.detail);
      break;
  }
});

// ─────────────────────────────────────────────
// HANDLERS DE BOUTONS (LIENS ET EVENEMENTS)
// ─────────────────────────────────────────────

/**
 * Lie un gestionnaire d'événement de clic de manière sécurisée en vérifiant l'existence de l'élément.
 *
 * @param {string}   id      - ID de l'élément DOM.
 * @param {Function} handler - Callback de clic.
 */
function safeBindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Élément #${id} introuvable pour liaison d'événement`);
  }
  el.addEventListener('click', handler);
}

function bindButtons() {
  // Auth
  safeBindClick('btn-connect', () => {
    showState('loading');
    browser.runtime.sendMessage({ action: 'CONNECT_AUTH' });
  });

  // Import PDF / MD
  safeBindClick('btn-pdf', () => startEmailCapture('pdf'));
  safeBindClick('btn-md', () => startEmailCapture('md'));



  // Import PJ sélectionnées
  safeBindClick('btn-import-attachments', startAttachmentCapture);

  // Créer un carnet
  safeBindClick('btn-create-notebook', async () => {
    const name = window.prompt(t('btnCreateNotebook'));
    if (!name) return;
    try {
      const resp = await browser.runtime.sendMessage({ action: 'CREATE_NOTEBOOK', title: name });
      if (resp && resp.id) {
        _currentNotebookId = resp.id;
        _notebooks.unshift({ id: resp.id, title: name });
        renderNotebooks(_notebooks);
      }
    } catch (_e) {
      console.warn('[NTC] Création carnet échouée :', _e.message);
    }
  });

  // Fast Research sur la liste de carnets (debounce 300ms)
  const searchInput = document.getElementById('notebook-search');
  if (!searchInput) throw new Error('Élément #notebook-search introuvable');
  let _searchDebounce = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _searchTerm = e.target.value;
      renderNotebooks(_notebooks);
    }, 300);
  });

  // Sélecteur de compte
  const accountSelect = document.getElementById('account-select');
  if (!accountSelect) throw new Error('Élément #account-select introuvable');
  accountSelect.addEventListener('change', async (e) => {
    const index = parseInt(e.target.value, 10);
    await browser.runtime.sendMessage({ action: 'SET_ACCOUNT', index });
    await loadNotebooks();
  });

  // Télécharger — le nom de fichier est géré côté background depuis le sujet
  // brut mémorisé à la capture (revue 2026-06-10, bug 4 : plus de titre
  // tronqué avec ellipse envoyé depuis la popup).
  safeBindClick('btn-download', () => {
    const btn = document.getElementById('btn-download');
    if (btn) {
      browser.runtime.sendMessage({
        action  : 'DOWNLOAD_CAPTURE',
        fileType: btn.dataset.fileType || _currentFormat,
      });
    }
  });

  // Ouvrir dans NotebookLM
  safeBindClick('btn-open-notebook', (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-open-notebook');
    if (btn && btn.href) {
      browser.tabs.create({ url: btn.href });
    }
  });

  // Nouvel import
  safeBindClick('btn-new-import', loadEmailMeta);

  // Retour depuis erreur
  safeBindClick('btn-back', () => showState('ready'));

  // Reconnexion après session expirée
  safeBindClick('btn-reconnect', () => {
    showState('loading');
    browser.runtime.sendMessage({ action: 'CONNECT_AUTH' });
  });
}

// ─────────────────────────────────────────────
// POINT D'ENTRÉE
// ─────────────────────────────────────────────

async function initPopup() {
  try {
    applyI18n();
    bindButtons();
  } catch (err) {
    console.error('[NTC] Erreur init UI :', err.message, err.stack);
    // Écran d'erreur factorisé dans pre_loader.js (revue 2026-06-10)
    if (typeof window.__ntcRenderErrorScreen === 'function') {
      window.__ntcRenderErrorScreen('CRASH INIT', `Error: ${err.message}\nStack: ${err.stack}`, false);
    }
    return;
  }

  showState('loading');

  // Vérifier l'état d'authentification
  let authStatus;
  try {
    authStatus = await browser.runtime.sendMessage({ action: 'GET_AUTH_STATUS' });
  } catch (err) {
    console.error('[NTC] GET_AUTH_STATUS failed :', err.message);
    showState('authRequired');
    return;
  }

  if (!authStatus || !authStatus.authReady) {
    showState('authRequired');
    return;
  }

  // Auth OK → charger les métadonnées email
  try {
    await loadEmailMeta();
  } catch (err) {
    console.error('[NTC] Erreur lors du chargement des métadonnées :', err.message, err.stack);
    showError('UNKNOWN', err.message);
    return;
  }

  // Charger la liste des comptes (section conditionnelle)
  try {
    const accountsResp = await browser.runtime.sendMessage({ action: 'GET_ACCOUNTS' });
    if (accountsResp && accountsResp.accounts && accountsResp.accounts.length > 1) {
      const sel = document.getElementById('account-select');
      if (sel) {
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        accountsResp.accounts.forEach(acc => {
          const opt = document.createElement('option');
          opt.value       = String(acc.index);
          opt.textContent = acc.email;
          sel.appendChild(opt);
        });
        // Charger le compte actif stocké et le sélectionner dans l'UI
        const stored = await browser.storage.local.get(STORAGE_KEYS.ACTIVE_AUTHUSER);
        const activeIndex = stored[STORAGE_KEYS.ACTIVE_AUTHUSER] !== undefined ? stored[STORAGE_KEYS.ACTIVE_AUTHUSER] : 0;
        sel.value = String(activeIndex);

        const section = document.getElementById('account-section');
        if (section) section.classList.remove('hidden');
      }
    }
  } catch (_e) {
    // Non bloquant
  }
}

// Les scripts étant chargés en fin de <body>, le DOM est déjà parsé.
// Dans le contexte de popup de Thunderbird, DOMContentLoaded peut ne pas se déclencher.
// Appel direct.
initPopup().catch(err => {
  console.error('[NTC] Fatal in initPopup:', err);
});
