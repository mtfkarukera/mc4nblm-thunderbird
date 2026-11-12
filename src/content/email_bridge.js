// email_bridge.js — MessageDisplayScript (point d'entrée email)
// Magic Clipper for Gemini Notebook (Thunderbird 128+ ESR — Manifest V3)
// Auteur : MTF Karukera
//
// Enregistré via messenger.scripting.messageDisplay.registerScripts().
// Écoute les messages du background et relaie les requêtes de génération PDF.
//
// Ce script tourne dans le contexte de l'onglet d'affichage de l'email.
// Tout appel réseau vers Google passe exclusivement par le background.

'use strict';

// Sentinelle de déduplication (toute ré-injection one-shot est inoffensive)
if (!window.__ntc_email_bridge) {
  window.__ntc_email_bridge = true;

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return false;

    // Ping de vérification — retourne l'état du bridge et du générateur PDF
    if (message.action === 'PING_BRIDGE') {
      return Promise.resolve({
        bridgeReady: true,
        pdfReady: typeof window.__ntc_generate_pdf === 'function',
        jspdfReady:
          typeof window.jspdf !== 'undefined' ||
          typeof jspdf !== 'undefined' ||
          typeof window.jsPDF !== 'undefined' ||
          (typeof globalThis !== 'undefined' && typeof globalThis.jsPDF !== 'undefined'),
      });
    }

    if (message.action !== 'CAPTURE_EMAIL_PDF') return false;

    if (typeof window.__ntc_generate_pdf !== 'function') {
      browser.runtime.sendMessage({
        action: 'CAPTURE_ERROR',
        captureId: message.captureId,
        code: 'INJECTION_FAILED',
        detail:
          'email_pdf_generator.js non injecté (jspdf: ' +
          (typeof window.jspdf !== 'undefined' ? 'OK' : 'ABSENT') +
          ')',
      }).catch(() => {});
      return false;
    }

    window.__ntc_generate_pdf(message.grounding, message.intentNote, message.labels)
      .then((result) => {
        const pdfBase64 = typeof result === 'string' ? result : result.pdfBase64;
        const hasNonLatinGlyphs = Boolean(result && result.hasNonLatinGlyphs);
        browser.runtime.sendMessage({
          action: 'PDF_READY',
          captureId: message.captureId,
          pdfBase64,
          hasNonLatinGlyphs,
          title: message.grounding ? message.grounding.subject : 'email',
        }).catch(() => {});
      })
      .catch((err) => {
        browser.runtime.sendMessage({
          action: 'CAPTURE_ERROR',
          captureId: message.captureId,
          code: (err && err.code) || 'INJECTION_FAILED',
          detail: err ? err.message : 'Erreur PDF',
        }).catch(() => {});
      });

    return false;
  });
}
