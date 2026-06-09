// pre_loader.js — Script d'écoute précoce des erreurs
// NotebookLM Clipper for Thunderbird
// Chargé en premier dans popup.html pour intercepter les erreurs avant tout autre script.

'use strict';

console.warn("[NTC-LOADER] Enregistrement de l'écouteur d'erreurs global...");

/**
 * Affiche un écran d'erreur critique de secours dans le DOM.
 *
 * @param {string} title - Titre du panneau.
 * @param {string} details - Détails de l'erreur / stack trace.
 * @param {boolean} isLoadError - Vrai s'il s'agit d'une erreur de chargement.
 */
function renderErrorScreen(title, details, isLoadError) {
  // Ne pas superposer plusieurs écrans
  if (document.getElementById('ntc-critical-error-screen')) return;

  const div = document.createElement('div');
  div.id = 'ntc-critical-error-screen';
  div.style.position = 'fixed';
  div.style.top = '0';
  div.style.left = '0';
  div.style.width = '100%';
  div.style.height = '100%';
  div.style.background = isLoadError ? '#4b0082' : '#8b0000'; // Indigo pour chargement, Rouge pour runtime
  div.style.color = '#ffffff';
  div.style.padding = '15px';
  div.style.zIndex = '999999';
  div.style.fontFamily = 'monospace';
  div.style.fontSize = '11px';
  div.style.lineHeight = '1.4';
  div.style.overflow = 'auto';
  div.style.boxSizing = 'border-box';
  div.textContent = `${title}\n\n${details}`;
  
  if (document.body) {
    document.body.appendChild(div);
  } else {
    document.documentElement.appendChild(div);
  }
}

// Exposé pour popup.js (factorisation revue 2026-06-10) — évite de dupliquer
// le bloc d'écran d'erreur stylé dans initPopup().
window.__ntcRenderErrorScreen = renderErrorScreen;

// Écouteur global en phase de CAPTURE (indispensable pour intercepter les erreurs de chargement qui ne propagent pas)
window.addEventListener('error', function(e) {
  // 1. Cas d'un échec de chargement de ressource (ex: <script src="..."> qui renvoie un 404 ou CSP block)
  if (e.target && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) {
    const url = e.target.src || e.target.href || 'Inconnue';
    console.error("[NTC-LOADER] Échec du chargement de la ressource :", url);
    renderErrorScreen(
      "ERREUR DE CHARGEMENT RESOURCE",
      `Impossible de charger la ressource :\n${url}\n\nTag : <${e.target.tagName.toLowerCase()}>`,
      true
    );
    return;
  }

  // 2. Cas d'une erreur d'exécution Javascript standard (runtime error)
  const message = e.message || "Erreur inconnue";
  const filename = e.filename || "Inconnu";
  const lineno = e.lineno || 0;
  const colno = e.colno || 0;
  const stack = e.error ? e.error.stack : 'N/A';
  
  console.error("[NTC-LOADER] Erreur d'exécution capturée :", message, "dans", filename, "à la ligne", lineno);
  
  renderErrorScreen(
    "ERREUR D'EXÉCUTION RUNTIME",
    `Message : ${message}\nFichier : ${filename}\nLigne   : ${lineno}:${colno}\n\nStack   : ${stack}`,
    false
  );
}, true); // true = phase de capture (CRITIQUE)

