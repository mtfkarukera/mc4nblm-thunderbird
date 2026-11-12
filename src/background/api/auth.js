// auth.js — Authentification Google par cookies Gecko (Thunderbird 128+ ESR — MV3)
// Magic Clipper for Gemini Notebook
// Auteur : MTF Karukera
//
// Référence : API-REFERENCE.md §7 + AGENTS.md §5.1
// Ne jamais stocker les valeurs de cookies ni les jetons CSRF dans browser.storage.
// Toujours relire les cookies depuis le magasin Gecko via browser.cookies.getAll().

(function () {
  'use strict';

  const NBLM_URL = 'https://notebook.google.com/';
  const NBLM_LEGACY_URL = 'https://notebooklm.google.com/';
  const ACCOUNTS_URL = 'https://accounts.google.com/';
  const ROTATE_URL = 'https://accounts.google.com/RotateCookies';

  /** Nom de l'alarme périodique MV3 remplaçant setInterval (Event Page non-persistante) */
  const ROTATE_ALARM_NAME = 'ntc-rotate-cookies';
  /** Période d'alarme en minutes (9 min = 540s, cible ~550s) */
  const ROTATE_PERIOD_MINUTES = 9;
  /** Intervalle minimal entre deux rotations (60s) */
  const ROTATION_MIN_GAP_MS = 60000;
  /** Seuil d'échecs consécutifs avant purge d'état de rotation */
  const MAX_ROTATE_FAILURES = 3;

  // Tier 1 : obligatoires — bloquants si absents
  const TIER1_COOKIES = ['SID', '__Secure-1PSIDTS'];
  // Tier 2 : probabilistes — journalisés en debug si absents, non bloquants
  const TIER2_COOKIES = ['OSID', 'APISID', 'SAPISID'];

  // Verrous en vol (protègent contre les appels concurrents au sein d'un même réveil)
  let _isRotating = false;
  let _openingAuthTab = false;
  let _verifyingAuthTab = false;

  // Cache mémoire synchronisé avec browser.storage.session
  let _authTabId = null;
  let _lastRotateTs = 0;
  let _rotateFailCount = 0;

  // Callbacks enregistrés au top-level par background.js
  let _onAuthSuccess = null;
  let _onAuthClosed = null;

  // ─────────────────────────────────────────────
  // HELPERS SESSION STORAGE (MV3 EVENT PAGE)
  // ─────────────────────────────────────────────

  async function getStoredAuthTabId() {
    if (_authTabId !== null) return _authTabId;
    try {
      const data = await browser.storage.session.get(NtcUtils.SESSION_KEYS.AUTH_TAB_ID);
      const id = data[NtcUtils.SESSION_KEYS.AUTH_TAB_ID];
      if (typeof id === 'number') {
        _authTabId = id;
        return id;
      }
    } catch (_e) {
      // Fallback mémoire uniquement
    }
    return null;
  }

  async function setStoredAuthTabId(tabId) {
    _authTabId = tabId;
    try {
      if (tabId === null) {
        await browser.storage.session.remove(NtcUtils.SESSION_KEYS.AUTH_TAB_ID);
      } else {
        await browser.storage.session.set({ [NtcUtils.SESSION_KEYS.AUTH_TAB_ID]: tabId });
      }
    } catch (_e) {
      // Non bloquant
    }
  }

  async function loadRotateMeta() {
    if (_lastRotateTs > 0 || _rotateFailCount > 0) {
      return { lastRotateTs: _lastRotateTs, rotateFailCount: _rotateFailCount };
    }
    try {
      const data = await browser.storage.session.get(NtcUtils.SESSION_KEYS.ROTATE_META);
      const meta = data[NtcUtils.SESSION_KEYS.ROTATE_META];
      if (meta && typeof meta === 'object') {
        _lastRotateTs = Number(meta.lastRotateTs) || 0;
        _rotateFailCount = Number(meta.rotateFailCount) || 0;
      }
    } catch (_e) {
      // Fallback mémoire
    }
    return { lastRotateTs: _lastRotateTs, rotateFailCount: _rotateFailCount };
  }

  async function saveRotateMeta(lastRotateTs, rotateFailCount) {
    _lastRotateTs = lastRotateTs;
    _rotateFailCount = rotateFailCount;
    try {
      await browser.storage.session.set({
        [NtcUtils.SESSION_KEYS.ROTATE_META]: { lastRotateTs, rotateFailCount },
      });
    } catch (_e) {
      // Non bloquant
    }
  }

  // ─────────────────────────────────────────────
  // 1. COLLECTE ET VALIDATION DES COOKIES
  // ─────────────────────────────────────────────

  /**
   * Collecte les cookies d'authentification Gemini Notebook depuis le magasin Gecko.
   * Interroge en priorité https://notebook.google.com/ puis replie sur
   * https://notebooklm.google.com/ et https://accounts.google.com/ sans jamais
   * écraser un cookie déjà résolu sur l'hôte principal.
   *
   * @returns {Promise<Object>} - Map { cookieName: cookieValue }
   */
  async function collectGoogleCookies() {
    const cookieMap = {};
    const allowed = new Set([...TIER1_COOKIES, ...TIER2_COOKIES]);
    const candidateUrls = [NBLM_URL, NBLM_LEGACY_URL, ACCOUNTS_URL];

    for (const url of candidateUrls) {
      const cookies = await browser.cookies.getAll({ url });
      for (const c of cookies) {
        if (allowed.has(c.name) && !cookieMap[c.name] && c.value) {
          cookieMap[c.name] = c.value;
        }
      }
      // Dès que les cookies Tier 1 et OSID sont réunis sur l'hôte principal, inutile d'aller plus loin
      if (cookieMap.SID && cookieMap['__Secure-1PSIDTS'] && cookieMap.OSID) {
        break;
      }
    }
    return cookieMap;
  }

  /**
   * Valide la présence des cookies Tier 1 (bloquant) et Tier 2 (probabiliste).
   *
   * @param  {Object} cookieMap - Map produite par collectGoogleCookies().
   * @returns {{ valid: boolean }}
   */
  function validateCookies(cookieMap) {
    const missingTier1 = TIER1_COOKIES.filter(name => !cookieMap[name]);

    if (missingTier1.length > 0) {
      NtcUtils.log('Cookies Tier 1 manquants :', missingTier1.length);
      return { valid: false };
    }

    const hasTier2 = cookieMap.OSID || (cookieMap.APISID && cookieMap.SAPISID);
    if (!hasTier2) {
      NtcUtils.log('Aucun cookie Tier 2 (OSID ou APISID+SAPISID). Session potentiellement instable.');
    }

    return { valid: true };
  }

  // ─────────────────────────────────────────────
  // 2. TOKENS CSRF (WIZ_global_data)
  // ─────────────────────────────────────────────

  /**
   * Récupère la page d'accueil Gemini Notebook et extrait le jeton CSRF SNlM0e.
   * Doit être appelée AVANT chaque capture — ne jamais mettre SNlM0e en cache durable.
   *
   * @param  {number} authuserIndex - Index authuser actif (0..4).
   * @returns {Promise<{ csrfToken: string }>}
   * @throws {Error} - AUTH_EXPIRED (HTTP 401/403, redirection login ou SNlM0e absent) ou TIMEOUT.
   */
  async function fetchCSRFTokens(authuserIndex) {
    const safeIdx = NtcUtils.sanitizeAuthuserIndex(authuserIndex);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let html = '';

    try {
      const response = await fetch(`${NBLM_URL}?authuser=${safeIdx}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw NtcUtils.ntcError('AUTH_EXPIRED', 'AUTH_EXPIRED');
        }
        throw new Error(`HTTP ${response.status}`);
      }

      // Si Google a redirigé en HTTP 200 vers ServiceLogin / accounts.google.com
      if (response.url && response.url.includes('accounts.google.com')) {
        throw NtcUtils.ntcError('AUTH_EXPIRED', 'AUTH_EXPIRED');
      }

      html = await response.text();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw NtcUtils.ntcError('TIMEOUT', 'TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    const snlMatch = html.match(/"SNlM0e":"([^"]+)"/);
    if (!snlMatch) {
      throw NtcUtils.ntcError('AUTH_EXPIRED', 'AUTH_EXPIRED');
    }

    return { csrfToken: snlMatch[1] };
  }

  // ─────────────────────────────────────────────
  // 3. ROTATION DES COOKIES (Alarme MV3)
  // ─────────────────────────────────────────────

  /**
   * Planifie l'alarme périodique MV3 de rotation des cookies sans réinitialiser
   * une alarme déjà active lors des réveils successifs de l'Event Page.
   */
  async function startCookieRotationSchedule() {
    try {
      const existing = await browser.alarms.get(ROTATE_ALARM_NAME);
      if (!existing) {
        await browser.alarms.create(ROTATE_ALARM_NAME, {
          delayInMinutes: ROTATE_PERIOD_MINUTES,
          periodInMinutes: ROTATE_PERIOD_MINUTES,
        });
      }
    } catch (err) {
      NtcUtils.log('Impossible de planifier l\'alarme RotateCookies :', err.message);
    }
  }

  /**
   * Arrête l'alarme périodique MV3 de rotation des cookies.
   */
  async function stopCookieRotationSchedule() {
    try {
      await browser.alarms.clear(ROTATE_ALARM_NAME);
    } catch (_e) {
      // Ignorer
    }
  }

  /**
   * Réinitialise l'état local de session d'authentification (en cas d'expiration 401/403
   * ou de déconnexion demandée par l'utilisateur).
   */
  async function clearAuthSession() {
    await stopCookieRotationSchedule();
    _lastRotateTs = 0;
    _rotateFailCount = 0;
    try {
      await browser.storage.session.remove(NtcUtils.SESSION_KEYS.ROTATE_META);
    } catch (_e) {
      // Non bloquant
    }
  }

  /**
   * Émet un POST RotateCookies si le délai minimal est respecté.
   * Vérifie resp.ok pour ne jamais masquer une révocation 401/403.
   */
  async function rotateCookiesIfNeeded() {
    if (_isRotating) return;
    _isRotating = true;

    try {
      const meta = await loadRotateMeta();
      const now = Date.now();
      if (now - meta.lastRotateTs < ROTATION_MIN_GAP_MS) return;

      // Ne pas appeler RotateCookies si aucun cookie Tier 1 n'est présent
      const cookieMap = await collectGoogleCookies();
      if (!validateCookies(cookieMap).valid) {
        await stopCookieRotationSchedule();
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(ROTATE_URL, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'continue=https://notebook.google.com/',
          signal: controller.signal,
        });
        await resp.text().catch(() => '');

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        await saveRotateMeta(Date.now(), 0);
      } catch (err) {
        const failCount = meta.rotateFailCount + 1;
        await saveRotateMeta(meta.lastRotateTs, failCount);
        if (err.name === 'AbortError') {
          console.error('[NTC] RotateCookies timeout (10s)');
        } else {
          console.error('[NTC] RotateCookies en échec :', err.message);
        }
        if (failCount >= MAX_ROTATE_FAILURES) {
          console.error('[NTC] RotateCookies en échec répété — arrêt de l\'alarme périodique');
          await clearAuthSession();
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } finally {
      _isRotating = false;
    }
  }

  // ─────────────────────────────────────────────
  // 4. SETUP AUTH — Onglet WebContent (Listeners Top-Level MV3)
  // ─────────────────────────────────────────────

  /**
   * Enregistre les callbacks de cycle de vie de l'onglet d'authentification
   * au chargement top-level de l'Event Page.
   *
   * @param {{ onSuccess?: Function, onClosed?: Function }} callbacks
   */
  function setAuthTabCallbacks(callbacks) {
    if (callbacks && typeof callbacks.onSuccess === 'function') {
      _onAuthSuccess = callbacks.onSuccess;
    }
    if (callbacks && typeof callbacks.onClosed === 'function') {
      _onAuthClosed = callbacks.onClosed;
    }
  }

  /**
   * Listener top-level tabs.onUpdated : survit à l'endormissement de l'Event Page
   * pendant que l'utilisateur saisit ses identifiants et sa validation 2FA.
   */
  async function handleAuthTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;

    const trackedId = await getStoredAuthTabId();
    if (trackedId === null || tabId !== trackedId) return;

    // Attendre que l'onglet ait effectivement atterri sur Gemini Notebook (et non sur accounts.google.com)
    const currentUrl = (tab && tab.url) || changeInfo.url || '';
    if (
      currentUrl &&
      !currentUrl.startsWith(NBLM_URL) &&
      !currentUrl.startsWith(NBLM_LEGACY_URL)
    ) {
      return;
    }

    if (_verifyingAuthTab) return;
    _verifyingAuthTab = true;

    try {
      const cookieMap = await collectGoogleCookies();
      if (!validateCookies(cookieMap).valid) return;

      // Vérifier qu'un jeton SNlM0e est réellement disponible (évite de fermer l'onglet
      // prématurément si l'utilisateur doit d'abord accepter un écran d'accueil Gemini Notebook)
      await fetchCSRFTokens(0);

      // Effacer l'ID suivi AVANT browser.tabs.remove pour que handleAuthTabRemoved l'ignore
      await setStoredAuthTabId(null);
      await startCookieRotationSchedule();
      try {
        await browser.tabs.remove(tabId);
      } catch (_e) {
        // Onglet déjà refermé
      }

      if (typeof _onAuthSuccess === 'function') {
        _onAuthSuccess();
      }
    } catch (_err) {
      // Session pas encore finalisée dans l'onglet : laisser l'utilisateur poursuivre
    } finally {
      _verifyingAuthTab = false;
    }
  }

  /**
   * Listener top-level tabs.onRemoved : notifie la popup si l'utilisateur referme
   * manuellement l'onglet WebContent sans avoir terminé la connexion.
   */
  async function handleAuthTabRemoved(tabId) {
    const trackedId = await getStoredAuthTabId();
    if (trackedId === null || tabId !== trackedId) return;

    NtcUtils.log('Onglet auth refermé sans connexion complète');
    await setStoredAuthTabId(null);
    if (typeof _onAuthClosed === 'function') {
      _onAuthClosed();
    }
  }

  // Enregistrement synchrone au top-level requis par Manifest V3
  browser.tabs.onUpdated.addListener(handleAuthTabUpdated);
  browser.tabs.onRemoved.addListener(handleAuthTabRemoved);

  /**
   * Ouvre (ou remet au premier plan) l'onglet WebContent Thunderbird vers Gemini Notebook.
   *
   * @param {Function} [onSuccess] - Callback optionnel de succès.
   */
  async function openAuthWebContentTab(onSuccess) {
    if (typeof onSuccess === 'function') {
      _onAuthSuccess = onSuccess;
    }
    if (_openingAuthTab) return;
    _openingAuthTab = true;

    try {
      const existingId = await getStoredAuthTabId();
      if (existingId !== null) {
        try {
          const existingTab = await browser.tabs.get(existingId);
          await browser.tabs.update(existingId, { active: true });
          if (existingTab && typeof existingTab.windowId === 'number') {
            await browser.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
          }
          return;
        } catch (_e) {
          await setStoredAuthTabId(null);
        }
      }

      const tab = await browser.tabs.create({ url: NBLM_URL });
      await setStoredAuthTabId(tab.id);
    } finally {
      _openingAuthTab = false;
    }
  }

  // ─────────────────────────────────────────────
  // 5. DÉTECTION MULTI-COMPTES
  // ─────────────────────────────────────────────

  /**
   * Itère sur authuser=0..4 pour détecter les comptes Google connectés.
   * S'arrête dès qu'une redirection 302 vers accounts.google.com survient.
   *
   * @returns {Promise<Array<{ index: number, email: string }>>}
   */
  async function detectGoogleAccounts() {
    const accounts = [];
    for (let index = 0; index < 5; index++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(`${NBLM_URL}?authuser=${index}`, {
          method: 'GET',
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal,
        });

        if (resp.type === 'opaqueredirect' || resp.status === 302 || !resp.ok) {
          break;
        }

        const html = await resp.text();
        // Extraction prioritaire via WIZ_global_data "oPEP7c"
        const wizMatch = html.match(/"oPEP7c":"([^"@]+@[^"]+)"/);
        let email;
        if (wizMatch) {
          email = wizMatch[1];
        } else {
          const emailMatches = [...new Set(html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
          email = emailMatches.find(e => e.includes('@')) || `account-${index}`;
        }

        // Si Google replie sur un compte déjà listé, fin des comptes actifs
        if (accounts.some(acc => acc.email === email)) {
          break;
        }

        accounts.push({ index, email });
      } catch (_err) {
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return accounts;
  }

  // Exposition globale sur l'Event Page MV3
  window.NtcAuth = {
    ROTATE_ALARM_NAME,
    collectGoogleCookies,
    validateCookies,
    fetchCSRFTokens,
    rotateCookiesIfNeeded,
    startCookieRotationSchedule,
    stopCookieRotationSchedule,
    clearAuthSession,
    setAuthTabCallbacks,
    openAuthWebContentTab,
    detectGoogleAccounts,
  };
})();
