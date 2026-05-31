window.nwcmdgen      = true;
// md_generator.js — Rôle : Convertisseur HTML → Markdown structuré

/**
 * Aplatit un tableau HTML contenant des colspan et rowspan pour produire une grille 2D.
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

// VERSION 1.0 : Tables pipe-delimited, headings, listes, liens, code
//
// Ce module reçoit le même container HTML du Serializer V9 que le PDF Generator.
// Il produit un document Markdown optimisé pour l'ingestion par Gemini/NotebookLM.
// Les tables sont rendues en format pipe-delimited, nativement compris par les LLMs.

window.ClipperMarkdownGenerator = {

  /**
   * Génère du Markdown structuré à partir du container HTML du Serializer V9.
   *
   * @param {HTMLElement} container - Container avec CSS Reader Mode + data URI images.
   * @returns {string} Document Markdown complet.
   */
  generate(container, intentNote = null) {
    console.log("[MD Gen V1] Extraction des blocs structurés...");

    const blocks = this._extractBlocks(container);
    console.log(`[MD Gen V1] ${blocks.length} blocs extraits.`);

    const lines = [];

    const buildIntentPrefix = (note) => {
      if (!note) return "";
      return [
        "> **[INTENTION DE RECHERCHE]**",
        `> ${note.split('\n').join('\n> ')}`,
        ">",
        ""
      ].join('\n');
    };

    const intentPrefix = buildIntentPrefix(intentNote);
    if (intentPrefix) {
      lines.push(intentPrefix);
    }

    for (const block of blocks) {
      switch (block.type) {
        case 'meta-header':
          lines.push('---');
          lines.push('');
          lines.push(`**${block.text}**`);
          lines.push('');
          break;

        case 'meta-title':
          lines.push(`**${block.text}**`);
          lines.push('');
          break;

        case 'meta-info':
          lines.push(block.text);
          break;

        case 'meta-url':
          lines.push('');
          lines.push(block.text);
          lines.push('');
          lines.push('---');
          lines.push('');
          break;

        case 'h1':
          lines.push('');
          lines.push(`# ${block.text}`);
          lines.push('');
          break;

        case 'h2':
          lines.push('');
          lines.push(`## ${block.text}`);
          lines.push('');
          break;

        case 'h3':
          lines.push('');
          lines.push(`### ${block.text}`);
          lines.push('');
          break;

        case 'h4': case 'h5': case 'h6':
          lines.push('');
          lines.push(`#### ${block.text}`);
          lines.push('');
          break;

        case 'li':
          lines.push(`- ${block.text}`);
          break;

        case 'li-ordered':
          lines.push(`${block.index}. ${block.text}`);
          break;

        case 'table':
          lines.push('');
          this._renderMarkdownTable(block, lines);
          lines.push('');
          break;

        case 'image':
          // En Markdown, on référence l'URL originale (pas le data URI)
          if (block.alt || block.url) {
            lines.push('');
            lines.push(`![${block.alt || 'Image'}](${block.url || ''})`);
            lines.push('');
          }
          break;

        case 'code':
          lines.push('');
          lines.push('```');
          lines.push(block.text);
          lines.push('```');
          lines.push('');
          break;

        case 'blockquote':
          lines.push('');
          block.text.split('\n').forEach(line => {
            lines.push(`> ${line}`);
          });
          lines.push('');
          break;

        case 'hr':
          lines.push('');
          lines.push('---');
          lines.push('');
          break;

        case 'link':
          lines.push(`[${block.text}](${block.url})`);
          break;

        case 'p': default:
          if (block.text) {
            lines.push('');
            lines.push(block.text);
          }
          break;
      }
    }

    const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    console.log(`[MD Gen V1] ✅ Markdown généré (${markdown.length} chars)`);
    return markdown;
  },

  // =================================================================
  // _renderMarkdownTable : Table pipe-delimited
  // =================================================================
  _renderMarkdownTable(block, lines) {
    const allRows = [...(block.head || []), ...(block.body || [])];
    if (allRows.length === 0) return;

    const maxCols = Math.max(...allRows.map(r => r.length));
    if (maxCols === 0) return;

    // Calculer la largeur max de chaque colonne pour un alignement propre
    const colWidths = [];
    for (let c = 0; c < maxCols; c++) {
      let maxW = 3; // minimum "---"
      for (const row of allRows) {
        const cellLen = (row[c] || '').toString().length;
        if (cellLen > maxW) maxW = cellLen;
      }
      colWidths.push(maxW);
    }

    const headCount = (block.head || []).length;

    for (let r = 0; r < allRows.length; r++) {
      const row = allRows[r];

      // Construire la ligne de cellules
      const cells = [];
      for (let c = 0; c < maxCols; c++) {
        const cell = (row[c] || '').toString();
        cells.push(` ${cell.padEnd(colWidths[c])} `);
      }
      lines.push(`|${cells.join('|')}|`);

      // Séparateur après la dernière ligne d'en-tête (ou après la 1ère ligne si pas d'en-tête)
      if ((headCount > 0 && r === headCount - 1) || (headCount === 0 && r === 0)) {
        const sep = colWidths.map(w => '-'.repeat(w + 2));
        lines.push(`|${sep.join('|')}|`);
      }
    }
  },

  // =================================================================
  // _extractBlocks : Parcourt le container HTML du serializer V9
  // Similaire au PDF Generator mais avec des types enrichis pour Markdown
  // =================================================================
  _extractBlocks(container) {
    const blocks = [];

    const walk = (node, listContext) => {
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
        const label = node.querySelector('.meta-label');
        if (label) blocks.push({ type: 'meta-header', text: label.textContent.trim() });

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

      // Images — garder l'URL originale pour le Markdown
      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        // En markdown, on référence l'URL. Si c'est un data URI, on le garde aussi
        // car c'est le seul moyen de ne pas perdre l'info
        if (src) {
          blocks.push({ type: 'image', url: src, alt: alt });
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

      // Code block
      if (tag === 'pre') {
        const code = node.querySelector('code');
        const text = (code || node).textContent.trim();
        if (text) blocks.push({ type: 'code', text });
        return;
      }

      // Blockquote
      if (tag === 'blockquote') {
        const text = node.textContent.trim();
        if (text) blocks.push({ type: 'blockquote', text });
        return;
      }

      // Listes ordonnées
      if (tag === 'ol') {
        let idx = 1;
        for (const child of node.children) {
          if (child.tagName.toLowerCase() === 'li') {
            const hasBlock = child.querySelector('table, div, p, ul, ol, h1, h2, h3, h4, h5, h6');
            if (hasBlock) {
              for (const sub of child.childNodes) walk(sub);
            } else {
              const text = child.textContent.trim();
              if (text) blocks.push({ type: 'li-ordered', text, index: idx });
            }
            idx++;
          }
        }
        return;
      }

      // Listes non ordonnées
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

      // Paragraphes
      if (tag === 'p') {
        const imgs = node.querySelectorAll('img');
        if (imgs.length > 0) {
          for (const child of node.childNodes) walk(child);
          return;
        }
        const text = node.textContent.trim();
        if (text) blocks.push({ type: 'p', text });
        return;
      }

      // Figcaption
      if (tag === 'figcaption') {
        const text = node.textContent.trim();
        if (text) blocks.push({ type: 'p', text: `*${text}*` });
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
          b.type === 'meta-header' || b.type === 'meta-title' || b.type === 'meta-url' ||
          b.type === 'meta-info' || b.type === 'code' || b.type === 'blockquote') {
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
