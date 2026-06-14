// email_pdf_generator.js — Générateur PDF depuis le DOM email (jsPDF Walker)
// NotebookLM Clipper for Thunderbird
//
// ⚠️ Exécuté à la demande dans l'onglet email.
// ⚠️ Dépend de jspdf.umd.min.js injecté juste avant lui.

'use strict';

var __ntc_pdf_generator = true;

window.__ntc_generate_pdf = function (grounding, intentNote, labels) {
  return new Promise((resolve, reject) => {
    try {
      const jsPDFClass = (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) ? window.jspdf.jsPDF :
                         (typeof jspdf !== 'undefined' && jspdf.jsPDF) ? jspdf.jsPDF :
                         (typeof window.jsPDF !== 'undefined') ? window.jsPDF :
                         (typeof globalThis !== 'undefined' && globalThis.jsPDF) ? globalThis.jsPDF : null;
      if (!jsPDFClass) {
        throw new Error("jsPDF n'est pas chargé dans la page (window.jspdf: " + (typeof window.jspdf) + ", jspdf: " + (typeof jspdf) + ", window.jsPDF: " + (typeof window.jsPDF) + ", globalThis.jsPDF: " + (typeof globalThis !== 'undefined' ? typeof globalThis.jsPDF : 'N/A') + ")");
      }

      // 1. Estimation des mots
      let textContentCleaned = '';
      if (document.body) {
        if (document.body.innerText) {
          textContentCleaned = document.body.innerText;
        } else {
          // Fallback sur textContent en nettoyant d'abord les scripts et styles
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          textContentCleaned = clone.textContent || '';
        }
      }
      const wordCount = textContentCleaned.split(/\s+/).filter(Boolean).length;
      if (wordCount > 500000) {
        throw new Error("L'email dépasse la limite de 500 000 mots.");
      }

      // 2. Initialisation du document PDF
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

      function renderText(text, style, size) {
        doc.setFont("Helvetica", style || "normal");
        doc.setFontSize(size || 9);
        const lines = doc.splitTextToSize(text, contentWidth);
        const linesHeight = lines.length * (size * 1.2);
        checkPageOverflow(linesHeight);
        doc.text(lines, margin, y);
        y += linesHeight + 4;
      }

      function renderHeading(text, size) {
        if (!text) return;
        y += 8;
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(size);
        const lines = doc.splitTextToSize(text, contentWidth);
        const linesHeight = lines.length * (size * 1.2);
        checkPageOverflow(linesHeight);
        doc.text(lines, margin, y);
        y += linesHeight + 6;
      }

      function renderParagraph(node) {
        const text = (node.innerText || node.textContent || '').trim();
        if (text) {
          renderText(text, "normal", 9);
          y += 4;
        }
      }

      function renderList(listNode, isOrdered) {
        let index = 1;
        const listItems = listNode.querySelectorAll(':scope > li');
        listItems.forEach(li => {
          const text = (li.innerText || li.textContent || '').trim();
          if (!text) return;

          const prefix = isOrdered ? `${index++}. ` : '• ';
          const indent = 15;
          const listContentWidth = contentWidth - indent;

          doc.setFont("Helvetica", "normal");
          doc.setFontSize(9);
          const lines = doc.splitTextToSize(text, listContentWidth);
          const linesHeight = lines.length * 11;
          checkPageOverflow(linesHeight);

          doc.text(prefix, margin, y);
          doc.text(lines, margin + indent, y);
          y += linesHeight + 4;
        });
        y += 4;
      }

      function renderTable(tableNode) {
        const rows = tableNode.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr');
        if (rows.length === 0) return;

        const mdLines = [];
        let colCount = 0;

        rows.forEach((row, rowIndex) => {
          const cells = row.querySelectorAll(':scope > th, :scope > td');
          if (cells.length === 0) return;

          const cellTexts = [];
          cells.forEach(cell => {
            const cellText = (cell.innerText || cell.textContent || '').trim();
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

        doc.setFont("Courier", "normal");
        doc.setFontSize(8.5);

        mdLines.forEach(line => {
          const lines = doc.splitTextToSize(line, contentWidth);
          const linesHeight = lines.length * 10;
          checkPageOverflow(linesHeight);
          doc.text(lines, margin, y);
          y += linesHeight + 2;
        });

        doc.setFont("Helvetica", "normal");
        doc.setFontSize(9);
        y += 8;
      }

      function renderImage(imgNode) {
        try {
          if (!imgNode.complete || imgNode.naturalWidth === 0) return;

          const src = imgNode.src || '';
          let imgData = null;

          if (src.startsWith('data:')) {
            imgData = src;
          } else {
            const canvas = document.createElement('canvas');
            canvas.width = imgNode.naturalWidth;
            canvas.height = imgNode.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgNode, 0, 0);
            imgData = canvas.toDataURL('image/jpeg');
          }

          if (imgData) {
            const naturalWidth = imgNode.naturalWidth;
            const naturalHeight = imgNode.naturalHeight;
            const ratio = naturalHeight / naturalWidth;

            let imgWidth = Math.min(naturalWidth, contentWidth);
            let imgHeight = imgWidth * ratio;

            if (imgHeight > (height - topMargin - bottomMargin)) {
              imgHeight = height - topMargin - bottomMargin - 20;
              imgWidth = imgHeight / ratio;
            }

            checkPageOverflow(imgHeight + 10);
            doc.addImage(imgData, 'JPEG', margin, y, imgWidth, imgHeight);
            y += imgHeight + 10;
          }
        } catch (_e) {
          console.warn("[NTC-PDF] Image skipped due to CORS/canvas restriction:", imgNode.src);
        }
      }

      // 3. Rendu de l'Intent Note (si présente)
      if (intentNote) {
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(10);
        checkPageOverflow(14);
        const intentHeader = (labels && labels.pdfLabelIntention) || "INTENTION DE RECHERCHE :";
        doc.text(intentHeader, margin, y);
        y += 14;

        doc.setFont("Helvetica", "normal");
        doc.setFontSize(9);
        const lines = doc.splitTextToSize(intentNote, contentWidth);
        const linesHeight = lines.length * 12;
        checkPageOverflow(linesHeight + 10);
        doc.text(lines, margin, y);
        y += linesHeight + 15;
      }

      // 4. Rendu des Métadonnées de Grounding
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(11);
      checkPageOverflow(15);
      const emailHeader = (labels && labels.pdfLabelEmail) || "=== EMAIL ===";
      doc.text(emailHeader, margin, y);
      y += 15;

      doc.setFont("Helvetica", "normal");
      doc.setFontSize(9);

      // grounding.date est null si absente (revue 2026-06-10) — garde
      // anti-"Invalid Date" : on ne formate que si la date est parsable.
      let dateLabel = "—";
      if (grounding.date) {
        const parsedDate = new Date(grounding.date);
        if (!isNaN(parsedDate.getTime())) {
          dateLabel = parsedDate.toLocaleString();
        }
      }

      const metadata = [
        { label: (labels && labels.pdfLabelSubject) || "Objet :", val: grounding.subject },
        { label: (labels && labels.pdfLabelFrom) || "De    :", val: grounding.author },
        { label: (labels && labels.pdfLabelTo) || "À     :", val: grounding.recipients },
        { label: (labels && labels.pdfLabelDate) || "Date  :", val: dateLabel }
      ];

      metadata.forEach(item => {
        const text = `${item.label} ${item.val || ''}`;
        const lines = doc.splitTextToSize(text, contentWidth);
        const linesHeight = lines.length * 12;
        checkPageOverflow(linesHeight);
        doc.text(lines, margin, y);
        y += linesHeight;
      });

      doc.setFont("Helvetica", "bold");
      doc.setFontSize(11);
      checkPageOverflow(20);
      doc.text("========================================", margin, y);
      y += 25;

      // 5. Parcours récursif du DOM de l'email
      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim().replace(/\s+/g, ' ');
          if (text) {
            renderText(text, "normal", 9);
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          let style = null;
          try {
            style = window.getComputedStyle(node);
          } catch (_e) {}
          const display = style ? style.display : 'block';
          if (display === 'none' || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
            return;
          }

          const tag = node.tagName.toLowerCase();
          if (/^h[1-6]$/.test(tag)) {
            const size = 16 - parseInt(tag[1], 10);
            const headingText = (node.innerText || node.textContent || '').trim();
            renderHeading(headingText, size);
          } else if (tag === 'p') {
            renderParagraph(node);
          } else if (tag === 'ul' || tag === 'ol') {
            renderList(node, tag === 'ol');
          } else if (tag === 'table') {
            renderTable(node);
          } else if (tag === 'img') {
            renderImage(node);
          } else {
            for (const child of node.childNodes) {
              walk(child);
            }
          }
        }
      }

      // Démarrer la traversée du document.body
      for (const child of document.body.childNodes) {
        walk(child);
      }

      // 6. Finalisation et retour
      const pdfBase64 = doc.output('datauristring');
      resolve(pdfBase64);
    } catch (err) {
      reject(err);
    }
  });
};
void 0;
