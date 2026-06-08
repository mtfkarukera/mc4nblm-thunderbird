// utils.js — Fonctions utilitaires partagées
// NotebookLM Clipper for Thunderbird — MV2
// Pas d'ES modules (MV2) — exposé via var NtcUtils

'use strict';

// eslint-disable-next-line no-unused-vars
var NtcUtils = (function () {
  /**
   * Résout une clé i18n en chaîne traduite via browser.i18n.getMessage().
   * NE JAMAIS appeler browser.i18n.getMessage() directement dans popup.js.
   *
   * @param  {string}              key            - Clé de traduction.
   * @param  {string|string[]}     [substitutions] - Substitutions positionnelles.
   * @returns {string} - Chaîne traduite, ou la clé elle-même si introuvable.
   */
  function t(key, substitutions) {
    try {
      if (typeof browser === 'undefined' || !browser.i18n || typeof browser.i18n.getMessage !== 'function') {
        console.warn('[NTC] browser.i18n non disponible');
        return key;
      }
      const msg = substitutions
        ? browser.i18n.getMessage(key, substitutions)
        : browser.i18n.getMessage(key);

      if (!msg) {
        console.warn('[NTC] Clé i18n manquante :', key);
        return key;
      }
      return msg;
    } catch (e) {
      console.error('[NTC] Erreur dans t():', e);
      return key;
    }
  }

  /**
   * Convertit un Blob en data URI Base64 via FileReader.
   *
   * @param  {Blob} blob - Blob à convertir.
   * @returns {Promise<string>} - Data URI complet (ex: "data:application/pdf;base64,…").
   */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Assainit un nom de fichier en remplaçant les caractères spéciaux et non autorisés par des tirets bas.
   *
   * @param  {string} name - Le nom de fichier d'origine.
   * @returns {string} - Le nom de fichier assaini.
   */
  function sanitizeFilename(name) {
    if (!name) return 'file';
    // Remplace les caractères interdits/sensibles par _
    let sanitized = name.replace(/[?*:|<>/\\]/g, '_');
    // Évite les underscores multiples
    sanitized = sanitized.replace(/_+/g, '_');
    return sanitized.trim();
  }

  /**
   * Convertit un nœud DOM récursivement en Markdown.
   *
   * @param {Node} node - Le nœud DOM.
   * @param {number} [depth=0] - Niveau d'indentation.
   * @returns {string} - Le contenu Markdown.
   */
  function nodeToMarkdown(node, depth = 0) {
    if (!node) return '';
    if (node.nodeType === 3) { // Node.TEXT_NODE
      return node.textContent;
    }
    if (node.nodeType !== 1) { // Node.ELEMENT_NODE
      return '';
    }

    const tag = node.tagName.toLowerCase();

    // Ignorer les balises inutiles
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'link' || tag === 'meta') {
      return '';
    }

    if (tag === 'table') {
      if (isLayoutTable(node)) {
        let content = '';
        for (const child of node.childNodes) {
          content += nodeToMarkdown(child, depth);
        }
        return '\n' + content + '\n';
      }
      return '\n\n' + tableToMarkdown(node) + '\n\n';
    }
    if (tag === 'tr') {
      let content = '';
      for (const child of node.childNodes) {
        content += nodeToMarkdown(child, depth);
      }
      return content.trim() ? '\n' + content + '\n' : '';
    }
    if (tag === 'td' || tag === 'th') {
      let content = '';
      for (const child of node.childNodes) {
        content += nodeToMarkdown(child, depth);
      }
      return content.trim() ? ' ' + content.trim() + ' ' : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      return '\n\n' + listToMarkdown(node, tag === 'ol', depth) + '\n\n';
    }

    let childrenContent = '';
    for (const child of node.childNodes) {
      childrenContent += nodeToMarkdown(child, depth);
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      return `\n\n${'#'.repeat(level)} ${childrenContent.trim()}\n\n`;
    }
    if (tag === 'p') {
      return `\n\n${childrenContent.trim()}\n\n`;
    }
    if (tag === 'br') {
      return '\n';
    }
    if (tag === 'hr') {
      return '\n\n---\n\n';
    }
    if (tag === 'strong' || tag === 'b') {
      const trimmed = childrenContent.trim();
      return trimmed ? ` **${trimmed}** ` : '';
    }
    if (tag === 'em' || tag === 'i') {
      const trimmed = childrenContent.trim();
      return trimmed ? ` _${trimmed}_ ` : '';
    }
    if (tag === 'a') {
      const href = node.getAttribute('href');
      const text = childrenContent.trim();
      if (href && text) {
        if (href.startsWith('data:')) {
          return ` ${text} `;
        }
        return ` [${text}](${href}) `;
      }
      return childrenContent;
    }
    if (tag === 'blockquote') {
      const blockContent = childrenContent.trim();
      if (blockContent) {
        const bqLines = blockContent.split('\n').map(line => `> ${line}`);
        return '\n\n' + bqLines.join('\n') + '\n\n';
      }
      return '';
    }
    if (tag === 'pre') {
      return `\n\n\`\`\`\n${childrenContent}\n\`\`\`\n\n`;
    }
    if (tag === 'code') {
      if (node.parentNode && node.parentNode.tagName.toLowerCase() === 'pre') {
        return childrenContent;
      }
      return `\`${childrenContent.trim()}\``;
    }
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || 'Image';
      const src = node.getAttribute('src');
      if (src) {
        if (src.startsWith('data:')) {
          return ` [${alt}] `;
        }
        return ` ![${alt}](${src}) `;
      }
      return '';
    }
    if (tag === 'div' || tag === 'section' || tag === 'article') {
      return '\n' + childrenContent + '\n';
    }

    return childrenContent;
  }

  /**
   * Détermine si une table DOM sert à la mise en page (layout) ou contient des données.
   */
  function isLayoutTable(tableNode) {
    if (tableNode.querySelector('table')) {
      return true;
    }

    const rows = tableNode.querySelectorAll('tr');
    if (rows.length === 0) return true;
    if (rows.length === 1) return true;

    let maxCols = 0;
    rows.forEach(row => {
      const cells = row.querySelectorAll(':scope > th, :scope > td');
      if (cells.length > maxCols) {
        maxCols = cells.length;
      }
    });

    if (maxCols <= 1) return true;
    return false;
  }

  /**
   * Convertit un élément table en tableau Markdown.
   */
  function tableToMarkdown(tableNode) {
    const rows = tableNode.querySelectorAll('tr');
    if (rows.length === 0) return '';

    const mdLines = [];
    let hasHeaderSeparatorBeenAdded = false;

    rows.forEach((row) => {
      const cells = row.querySelectorAll(':scope > th, :scope > td');
      if (cells.length === 0) return;

      const cellTexts = [];
      cells.forEach(cell => {
        let cellText = '';
        for (const child of cell.childNodes) {
          cellText += nodeToMarkdown(child, 0);
        }
        cellTexts.push(cellText.trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|'));
      });

      mdLines.push(`| ${cellTexts.join(' | ')} |`);

      if (!hasHeaderSeparatorBeenAdded && cellTexts.length > 0) {
        const delims = Array(cellTexts.length).fill('---');
        mdLines.push(`| ${delims.join(' | ')} |`);
        hasHeaderSeparatorBeenAdded = true;
      }
    });

    return mdLines.join('\n');
  }

  /**
   * Convertit un élément ul ou ol en liste Markdown.
   */
  function listToMarkdown(listNode, isOrdered, depth = 0) {
    const listItems = listNode.querySelectorAll(':scope > li');
    const mdLines = [];
    let index = 1;

    listItems.forEach(li => {
      let itemText = '';
      const subLists = [];

      for (const child of li.childNodes) {
        if (child.nodeType === 1 && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) {
          subLists.push(child);
        } else {
          itemText += nodeToMarkdown(child, depth);
        }
      }

      const indent = ' '.repeat(depth);
      const prefix = isOrdered ? `${index++}. ` : '- ';
      let line = `${indent}${prefix}${itemText.trim()}`;

      // Si l'item contient des sous-listes, on les ajoute sur de nouvelles lignes indentées
      subLists.forEach(subList => {
        const subMarkdown = listToMarkdown(subList, subList.tagName.toLowerCase() === 'ol', depth + 4);
        line += '\n' + subMarkdown;
      });

      mdLines.push(line);
    });

    return mdLines.join('\n');
  }

  /**
   * Convertit une chaîne HTML simple en Markdown.
   *
   * @param  {string} html - Code HTML à convertir.
   * @returns {string} - Chaîne convertie en Markdown.
   */
  function htmlToMarkdown(html) {
    if (!html) return '';

    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const markdown = nodeToMarkdown(doc.body);
        return markdown
          .replace(/\n{3,}/g, '\n\n') // Max 2 sauts de ligne
          .trim();
      } catch (e) {
        console.error('[NTC] Erreur parsing DOM dans htmlToMarkdown:', e);
      }
    }

    // Fallback regex d'origine si DOMParser est absent (n'arrive normalement pas)
    return html
      .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, n, t) => `${'#'.repeat(+n)} ${t.trim()}`)
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Construit l'URL NotebookLM pointant vers un carnet donné.
   *
   * @param  {string} notebookId - Identifiant du carnet.
   * @param  {number} [authuserIndex] - Index du compte Google actif.
   * @returns {string} - URL complète vers le carnet.
   */
  function buildNotebookUrl(notebookId, authuserIndex) {
    const url = `https://notebooklm.google.com/notebook/${notebookId}`;
    if (authuserIndex !== undefined && authuserIndex !== null) {
      return `${url}?authuser=${authuserIndex}`;
    }
    return url;
  }

  return {
    t,
    blobToBase64,
    buildNotebookUrl,
    htmlToMarkdown,
    sanitizeFilename,
  };
})();


