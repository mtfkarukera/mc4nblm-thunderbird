// orchestrator.js — Point d'entrée du Content Script
// VERSION 5.2 : Pipeline Readability → jsPDF (PDF) ou Markdown (texte)

/**
 * Routeur de messages du content script.
 * Écoute les messages émis par background.js vers l'onglet actif.
 *
 * Handlers :
 * - CAPTURE_CONTENT  : déclenche le pipeline PDF ou Markdown (via handleCapture).
 * - GET_SELECTION_HTML : retourne le HTML de la sélection active (menu contextuel).
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CAPTURE_CONTENT") {

    const format = message.format || "pdf";
    const intentNote = message.intentNote ?? null;

    handleCapture(format, intentNote)
      .then(result => sendResponse({
        status: "SUCCESS",
        payload: result,
        format: format
      }))
      .catch(error => {
        console.error('[MC] Capture échouée:', error.message || String(error));
        sendResponse({ status: "ERROR", error: error.message || String(error) });
      });

    // return true = on va répondre de manière asynchrone
    return true;
  }

  // Capturer le HTML de la sélection (demandé par le menu contextuel)
  if (message.action === "GET_SELECTION_HTML") {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const fragment = range.cloneContents();
      const wrapper = document.createElement('div');
      wrapper.appendChild(fragment);
      const serializer = new XMLSerializer();
      sendResponse({ html: serializer.serializeToString(wrapper) });
    } else {
      sendResponse({ html: null });
    }
    return;
  }
});

/**
 * Orchestre le pipeline de capture complet pour un onglet :
 *   1. Vérification des quotas (PDF uniquement — 500 000 mots max)
 *   2. Serializer V9 (readability-content-extractor) → container HTML autonome
 *   3a. PDF Generator V7 (jsPDF) → Base64 PDF        [format=pdf]
 *   3b. Markdown Generator V1 → texte Markdown structuré [format=md]
 *
 * @param  {string}      format     - Format de sortie : "pdf" ou "md".
 * @param  {string|null} intentNote - Annotation d'intention optionnelle (§8 AGENTS.md).
 * @returns {Promise<string>}        - Base64 data URI (PDF) ou texte Markdown brut.
 */
async function handleCapture(format, intentNote = null) {

  // 1. Quotas (seulement pour PDF, le Markdown est toujours léger)
  if (format === "pdf") {
    window.ClipperPDFGenerator.checkWordCountQuota();
  }

  // 2. Préparer un clone du body (utilisé en fallback par le serializer)
  const wrapperClone = document.createElement('div');
  wrapperClone.appendChild(document.body.cloneNode(true));

  // 3. Serializer : extraction + container Reader Mode + images data URIs
  const container = await window.ClipperSerializer.process(wrapperClone);

  if (format === "md") {
    // 4a. Markdown Generator : texte structuré
    const markdown = window.ClipperMarkdownGenerator.generate(container, intentNote);
    return markdown;
  } else {
    // 4b. PDF Generator : jsPDF sur le container autonome
    const base64Pdf = await window.ClipperPDFGenerator.generate(container, intentNote);
    return base64Pdf;
  }
}
