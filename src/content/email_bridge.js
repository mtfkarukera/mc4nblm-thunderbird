// email_bridge.js — MessageDisplayScript (point d'entrée email)
// NotebookLM Clipper for Thunderbird
//
// Enregistré au démarrage via messenger.messageDisplayScripts.register().
// Écoute les messages du background et relaie les requêtes PDF.
//
// ⚠️ Ce script tourne dans le contexte de l'onglet d'affichage de l'email.
//    Il ne peut PAS faire de fetch() réseau (soumis au CORS de l'email).
//    Tout réseau doit passer par le background.

'use strict';

// ── Sentinelle de déduplication ────────────────────────────────────────────
// Empêche la double-exécution si le script est injecté plusieurs fois.
if (window.__ntc_email_bridge) {
  // Déjà chargé — ne rien faire
} else {
  window.__ntc_email_bridge = true;

  browser.runtime.onMessage.addListener((message) => {
    // Ping de vérification — retourne l'état du bridge et du PDF generator
    if (message.action === 'PING_BRIDGE') {
      return Promise.resolve({
        bridgeReady: true,
        pdfReady: typeof window.__ntc_generate_pdf === 'function',
        jspdfReady: (typeof window.jspdf !== 'undefined') || (typeof jspdf !== 'undefined') || (typeof window.jsPDF !== 'undefined') || (typeof globalThis !== 'undefined' && typeof globalThis.jsPDF !== 'undefined')
      });
    }

    if (message.action !== 'CAPTURE_EMAIL_PDF') return;

    // Vérifier que le PDF generator est chargé
    if (typeof window.__ntc_generate_pdf !== 'function') {
      browser.runtime.sendMessage({
        action: 'CAPTURE_ERROR',
        code:   'INJECTION_FAILED',
        detail: 'email_pdf_generator.js non injecté (jspdf: ' +
                (typeof window.jspdf !== 'undefined' ? 'OK' : 'ABSENT') + ')'
      });
      return;
    }

    // Appel de la fonction exposée par email_pdf_generator.js
    window.__ntc_generate_pdf(message.grounding, message.intentNote)
      .then(pdfBase64 => {
        browser.runtime.sendMessage({
          action:    'PDF_READY',
          pdfBase64,
          title:     message.grounding ? message.grounding.subject : 'email',
        });
      })
      .catch(err => {
        browser.runtime.sendMessage({
          action: 'CAPTURE_ERROR',
          code:   'INJECTION_FAILED',
          detail: err.message,
        });
      });
  });
}
