// auth_personal.js : Rétro-ingénierie d'authentification pour les comptes Google classiques

// Les cookies de session (SID, HSID, SSID, etc.) sont extraits automatiquement
// par browser.cookies.getAll() sur le domaine notebooklm.google.com.

/**
 * Lit les cookies de session NotebookLM depuis le cookie jar Firefox et les stocke
 * dans browser.storage.local pour les requêtes RPC ultérieures.
 *
 * @returns {Promise<string>} - Chaîne cookie concaténée (ex: "SID=…; HSID=…").
 * @throws  {Error}           - Si aucun cookie n'est trouvé (utilisateur déconnecté).
 */
export async function getPersonalAuthCookies() {
  // L'URL exacte sur laquelle interroger le cookie jar de Firefox
  const cookies = await browser.cookies.getAll({ url: "https://notebooklm.google.com/" });

  if (cookies.length === 0) {
    throw new Error(`Aucun cookie trouvé. Veuillez vous connecter à NotebookLM dans un nouvel onglet.`);
  }

  // On concatène tous les cookies sans filtrage strict,
  // car certains cookies secondaires peuvent manquer sans casser l'API.
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Stockage sécurisé en mémoire MV3 (sans log)
  await browser.storage.local.set({ nblm_personal_cookie: cookieString });
  return cookieString;
}

/**
 * Récupère le jeton CSRF dynamique SNlM0e depuis la page NotebookLM.
 * Ce jeton est requis pour signer chaque payload batchexecute.
 * Le jeton extrait est stocké dans browser.storage.local sous la clé nblm_csrf.
 *
 * @param  {string} cookieString      - Chaîne cookie produite par getPersonalAuthCookies().
 * @param  {number} [authuserIndex=0] - Index du compte Google actif (multi-compte).
 * @returns {Promise<string>}          - Jeton CSRF SNlM0e prêt à être injecté dans les payloads.
 * @throws  {Error}                    - Si la session est expirée (401/403) ou si le token est absent de la page.
 */
export async function fetchCSRFToken(cookieString, authuserIndex = 0) {
  // Le token SNlM0e est indispensable pour la signature des charges utiles batchexecute
  const response = await fetch(`https://notebooklm.google.com/?authuser=${authuserIndex}`, {
    method: 'GET',
    headers: {
       'Cookie': cookieString,
       'User-Agent': navigator.userAgent
    }
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      await browser.storage.local.remove('nblm_personal_cookie');
      throw new Error("Session NotebookLM expirée (HTTP 401/403).");
    }
    throw new Error(`HTTP Error ${response.status}`);
  }

  const html = await response.text();

  // Rétro-ingénierie : Capter la variable SNlM0e dynamique
  const match = html.match(/"SNlM0e":"([^"]+)"/);
  if (match && match[1]) {
    const csrfToken = match[1];
    await browser.storage.local.set({ nblm_csrf: csrfToken });
    return csrfToken;
  } else {
    throw new Error("Token CSRF SNlM0e introuvable sur la page.");
  }
}

/**
 * Détecte les comptes Google connectés en sondant séquentiellement les index authuser.
 * S'arrête dès qu'une redirection vers accounts.google.com est détectée (index invalide)
 * ou qu'aucun email ne peut être extrait de la page.
 *
 * @param  {string} cookieString - Chaîne cookie produite par getPersonalAuthCookies().
 * @returns {Promise<Array<{index: number, email: string}>>} - Tableau des comptes détectés.
 */
export async function detectGoogleAccounts(cookieString) {
  const accounts = [];
  const MAX_ACCOUNTS = 5;
  const assignedEmails = new Set(); // Emails déjà attribués à un index

  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    try {
      const response = await fetch(`https://notebooklm.google.com/?authuser=${i}`, {
        method: 'GET',
        headers: { 'Cookie': cookieString },
        redirect: 'manual'  // Ne pas suivre les redirections automatiquement
      });

      // HTTP 302/303 vers login = ce compte n'existe pas
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location') || '';
        if (location.includes('accounts.google.com') || location.includes('ServiceLogin')) {
          break;
        }
        // Redirection non-login (ex: HTTPS, dashboard) → on continue
        continue;
      }

      // Si la réponse est une redirection suivie automatiquement vers login
      if (response.url && (response.url.includes('accounts.google.com') || response.url.includes('ServiceLogin'))) {
        break;
      }

      // Erreur serveur (5xx, 4xx) — arrêter
      if (!response.ok) break;

      const html = await response.text();

      // Stratégie d'extraction robuste :
      // 1. D'abord, chercher la clé WIZ spécifique "oPEP7c" (email du user actif sur cette page)
      const wizMatch = html.match(/"oPEP7c":"([^"]+@[^"]+)"/);
      if (wizMatch && wizMatch[1] && !assignedEmails.has(wizMatch[1])) {
        assignedEmails.add(wizMatch[1]);
        accounts.push({ index: i, email: wizMatch[1] });
        continue;
      }

      // 2. Sinon, collecter TOUS les emails de la page et prendre le premier non-attribué
      const allEmailMatches = [...html.matchAll(/"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/g)]
        .map(m => m[1])
        .filter(e => !e.includes('example.com') && !e.includes('gstatic.com') && !e.includes('google.com'));

      const uniqueEmail = allEmailMatches.find(e => !assignedEmails.has(e));

      if (uniqueEmail) {
        assignedEmails.add(uniqueEmail);
        accounts.push({ index: i, email: uniqueEmail });
      } else if (allEmailMatches.length > 0) {
        // Tous les emails déjà vus : ce n'est probablement pas un nouveau compte
        break;
      } else {
        // Aucun email trouvé mais page valide
        accounts.push({ index: i, email: `Compte ${i + 1}` });
      }
    } catch (err) {
      console.warn(`[MC] detectGoogleAccounts — arrêt à l'index ${i}:`, err.message);
      break;
    }
  }

  return accounts;
}
