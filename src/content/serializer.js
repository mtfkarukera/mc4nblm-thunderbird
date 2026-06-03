window.nwcserializer = true;
// serializer.js — Rôle : readability-content-extractor
// VERSION 9 : Extraction Readability → Container autonome → Tainted Canvas Protection
//
// RESPONSABILITÉS (skill readability-content-extractor) :
// 1. Cloner le document (JAMAIS le document live)
// 2. Extraire via Readability.parse() avec fallback vers document.body
// 3. Construire un container HTML virtuel avec métadonnées de grounding
// 4. Appliquer la protection "Tainted Canvas" (images → data URIs)
// 5. Appliquer un CSS minimaliste (Reader Mode)
// 6. Retourner un container 100% autonome, prêt pour jsPDF
//
// Ce module ne "convertit" rien en PDF. Il prépare le DOM.

window.ClipperSerializer = {

  // =====================================================================
  // CSS Reader Mode — typographie lisible, tables bordurées, images fluides
  // Readability SUPPRIME tous les styles d'origine de la page.
  // Ce CSS est le seul style appliqué au container.
  // =====================================================================
  READER_CSS: `
    .clipper-reader {
      font-family: Georgia, 'Times New Roman', serif;
      max-width: 680px;
      margin: 0 auto;
      padding: 20px 24px;
      color: #1a1a1a;
      line-height: 1.7;
      font-size: 15px;
      background: #ffffff;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .clipper-reader h1 {
      font-size: 26px; font-weight: bold;
      margin: 0 0 16px 0; line-height: 1.3; color: #111;
    }
    .clipper-reader h2 {
      font-size: 21px; font-weight: bold;
      margin: 28px 0 12px 0; color: #222;
    }
    .clipper-reader h3 {
      font-size: 17px; font-weight: bold;
      margin: 20px 0 8px 0; color: #333;
    }
    .clipper-reader h4, .clipper-reader h5, .clipper-reader h6 {
      font-size: 15px; font-weight: bold;
      margin: 16px 0 6px 0; color: #444;
    }
    .clipper-reader p { margin: 0 0 12px 0; }
    .clipper-reader img {
      max-width: 100%; height: auto;
      margin: 14px 0; display: block;
    }
    .clipper-reader table {
      border-collapse: collapse; width: 100%;
      margin: 18px 0; font-size: 13px;
    }
    .clipper-reader th, .clipper-reader td {
      border: 1px solid #bbb; padding: 8px 12px;
      text-align: left; vertical-align: top;
    }
    .clipper-reader th {
      background: #e8edf3; font-weight: bold; color: #222;
    }
    .clipper-reader tr:nth-child(even) { background: #f7f8fa; }
    .clipper-reader a { color: #1a73e8; text-decoration: underline; }
    .clipper-reader blockquote {
      border-left: 4px solid #ccc; margin: 16px 0;
      padding: 8px 16px; color: #555; font-style: italic;
    }
    .clipper-reader ul, .clipper-reader ol {
      margin: 8px 0 12px 0; padding-left: 24px;
    }
    .clipper-reader li { margin-bottom: 4px; }
    .clipper-reader pre, .clipper-reader code {
      font-family: 'Courier New', monospace; font-size: 13px;
      background: #f5f5f5; padding: 2px 4px; border-radius: 3px;
    }
    .clipper-reader pre { padding: 12px; overflow-x: auto; margin: 12px 0; }
    .clipper-reader hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
    .clipper-reader figure { margin: 16px 0; text-align: center; }
    .clipper-reader figcaption {
      font-size: 12px; color: #777; margin-top: 6px; font-style: italic;
    }
    .clipper-meta {
      border-bottom: 2px solid #ddd; padding-bottom: 16px; margin-bottom: 24px;
      font-family: 'Helvetica Neue', Arial, sans-serif; color: #666; font-size: 12px;
    }
    .clipper-meta .meta-label {
      font-size: 13px; color: #888; margin: 0 0 8px 0;
      font-weight: normal; text-transform: uppercase; letter-spacing: 1px;
    }
    .clipper-meta .meta-title {
      font-size: 14px; color: #333; font-weight: bold; margin-bottom: 4px;
    }
    .clipper-meta .meta-date { margin-bottom: 6px; }
    .clipper-meta .meta-author { font-style: italic; margin-bottom: 4px; }
    .clipper-meta a { color: #1a73e8; word-break: break-all; }
  `,

  /**
   * Point d'entrée principal du serializer.
   * Orchestre les 3 étapes : extraction Readability, construction du container
   * HTML autonome avec grounding, puis protection Tainted Canvas (images → data URIs).
   *
   * @param  {HTMLElement} wrapperClone - Clone du body, utilisé en fallback si Readability échoue.
   * @returns {Promise<HTMLElement>}     - Container HTML 100% autonome (CSS + métadonnées + contenu).
   */
  async process(wrapperClone) {
    // ---------------------------------------------------------------
    // ÉTAPE 1 : Extraction du contenu via Readability
    // (Skill readability-content-extractor §2-3)
    // CRITIQUE : on clone le DOCUMENT, pas le body, pour ne JAMAIS
    // modifier la page de l'utilisateur.
    // ---------------------------------------------------------------
    const article = this._tryReadability();

    let contentHtml, title, byline, siteName;

    if (article && article.content && article.content.length > 200) {
      contentHtml = article.content;
      title = article.title || null;
      byline = article.byline || null;
      siteName = article.siteName || null;
    } else {
      // Fallback : si Readability échoue, on utilise le body nettoyé
      console.warn('[MC] Readability: échec ou contenu insuffisant — fallback DOM complet.');
      this._cleanDomFallback(wrapperClone);
      contentHtml = new XMLSerializer().serializeToString(wrapperClone);
      title = null;
      byline = null;
      siteName = null;
    }

    // ---------------------------------------------------------------
    // ÉTAPE 2 : Construction du container HTML virtuel
    // (Skill readability-content-extractor §3)
    // ---------------------------------------------------------------
    const container = this._buildContainer(contentHtml, title, byline, siteName);

    // ---------------------------------------------------------------
    // ÉTAPE 3 : Tainted Canvas Protection
    // (Skill readability-content-extractor §4)
    // AVANT de passer au convertisseur PDF, on DOIT convertir les
    // images distantes en Base64 pour éviter les problèmes de CORS
    // lors de jsPDF addImage().
    // ---------------------------------------------------------------
    await this._protectTaintedCanvas(container);

    return container;
  },

  // =================================================================
  // MÉTHODES PRIVÉES
  // =================================================================

  /**
   * Tente d'extraire le contenu principal via Mozilla Readability.js.
   * Applique un algorithme de vérification de rétention sur un dénominateur
   * préalablement débruité (exclusion des nœuds de navigation et d'interface)
   * pour éviter les faux positifs sur les sites à forte composante UI.
   * Retourne null si Readability est absente, échoue, ou si la rétention est
   * jugée insuffisante — dans ce cas le pipeline bascule sur _cleanDomFallback().
   *
   * @warning Seuils de rétention : texte 40% || structure 35%
   * || tables 50%. Trois signaux INDÉPENDANTS (||), jamais
   * fusionner en &&, jamais descendre texte/structure sous
   * 40%/35%. Signal tabulaire actif uniquement si
   * originalTables >= 2.
   *
   * @returns {Object|null} - Objet article Readability ({content, title, byline, siteName, textContent}),
   *                          ou null si l'extraction est rejetée ou échoue.
   */
  _tryReadability() {
    try {
      if (typeof Readability === 'undefined') {
        console.warn('[MC] Readability.js non chargé — injection manquante ?');
        return null;
      }

      // 1. Dénominateur nettoyé : exclusion de l'UI et de la navigation
      const NOISE_SELECTORS = 'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"], aside, .sidebar, #sidebar, .fr-header, .fr-footer, .fr-sidemenu, .fr-nav';
      const bodyCloneForMetrics = document.body.cloneNode(true);
      bodyCloneForMetrics.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());

      // CRITIQUE : textContent (pas innerText) — fonctionne sur les nœuds détachés du DOM
      const originalTextLength = (bodyCloneForMetrics.textContent || '').trim().length;
      const originalNodes = bodyCloneForMetrics.querySelectorAll(
        'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote'
      ).length;
      const originalTables = bodyCloneForMetrics.querySelectorAll('table').length;

      // 2. Exécution de Readability sur le vrai document (cloné)
      const documentClone = document.cloneNode(true);
      const reader = new Readability(documentClone, { charThreshold: 100 });
      const article = reader.parse();

      if (!article || !article.content) return null;

      // 3. Métriques du résultat Readability
      const extractedTextLength = (article.textContent || '').trim().length;
      const parsedForCount = new DOMParser().parseFromString(article.content, 'text/html');
      const extractedNodes = parsedForCount.body.querySelectorAll(
        'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote'
      ).length;
      const extractedTables = parsedForCount.body.querySelectorAll('table').length;

      // 4. Calcul des taux de rétention sur le dénominateur propre
      const textRetention = originalTextLength > 0 ? extractedTextLength / originalTextLength : 1;
      const nodeRetention = originalNodes > 0 ? extractedNodes / originalNodes : 1;
      const tableRetention = originalTables > 0
        ? extractedTables / originalTables
        : 1;

      // 5. Arbitrage strict (Logique AND)
      // Les deux signaux doivent échouer simultanément pour éviter les faux positifs.
      const isTruncatedByText = originalTextLength > 2000 && textRetention < 0.30;
      const isTruncatedByStructure = originalNodes > 10 && nodeRetention < 0.25;
      const isTruncatedByTables = originalTables >= 2 && tableRetention < 0.50;

      if ((isTruncatedByText && isTruncatedByStructure) || isTruncatedByTables) {
        return null;
      }

      return article;

    } catch (e) {
      console.warn('[MC] Erreur Readability:', e.message);
      return null;
    }
  },

  /**
   * Construit le container HTML virtuel autonome : CSS Reader Mode injecté en
   * ligne, bloc de métadonnées de grounding (titre, auteur, site, date, URL),
   * puis contenu principal parsé via DOMParser (zéro innerHTML — conformité AMO).
   *
   * @param  {string}      contentHtml - HTML du contenu principal (produit par Readability ou _cleanDomFallback).
   * @param  {string|null} title       - Titre de l'article extrait par Readability (null si fallback).
   * @param  {string|null} byline      - Auteur extrait par Readability (null si absent ou fallback).
   * @param  {string|null} siteName    - Nom du site extrait par Readability (null si absent ou fallback).
   * @returns {HTMLElement}             - Div container autonome prêt pour la génération PDF/MD.
   */
  _buildContainer(contentHtml, title, byline, siteName) {
    const container = document.createElement('div');

    // CSS Reader Mode (inline <style>) — marqué pour isolation CORS
    const style = document.createElement('style');
    style.setAttribute('data-clipper', 'true');
    style.textContent = this.READER_CSS;
    container.appendChild(style);

    // Wrapper Reader Mode
    const readerDiv = document.createElement('div');
    readerDiv.className = 'clipper-reader';

    // --- Métadonnées de Grounding (Skill §3) ---
    const pageTitle = title
                   || document.querySelector('title')?.innerText
                   || document.querySelector('h1')?.innerText
                   || 'Document sans titre';
    const pageUrl = window.location.href;
    const captureDate = new Date().toLocaleString();

    const metaBlock = document.createElement('div');
    metaBlock.className = 'clipper-meta';

    // Construction DOM sécurisée (zéro innerHTML — conformité Mozilla AMO)
    const labelDiv = document.createElement('div');
    labelDiv.className = 'meta-label';
    labelDiv.textContent = 'Métadonnées de Capture (NotebookLM)';
    metaBlock.appendChild(labelDiv);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'meta-title';
    titleDiv.textContent = pageTitle;
    metaBlock.appendChild(titleDiv);

    if (byline) {
      const authorDiv = document.createElement('div');
      authorDiv.className = 'meta-author';
      authorDiv.textContent = `Par : ${byline}`;
      metaBlock.appendChild(authorDiv);
    }
    if (siteName) {
      const siteDiv = document.createElement('div');
      siteDiv.textContent = `Site : ${siteName}`;
      metaBlock.appendChild(siteDiv);
    }

    const dateDiv = document.createElement('div');
    dateDiv.className = 'meta-date';
    dateDiv.textContent = `Capturé le : ${captureDate}`;
    metaBlock.appendChild(dateDiv);

    const urlDiv = document.createElement('div');
    const urlLink = document.createElement('a');
    urlLink.href = pageUrl;
    urlLink.textContent = pageUrl;
    urlDiv.appendChild(urlLink);
    metaBlock.appendChild(urlDiv);
    readerDiv.appendChild(metaBlock);

    // --- Contenu principal ---
    // SAFE: contentHtml est produit par Mozilla Readability.parse() (sanitisé)
    // ou par _cleanDomFallback() (nettoyé). On utilise DOMParser au lieu de
    // innerHTML pour satisfaire la politique AMO de zéro innerHTML.
    const contentDiv = document.createElement('div');
    const parsedDoc = new DOMParser().parseFromString(contentHtml, 'text/html');
    Array.from(parsedDoc.body.childNodes).forEach(child => {
      contentDiv.appendChild(document.importNode(child, true));
    });
    readerDiv.appendChild(contentDiv);

    container.appendChild(readerDiv);
    return container;
  },

  /**
   * Tainted Canvas Protection : convertit toutes les images distantes du container
   * en data URIs Base64 via le background script (seul contexte sans CORS).
   * Les images qui échouent sont supprimées du DOM pour éviter des erreurs jsPDF.
   * Sans cette étape, doc.addImage() lève une SecurityError sur les images cross-origin.
   *
   * @param  {HTMLElement} container - Container DOM produit par _buildContainer().
   * @returns {Promise<void>}         - Résout quand toutes les images sont traitées.
   */
  async _protectTaintedCanvas(container) {
    const images = container.querySelectorAll('img');
    if (images.length === 0) return;

    let converted = 0;
    let failed = 0;

    const promises = Array.from(images).map(async (img) => {
      const src = img.getAttribute('src') || '';

      // Déjà un data URI : rien à faire
      if (src.startsWith('data:')) return;

      // URL vide ou invalide
      if (!src || src.length < 5) {
        img.remove();
        failed++;
        return;
      }

      // Résoudre les URLs relatives en absolues
      let absoluteUrl;
      try {
        absoluteUrl = new URL(src, window.location.href).href;
      } catch {
        img.remove();
        failed++;
        return;
      }

      try {
        const response = await browser.runtime.sendMessage({
          action: "FETCH_IMAGE",
          url: absoluteUrl
        });

        if (response && response.data) {
          img.setAttribute('src', response.data);
          // Nettoyer les attributs qui pourraient forcer un rechargement réseau
          img.removeAttribute('srcset');
          img.removeAttribute('loading');
          img.removeAttribute('data-src');
          converted++;
        } else {
          img.remove();
          failed++;
        }
      } catch (err) {
        console.warn('[MC] Image non convertible:', absoluteUrl, err.message);
        img.remove();
        failed++;
      }
    });

    await Promise.all(promises);
  },

  /**
   * Nettoyage DOM étendu pour le mode Fallback (incluant Légifrance / DSFR).
   * Supprime les éléments non-contenu : scripts, styles, iframes, navigation,
   * bannières cookies, éléments masqués. Opère sur un clone — jamais le DOM live.
   *
   * @param  {HTMLElement} clone - Clone du body à nettoyer in-place.
   * @returns {void}
   */
  _cleanDomFallback(clone) {
    const selectors = [
      'script', 'noscript', 'link[rel="stylesheet"]', 'meta',
      'style', 'iframe', 'video', 'audio', 'canvas',
      'object', 'embed', 'source', 'svg',
      'input', 'select', 'textarea', 'form',
      '#tarteaucitronRoot', '#tarteaucitron',
      '#onetrust-consent-sdk', '#CybotCookiebotDialog',
      '#cookie-banner', '.cookie-notice',
      // Balises sémantiques de navigation et classes DSFR (Légifrance)
      'header', 'footer', 'nav', 'aside',
      '.fr-header', '.fr-footer', '.fr-sidemenu', '.fr-nav'
    ];
    selectors.forEach(sel => {
      try { clone.querySelectorAll(sel).forEach(el => el.remove()); }
      catch (e) { /* sélecteur invalide */ }
    });

    // Nettoyage des éléments masqués
    clone.querySelectorAll('[style]').forEach(el => {
      if (/display\s*:\s*none/i.test(el.getAttribute('style') || '')) el.remove();
    });
    clone.querySelectorAll('[hidden]').forEach(el => el.remove());
    clone.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());
  },

};
