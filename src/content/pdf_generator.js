window.nwcpdfgen     = true;
// pdf_generator.js — Rôle : dom-to-pdf-converter (jsPDF)

/**
 * Aplatit un tableau HTML contenant des colspan et rowspan pour produire une grille 2D.
 * Duplication volontaire pour environnement Firefox MV3 sans bundler.
 *
 * @param {HTMLElement} tableNode - Nœud DOM de la table.
 * @returns {Object} Un objet { head: string[][], body: string[][] } contenant les lignes aplaties.
 */
function flattenTable(tableNode) {
  if (!tableNode) return { head: [], body: [] };
  
  const rows = Array.from(tableNode.querySelectorAll('tr'));
  if (rows.length === 0) return { head: [], body: [] };

  const grid = [];
  const isHeaderRow = [];

  for (let r = 0; r < rows.length; r++) {
    const rowEl = rows[r];
    grid[r] = grid[r] || [];
    
    const isHead = (rowEl.parentElement && rowEl.parentElement.tagName.toLowerCase() === 'thead')
                 || (rowEl.querySelector('th') !== null && rowEl.querySelector('td') === null);
    isHeaderRow[r] = isHead;

    const cells = Array.from(rowEl.querySelectorAll('th, td'));
    let col = 0;

    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];

      while (grid[r][col] !== undefined) {
        col++;
      }

      const colspan = parseInt(cell.getAttribute('colspan'), 10) || 1;
      const rowspan = parseInt(cell.getAttribute('rowspan'), 10) || 1;

      const content = cell.textContent.trim()
                          .replace(/\n/g, ' ')
                          .replace(/\|/g, '\\|');

      grid[r][col] = content;

      for (let i = 1; i < colspan; i++) {
        grid[r][col + i] = "";
      }

      const limitRow = Math.min(r + rowspan, rows.length);
      for (let nextR = r + 1; nextR < limitRow; nextR++) {
        grid[nextR] = grid[nextR] || [];
        grid[nextR][col] = "↓";
        for (let i = 1; i < colspan; i++) {
          grid[nextR][col + i] = "";
        }
      }

      col += colspan;
    }
  }

  let maxCols = 0;
  for (let r = 0; r < grid.length; r++) {
    if (grid[r].length > maxCols) {
      maxCols = grid[r].length;
    }
  }

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < maxCols; c++) {
      if (grid[r][c] === undefined) {
        grid[r][c] = "";
      }
    }
  }

  const head = [];
  const body = [];

  for (let r = 0; r < grid.length; r++) {
    if (isHeaderRow[r]) {
      head.push(grid[r]);
    } else {
      body.push(grid[r]);
    }
  }

  if (head.length === 0 && grid.length > 0) {
    head.push(grid[0]);
    body.shift();
  }

  return { head, body };
}

// VERSION 7 : jsPDF amélioré — images data URI, tables visuelles, contenu Readability
//
// Ce module reçoit un container HTML préparé par le Serializer V9
// (Readability + CSS Reader Mode + images en data URIs).
// Il parcourt le DOM du container et génère un PDF structuré via jsPDF.

window.ClipperPDFGenerator = {

  /**
   * Vérification des quotas NotebookLM (~500 000 mots, 200 MB).
   */
  checkWordCountQuota() {
    const text = document.body.innerText || "";
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount > 490000) {
      throw new Error(`Quota dépassé : ~${wordCount} mots (limite NotebookLM : 500 000).`);
    }

  },

  /**
   * Génère un PDF à partir du container HTML du Serializer V9.
   *
   * @param {HTMLElement} container - Container avec CSS Reader Mode + data URI images.
   * @returns {Promise<string>} PDF en Base64 Data URI.
   */
  async generate(container, intentNote = null) {
    // Extraire les blocs du container HTML
    const blocks = this._extractBlocks(container);

    // Initialiser jsPDF
    const jsPDFCtor = (typeof jspdf !== 'undefined' && jspdf.jsPDF) ? jspdf.jsPDF :
                      (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

    if (!jsPDFCtor) {
      throw new Error("jsPDF non chargé. Vérifiez lib/jspdf.umd.min.js dans le manifest.");
    }

    const doc = new jsPDFCtor({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 15; // marge
    const uw = pw - m * 2; // largeur utilisable
    let y = m; // curseur vertical

    // --- Helpers ---
    const newPage = () => { doc.addPage(); y = m; };
    const space = (needed) => { if (y + needed > ph - m) newPage(); };

    const addText = (text, size, bold, spacing, color) => {
      if (!text) return;
      color = color || [50, 50, 50];
      doc.setFontSize(size);
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setTextColor(color[0], color[1], color[2]);
      const lines = doc.splitTextToSize(text, uw);
      const lh = size * 0.4;
      for (const line of lines) {
        space(lh);
        doc.text(line, m, y);
        y += lh;
      }
      y += (spacing || 2);
    };

    const addRule = () => {
      space(5);
      doc.setDrawColor(180, 180, 180);
      doc.line(m, y, pw - m, y);
      y += 4;
    };

    // Injecte le bloc d'intention AVANT le grounding et retourne le curseur y mis à jour.
    // Utilise y comme paramètre explicite — jamais doc.y (propriété dynamique non-standard).
    const injectIntentHeader = (doc, intentNote, y, layout) => {
      if (!intentNote) return y; // champ vide → aucune injection, y inchangé

      const { margin, pageWidth, lineHeight } = layout;
      const usableWidth = pageWidth - margin * 2;

      // Titre de section
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.text("[INTENTION DE RECHERCHE]", margin, y);
      y += lineHeight;

      // Contenu de la note
      doc.setFont("helvetica", "italic");
      const lines = doc.splitTextToSize(intentNote, usableWidth);
      lines.forEach(line => {
        doc.text(line, margin, y);
        y += lineHeight;
      });

      // Séparateur visuel
      doc.setFont("helvetica", "normal");
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, y, pageWidth - margin, y);
      y += lineHeight * 1.5;

      return y;
    };

    // Ordre d'injection : on insère AVANT le rendu des meta-blocs (grounding)
    if (intentNote) {
      y = injectIntentHeader(doc, intentNote, y, { margin: m, pageWidth: pw, lineHeight: 5 });
    }

    // --- Rendu des blocs ---
    for (const block of blocks) {
      switch (block.type) {

        case 'meta-title':
          addText('— Métadonnées de Capture (NotebookLM) —', 11, true, 3, [80, 80, 80]);
          addText(block.text, 10, true, 2, [50, 50, 50]);
          break;

        case 'meta-info':
          addText(block.text, 9, false, 1, [100, 100, 100]);
          break;

        case 'meta-url':
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(26, 115, 232);
          space(5);
          doc.textWithLink(block.text, m, y, { url: block.text });
          y += 6;
          addRule();
          break;

        case 'h1':
          y += 3;
          addText(block.text, 16, true, 4, [20, 20, 20]);
          break;
        case 'h2':
          y += 2;
          addText(block.text, 14, true, 3, [30, 30, 30]);
          break;
        case 'h3': case 'h4': case 'h5': case 'h6':
          y += 1;
          addText(block.text, 12, true, 2, [40, 40, 40]);
          break;

        case 'li':
          addText('  •  ' + block.text, 10, false, 1.5, [50, 50, 50]);
          break;

        case 'image': {
          if (!block.data) break;
          try {
            const imgW = block.width || 400;
            const imgH = block.height || 300;
            const maxW = uw;
            const maxH = ph - m * 2 - 10;
            const ratio = Math.min(maxW / imgW, maxH / imgH, 1);
            const fw = imgW * ratio;
            const fh = imgH * ratio;
            space(fh + 5);
            const xOff = m + (uw - fw) / 2;
            doc.addImage(block.data, 'JPEG', xOff, y, fw, fh);
            y += fh + 5;
          } catch (e) {
            console.warn('[MC] Image ignorée:', e.message);
          }
          break;
        }

        case 'table':
          this._renderTable(doc, block, m, uw, ph, () => y, (v) => { y = v; }, space, newPage);
          break;

        case 'hr':
          addRule();
          break;

        case 'p': default:
          if (block.text) addText(block.text, 10, false, 2, [50, 50, 50]);
          break;
      }
    }

    const result = doc.output('datauristring');
    return result;
  },

  // =================================================================
  // _renderTable : Table visuelle avec bordures ET texte structuré
  // =================================================================
  _renderTable(doc, block, m, uw, ph, getY, setY, space, newPage) {
    const allRows = [...(block.head || []), ...(block.body || [])];
    if (allRows.length === 0) return;
    const maxCols = Math.max(...allRows.map(r => r.length));
    if (maxCols === 0) return;

    const fontSize = 8;
    const cellPadX = 2;
    const cellPadY = 1.5;
    const lh = fontSize * 0.4;

    doc.setFontSize(fontSize);
    doc.setFont('helvetica', 'normal');

    // Calculer largeurs de colonnes
    const colW = [];
    for (let c = 0; c < maxCols; c++) {
      let maxW = 10;
      for (const row of allRows) {
        const tw = doc.getTextWidth((row[c] || '').toString()) + cellPadX * 2;
        if (tw > maxW) maxW = tw;
      }
      colW.push(maxW);
    }

    // Ajuster à la largeur utilisable
    const totalW = colW.reduce((a, b) => a + b, 0);
    const scale = Math.min(uw / totalW, 1);
    for (let c = 0; c < maxCols; c++) colW[c] *= scale;

    const headCount = (block.head || []).length;

    for (let r = 0; r < allRows.length; r++) {
      const row = allRows[r];
      const isHead = r < headCount;

      // Calculer hauteur (multi-ligne)
      const cellLines = [];
      let maxLines = 1;
      for (let c = 0; c < maxCols; c++) {
        const txt = (row[c] || '').toString();
        const avail = colW[c] - cellPadX * 2;
        const lines = doc.splitTextToSize(txt, Math.max(avail, 5));
        cellLines.push(lines);
        if (lines.length > maxLines) maxLines = lines.length;
      }
      const rowH = maxLines * lh + cellPadY * 2;

      // Saut de page si nécessaire
      let curY = getY();
      if (curY + rowH > ph - m) {
        newPage();
        curY = m;
      }

      // Dessiner chaque cellule
      let cellX = m;
      for (let c = 0; c < maxCols; c++) {
        const cw = colW[c];

        // Fond
        if (isHead) {
          doc.setFillColor(230, 240, 255);
          doc.rect(cellX, curY, cw, rowH, 'F');
        } else if (r % 2 === 0) {
          doc.setFillColor(248, 248, 248);
          doc.rect(cellX, curY, cw, rowH, 'F');
        }

        // Bordure
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.2);
        doc.rect(cellX, curY, cw, rowH, 'S');

        // Texte
        doc.setFontSize(fontSize);
        doc.setFont('helvetica', isHead ? 'bold' : 'normal');
        doc.setTextColor(isHead ? 30 : 50, isHead ? 30 : 50, isHead ? 30 : 50);
        const lines = cellLines[c];
        let textY = curY + cellPadY + lh * 0.8;
        for (const line of lines) {
          doc.text(line, cellX + cellPadX, textY);
          textY += lh;
        }
        cellX += cw;
      }
      setY(curY + rowH);
    }
    setY(getY() + 4);
  },

  // =================================================================
  // _extractBlocks : Parcourt le container HTML du serializer V9
  // =================================================================
  _extractBlocks(container) {
    const blocks = [];

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text.length > 0) blocks.push({ type: 'p', text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();

      // Ignorer les styles et scripts
      if (['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) return;

      // Métadonnées de grounding (le bloc .clipper-meta)
      if (node.classList && node.classList.contains('clipper-meta')) {
        const title = node.querySelector('.meta-title');
        if (title) blocks.push({ type: 'meta-title', text: title.textContent.trim() });

        const infos = node.querySelectorAll('.meta-date, .meta-author, div:not(.meta-title):not(.meta-date):not(.meta-author)');
        infos.forEach(el => {
          const a = el.querySelector('a');
          if (a && a.href) {
            blocks.push({ type: 'meta-url', text: a.href });
          } else {
            const t = el.textContent.trim();
            if (t && !el.classList.contains('meta-label') && !el.classList.contains('meta-title')) {
              blocks.push({ type: 'meta-info', text: t });
            }
          }
        });
        return;
      }

      // Images (data URIs du serializer)
      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        if (src.startsWith('data:')) {
          const w = parseInt(node.getAttribute('width'), 10) || node.naturalWidth || 400;
          const h = parseInt(node.getAttribute('height'), 10) || node.naturalHeight || 300;
          blocks.push({ type: 'image', data: src, width: w, height: h });
        }
        return;
      }

      // Éléments à ignorer
      if (['svg', 'video', 'audio', 'canvas', 'iframe', 'input', 'select',
           'textarea', 'button', 'form', 'object', 'embed'].includes(tag)) return;

      // Tables
      if (tag === 'table') {
        const { head, body } = flattenTable(node);
        if (head.length > 0 || body.length > 0) {
          blocks.push({ type: 'table', head, body });
        }
        return;
      }

      // Titres
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const text = node.textContent.trim();
        if (text) blocks.push({ type: tag, text });
        return;
      }

      // Séparateurs
      if (tag === 'hr') { blocks.push({ type: 'hr' }); return; }

      // Listes
      if (tag === 'li') {
        const hasBlock = node.querySelector('table, div, p, ul, ol, h1, h2, h3, h4, h5, h6');
        if (hasBlock) {
          for (const child of node.childNodes) walk(child);
        } else {
          const text = node.textContent.trim();
          if (text) blocks.push({ type: 'li', text });
        }
        return;
      }

      // Paragraphes (blocs terminaux)
      if (['p', 'blockquote', 'figcaption', 'pre', 'code'].includes(tag)) {
        // Vérifier s'il contient des images
        const imgs = node.querySelectorAll('img');
        if (imgs.length > 0) {
          // Parcourir pour extraire texte + images séparément
          for (const child of node.childNodes) walk(child);
          return;
        }
        const text = node.textContent.trim();
        if (text) blocks.push({ type: 'p', text });
        return;
      }

      // Figure (peut contenir img + figcaption)
      if (tag === 'figure') {
        for (const child of node.childNodes) walk(child);
        return;
      }

      // Conteneurs : descendre
      for (const child of node.childNodes) walk(child);
    };

    // On parcourt le .clipper-reader s'il existe, sinon le container entier
    const reader = container.querySelector('.clipper-reader');
    walk(reader || container);

    // Dédupliquer les blocs texte consécutifs identiques
    const deduped = [];
    for (const b of blocks) {
      if (b.type === 'table' || b.type === 'image' || b.type === 'hr' ||
          b.type === 'meta-title' || b.type === 'meta-url' || b.type === 'meta-info') {
        deduped.push(b);
        continue;
      }
      if (!b.text || b.text.length === 0) continue;
      const last = deduped[deduped.length - 1];
      if (last && last.type === b.type && last.text === b.text) continue;
      deduped.push(b);
    }

    return deduped;
  }
};
