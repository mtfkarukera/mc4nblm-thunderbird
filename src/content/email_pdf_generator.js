// email_pdf_generator.js — Générateur PDF depuis le DOM email (jsPDF Walker)
// Magic Clipper for Gemini Notebook (Thunderbird 128+ ESR — Manifest V3)
// Auteur : MTF Karukera
//
// Exécuté dans l'onglet d'affichage de l'email.
// Dépend de jspdf.umd.min.js injecté juste avant lui.

'use strict';

window.__ntc_generate_pdf = function (grounding, intentNote, labels) {
  return new Promise((resolve, reject) => {
    try {
      const jsPDFClass =
        (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) ? window.jspdf.jsPDF :
        (typeof jspdf !== 'undefined' && jspdf.jsPDF) ? jspdf.jsPDF :
        (typeof window.jsPDF !== 'undefined') ? window.jsPDF :
        (typeof globalThis !== 'undefined' && globalThis.jsPDF) ? globalThis.jsPDF : null;

      if (!jsPDFClass) {
        throw new Error('jsPDF non disponible dans le contexte email');
      }

      // 1. Estimation des mots (quota Gemini Notebook : 500 000 mots)
      let textContentCleaned = '';
      if (document.body) {
        if (document.body.innerText) {
          textContentCleaned = document.body.innerText;
        } else {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          textContentCleaned = clone.textContent || '';
        }
      }
      const wordCount = textContentCleaned.split(/\s+/).filter(Boolean).length;
      if (wordCount > 500000) {
        const limitErr = new Error('WORD_LIMIT_EXCEEDED');
        limitErr.code = 'WORD_LIMIT_EXCEEDED';
        throw limitErr;
      }

      // Compteur de glyphes non-latins hors encodage WinAnsi (CP1252) des polices natives jsPDF
      let nonLatinCount = 0;

      /**
       * Normalise la typographie Unicode courante vers des équivalents WinAnsi sûrs
       * et comptabilise les caractères non-latins résiduels (CJK, arabe, cyrillique, etc.).
       *
       * @param {string} raw - Chaîne brute à normaliser.
       * @returns {string} Chaîne compatible avec Helvetica/Courier jsPDF.
       */
      function normalizePdfText(raw) {
        if (!raw) return '';
        const replaced = String(raw)
          .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
          .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
          .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
          .replace(/\u2026/g, '...')
          .replace(/\u2192/g, '->')
          .replace(/\u2190/g, '<-')
          .replace(/\u2194/g, '<->')
          .replace(/\u21D2/g, '=>')
          .replace(/[\u2022\u25AA\u25B8\u25CF\u25E6]/g, '-')
          .replace(/[\u00A0\u202F\u2009\u2007]/g, ' ')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/[\u2713\u2714]/g, '[x]')
          .replace(/[\u2717\u2718]/g, '[ ]');

        let safe = '';
        for (let i = 0; i < replaced.length; i++) {
          const code = replaced.charCodeAt(i);
          // Plage Latin-1 + symbole Euro supportés nativement
          if (code <= 0x00ff || code === 0x20ac) {
            safe += replaced[i];
          } else {
            nonLatinCount++;
            // Évite les paires de substitution cassées
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < replaced.length) {
              i++;
            }
            safe += '?';
          }
        }
        return safe;
      }

      // 2. Initialisation du document PDF A4
      const doc = new jsPDFClass({
        orientation: 'p',
        unit: 'pt',
        format: 'a4',
      });

      const margin = 40;
      const topMargin = 40;
      const bottomMargin = 40;
      const width = 595.28;
      const height = 841.89;
      const contentWidth = width - (2 * margin);

      let y = topMargin;

      function checkPageOverflow(neededHeight) {
        if (y + neededHeight > height - bottomMargin) {
          doc.addPage();
          y = topMargin;
          return true;
        }
        return false;
      }

      /**
       * Trace un tableau de lignes en paginant chaque ligne individuellement
       * afin de ne jamais tronquer les longs paragraphes en bas de page.
       */
      function drawLinesPaginated(lines, xPos, lineHeight) {
        for (let i = 0; i < lines.length; i++) {
          checkPageOverflow(lineHeight);
          doc.text(lines[i], xPos, y);
          y += lineHeight;
        }
      }

      function renderText(text, style, size, indentOffset = 0) {
        const clean = normalizePdfText(text);
        if (!clean.trim()) return;
        const fontSize = size || 9;
        const lineHeight = fontSize * 1.25;
        doc.setFont('Helvetica', style || 'normal');
        doc.setFontSize(fontSize);
        const availWidth = Math.max(80, contentWidth - indentOffset);
        const lines = doc.splitTextToSize(clean, availWidth);
        drawLinesPaginated(lines, margin + indentOffset, lineHeight);
        y += 4;
      }

      function renderHeading(text, size) {
        const clean = normalizePdfText(text);
        if (!clean.trim()) return;
        const fontSize = size || 12;
        const lineHeight = fontSize * 1.25;
        checkPageOverflow(lineHeight + 8);
        y += 6;
        doc.setFont('Helvetica', 'bold');
        doc.setFontSize(fontSize);
        const lines = doc.splitTextToSize(clean, contentWidth);
        drawLinesPaginated(lines, margin, lineHeight);
        y += 5;
      }

      function renderPreformatted(node) {
        const raw = node.textContent || '';
        if (!raw.trim()) return;
        const fontSize = 8.5;
        const lineHeight = 10.5;
        doc.setFont('Courier', 'normal');
        doc.setFontSize(fontSize);
        const rawLines = raw.split(/\r?\n/);
        for (const rawLine of rawLines) {
          const cleanLine = normalizePdfText(rawLine) || ' ';
          const wrapped = doc.splitTextToSize(cleanLine, contentWidth);
          drawLinesPaginated(wrapped, margin, lineHeight);
        }
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(9);
        y += 6;
      }

      function isHiddenElement(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'head' || tag === 'meta' || tag === 'link') {
          return true;
        }
        try {
          const st = window.getComputedStyle(el);
          if (st && (st.display === 'none' || st.visibility === 'hidden')) {
            return true;
          }
        } catch (_e) {
          // Ignorer
        }
        return false;
      }

      const BLOCK_TAGS = new Set([
        'div', 'p', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'pre', 'blockquote', 'hr', 'section', 'article', 'header', 'footer',
        'main', 'aside', 'nav', 'dl', 'figure',
      ]);

      /**
       * Vérifie si un élément contient au moins un sous-bloc visible.
       */
      function hasBlockChildren(el) {
        for (const child of el.children) {
          if (isHiddenElement(child)) continue;
          const childTag = child.tagName.toLowerCase();
          if (BLOCK_TAGS.has(childTag) || hasBlockChildren(child)) {
            return true;
          }
        }
        return false;
      }

      function renderImage(imgNode) {
        let canvas = null;
        try {
          if (!imgNode.complete || imgNode.naturalWidth === 0 || imgNode.naturalHeight === 0) return;

          const src = imgNode.src || '';
          let imgData = null;
          let format = 'JPEG';

          if (/^data:image\/(png|jpe?g);base64,/i.test(src)) {
            imgData = src;
            format = /^data:image\/png/i.test(src) ? 'PNG' : 'JPEG';
          } else {
            canvas = document.createElement('canvas');
            canvas.width = imgNode.naturalWidth;
            canvas.height = imgNode.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            // Peindre un fond blanc uni pour éviter que les PNG transparents ne deviennent noirs en JPEG
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(imgNode, 0, 0);
            imgData = canvas.toDataURL('image/jpeg', 0.92);
            format = 'JPEG';
          }

          if (imgData) {
            const naturalWidth = imgNode.naturalWidth;
            const naturalHeight = imgNode.naturalHeight;
            const ratio = naturalHeight / naturalWidth;

            let imgWidth = Math.min(naturalWidth, contentWidth);
            let imgHeight = imgWidth * ratio;

            const maxPageHeight = height - topMargin - bottomMargin - 20;
            if (imgHeight > maxPageHeight) {
              imgHeight = maxPageHeight;
              imgWidth = imgHeight / ratio;
            }

            checkPageOverflow(imgHeight + 10);
            doc.addImage(imgData, format, margin, y, imgWidth, imgHeight);
            y += imgHeight + 10;
          }
        } catch (_e) {
          // Restriction CORS/Canvas sur image distante : ignorée silencieusement sans exposer l'URL
        } finally {
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      }

      /**
       * Rend de façon unifiée un conteneur composé uniquement de texte et de balises inline
       * (<b>, <i>, <a>, <span>, <br>, <img>), évitant les sauts de ligne parasites sur chaque nœud.
       */
      function renderInlineContainer(containerEl, indentOffset = 0, firstLinePrefix = '') {
        let buffer = '';
        let isFirstFlush = true;

        function flushBuffer() {
          const collapsed = buffer.replace(/[ \t\f\v]+/g, ' ').trim();
          buffer = '';
          if (!collapsed) return;

          const clean = normalizePdfText(collapsed);
          if (!clean) return;

          const fontSize = 9;
          const lineHeight = 11.25;
          doc.setFont('Helvetica', 'normal');
          doc.setFontSize(fontSize);

          if (isFirstFlush && firstLinePrefix) {
            const normPrefix = normalizePdfText(firstLinePrefix);
            const availWidth = Math.max(80, contentWidth - indentOffset);
            const lines = doc.splitTextToSize(clean, availWidth);
            if (lines.length > 0) {
              checkPageOverflow(lineHeight);
              doc.text(normPrefix, margin + Math.max(0, indentOffset - 15), y);
              doc.text(lines[0], margin + indentOffset, y);
              y += lineHeight;
              if (lines.length > 1) {
                drawLinesPaginated(lines.slice(1), margin + indentOffset, lineHeight);
              }
            }
            isFirstFlush = false;
          } else {
            const availWidth = Math.max(80, contentWidth - indentOffset);
            const lines = doc.splitTextToSize(clean, availWidth);
            drawLinesPaginated(lines, margin + indentOffset, lineHeight);
            isFirstFlush = false;
          }
          y += 3;
        }

        function collectInline(node, inlineDepth) {
          if (inlineDepth > 200) return;
          if (node.nodeType === Node.TEXT_NODE) {
            buffer += node.textContent.replace(/[\r\n]+/g, ' ');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE || isHiddenElement(node)) {
            return;
          }
          const tag = node.tagName.toLowerCase();
          if (tag === 'br') {
            flushBuffer();
            return;
          }
          if (tag === 'img') {
            flushBuffer();
            renderImage(node);
            return;
          }
          for (const child of node.childNodes) {
            collectInline(child, inlineDepth + 1);
          }
        }

        for (const child of containerEl.childNodes) {
          collectInline(child, 0);
        }
        flushBuffer();
      }

      function renderList(listNode, isOrdered, listLevel = 0) {
        let index = 1;
        const baseIndent = 15 + (listLevel * 14);
        const listItems = Array.from(listNode.children).filter(
          child => child.tagName && child.tagName.toLowerCase() === 'li'
        );

        listItems.forEach(li => {
          if (isHiddenElement(li)) return;
          const prefix = isOrdered ? `${index++}. ` : '- ';

          // Séparer le contenu inline direct des sous-listes éventuelles
          const tempWrapper = document.createElement('span');
          const nestedLists = [];
          for (const child of li.childNodes) {
            if (
              child.nodeType === Node.ELEMENT_NODE &&
              (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')
            ) {
              nestedLists.push(child);
            } else {
              tempWrapper.appendChild(child.cloneNode(true));
            }
          }

          renderInlineContainer(tempWrapper, baseIndent, prefix);
          nestedLists.forEach(sub => {
            renderList(sub, sub.tagName.toLowerCase() === 'ol', listLevel + 1);
          });
        });
        y += 4;
      }

      function isLayoutTable(tableNode) {
        if (tableNode.querySelector('table')) {
          return true;
        }

        const rows = Array.from(tableNode.querySelectorAll('tr')).filter(tr => tr.closest('table') === tableNode);
        if (rows.length <= 1) return true;

        let maxCols = 0;
        rows.forEach(row => {
          const cellsCount = row.cells ? row.cells.length : 0;
          if (cellsCount > maxCols) {
            maxCols = cellsCount;
          }
        });

        return maxCols <= 1;
      }

      function renderTable(tableNode) {
        const rows = Array.from(tableNode.querySelectorAll('tr')).filter(tr => tr.closest('table') === tableNode);
        if (rows.length === 0) return;

        const mdLines = [];
        let colCount = 0;

        rows.forEach((row, rowIndex) => {
          const cells = Array.from(row.cells);
          if (cells.length === 0) return;

          const cellTexts = [];
          cells.forEach(cell => {
            const cellText = normalizePdfText((cell.innerText || cell.textContent || '').trim());
            cellTexts.push(cellText.replace(/\s+/g, ' ').replace(/\|/g, '\\|'));
          });

          if (rowIndex === 0) {
            colCount = cellTexts.length;
          }

          mdLines.push(`| ${cellTexts.join(' | ')} |`);

          if (rowIndex === 0 && colCount > 0) {
            const delims = Array(colCount).fill('---');
            mdLines.push(`| ${delims.join(' | ')} |`);
          }
        });

        doc.setFont('Courier', 'normal');
        doc.setFontSize(8.5);

        mdLines.forEach(line => {
          const lines = doc.splitTextToSize(line, contentWidth);
          drawLinesPaginated(lines, margin, 10);
          y += 2;
        });

        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(9);
        y += 8;
      }

      // 3. Rendu de l'Intent Note (si présente) — paginée ligne par ligne
      if (intentNote) {
        doc.setFont('Helvetica', 'bold');
        doc.setFontSize(10);
        checkPageOverflow(14);
        const intentHeader = normalizePdfText((labels && labels.pdfLabelIntention) || 'INTENTION DE RECHERCHE :');
        doc.text(intentHeader, margin, y);
        y += 14;

        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(9);
        const intentParagraphs = String(intentNote).split(/\r?\n/);
        for (const para of intentParagraphs) {
          const cleanPara = normalizePdfText(para) || ' ';
          const lines = doc.splitTextToSize(cleanPara, contentWidth);
          drawLinesPaginated(lines, margin, 12);
        }
        y += 12;
      }

      // 4. Rendu des Métadonnées de Grounding
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(11);
      checkPageOverflow(15);
      const emailHeader = normalizePdfText((labels && labels.pdfLabelEmail) || '=== EMAIL ===');
      doc.text(emailHeader, margin, y);
      y += 15;

      doc.setFont('Helvetica', 'normal');
      doc.setFontSize(9);

      let dateLabel = '-';
      if (grounding && grounding.date) {
        const parsedDate = new Date(grounding.date);
        if (!isNaN(parsedDate.getTime())) {
          dateLabel = parsedDate.toLocaleString();
        }
      }

      const metadata = [
        { label: (labels && labels.pdfLabelSubject) || 'Objet :', val: grounding && grounding.subject },
        { label: (labels && labels.pdfLabelFrom) || 'De    :', val: grounding && grounding.author },
        { label: (labels && labels.pdfLabelTo) || 'A     :', val: grounding && grounding.recipients },
        { label: (labels && labels.pdfLabelDate) || 'Date  :', val: dateLabel },
      ];

      metadata.forEach(item => {
        const text = normalizePdfText(`${item.label} ${item.val || ''}`);
        const lines = doc.splitTextToSize(text, contentWidth);
        drawLinesPaginated(lines, margin, 12);
      });

      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(11);
      checkPageOverflow(20);
      doc.text('========================================', margin, y);
      y += 22;

      // 5. Parcours récursif du DOM de l'email
      function walk(node, depth = 0) {
        if (depth > 200) return;

        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.replace(/\s+/g, ' ').trim();
          if (text) {
            renderText(text, 'normal', 9);
          }
          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE || isHiddenElement(node)) {
          return;
        }

        const tag = node.tagName.toLowerCase();

        if (/^h[1-6]$/.test(tag)) {
          const size = 16 - parseInt(tag[1], 10);
          const headingText = (node.innerText || node.textContent || '').trim();
          renderHeading(headingText, size);
        } else if (tag === 'p') {
          if (!hasBlockChildren(node)) {
            renderInlineContainer(node, 0);
            y += 3;
          } else {
            for (const child of node.childNodes) {
              walk(child, depth + 1);
            }
          }
        } else if (tag === 'pre') {
          renderPreformatted(node);
        } else if (tag === 'hr') {
          checkPageOverflow(12);
          doc.setDrawColor(180, 180, 180);
          doc.line(margin, y, width - margin, y);
          y += 10;
        } else if (tag === 'blockquote') {
          if (!hasBlockChildren(node)) {
            renderInlineContainer(node, 15, '> ');
            y += 3;
          } else {
            for (const child of node.childNodes) {
              walk(child, depth + 1);
            }
          }
        } else if (tag === 'ul' || tag === 'ol') {
          renderList(node, tag === 'ol', 0);
        } else if (tag === 'table') {
          if (isLayoutTable(node)) {
            for (const child of node.childNodes) {
              walk(child, depth + 1);
            }
          } else {
            renderTable(node);
          }
        } else if (tag === 'img') {
          renderImage(node);
        } else if (!hasBlockChildren(node)) {
          // Conteneur feuille (ex: <div> d'email Gmail/Outlook contenant du texte + <b>/<a>/<span>/<br>/<img>)
          renderInlineContainer(node, 0);
        } else {
          for (const child of node.childNodes) {
            walk(child, depth + 1);
          }
        }
      }

      if (document.body) {
        if (!hasBlockChildren(document.body)) {
          renderInlineContainer(document.body, 0);
        } else {
          for (const child of document.body.childNodes) {
            walk(child, 0);
          }
        }
      }

      // 6. Finalisation et retour
      const pdfBase64 = doc.output('datauristring');
      resolve({
        pdfBase64,
        hasNonLatinGlyphs: nonLatinCount >= 3,
      });
    } catch (err) {
      reject(err);
    }
  });
};
