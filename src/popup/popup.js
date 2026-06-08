// popup.js — Logique UI de la popup Thunderbird MV2
// NotebookLM Clipper for Thunderbird — v1.0.0
//
// Dépend de utils.js chargé avant lui (expose var NtcUtils → t())
// Utilise browser.runtime.sendMessage pour communiquer avec background.js

'use strict';

// Gestion des erreurs globales avec affichage visuel (failsafe)
window.onerror = function (message, source, lineno, colno, error) {
  const div = document.createElement('div');
  div.style.position = 'fixed';
  div.style.top = '0';
  div.style.left = '0';
  div.style.width = '100%';
  div.style.height = '100%';
  div.style.background = '#8b0000';
  div.style.color = '#ffffff';
  div.style.padding = '15px';
  div.style.zIndex = '999999';
  div.style.fontFamily = 'monospace';
  div.style.fontSize = '11px';
  div.style.lineHeight = '1.4';
  div.style.overflow = 'auto';
  div.style.boxSizing = 'border-box';
  div.textContent = `CRASH GLOBAL:\nError: ${message}\nSource: ${source}\nLine: ${lineno}:${colno}\nStack: ${error ? error.stack : 'N/A'}`;
  document.body.appendChild(div);
  return false;
};

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
let _detectedUrls       = [];
let _selectedUrl        = null;
let _pingInterval       = null;
let _currentFormat      = null;  // 'pdf' | 'md' | 'url' | 'attachment'

// ─────────────────────────────────────────────
// GESTION DES ÉTATS
// ─────────────────────────────────────────────

/**
 * Affiche uniquement l'état demandé, masque tous les autres.
 *
 * @param {'authRequired'|'loading'|'ready'|'urlSelector'|'capturing'|'success'|'error'} name
 */
function showState(name) {
  const idMap = {
    authRequired : 'state-auth-required',
    loading      : 'state-loading',
    ready        : 'state-ready',
    urlSelector  : 'state-url-selector',
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
    showError(e.code || 'UNKNOWN', e.message);
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
    dateEl.textContent = meta.date
      ? new Date(meta.date).toLocaleString()
      : '';
  }

  _currentMessageId = meta.messageId;
  _detectedUrls     = meta.detectedUrls || [];



  // Section PJ
  renderAttachments(meta.attachments || []);

  // Charger les carnets
  await loadNotebooks();
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
    li.className   = 'attachment-item';

    const cb       = document.createElement('input');
    cb.type        = 'checkbox';
    cb.id          = `att-${att.partName}`;
    cb.dataset.partName    = att.partName;
    cb.dataset.name        = att.name;
    cb.dataset.contentType = att.contentType;
    cb.addEventListener('change', onAttachmentCheckboxChange);

    const label    = document.createElement('label');
    label.htmlFor  = `att-${att.partName}`;
    label.className = 'attachment-name';
    label.textContent = att.name;

    const size     = document.createElement('span');
    size.className = 'attachment-size';
    if (att.size) {
      size.textContent = att.size > 1024 * 1024
        ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(att.size / 1024)} KB`;
    }

    li.appendChild(cb);
    li.appendChild(label);
    li.appendChild(size);
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
    console.error('[NTC-UI] Échec du chargement des carnets :', err.message, err);
    list.setAttribute('data-empty', t('noNotebookFound') + ' (' + err.message + ')');
    return;
  }

  _notebooks = (resp && resp.notebooks) ? resp.notebooks : [];

  // Tenter de restaurer le dernier carnet sélectionné
  const stored = await browser.storage.local.get('ntc_last_notebook_id');
  if (stored.ntc_last_notebook_id) {
    _currentNotebookId = stored.ntc_last_notebook_id;
  }

  renderNotebooks(_notebooks);
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
    li.className  = 'notebook-item' + (nb.id === _currentNotebookId ? ' selected' : '');
    li.role       = 'option';
    li.dataset.id = nb.id;
    li.textContent = nb.title;
    li.setAttribute('aria-selected', nb.id === _currentNotebookId ? 'true' : 'false');
    li.addEventListener('click', () => selectNotebook(nb.id, nb.title, li));
    list.appendChild(li);
  });
}

function selectNotebook(id, _title, liEl) {
  _currentNotebookId = id;
  document.querySelectorAll('.notebook-item').forEach(el => {
    el.classList.toggle('selected', el === liEl);
    el.setAttribute('aria-selected', el === liEl ? 'true' : 'false');
  });
  browser.storage.local.set({ ntc_last_notebook_id: id });
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
      browser.storage.local.get('ntc_active_authuser').then(stored => {
        const index = stored.ntc_active_authuser !== undefined ? stored.ntc_active_authuser : 0;
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

  // Télécharger
  safeBindClick('btn-download', () => {
    const btn = document.getElementById('btn-download');
    if (btn) {
      const subjectEl = document.getElementById('meta-subject');
      browser.runtime.sendMessage({
        action  : 'DOWNLOAD_CAPTURE',
        fileType: btn.dataset.fileType || _currentFormat,
        title   : (subjectEl ? subjectEl.textContent : '') || 'email',
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
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '0';
    div.style.left = '0';
    div.style.width = '100%';
    div.style.height = '100%';
    div.style.background = '#8b0000';
    div.style.color = '#ffffff';
    div.style.padding = '15px';
    div.style.zIndex = '999999';
    div.style.fontFamily = 'monospace';
    div.style.fontSize = '11px';
    div.style.lineHeight = '1.4';
    div.style.overflow = 'auto';
    div.style.boxSizing = 'border-box';
    div.textContent = `CRASH INIT:\nError: ${err.message}\nStack: ${err.stack}`;
    document.body.appendChild(div);
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
        const stored = await browser.storage.local.get('ntc_active_authuser');
        const activeIndex = stored.ntc_active_authuser !== undefined ? stored.ntc_active_authuser : 0;
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
