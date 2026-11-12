// pre_loader.js — Script d'écoute précoce des erreurs critiques
// Magic Clipper for Gemini Notebook — Thunderbird 128+ ESR (Manifest V3)
// Auteur : MTF Karukera
// Chargé en premier dans popup.html pour intercepter les erreurs avant tout autre script.

'use strict';

/**
 * Affiche un écran d'erreur critique de secours dans le DOM et isole le reste de l'UI.
 *
 * @param {string} title - Titre du panneau.
 * @param {string} details - Détails de l'erreur / stack trace.
 * @param {boolean} isLoadError - Vrai s'il s'agit d'une erreur de chargement.
 */
function renderErrorScreen(title, details, isLoadError) {
  if (document.getElementById('ntc-critical-error-screen')) return;

  // Isoler l'application principale pour les technologies d'assistance
  const mainApp = document.getElementById('popup-app');
  if (mainApp) {
    mainApp.inert = true;
    mainApp.setAttribute('aria-hidden', 'true');
  }

  const div = document.createElement('div');
  div.id = 'ntc-critical-error-screen';
  div.setAttribute('role', 'alert');
  div.style.position = 'fixed';
  div.style.top = '0';
  div.style.left = '0';
  div.style.width = '100%';
  div.style.height = '100%';
  div.style.background = isLoadError ? '#4b0082' : '#8b0000';
  div.style.color = '#ffffff';
  div.style.padding = '15px';
  div.style.zIndex = '999999';
  div.style.fontFamily = 'monospace';
  div.style.fontSize = '11px';
  div.style.lineHeight = '1.4';
  div.style.overflow = 'auto';
  div.style.boxSizing = 'border-box';
  div.style.whiteSpace = 'pre-wrap';
  div.textContent = `${title}\n\n${details}`;

  if (document.body) {
    document.body.appendChild(div);
  } else {
    document.documentElement.appendChild(div);
  }
}

// Exposé pour popup.js afin d'éviter toute duplication d'écran critique dans initPopup()
window.__ntcRenderErrorScreen = renderErrorScreen;

// Écouteur global en phase de CAPTURE (intercepte les erreurs de ressources <script>/<link>)
window.addEventListener('error', function (e) {
  if (e.target && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) {
    const url = e.target.src || e.target.href || 'Inconnue';
    console.error('[NTC-LOADER] Échec du chargement de la ressource :', url);
    renderErrorScreen(
      'ERREUR DE CHARGEMENT RESSOURCE',
      `Impossible de charger la ressource :\n${url}\n\nTag : <${e.target.tagName.toLowerCase()}>`,
      true
    );
    return;
  }

  const message = e.message || 'Erreur inconnue';
  const filename = e.filename || 'Inconnu';
  const lineno = e.lineno || 0;
  const colno = e.colno || 0;
  const stack = e.error ? e.error.stack : 'N/A';

  console.error('[NTC-LOADER] Erreur d\'exécution capturée :', message, 'dans', filename, 'ligne', lineno);

  renderErrorScreen(
    'ERREUR D\'EXÉCUTION RUNTIME',
    `Message : ${message}\nFichier : ${filename}\nLigne   : ${lineno}:${colno}\n\nStack   : ${stack}`,
    false
  );
}, true);
