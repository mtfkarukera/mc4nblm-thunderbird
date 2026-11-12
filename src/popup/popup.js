// popup.js — Orchestrateur UI de la popup Thunderbird 128+ ESR (Manifest V3)
// Magic Clipper for Gemini Notebook
// Auteur : MTF Karukera
//
// Dépend de utils.js chargé avant lui (expose var NtcUtils → t())
// Communique avec l'Event Page background.js via browser.runtime.sendMessage

'use strict';

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
// ÉTAT DE LA POPUP
// ─────────────────────────────────────────────

let _currentState = null;
let _currentNotebookId = null;
let _currentMessageId = null;
let _emailHasBody = true;
let _canDownloadLastCapture = false;
let _pingInterval = null;
let _currentFormat = null;   // 'pdf' | 'md' | 'attachment'
let _isCapturing = false;    // Verrou anti-double-clic
let _captureTimeout = null;  // Timeout de sécurité réinitialisable (120s)
let _notebooks = [];
let _searchTerm = '';
let _creatingNotebook = false;

const STORAGE_KEYS = (typeof NtcUtils !== 'undefined' && NtcUtils.STORAGE_KEYS) || {
  ACTIVE_AUTHUSER: 'ntc_active_authuser',
  LAST_NOTEBOOK: 'ntc_last_notebook_id',
  DATA_CONSENT: 'ntc_data_consent',
};

// ─────────────────────────────────────────────
// KEEPALIVE MV3 & TIMEOUT DYNAMIQUE
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

function purgeBackgroundCaptureBuffer() {
  _canDownloadLastCapture = false;
  browser.runtime.sendMessage({ action: 'PURGE_CAPTURE' }).catch(() => {});
}

function resetCaptureTimeout() {
  if (_captureTimeout) {
    clearTimeout(_captureTimeout);
  }
  _captureTimeout = setTimeout(() => {
    _captureTimeout = null;
    _isCapturing = false;
    setImportButtonsDisabled(false);
    showError('TIMEOUT');
  }, 120000);
}

function clearCaptureTimeout() {
  if (_captureTimeout) {
    clearTimeout(_captureTimeout);
    _captureTimeout = null;
  }
}

// ─────────────────────────────────────────────
// GESTION DES ÉTATS & FOCUS ACCESSIBLE
// ─────────────────────────────────────────────

function resetBatchProgress() {
  const batchEl = document.getElementById('batch-progress');
  const track = document.getElementById('batch-progress-track');
  const fill = document.getElementById('progress-bar-fill');
  const label = document.getElementById('batch-progress-label');
  if (batchEl) batchEl.classList.add('hidden');
  if (fill) fill.style.width = '0%';
  if (label) label.textContent = '';
  if (track) {
    track.setAttribute('aria-valuenow', '0');
    track.removeAttribute('aria-valuetext');
  }
}

function showInlineReadyError(msg) {
  const el = document.getElementById('ready-inline-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Place le focus clavier sur le premier élément pertinent de l'écran actif.
 *
 * @param {string} stateName
 * @param {HTMLElement|null} activeEl
 */
function focusActiveStateTarget(stateName, activeEl) {
  if (!activeEl) return;

  let target = null;
  if (stateName === 'authRequired') {
    const cb = document.getElementById('consent-checkbox');
    const btn = document.getElementById('btn-connect');
    target = (cb && !cb.checked) ? cb : btn;
  } else if (stateName === 'ready') {
    target = document.getElementById('notebook-search');
  } else if (stateName === 'success') {
    const btnOpen = document.getElementById('btn-open-notebook');
    target = (btnOpen && !btnOpen.classList.contains('hidden'))
      ? btnOpen
      : document.getElementById('btn-new-import');
  } else if (stateName === 'error') {
    const btnReconnect = document.getElementById('btn-reconnect');
    target = (btnReconnect && !btnReconnect.classList.contains('hidden'))
      ? btnReconnect
      : document.getElementById('btn-back');
  }

  if (target && !target.disabled) {
    target.focus();
    return;
  }

  const heading = activeEl.querySelector('.state-heading');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  } else {
    activeEl.setAttribute('tabindex', '-1');
    activeEl.focus();
  }
}

/**
 * Affiche uniquement l'état demandé, masque tous les autres et synchronise ARIA/KeepAlive.
 *
 * @param {'authRequired'|'loading'|'ready'|'capturing'|'success'|'error'} name
 */
function showState(name) {
  const enteringCapturing = (name === 'capturing' && _currentState !== 'capturing');
  const stateChanged = (_currentState !== name);
  _currentState = name;

  if (name !== 'capturing') {
    clearCaptureTimeout();
  }

  const idMap = {
    authRequired: 'state-auth-required',
    loading: 'state-loading',
    ready: 'state-ready',
    capturing: 'state-capturing',
    success: 'state-success',
    error: 'state-error',
  };

  for (const [key, id] of Object.entries(idMap)) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('hidden', key !== name);
    }
  }

  // Synchronisation dynamique de aria-busy sur les états d'attente
  const loadingEl = document.getElementById('state-loading');
  if (loadingEl) {
    loadingEl.setAttribute('aria-busy', name === 'loading' ? 'true' : 'false');
  }
  const capturingEl = document.getElementById('state-capturing');
  if (capturingEl) {
    capturingEl.setAttribute('aria-busy', name === 'capturing' ? 'true' : 'false');
  }

  if (name === 'ready') {
    showInlineReadyError(null);
  }

  if (enteringCapturing) {
    resetBatchProgress();
    const statusEl = document.getElementById('capturing-status');
    if (statusEl) statusEl.textContent = t('statusCapturing');
  }

  // Maintien de l'Event Page MV3 éveillée pendant l'upload ET sur l'écran succès
  // tant que le bouton Télécharger est affiché (garantit le quota natif 200 Mo sans sous-limite)
  if (name === 'capturing') {
    startKeepAlive();
    resetCaptureTimeout();
  } else if (name === 'success' && _canDownloadLastCapture) {
    startKeepAlive();
  } else {
    stopKeepAlive();
  }

  if (stateChanged) {
    const activeEl = document.getElementById(idMap[name]);
    focusActiveStateTarget(name, activeEl);
  }
}

/**
 * Active/désactive les boutons d'import en respectant la présence réelle d'un corps email
 * et la sélection éventuelle de pièces jointes.
 */
function setImportButtonsDisabled(disabled) {
  const btnPdf = document.getElementById('btn-pdf');
  const btnMd = document.getElementById('btn-md');
  const btnAtt = document.getElementById('btn-import-attachments');

  if (disabled) {
    if (btnPdf) btnPdf.disabled = true;
    if (btnMd) btnMd.disabled = true;
    if (btnAtt) btnAtt.disabled = true;
  } else {
    if (btnPdf) btnPdf.disabled = !_emailHasBody;
    if (btnMd) btnMd.disabled = !_emailHasBody;
    onAttachmentCheckboxChange();
  }
}

// ─────────────────────────────────────────────
// INTERNATIONALISATION
// ─────────────────────────────────────────────

/**
 * Applique les traductions via attributs data-i18n* sur tout le DOM.
 */
function applyI18n() {
  document.documentElement.lang = browser.i18n.getUILanguage() || 'en';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
}

// ─────────────────────────────────────────────
// CONSENTEMENT & AUTHENTIFICATION
// ─────────────────────────────────────────────

function syncConsentControls(consentGranted) {
  const cb = document.getElementById('consent-checkbox');
  const btn = document.getElementById('btn-connect');
  if (cb) {
    cb.checked = Boolean(consentGranted);
  }
  if (btn) {
    btn.disabled = !(cb && cb.checked);
  }
}

async function loadAccounts() {
  const section = document.getElementById('account-section');
  const sel = document.getElementById('account-select');
  if (!section || !sel) return;

  try {
    const accountsResp = await browser.runtime.sendMessage({ action: 'GET_ACCOUNTS' });
    if (accountsResp && Array.isArray(accountsResp.accounts) && accountsResp.accounts.length > 1) {
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      accountsResp.accounts.forEach((acc) => {
        const opt = document.createElement('option');
        opt.value = String(acc.index);
        opt.textContent = acc.email;
        sel.appendChild(opt);
      });
      const stored = await browser.storage.local.get(STORAGE_KEYS.ACTIVE_AUTHUSER);
      const activeIndex = stored[STORAGE_KEYS.ACTIVE_AUTHUSER] !== undefined
        ? stored[STORAGE_KEYS.ACTIVE_AUTHUSER]
        : 0;
      sel.value = String(activeIndex);
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  } catch (_e) {
    section.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
// MÉTADONNÉES EMAIL
// ─────────────────────────────────────────────

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

/**
 * Charge les métadonnées du courriel actif depuis le background et prépare l'écran ready.
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

  if (meta && meta.error) {
    showError(meta.code || 'UNKNOWN', meta.detail || meta.message);
    return;
  }

  const subEl = document.getElementById('meta-subject');
  if (subEl) {
    const fullSub = meta.subject || '';
    subEl.textContent = truncate(fullSub, 60);
    subEl.title = fullSub;
  }

  const fromEl = document.getElementById('meta-from');
  if (fromEl) {
    const fullFrom = meta.from || '';
    fromEl.textContent = truncate(fullFrom, 45);
    fromEl.title = fullFrom;
  }

  const dateEl = document.getElementById('meta-date');
  if (dateEl) {
    const dateText = meta.date
      ? new Date(meta.date).toLocaleString()
      : t('labelDateUnknown');
    dateEl.textContent = dateText;
    dateEl.title = dateText;
  }

  _currentMessageId = meta.messageId;
  _emailHasBody = Boolean(meta.hasMd);

  const btnPdf = document.getElementById('btn-pdf');
  const btnMd = document.getElementById('btn-md');
  if (btnPdf) btnPdf.disabled = !_emailHasBody;
  if (btnMd) btnMd.disabled = !_emailHasBody;

  renderAttachments(meta.attachments || []);

  const notebooksOk = await loadNotebooks();
  if (notebooksOk === false) return;

  await loadAccounts();
  showState('ready');
}

// ─────────────────────────────────────────────
// PIÈCES JOINTES
// ─────────────────────────────────────────────

/**
 * Rend la liste des pièces jointes filtrées dans l'UI avec associations ARIA complètes.
 *
 * @param {Array} attachments
 */
function renderAttachments(attachments) {
  const section = document.getElementById('attachments-section');
  const list = document.getElementById('attachment-list');
  if (!section || !list) return;

  while (list.firstChild) list.removeChild(list.firstChild);

  if (attachments.length === 0) {
    section.classList.add('hidden');
    onAttachmentCheckboxChange();
    return;
  }

  section.classList.remove('hidden');

  attachments.forEach((att, idx) => {
    const safePartId = String(att.partName || idx).replace(/[^a-zA-Z0-9_-]/g, '_');
    const cbId = `att-cb-${safePartId}-${idx}`;
    const descIds = [];

    const li = document.createElement('li');
    li.className = `attachment-item${att.tooLarge ? ' disabled' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = cbId;
    cb.dataset.partName = att.partName;
    cb.dataset.name = att.name;
    cb.dataset.contentType = att.contentType;

    if (att.tooLarge) {
      cb.disabled = true;
      li.title = t('errorAttachmentTooLarge');
    } else {
      cb.addEventListener('change', onAttachmentCheckboxChange);
    }

    const label = document.createElement('label');
    label.htmlFor = cbId;
    label.className = 'attachment-name';
    label.textContent = att.name;
    label.title = att.name;

    const size = document.createElement('span');
    size.className = `attachment-size${att.tooLarge ? ' too-large' : ''}`;
    if (att.size) {
      size.id = `att-size-${safePartId}-${idx}`;
      size.textContent = att.size > 1024 * 1024
        ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(att.size / 1024))} KB`;
      descIds.push(size.id);
    }

    li.appendChild(cb);
    li.appendChild(label);
    li.appendChild(size);

    if (att.tooLarge) {
      const errSpan = document.createElement('span');
      errSpan.id = `att-err-${safePartId}-${idx}`;
      errSpan.className = 'visually-hidden';
      errSpan.textContent = t('errorAttachmentTooLarge');
      li.appendChild(errSpan);
      descIds.push(errSpan.id);
    } else if (att.unknownType) {
      const flag = document.createElement('span');
      flag.id = `att-flag-${safePartId}-${idx}`;
      flag.className = 'attachment-flag';
      const flagLabel = t('attachmentUnknownType');
      flag.textContent = flagLabel;
      flag.title = flagLabel;
      li.appendChild(flag);
      descIds.push(flag.id);
    }

    if (descIds.length > 0) {
      cb.setAttribute('aria-describedby', descIds.join(' '));
    }

    list.appendChild(li);
  });

  // Toujours synchroniser l'état du bouton PJ et du champ d'intention (évite tout état rassis)
  onAttachmentCheckboxChange();
}

/**
 * Met à jour le bouton d'import PJ et désactive en douceur la note d'intention
 * (sans masquer le bloc afin d'éviter tout saut de mise en page).
 */
function onAttachmentCheckboxChange() {
  const checked = document.querySelectorAll('#attachment-list input[type="checkbox"]:checked');
  const btn = document.getElementById('btn-import-attachments');
  const intentWr = document.getElementById('intent-wrapper');
  const intentTa = document.getElementById('intent-note');
  if (!btn || !intentWr) return;

  const hasChecked = checked.length > 0;
  if (hasChecked) {
    btn.classList.remove('hidden');
    btn.disabled = _isCapturing;
    btn.textContent = t('btnImportSelection', [String(checked.length)]);
    intentWr.classList.add('is-disabled');
    if (intentTa) intentTa.disabled = true;
  } else {
    btn.classList.add('hidden');
    btn.disabled = true;
    intentWr.classList.remove('is-disabled');
    if (intentTa) intentTa.disabled = false;
  }
}

// ─────────────────────────────────────────────
// CARNETS NOTEBOOKLM
// ─────────────────────────────────────────────

async function loadNotebooks() {
  const list = document.getElementById('notebook-list');
  if (!list) return true;
  while (list.firstChild) list.removeChild(list.firstChild);
  list.setAttribute('data-empty', t('loadingNotebooks'));

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ action: 'GET_NOTEBOOKS' });
  } catch (err) {
    const { code } = classifyError(err);
    if (code === 'AUTH_EXPIRED') {
      showState('authRequired');
      return false;
    }
    console.error('[NTC-UI] Échec du chargement des carnets :', err.message);
    _notebooks = [];
    _currentNotebookId = null;
    list.setAttribute('data-empty', t(ERROR_KEYS[code] || 'errorUnknown'));
    return true;
  }

  if (resp && resp.error) {
    const code = ERROR_KEYS[resp.code] ? resp.code : 'UNKNOWN';
    if (code === 'AUTH_EXPIRED') {
      showState('authRequired');
      return false;
    }
    _notebooks = [];
    _currentNotebookId = null;
    list.setAttribute('data-empty', t(ERROR_KEYS[code]));
    return true;
  }

  _notebooks = (resp && Array.isArray(resp.notebooks)) ? resp.notebooks : [];

  // Restaurer le dernier carnet sélectionné UNIQUEMENT s'il appartient aux carnets du compte actif
  const stored = await browser.storage.local.get(STORAGE_KEYS.LAST_NOTEBOOK);
  const candidateId = stored[STORAGE_KEYS.LAST_NOTEBOOK] || null;
  if (
    candidateId &&
    candidateId !== '__diag__' &&
    _notebooks.some((nb) => nb.id === candidateId)
  ) {
    _currentNotebookId = candidateId;
  } else {
    _currentNotebookId = null;
  }

  renderNotebooks(_notebooks);
  return true;
}

function renderNotebooks(notebooks) {
  const list = document.getElementById('notebook-list');
  if (!list) return;
  const term = _searchTerm.toLowerCase();
  const filtered = term
    ? notebooks.filter((nb) => nb.title.toLowerCase().includes(term))
    : notebooks;

  while (list.firstChild) list.removeChild(list.firstChild);
  list.setAttribute('data-empty', t('noNotebookFound'));

  filtered.forEach((nb, idx) => {
    const li = document.createElement('li');
    const isDiag = nb.id === '__diag__';
    const isSelected = !isDiag && nb.id === _currentNotebookId;
    const safeId = String(nb.id || idx).replace(/[^a-zA-Z0-9_-]/g, '_');

    li.id = `nb-option-${safeId}-${idx}`;
    li.className = `notebook-item${isDiag ? ' diag' : ''}${isSelected ? ' selected' : ''}`;
    li.setAttribute('role', 'option');
    li.dataset.id = nb.id;
    li.textContent = nb.title;
    li.title = nb.title;
    li.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    li.tabIndex = -1;

    if (isDiag) {
      li.setAttribute('aria-disabled', 'true');
    } else {
      li.addEventListener('click', () => selectNotebook(nb.id, nb.title, li));
    }
    list.appendChild(li);
  });

  const selectedEl = list.querySelector('.notebook-item.selected');
  if (selectedEl) {
    list.setAttribute('aria-activedescendant', selectedEl.id);
  } else {
    list.removeAttribute('aria-activedescendant');
  }
}

function selectNotebook(id, _title, liEl) {
  if (id === '__diag__') return;
  _currentNotebookId = id;
  showInlineReadyError(null);

  const list = document.getElementById('notebook-list');
  document.querySelectorAll('#notebook-list .notebook-item').forEach((el) => {
    const isTarget = el === liEl;
    el.classList.toggle('selected', isTarget);
    el.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });
  if (list) {
    if (liEl) {
      list.setAttribute('aria-activedescendant', liEl.id);
    } else {
      list.removeAttribute('aria-activedescendant');
    }
  }
  browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: id }).catch(() => {});
}

function handleNotebookListKeyDown(e) {
  const items = Array.from(document.querySelectorAll('#notebook-list .notebook-item:not(.diag)'));
  if (items.length === 0) return;

  let currentIndex = items.findIndex((el) => el.classList.contains('selected'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    currentIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    const nextItem = items[currentIndex];
    selectNotebook(nextItem.dataset.id, nextItem.textContent, nextItem);
    nextItem.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    const prevItem = items[currentIndex];
    selectNotebook(prevItem.dataset.id, prevItem.textContent, prevItem);
    prevItem.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (currentIndex < 0) {
      selectNotebook(items[0].dataset.id, items[0].textContent, items[0]);
    }
    const firstAction = document.querySelector('#btn-pdf:not(:disabled), #btn-import-attachments:not(:disabled)');
    if (firstAction) firstAction.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const searchEl = document.getElementById('notebook-search');
    if (searchEl) searchEl.focus();
  }
}

// ─────────────────────────────────────────────
// ERREURS & SUCCÈS
// ─────────────────────────────────────────────

const ERROR_KEYS = {
  AUTH_EXPIRED: 'errorAuthExpired',
  API_CHANGED: 'errorApiChanged',
  UPLOAD_SESSION_MISSING: 'errorUploadSessionMissing',
  TIMEOUT: 'errorTimeout',
  INJECTION_FAILED: 'errorInjectionFailed',
  NO_EMAIL_DISPLAYED: 'errorNoEmailDisplayed',
  EMPTY_EMAIL_BODY: 'errorEmptyEmailBody',
  ATTACHMENT_TOO_LARGE: 'errorAttachmentTooLarge',
  WORD_LIMIT_EXCEEDED: 'errorWordLimitExceeded',
  INVALID_TITLE: 'errorInvalidTitle',
  UNKNOWN: 'errorUnknown',
};

function classifyError(e) {
  if (e && e.code && ERROR_KEYS[e.code]) {
    return { code: e.code, detail: e.detail || null };
  }
  if (e && e.message && ERROR_KEYS[e.message]) {
    return { code: e.message, detail: null };
  }
  return { code: 'UNKNOWN', detail: e ? e.message : null };
}

function showError(code, detail) {
  const normalizedCode = ERROR_KEYS[code] ? code : 'UNKNOWN';
  const key = ERROR_KEYS[normalizedCode];
  const errEl = document.getElementById('error-message');
  if (errEl) {
    let msg = t(key);
    if (detail && detail !== normalizedCode && !ERROR_KEYS[detail]) {
      msg += `\n(${detail})`;
    }
    errEl.textContent = msg;
  }

  // Ne jamais laisser le bouton Se reconnecter visible hors expiration de session
  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    btnReconnect.classList.toggle('hidden', normalizedCode !== 'AUTH_EXPIRED');
  }

  showState('error');
}

function showSuccess(payload) {
  _canDownloadLastCapture = Boolean(payload.showDownload);

  const btnOpen = document.getElementById('btn-open-notebook');
  if (btnOpen) {
    if (payload.notebookId) {
      // Construction synchrone immédiate (évite toute course au clic rapide)
      btnOpen.dataset.notebookUrl = NtcUtils.buildNotebookUrl(
        payload.notebookId,
        payload.authuserIndex !== undefined ? payload.authuserIndex : 0
      );
      btnOpen.classList.remove('hidden');
    } else {
      delete btnOpen.dataset.notebookUrl;
      btnOpen.classList.add('hidden');
    }
  }

  const btnDownload = document.getElementById('btn-download');
  if (btnDownload) {
    btnDownload.classList.toggle('hidden', !_canDownloadLastCapture);
    if (_canDownloadLastCapture) {
      btnDownload.dataset.fileType = payload.fileType || 'pdf';
    }
  }

  const warningsEl = document.getElementById('warnings-container');
  if (warningsEl) {
    warningsEl.classList.add('hidden');
    while (warningsEl.firstChild) warningsEl.removeChild(warningsEl.firstChild);

    let hasAnyWarning = false;

    if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
      const msg = document.createElement('p');
      msg.textContent = `${t('warningPartialImport', [String(payload.warnings.length)])} (${payload.warnings.join(', ')})`;
      warningsEl.appendChild(msg);
      hasAnyWarning = true;
    }

    if (payload.hasNonLatinGlyphs) {
      const glyphMsg = document.createElement('p');
      glyphMsg.textContent = t('warningPdfNonLatin');
      warningsEl.appendChild(glyphMsg);
      hasAnyWarning = true;
    }

    if (hasAnyWarning) {
      warningsEl.classList.remove('hidden');
    }
  }

  showState('success');
}

// ─────────────────────────────────────────────
// PROGRESSION BATCH PJ
// ─────────────────────────────────────────────

function updateBatchProgress(current, total) {
  const batchEl = document.getElementById('batch-progress');
  const track = document.getElementById('batch-progress-track');
  const fill = document.getElementById('progress-bar-fill');
  const label = document.getElementById('batch-progress-label');
  if (!batchEl || !fill || !label || !total) return;

  batchEl.classList.remove('hidden');
  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  const labelText = t('statusBatchProgress', [String(current), String(total)]);
  fill.style.width = `${pct}%`;
  label.textContent = labelText;

  if (track) {
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuetext', labelText);
  }
}

// ─────────────────────────────────────────────
// DÉCLENCHEMENT DES IMPORTS
// ─────────────────────────────────────────────

function getIntentNote() {
  const ta = document.getElementById('intent-note');
  return (ta && !ta.disabled) ? (ta.value.trim() || null) : null;
}

function requireSelectedNotebook() {
  if (_currentNotebookId) {
    showInlineReadyError(null);
    return true;
  }
  showInlineReadyError(t('errNoNotebook'));
  const list = document.getElementById('notebook-list');
  if (list) list.focus();
  return false;
}

function startEmailCapture(format) {
  if (_isCapturing) return;
  if (!requireSelectedNotebook()) return;

  _isCapturing = true;
  _canDownloadLastCapture = false;
  setImportButtonsDisabled(true);
  _currentFormat = format;
  showState('capturing');

  browser.runtime.sendMessage({
    action: 'START_CAPTURE',
    format,
    notebookId: _currentNotebookId,
    messageId: _currentMessageId,
    intentNote: getIntentNote(),
  }).catch((err) => {
    _isCapturing = false;
    setImportButtonsDisabled(false);
    const { code, detail } = classifyError(err);
    showError(code, detail);
  });
}

function startAttachmentCapture() {
  if (_isCapturing) return;
  if (!requireSelectedNotebook()) return;

  const checked = [...document.querySelectorAll('#attachment-list input[type="checkbox"]:checked')];
  if (checked.length === 0) return;

  const attachments = checked.map((cb) => ({
    partName: cb.dataset.partName,
    name: cb.dataset.name,
    contentType: cb.dataset.contentType,
  }));

  _isCapturing = true;
  _canDownloadLastCapture = false;
  setImportButtonsDisabled(true);
  _currentFormat = 'attachment';
  showState('capturing');

  browser.runtime.sendMessage({
    action: 'START_CAPTURE',
    format: 'attachment',
    notebookId: _currentNotebookId,
    messageId: _currentMessageId,
    attachments,
  }).catch((err) => {
    _isCapturing = false;
    setImportButtonsDisabled(false);
    const { code, detail } = classifyError(err);
    showError(code, detail);
  });
}

// ─────────────────────────────────────────────
// ÉCOUTE DES STATUS_UPDATE (background → popup)
// ─────────────────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'STATUS_UPDATE') return;

  switch (message.status) {
    case 'auth_ready':
      loadEmailMeta().catch((err) => {
        showError('UNKNOWN', err.message);
      });
      break;

    case 'auth_closed':
      // L'utilisateur a refermé l'onglet WebContent sans finaliser la connexion
      showState('authRequired');
      break;

    case 'capturing':
    case 'uploading':
      showState('capturing');
      resetCaptureTimeout();
      if (message.statusKey) {
        const statusEl = document.getElementById('capturing-status');
        if (statusEl) statusEl.textContent = t(message.statusKey);
      }
      break;

    case 'info':
      resetCaptureTimeout();
      if (message.batchProgress) {
        updateBatchProgress(message.batchProgress.current, message.batchProgress.total);
      }
      break;

    case 'success':
      _isCapturing = false;
      setImportButtonsDisabled(false);
      showSuccess({
        notebookId: message.notebookId || _currentNotebookId,
        authuserIndex: message.authuserIndex,
        showDownload: Boolean(message.showDownload),
        fileType: _currentFormat,
        warnings: message.warnings,
        hasNonLatinGlyphs: Boolean(message.hasNonLatinGlyphs),
      });
      break;

    case 'error':
      _isCapturing = false;
      setImportButtonsDisabled(false);
      showError(message.code || 'UNKNOWN', message.detail);
      break;
  }
});

// ─────────────────────────────────────────────
// CRÉATION DE CARNET INLINE
// ─────────────────────────────────────────────

function updateCreateConfirmState() {
  const input = document.getElementById('create-notebook-name');
  const btn = document.getElementById('btn-create-confirm');
  if (!input || !btn) return;
  btn.disabled = _creatingNotebook || input.value.trim().length === 0;
}

function setCreateStatus(message, isError) {
  const el = document.getElementById('create-notebook-status');
  const input = document.getElementById('create-notebook-name');
  if (input) {
    if (isError && message) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', Boolean(isError));
  el.classList.toggle('hidden', !message);
}

function openCreateNotebookRow() {
  const searchRow = document.getElementById('search-notebook-row');
  const createRow = document.getElementById('create-notebook-row');
  const btnCreate = document.getElementById('btn-create-notebook');
  const input = document.getElementById('create-notebook-name');
  const search = document.getElementById('notebook-search');
  if (!createRow || !input) return;

  if (searchRow) searchRow.classList.add('hidden');
  createRow.classList.remove('hidden');
  if (btnCreate) btnCreate.setAttribute('aria-expanded', 'true');
  setCreateStatus(null, false);

  input.value = (search ? search.value : '').trim().slice(0, 100);
  updateCreateConfirmState();
  input.focus();
  input.select();
}

function closeCreateNotebookRow(restoreFocus = false) {
  if (_creatingNotebook) return;
  const searchRow = document.getElementById('search-notebook-row');
  const createRow = document.getElementById('create-notebook-row');
  const btnCreate = document.getElementById('btn-create-notebook');
  if (createRow) createRow.classList.add('hidden');
  if (searchRow) searchRow.classList.remove('hidden');
  if (btnCreate) {
    btnCreate.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btnCreate.focus();
  }
  setCreateStatus(null, false);
}

function setCreateRowBusy(busy) {
  _creatingNotebook = busy;
  const input = document.getElementById('create-notebook-name');
  const confirm = document.getElementById('btn-create-confirm');
  const cancel = document.getElementById('btn-create-cancel');
  if (input) input.disabled = busy;
  if (cancel) cancel.disabled = busy;
  if (confirm) confirm.disabled = busy || !input || input.value.trim().length === 0;
}

async function submitCreateNotebook() {
  const input = document.getElementById('create-notebook-name');
  if (!input || _creatingNotebook) return;
  const title = input.value.trim();
  if (!title) return;

  setCreateRowBusy(true);
  setCreateStatus(t('statusCreatingNotebook'), false);

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ action: 'CREATE_NOTEBOOK', title });
  } catch (err) {
    setCreateRowBusy(false);
    const { code, detail } = classifyError(err);
    if (code === 'AUTH_EXPIRED') {
      setCreateStatus(null, false);
      showState('authRequired');
      return;
    }
    console.error('[NTC-UI] Création carnet échouée :', err.message);
    let msg = (code && ERROR_KEYS[code]) ? t(ERROR_KEYS[code]) : t('errorCreateNotebook');
    if (detail && detail !== code && !ERROR_KEYS[detail]) msg += ` (${detail})`;
    setCreateStatus(msg, true);
    input.focus();
    return;
  }

  setCreateRowBusy(false);

  if (!resp || !resp.id) {
    setCreateStatus(t('errorCreateNotebook'), true);
    input.focus();
    return;
  }

  _currentNotebookId = resp.id;
  _notebooks.unshift({ id: resp.id, title });
  _searchTerm = '';
  const search = document.getElementById('notebook-search');
  if (search) search.value = '';
  showInlineReadyError(null);
  renderNotebooks(_notebooks);
  browser.storage.local.set({ [STORAGE_KEYS.LAST_NOTEBOOK]: resp.id }).catch(() => {});
  input.value = '';
  closeCreateNotebookRow(false);

  const list = document.getElementById('notebook-list');
  if (list) list.focus();
}

// ─────────────────────────────────────────────
// HANDLERS DE CONTRÔLES UI
// ─────────────────────────────────────────────

function safeBindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Élément #${id} introuvable pour liaison d'événement`);
  }
  el.addEventListener('click', handler);
}

async function triggerConnectFlow(explicitConsent) {
  showState('loading');
  try {
    const resp = await browser.runtime.sendMessage({
      action: 'CONNECT_AUTH',
      consent: Boolean(explicitConsent),
    });
    if (resp && resp.error === 'CONSENT_REQUIRED') {
      syncConsentControls(false);
      showState('authRequired');
      return;
    }
    if (resp && resp.alreadyAuthenticated) {
      await loadEmailMeta();
    }
  } catch (err) {
    const { code, detail } = classifyError(err);
    showError(code, detail);
  }
}

function bindButtons() {
  const consentCb = document.getElementById('consent-checkbox');
  if (!consentCb) throw new Error('Élément #consent-checkbox introuvable');
  consentCb.addEventListener('change', () => {
    const btn = document.getElementById('btn-connect');
    if (btn) btn.disabled = !consentCb.checked;
  });

  safeBindClick('btn-connect', () => {
    if (!consentCb.checked) return;
    triggerConnectFlow(true);
  });

  safeBindClick('btn-disconnect', async () => {
    stopKeepAlive();
    _isCapturing = false;
    _canDownloadLastCapture = false;
    _currentNotebookId = null;
    _notebooks = [];
    try {
      await browser.runtime.sendMessage({ action: 'DISCONNECT_AUTH' });
    } catch (_e) {
      // Ignorer
    }
    syncConsentControls(false);
    const accSection = document.getElementById('account-section');
    if (accSection) accSection.classList.add('hidden');
    showState('authRequired');
  });

  safeBindClick('btn-pdf', () => startEmailCapture('pdf'));
  safeBindClick('btn-md', () => startEmailCapture('md'));
  safeBindClick('btn-import-attachments', startAttachmentCapture);

  safeBindClick('btn-create-notebook', openCreateNotebookRow);
  safeBindClick('btn-create-confirm', submitCreateNotebook);
  safeBindClick('btn-create-cancel', () => closeCreateNotebookRow(true));

  const createInput = document.getElementById('create-notebook-name');
  if (!createInput) throw new Error('Élément #create-notebook-name introuvable');
  createInput.addEventListener('input', updateCreateConfirmState);
  createInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateNotebook(); }
    if (e.key === 'Escape') { e.preventDefault(); closeCreateNotebookRow(true); }
  });

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

  const accountSelect = document.getElementById('account-select');
  if (!accountSelect) throw new Error('Élément #account-select introuvable');
  accountSelect.addEventListener('change', async (e) => {
    const index = parseInt(e.target.value, 10);
    try {
      const resp = await browser.runtime.sendMessage({ action: 'SET_ACCOUNT', index });
      if (!resp || resp.error) {
        showInlineReadyError(t('errorUnknown'));
        return;
      }
      _currentNotebookId = null;
      _searchTerm = '';
      searchInput.value = '';
      closeCreateNotebookRow(false);
      showInlineReadyError(null);
      await loadNotebooks();
    } catch (err) {
      const { code, detail } = classifyError(err);
      showError(code, detail);
    }
  });

  const notebookList = document.getElementById('notebook-list');
  if (notebookList) {
    notebookList.addEventListener('keydown', handleNotebookListKeyDown);
  }

  safeBindClick('btn-download', () => {
    const btn = document.getElementById('btn-download');
    if (!btn) return;
    browser.runtime.sendMessage({
      action: 'DOWNLOAD_CAPTURE',
      fileType: btn.dataset.fileType || _currentFormat,
    }).catch((err) => {
      console.error('[NTC-UI] Échec du téléchargement :', err.message);
    });
  });

  safeBindClick('btn-open-notebook', () => {
    const btn = document.getElementById('btn-open-notebook');
    if (btn && btn.dataset.notebookUrl) {
      browser.tabs.create({ url: btn.dataset.notebookUrl }).catch(() => {});
    }
  });

  safeBindClick('btn-new-import', () => {
    _isCapturing = false;
    purgeBackgroundCaptureBuffer();
    loadEmailMeta().catch((err) => showError('UNKNOWN', err.message));
  });

  safeBindClick('btn-back', () => {
    _isCapturing = false;
    loadEmailMeta().catch((err) => showError('UNKNOWN', err.message));
  });

  safeBindClick('btn-reconnect', () => {
    // Le consentement explicite a déjà été accordé précédemment
    triggerConnectFlow(false);
  });

  // Libérer les buffers mémoire de l'Event Page MV3 à la fermeture de la popup
  window.addEventListener('pagehide', () => {
    stopKeepAlive();
    if (_canDownloadLastCapture && !_isCapturing) {
      purgeBackgroundCaptureBuffer();
    }
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
    if (typeof window.__ntcRenderErrorScreen === 'function') {
      window.__ntcRenderErrorScreen('CRASH INIT', `Error: ${err.message}\nStack: ${err.stack}`, false);
    }
    return;
  }

  showState('loading');

  let authStatus;
  try {
    authStatus = await browser.runtime.sendMessage({ action: 'GET_AUTH_STATUS' });
  } catch (err) {
    console.error('[NTC] GET_AUTH_STATUS failed :', err.message);
    syncConsentControls(false);
    showState('authRequired');
    return;
  }

  syncConsentControls(authStatus && authStatus.dataConsent);

  if (!authStatus || !authStatus.authReady) {
    showState('authRequired');
    return;
  }

  try {
    await loadEmailMeta();
  } catch (err) {
    console.error('[NTC] Erreur lors du chargement des métadonnées :', err.message, err.stack);
    showError('UNKNOWN', err.message);
  }
}

initPopup().catch((err) => {
  console.error('[NTC] Fatal in initPopup:', err);
});
