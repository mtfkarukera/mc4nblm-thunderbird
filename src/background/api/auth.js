// auth.js — Authentification Google par cookies Gecko (Thunderbird MV2)
// NotebookLM Clipper for Thunderbird
//
// Référence : API-REFERENCE.md §7 + AGENTS.md §5.1
// ⚠️ Ne jamais stocker les valeurs de cookies dans browser.storage.local.
// ⚠️ Toujours les relire depuis le cookie store Gecko via browser.cookies.getAll().

'use strict';

const NBLM_URL       = 'https://notebooklm.google.com/';
const ROTATE_URL     = 'https://accounts.google.com/RotateCookies';
const GOOGLE_DOMAINS = ['google.com', 'notebooklm.google.com', 'accounts.google.com'];

// Tier 1 : obligatoires — bloquants si absents
const TIER1_COOKIES  = ['SID', '__Secure-1PSIDTS'];
// Tier 2 : probabilistes — warnings si absents, non bloquants
const TIER2_COOKIES  = ['OSID', 'APISID', 'SAPISID'];

// Throttle RotateCookies : min 60s entre deux appels
let _lastRotateTs    = 0;
let _rotationTimer   = null;
let _authTabId       = null;   // Tab WebContent ouvert pour le setup

const ROTATION_INTERVAL_MS = 550000;
const ROTATION_MIN_GAP_MS  =  60000;

// P1.9 — Compteur d'échecs consécutifs de RotateCookies
let _rotateFailCount = 0;

// ─────────────────────────────────────────────
// 1. COLLECTE ET VALIDATION DES COOKIES
// ─────────────────────────────────────────────

/**
 * Collecte tous les cookies Google depuis le store Gecko de Thunderbird.
 * Itère sur les domaines GOOGLE_DOMAINS — la dernière valeur pour un nom donné gagne
 * (domaine le plus spécifique en dernier dans la liste).
 *
 * @returns {Promise<Object>} - Map { cookieName: cookieValue }
 */
async function collectGoogleCookies() {
  const cookieMap = {};
  const allowed = new Set([...TIER1_COOKIES, ...TIER2_COOKIES]);
  for (const domain of GOOGLE_DOMAINS) {
    const cookies = await browser.cookies.getAll({ domain });
    for (const c of cookies) {
      if (allowed.has(c.name)) {
        cookieMap[c.name] = c.value;
      }
    }
  }
  return cookieMap;
}

/**
 * Valide la présence des cookies Tier 1 (bloquant) et Tier 2 (probabiliste).
 *
 * Sprint 2 (v1.0.5) : retourne { valid } uniquement — `cookieString` et
 * `buildCookieString()` supprimés (plus aucun consommateur depuis le retrait
 * du header Cookie manuel en v1.0.4).
 *
 * @param  {Object}  cookieMap - Map produite par collectGoogleCookies().
 * @returns {{ valid: boolean }}
 */
function validateCookies(cookieMap) {
  const missingTier1 = TIER1_COOKIES.filter(name => !cookieMap[name]);

  if (missingTier1.length > 0) {
    NtcUtils.log('Cookies Tier 1 manquants :', missingTier1);
    return { valid: false };
  }

  const hasTier2 = cookieMap['OSID'] || (cookieMap['APISID'] && cookieMap['SAPISID']);

  if (!hasTier2) {
    NtcUtils.log('Aucun cookie Tier 2 (OSID ou APISID+SAPISID). Session peut être instable.');
  }

  return { valid: true };
}

// ─────────────────────────────────────────────
// 2. TOKENS CSRF
// ─────────────────────────────────────────────

/**
 * Fetche la page NotebookLM et extrait SNlM0e (token CSRF).
 * ⚠️ Doit être appelée AVANT chaque capture — ne jamais réutiliser un token mis en cache.
 *
 * Sprint 2 (v1.0.5) : FdrFJe (session ID) n'est plus extrait — jamais consommé
 * par aucun payload RPC. Regex documentée dans API-REFERENCE.md §CSRF si besoin futur.
 * La clé storage AUTH_READY n'est plus écrite (jamais lue — GET_AUTH_STATUS
 * recalcule depuis les cookies).
 *
 * @param  {number} authuserIndex   - Index authuser actif (0..4).
 * @returns {Promise<{ csrfToken: string }>}
 * @throws {Error} - AUTH_EXPIRED (HTTP 401/403 ou SNlM0e introuvable), ou erreur réseau.
 */
async function fetchCSRFTokens(authuserIndex) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${NBLM_URL}?authuser=${authuserIndex}`, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const e = new Error('TIMEOUT');
      e.code = 'TIMEOUT';
      throw e;
    }
    throw err;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const err = new Error('AUTH_EXPIRED');
      err.code = 'AUTH_EXPIRED';
      throw err;
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();

  const snlMatch = html.match(/"SNlM0e":"([^"]+)"/);

  // Pas de token CSRF dans la page (page de consentement, compte non connecté
  // à NotebookLM, etc.) → session inutilisable : AUTH_EXPIRED explicite.
  // Ne JAMAIS retourner csrfToken: null silencieusement (revue 2026-06-10).
  if (!snlMatch) {
    const err = new Error('AUTH_EXPIRED');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  return { csrfToken: snlMatch[1] };
}

// ─────────────────────────────────────────────
// 3. ROTATION DES COOKIES (RotateCookies)
// ─────────────────────────────────────────────

/**
 * Émet un POST RotateCookies si le délai minimum est respecté.
 * credentials: 'include' → Gecko attache les cookies et met à jour
 * __Secure-1PSIDTS automatiquement. Ne JAMAIS poser de header `Cookie`
 * manuel : header interdit, silencieusement ignoré par fetch (revue 2026-06-10).
 */
async function rotateCookiesIfNeeded() {
  const now = Date.now();
  if (now - _lastRotateTs < ROTATION_MIN_GAP_MS) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch(ROTATE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'continue=https://notebooklm.google.com/',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    _lastRotateTs = Date.now();
    _rotateFailCount = 0;
  } catch (e) {
    clearTimeout(timeoutId);
    _rotateFailCount++;
    if (e.name === 'AbortError') {
      console.error('[NTC] RotateCookies timeout (10s)');
    } else {
      console.error('[NTC] RotateCookies échoué :', e.message);
    }
    if (_rotateFailCount >= 3) {
      console.error('[NTC] RotateCookies failed ' + _rotateFailCount + ' consecutive times — session may expire soon');
    }
  }
}

/**
 * Démarre le planning de rotation des cookies (toutes les 550s).
 * À appeler après un setup d'auth réussi.
 */
function startCookieRotationSchedule() {
  if (_rotationTimer) clearInterval(_rotationTimer);
  _rotationTimer = setInterval(rotateCookiesIfNeeded, ROTATION_INTERVAL_MS);
}

/**
 * Arrête le planning de rotation des cookies.
 */
function stopCookieRotationSchedule() {
  if (_rotationTimer) {
    clearInterval(_rotationTimer);
    _rotationTimer = null;
  }
}

// ─────────────────────────────────────────────
// 4. SETUP AUTH — WebContent Tab
// ─────────────────────────────────────────────

/**
 * Ouvre un onglet WebContent Thunderbird vers NotebookLM pour le setup initial.
 * Écoute tabs.onUpdated pour détecter que l'utilisateur est connecté.
 * Ferme l'onglet automatiquement et notifie le background via le callback onSuccess.
 *
 * @param {Function} onSuccess - Appelée sans arguments quand la connexion est détectée.
 */
async function openAuthWebContentTab(onSuccess) {
  // Éviter d'ouvrir plusieurs onglets d'auth
  if (_authTabId !== null) {
    try {
      await browser.tabs.get(_authTabId);
      // Si on arrive ici, l'onglet existe encore — ne pas en rouvrir
      return;
    } catch (_e) {
      _authTabId = null;
    }
  }

  const tab = await browser.tabs.create({ url: NBLM_URL });
  _authTabId = tab.id;

  // Nettoyage commun : retire les DEUX listeners + reset _authTabId.
  // Indispensable pour éviter la fuite de listener si l'utilisateur ferme
  // l'onglet sans se connecter (revue 2026-06-10).
  function cleanup() {
    browser.tabs.onUpdated.removeListener(onTabUpdated);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    _authTabId = null;
  }

  async function onTabUpdated(tabId, changeInfo) {
    if (tabId !== _authTabId) return;
    if (changeInfo.status !== 'complete') return;

    // Vérifier si les cookies Tier 1 sont maintenant présents
    const cookieMap = await collectGoogleCookies();
    const { valid } = validateCookies(cookieMap);

    if (valid) {
      const tabToClose = _authTabId;
      cleanup();
      try { await browser.tabs.remove(tabToClose); } catch (_e) { /* déjà fermé */ }
      onSuccess();
    }
  }

  function onTabRemoved(tabId) {
    if (tabId !== _authTabId) return;
    // Onglet d'auth fermé manuellement sans connexion détectée
    NtcUtils.log('Onglet auth fermé sans connexion — nettoyage des listeners');
    cleanup();
  }

  browser.tabs.onUpdated.addListener(onTabUpdated);
  browser.tabs.onRemoved.addListener(onTabRemoved);
}

// ─────────────────────────────────────────────
// 5. DÉTECTION MULTI-COMPTES
// ─────────────────────────────────────────────

/**
 * Itère sur authuser=0..4 pour détecter les comptes Google connectés.
 * S'arrête sur HTTP 302 vers accounts.google.com (compte inexistant).
 *
 * @returns {Promise<Array<{ index: number, email: string }>>}
 */
async function detectGoogleAccounts() {
  const accounts = [];
  for (let index = 0; index < 5; index++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let resp;
      try {
        resp = await fetch(`${NBLM_URL}?authuser=${index}`, {
          method: 'GET',
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') break; // Timeout → stop probing
        throw fetchErr;
      }

      if (resp.type === 'opaqueredirect' || resp.status === 302) break;
      if (!resp.ok) break;

      const html = await resp.text();
      // Tentative d'extraction via WIZ_global_data "oPEP7c"
      const wizMatch = html.match(/"oPEP7c":"([^"@]+@[^"]+)"/);
      let email;
      if (wizMatch) {
        email = wizMatch[1];
      } else {
        // Fallback : scan des adresses email dans le HTML
        const emailMatches = [...new Set(html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])];
        email = emailMatches.find(e => e.includes('@')) || `account-${index}`;
      }

      // Si l'email est déjà enregistré, c'est que Google redirige vers le compte par défaut (fin de liste)
      if (accounts.some(acc => acc.email === email)) {
        break;
      }

      accounts.push({ index, email });
    } catch (_e) {
      break;
    }
  }
  return accounts;
}

// Exposition globale (MV2 — background scripts partagent le même scope global)
// eslint-disable-next-line no-unused-vars
var NtcAuth = {
  collectGoogleCookies,
  validateCookies,
  fetchCSRFTokens,
  rotateCookiesIfNeeded,
  startCookieRotationSchedule,
  stopCookieRotationSchedule,
  openAuthWebContentTab,
  detectGoogleAccounts,
};
