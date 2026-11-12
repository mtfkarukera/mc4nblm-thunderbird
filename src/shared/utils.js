// utils.js — Fonctions utilitaires partagées
// Magic Clipper for Gemini Notebook (Thunderbird 128+ ESR — Manifest V3)
// Auteur : MTF Karukera
// Exposé via var NtcUtils (partagé par l'Event Page MV3, la popup et les scripts email)

'use strict';

// eslint-disable-next-line no-unused-vars
var NtcUtils = (function () {
  /**
   * Mode debug — DOIT rester à false en release.
   * Gate tous les logs informatifs (log()) et les entrées diagnostic
   * (carnets __diag__). Voir AGENTS.md §4.4.
   */
  const DEBUG = false;

  /** Profondeur maximale de parcours DOM pour éviter tout dépassement de pile */
  const MAX_DOM_DEPTH = 200;

  /**
   * Log informatif gaté par DEBUG. Ne JAMAIS y passer de payload sensible
   * (cookies, tokens, réponses RPC brutes, contenu email) — même en DEBUG,
   * préférer des longueurs/booléens aux contenus.
   *
   * @param {...*} args - Arguments transmis à console.warn si DEBUG actif.
   */
  function log(...args) {
    if (DEBUG) console.warn('[NTC]', ...args);
  }

  /**
   * Clés browser.storage.local — source unique partagée par background.js
   * ET popup.js. Ne jamais utiliser ces littéraux directement ailleurs.
   */
  const STORAGE_KEYS = {
    ACTIVE_AUTHUSER: 'ntc_active_authuser',
    LAST_NOTEBOOK: 'ntc_last_notebook_id',
    DATA_CONSENT: 'ntc_data_consent',
  };

  /**
   * Clés browser.storage.session — métadonnées légères survivant à la mise en
   * veille de l'Event Page MV3 (zéro cookie, zéro jeton CSRF, zéro contenu email).
   */
  const SESSION_KEYS = {
    AUTH_TAB_ID: 'ntc_session_auth_tab_id',
    ROTATE_META: 'ntc_session_rotate_meta',
  };

  /**
   * Normalise et borne l'index de compte Google authuser dans l'intervalle [0..4].
   *
   * @param {*} val - Valeur brute issue du stockage ou d'un message IPC.
   * @returns {number} Entier sûr compris entre 0 et 4.
   */
  function sanitizeAuthuserIndex(val) {
    const parsed = Number.parseInt(String(val), 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
      return parsed;
    }
    return 0;
  }

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
   * Convertit une chaîne de données base64 (avec ou sans préfixe "data:...") en Blob.
   *
   * @param {string} base64 - Données base64.
   * @param {string} mimeType - Type MIME du Blob résultant.
   * @returns {Blob} Le Blob converti.
   */
  function base64ToBlob(base64, mimeType) {
    const cleanB64 = base64.includes(',') ? base64.split(',')[1] : base64;
    const byteCharacters = atob(cleanB64);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    return new Blob([byteNumbers], { type: mimeType });
  }

  /**
   * Helper pour créer une erreur typée avec un code.
   *
   * @param {string} code - Le code d'erreur (ex: 'AUTH_EXPIRED').
   * @param {string} message - Le message d'erreur.
   * @returns {Error} L'erreur créée.
   */
  function ntcError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  /**
   * Assainit un nom de fichier en remplaçant les caractères spéciaux, de contrôle
   * et non autorisés par des tirets bas, et supprime les points/espaces aux extrémités.
   *
   * @param  {string} name - Le nom de fichier d'origine.
   * @returns {string} - Le nom de fichier assaini (fallback 'email').
   */
  function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return 'email';
    // Supprime les caractères de contrôle ASCII (0x00–0x1F et 0x7F)
    let sanitized = '';
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code >= 0x20 && code !== 0x7f) {
        sanitized += name[i];
      }
    }
    // Remplace les caractères interdits par les systèmes de fichiers (dont ") par _
    sanitized = sanitized.replace(/[?*:|<>/\\"]/g, '_');
    // Évite les underscores multiples
    sanitized = sanitized.replace(/_+/g, '_');
    // Retire les points et espaces initiaux/finaux dangereux sous Windows/macOS
    sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');
    // Troncature à 200 caractères (P4.4)
    if (sanitized.length > 200) {
      sanitized = sanitized.slice(0, 200).replace(/[.\s]+$/g, '');
    }
    return sanitized || 'email';
  }

  /**
   * Convertit un nœud DOM récursivement en Markdown avec garde-fou de profondeur.
   *
   * @param {Node} node - Le nœud DOM.
   * @param {number} [listIndent=0] - Niveau d'indentation des listes.
   * @param {number} [domDepth=0] - Profondeur de récursion DOM.
   * @returns {string} - Le contenu Markdown.
   */
  function nodeToMarkdown(node, listIndent = 0, domDepth = 0) {
    if (!node) return '';
    if (domDepth > MAX_DOM_DEPTH) {
      return node.textContent || '';
    }
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
          content += nodeToMarkdown(child, listIndent, domDepth + 1);
        }
        return '\n' + content + '\n';
      }
      return '\n\n' + tableToMarkdown(node, domDepth + 1) + '\n\n';
    }
    if (tag === 'tr') {
      let content = '';
      for (const child of node.childNodes) {
        content += nodeToMarkdown(child, listIndent, domDepth + 1);
      }
      return content.trim() ? '\n' + content + '\n' : '';
    }
    if (tag === 'td' || tag === 'th') {
      let content = '';
      for (const child of node.childNodes) {
        content += nodeToMarkdown(child, listIndent, domDepth + 1);
      }
      return content.trim() ? ' ' + content.trim() + ' ' : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      return '\n\n' + listToMarkdown(node, tag === 'ol', listIndent, domDepth + 1) + '\n\n';
    }

    let childrenContent = '';
    for (const child of node.childNodes) {
      childrenContent += nodeToMarkdown(child, listIndent, domDepth + 1);
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
        const safeHref = href.trim();
        // N'autoriser que les schémas web sûrs (bloque javascript:, vbscript:, data:)
        if (/^(https?:|mailto:)/i.test(safeHref)) {
          return ` [${text}](${safeHref}) `;
        }
        return ` ${text} `;
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
      if (node.parentNode && node.parentNode.tagName && node.parentNode.tagName.toLowerCase() === 'pre') {
        return childrenContent;
      }
      return `\`${childrenContent.trim()}\``;
    }
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || 'Image';
      const src = node.getAttribute('src');
      if (src) {
        const safeSrc = src.trim();
        if (/^https?:/i.test(safeSrc)) {
          return ` ![${alt}](${safeSrc}) `;
        }
        return ` [${alt}] `;
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

  /**
   * Convertit un élément table en tableau Markdown.
   */
  function tableToMarkdown(tableNode, domDepth = 0) {
    const rows = Array.from(tableNode.querySelectorAll('tr')).filter(tr => tr.closest('table') === tableNode);
    if (rows.length === 0) return '';

    const mdLines = [];
    let hasHeaderSeparatorBeenAdded = false;

    rows.forEach((row) => {
      const cells = Array.from(row.cells);
      if (cells.length === 0) return;

      const cellTexts = [];
      cells.forEach(cell => {
        let cellText = '';
        for (const child of cell.childNodes) {
          cellText += nodeToMarkdown(child, 0, domDepth + 1);
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
  function listToMarkdown(listNode, isOrdered, listIndent = 0, domDepth = 0) {
    const listItems = Array.from(listNode.children).filter(child => child.tagName.toLowerCase() === 'li');
    const mdLines = [];
    let index = 1;

    listItems.forEach(li => {
      let itemText = '';
      const subLists = [];

      for (const child of li.childNodes) {
        if (child.nodeType === 1 && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) {
          subLists.push(child);
        } else {
          itemText += nodeToMarkdown(child, listIndent, domDepth + 1);
        }
      }

      const indent = ' '.repeat(listIndent);
      const prefix = isOrdered ? `${index++}. ` : '- ';
      let line = `${indent}${prefix}${itemText.trim()}`;

      // Si l'item contient des sous-listes, on les ajoute sur de nouvelles lignes indentées
      subLists.forEach(subList => {
        const subMarkdown = listToMarkdown(subList, subList.tagName.toLowerCase() === 'ol', listIndent + 4, domDepth + 1);
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
        const markdown = nodeToMarkdown(doc.body, 0, 0);
        return markdown
          .replace(/\n{3,}/g, '\n\n') // Max 2 sauts de ligne
          .trim();
      } catch (e) {
        console.error('[NTC] Erreur parsing DOM dans htmlToMarkdown:', e);
      }
    }

    // Fallback regex d'origine si DOMParser est absent (n'arrive normalement pas)
    return html
      .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, n, text) => `${'#'.repeat(+n)} ${text.trim()}`)
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => (
        /^(https?:|mailto:)/i.test(href.trim()) ? `[${text}](${href.trim()})` : text
      ))
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
   * Construit l'URL Gemini Notebook pointant vers un carnet donné avec validation stricte.
   *
   * @param  {string} notebookId - Identifiant du carnet.
   * @param  {number} [authuserIndex] - Index du compte Google actif.
   * @returns {string} - URL complète vers le carnet.
   */
  function buildNotebookUrl(notebookId, authuserIndex) {
    const rawId = String(notebookId || '').trim();
    if (!rawId || /[/?#\\]/.test(rawId)) {
      return 'https://notebook.google.com/';
    }
    const safeId = encodeURIComponent(rawId);
    const url = `https://notebook.google.com/notebook/${safeId}`;
    if (authuserIndex !== undefined && authuserIndex !== null) {
      const idx = sanitizeAuthuserIndex(authuserIndex);
      return `${url}?authuser=${idx}`;
    }
    return url;
  }

  return {
    DEBUG,
    log,
    STORAGE_KEYS,
    SESSION_KEYS,
    sanitizeAuthuserIndex,
    t,
    base64ToBlob,
    ntcError,
    buildNotebookUrl,
    htmlToMarkdown,
    sanitizeFilename,
  };
})();
