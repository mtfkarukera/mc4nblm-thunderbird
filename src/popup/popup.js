import { t, setCustomLocale } from '../shared/utils.js';

// popup.js : Logique UI et communication asynchrone

// Constantes DOM
const btnCapture = document.getElementById('btn-capture');
const uiSearchInput = document.getElementById('notebook-search');
const uiNotebookList = document.getElementById('notebook-list');
const uiStatusMessage = document.getElementById('status-message');
const uiAuthStatus = document.getElementById('auth-status');
const btnCustomSpinner = document.getElementById('btn-spinner');
const btnCreateNotebook = document.getElementById('btn-create-notebook');
const uiFormatToggle = document.getElementById('format-toggle');
const uiDirectImportSection = document.getElementById('direct-import-section');
const btnDirectImport = document.getElementById('btn-direct-import');
const uiDirectLabel = document.getElementById('direct-label');
const uiSelectionBanner = document.getElementById('selection-banner');
const uiSelectionPreview = document.getElementById('selection-text-preview');
const btnClearSelection = document.getElementById('btn-clear-selection');
const intentInput = document.getElementById('intent-input');
const intentCounter = document.getElementById('intent-counter');

const BINARY_EXTENSIONS = new Set([
  'pdf','mp3','mp4','wav','ogg','aac','m4a','flac','opus','amr','wma',
  'png','jpg','jpeg','gif','bmp','webp','avif','tiff','ico','heic','heif',
  'avi','mov','mkv','3gp','3g2','mpeg','docx','xlsx','pptx','epub','csv'
]);

/** Retourne true si l'URL correspond à une page YouTube (watch, shorts, youtu.be). */
function isYouTubeWatch(url) {
  return /(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/.test(url);
}

/** Retourne true si l'URL se termine par une extension binaire connue (pdf, mp3, png, etc.). */
function hasBinaryExtension(url) {
  try {
    const path = new URL(url).pathname;
    const ext = path.split('.').pop().toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

// Variables d'état
let currentSelectedNotebookId = null;
let allNotebooksCache = [];
let currentFormat = "pdf";
let detectedFileInfo = null;
let pendingSelection = null; // Sélection en attente (capturée via le menu contextuel)

/** Remplace le contenu d'un container par un placeholder textuel (zéro innerHTML). */
function setPlaceholder(container, text, style) {
  const div = document.createElement('div');
  div.className = 'placeholder-text';
  if (style) div.style.cssText = style;
  div.textContent = text;
  container.replaceChildren(div);
}

/** Applique les traductions i18n sur tous les éléments DOM portant data-i18n*. */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const { locale } = await browser.storage.local.get('locale');
  await setCustomLocale(locale ?? '');
  applyI18n();

  const localeSelector = document.getElementById('locale-selector');
  if (localeSelector) {
    localeSelector.value = (locale === 'gcf') ? 'gcf' : 'auto';
    localeSelector.addEventListener('change', async (e) => {
      await browser.storage.local.set({ locale: e.target.value });
      await setCustomLocale(e.target.value);
      applyI18n();
    });
  }

  // Connexion au background pour obtenir l'état et les carnets
  browser.runtime.sendMessage({ action: "GET_AUTH_STATUS" }).then((response) => {
     if(response && response.status === "CONNECTE") {
         updateAuthStatus(t('statusConnected').replace('{type}', response.type), "status-success");
         
         if (response.type === "PERSONAL") {
             browser.runtime.sendMessage({ action: "GET_ACCOUNTS" }).then(res => {
                 if (res && res.accounts && res.accounts.length > 1) {
                     const selectBox = document.getElementById("account-switcher");
                     if(selectBox) {
                         selectBox.replaceChildren();
                         res.accounts.forEach(acc => {
                             const opt = document.createElement("option");
                             opt.value = acc.index;
                             opt.textContent = acc.email;
                             if (acc.index === res.activeIndex) opt.selected = true;
                             selectBox.appendChild(opt);
                         });
                         selectBox.classList.remove("hidden");
                         selectBox.addEventListener("change", (e) => {
                             const newIndex = parseInt(e.target.value, 10);
                             browser.runtime.sendMessage({ action: "SET_ACCOUNT", index: newIndex }).then(() => {
                                 loadNotebooks(); // Recharger les carnets
                             });
                         });
                     }
                 }
                 loadNotebooks();
             }).catch(() => loadNotebooks());
         } else {
             loadNotebooks();
         }
     } else {
         updateAuthStatus(t('statusDisconnected'), "status-error");
         setPlaceholder(uiNotebookList, t('errAuth'));
     }
  }).catch(e => {
     updateAuthStatus(t('statusDisconnected'), "status-error");
     setPlaceholder(uiNotebookList, t('errAuth'));
   });
   
   uiSearchInput.addEventListener('input', debounce((e) => {
     filterNotebooks(e.target.value);
   }, 300));
   
   btnCapture.addEventListener('click', startCaptureProcess);
   
   // Bouton "+" : Crée un carnet avec le texte du champ de recherche
   btnCreateNotebook.addEventListener('click', createNewNotebook);

   // Toggle format PDF / Markdown / URL / Screenshot
   uiFormatToggle.addEventListener('click', (e) => {
     const btn = e.target.closest('.format-btn');
     if (!btn || btn.classList.contains('active') || btn.classList.contains('btn-disabled')) return;

     // Si une sélection est en attente, la cleariser quand l'utilisateur change de format
     if (pendingSelection) {
       browser.storage.local.remove('nwc_pending_selection');
       pendingSelection = null;
       uiSelectionBanner.classList.add('hidden');
       // Réactiver les boutons qui étaient grisés par la sélection
       uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('btn-disabled'));
     }

     // Désélectionner tous les boutons (format toggle + direct)
     uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
     if (btnDirectImport) btnDirectImport.classList.remove('active');
     
     btn.classList.add('active');
     currentFormat = btn.dataset.format;
     updateCaptureButtonLabel();
   });

   // Bouton Import Direct (séparé du toggle principal)
   if (btnDirectImport) {
     btnDirectImport.addEventListener('click', () => {
       if (btnDirectImport.classList.contains('active')) return;
       
       // Désélectionner les boutons du toggle principal
       uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
       btnDirectImport.classList.add('active');
       currentFormat = 'direct';
       updateCaptureButtonLabel();
     });
   }

   // Bouton Annuler la sélection
   if (btnClearSelection) {
     btnClearSelection.addEventListener('click', async () => {
       await browser.storage.local.remove('nwc_pending_selection');
       pendingSelection = null;
       uiSelectionBanner.classList.add('hidden');
       // Restaurer le format précédent
       if (currentFormat === 'selection') {
         currentFormat = 'pdf';
         uiFormatToggle.querySelector('[data-format="pdf"]').classList.add('active');
         updateCaptureButtonLabel();
       }
     });
   }

   // Détection du type de fichier pour l'Import Direct
   detectActiveTabFileType();

   // Vérifier s'il y a une sélection en attente (capturée via le menu contextuel)
   checkPendingSelection();

   // Compteur d'intention
   if (intentInput && intentCounter) {
     intentInput.addEventListener('input', () => {
       intentCounter.textContent = `${intentInput.value.length} / 300`;
     });
   }
});

/** Charge la liste des carnets depuis le background et met à jour l'affichage. */
function loadNotebooks() {
    setPlaceholder(uiNotebookList, t('loadingNotebooks'));
    browser.runtime.sendMessage({ action: "GET_NOTEBOOKS" }).then((res) => {
         uiSearchInput.disabled = false;
         if(res && res.notebooks) {
            allNotebooksCache = res.notebooks;
            renderNotebooks(allNotebooksCache);
         } else if (res && res.status === "error") {
            const msg = res.i18nKey ? t(res.i18nKey) : t('errLoadNotebooks');
            setPlaceholder(uiNotebookList, msg, "color:#d32f2f;font-size:12px;margin:10px");
         } else {
            setPlaceholder(uiNotebookList, t('noNotebookFound'));
         }
    }).catch(err => {
         setPlaceholder(uiNotebookList, t('errGeneric').replace('{msg}', err.message), 'color:#d32f2f;');
         uiSearchInput.disabled = true;
    });
}

/** Construit la liste visuelle des carnets dans le DOM à partir d'un tableau filtré. */
function renderNotebooks(list) {
    uiNotebookList.replaceChildren();
    if(list.length === 0) {
        setPlaceholder(uiNotebookList, t('notebookNotFound'));
        return;
    }
    list.forEach(nb => {
        const div = document.createElement('div');
        div.className = 'notebook-item';
        if (currentSelectedNotebookId === nb.id) {
           div.classList.add('selected');
        }
        div.textContent = nb.title;
        div.onclick = () => {
            document.querySelectorAll('.notebook-item').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            currentSelectedNotebookId = nb.id;
            btnCapture.disabled = false;
        };
        uiNotebookList.appendChild(div);
    });
}

/** Retarde l'exécution d'une fonction jusqu'à ce qu'un délai d'inactivité soit écoulé. */
function debounce(func, delay) {
  let timeoutId;
  return function (...args) {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

/** Filtre les carnets en cache par titre et rafraîchit l'affichage. */
function filterNotebooks(query) {
  const filtered = allNotebooksCache.filter(nb => nb.title.toLowerCase().includes(query.toLowerCase()));
  renderNotebooks(filtered);
}

/**
 * Création d'un nouveau carnet : utilise le contenu du champ de recherche comme nom
 */
async function createNewNotebook() {
  const title = uiSearchInput.value.trim();
  if (!title) {
    updateStatus(t('errNoSearchTerm'), "error");
    return;
  }
  
  btnCreateNotebook.disabled = true;
  updateStatus(t('creatingNotebook').replace('{title}', title), "info");
  
  try {
    const response = await browser.runtime.sendMessage({ 
      action: "CREATE_NOTEBOOK", 
      title: title 
    });
    
    if (response && response.notebookId) {
      // Sélectionner automatiquement le nouveau carnet
      currentSelectedNotebookId = response.notebookId;
      btnCapture.disabled = false;
      
      // Ajouter au cache et rafraîchir l'affichage
      allNotebooksCache.unshift({ id: response.notebookId, title: title });
      uiSearchInput.value = '';
      renderNotebooks(allNotebooksCache);
      
      const notebookUrl = `https://notebooklm.google.com/notebook/${response.notebookId}`;
      updateStatus(t('notebookCreated').replace('{title}', title), "success", notebookUrl);
    } else {
      const msg = response?.i18nKey ? t(response.i18nKey) : t('errCreateNotebook');
      updateStatus(msg, "error");
    }
  } catch (err) {
    updateStatus(t('errGeneric').replace('{msg}', err.message), "error");
  } finally {
    btnCreateNotebook.disabled = false;
  }
}

/** Déclenche le processus de capture en envoyant START_CAPTURE au background. */
function startCaptureProcess() {
   if (!currentSelectedNotebookId) {
     updateStatus(t('errNoNotebook'), "error");
     return;
   }

   // Mode sélection : envoyer le texte capturé
   if (currentFormat === 'selection' && pendingSelection) {
     btnCapture.disabled = true;
     uiSearchInput.disabled = true;
     btnCustomSpinner.classList.remove('hidden');
     updateStatus(t('importingSelection'), "info");
     
     browser.runtime.sendMessage({
       action: "START_CAPTURE",
       notebookId: currentSelectedNotebookId,
       format: 'selection',
       selectionData: pendingSelection,
       intentNote: intentInput.value.trim() || null
     });
     
     // Nettoyer la sélection en attente
     browser.storage.local.remove('nwc_pending_selection');
     pendingSelection = null;
     return;
   }

   btnCapture.disabled = true;
   uiSearchInput.disabled = true;
   btnCustomSpinner.classList.remove('hidden');

   const formatLabels = { pdf: 'PDF', md: 'Markdown', url: 'URL', screenshot: 'Screenshot', direct: 'Import direct', drive: 'Google Drive' };
   const label = formatLabels[currentFormat] || currentFormat;
   updateStatus(t('importingFormat').replace('{label}', label), "info");

   browser.runtime.sendMessage({ 
     action: "START_CAPTURE", 
     notebookId: currentSelectedNotebookId,
     format: currentFormat,
     intentNote: intentInput.value.trim() || null
   });
}

/**
 * Met à jour le libellé du bouton principal selon le format sélectionné.
 */
function updateCaptureButtonLabel() {
   const btnText = btnCapture.querySelector('.btn-text');
   btnText.textContent = t('popupTitleCapture');

   // Affichage conditionnel du champ d'intention
   const intentWrapper = document.getElementById('intent-wrapper');
   if (intentWrapper) {
     if (currentFormat === 'pdf' || currentFormat === 'md') {
       intentWrapper.classList.remove('hidden');
     } else {
       intentWrapper.classList.add('hidden');
       if (intentInput) intentInput.value = "";
       if (intentCounter) intentCounter.textContent = "0 / 300";
     }
   }
}

/**
 * Détecte si l'onglet actif affiche un fichier directement importable.
 * Active/désactive les boutons en conséquence.
 */
async function detectActiveTabFileType() {
   try {
     const tabs = await browser.tabs.query({ active: true, currentWindow: true });
     if (tabs.length === 0) return;

     const url = tabs[0].url;

     const pdfBtn = uiFormatToggle.querySelector('[data-format="pdf"]');
     const mdBtn = uiFormatToggle.querySelector('[data-format="md"]');
     const urlBtn = uiFormatToggle.querySelector('[data-format="url"]');
     const screenshotBtn = uiFormatToggle.querySelector('[data-format="screenshot"]');

     if (isYouTubeWatch(url)) {
       pdfBtn.classList.add('btn-disabled');
       mdBtn.classList.add('btn-disabled');
       screenshotBtn.classList.add('btn-disabled');
       if (btnDirectImport) {
         btnDirectImport.classList.add('btn-disabled');
       }

       if (currentFormat !== 'url') {
         uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
         if (btnDirectImport) btnDirectImport.classList.remove('active');
         urlBtn.classList.add('active');
         currentFormat = 'url';
         updateCaptureButtonLabel();
       }
       return;
     }

     if (hasBinaryExtension(url)) {
        pdfBtn.classList.add('btn-disabled');
        mdBtn.classList.add('btn-disabled');
        screenshotBtn.classList.add('btn-disabled');

       const ext = new URL(url).pathname.split('.').pop().toLowerCase();
       const label = ext.toUpperCase();
       if (uiDirectLabel) {
         uiDirectLabel.textContent = `${t('btnDirect')} (${label})`;
       }
       if (uiDirectImportSection) {
         uiDirectImportSection.classList.remove('hidden');
       }

       if (btnDirectImport) {
         btnDirectImport.classList.remove('btn-disabled');
         btnDirectImport.classList.add('active');
       }

       uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));

       currentFormat = 'direct';
       updateCaptureButtonLabel();
       return;
     }

     // F2 étape 2 : URL sans extension connue → HEAD request MIME via background
     try {
       const { isBinary, mime } = await browser.runtime.sendMessage({
         action: 'DETECT_MIME',
         url
       });
        if (isBinary) {
          pdfBtn.classList.add('btn-disabled');
          mdBtn.classList.add('btn-disabled');
          screenshotBtn.classList.add('btn-disabled');

         // Extraire un label lisible depuis le MIME (ex: "audio/mpeg" → "AUDIO")
         const mimeLabel = mime.split('/')[0].toUpperCase();
         if (uiDirectLabel) {
           uiDirectLabel.textContent = `${t('btnDirect')} (${mimeLabel})`;
         }
         if (uiDirectImportSection) {
           uiDirectImportSection.classList.remove('hidden');
         }
         if (btnDirectImport) {
           btnDirectImport.classList.remove('btn-disabled');
           btnDirectImport.classList.add('active');
         }
         uiFormatToggle.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
         currentFormat = 'direct';
         updateCaptureButtonLabel();
         return;
       }
     } catch (e) {
        console.warn('[MC] DETECT_MIME — requête échouée:', e?.message);
       // Skip silencieux : comportement page web ordinaire
     }

     // 1. Détection prioritaire Google Drive
     if (window.ClipperUtils && window.ClipperUtils.parseDriveUrl) {
         const driveInfo = window.ClipperUtils.parseDriveUrl(url);
         if (driveInfo) {
             const driveBtn = document.getElementById('btn-drive-import');
             if (driveBtn) {
                 driveBtn.style.display = 'flex';
                 driveBtn.classList.remove('hidden');

                 if (driveInfo.typeStr === 'file') {
                     // Fichier hébergé sur Drive → Drive + Screenshot
                     // (Drive pour les docs textuels, Screenshot pour le reste)
                     uiFormatToggle.querySelectorAll('.format-btn').forEach(b => {
                         b.classList.remove('active');
                         if (['pdf', 'md', 'url'].includes(b.dataset.format)) {
                             b.style.display = 'none';
                         }
                     });
                 } else {
                     // Google Workspace (Docs/Sheets/Slides) → Drive exclusif
                     uiFormatToggle.querySelectorAll('.format-btn').forEach(b => {
                         b.classList.remove('active');
                         if (['pdf', 'md', 'url', 'screenshot'].includes(b.dataset.format)) {
                             b.style.display = 'none';
                         }
                     });
                 }

                 driveBtn.classList.add("active");
                 currentFormat = "drive";
                 updateCaptureButtonLabel();
                 return;
             }
         }
     }

     // 2. Fallback pour fichiers réguliers via background script
     const result = await browser.runtime.sendMessage({ action: "DETECT_FILE_TYPE", url });
     detectedFileInfo = result;

     if (result && result.directImport) {
       // Afficher le bouton Import Direct avec le label du type détecté
       uiDirectLabel.textContent = `${t('btnDirect')} (${result.label})`;
       uiDirectImportSection.classList.remove('hidden');

      if (result.isLocal) {
         // === Fichier local : tout griser + message informatif ===
         uiFormatToggle.querySelectorAll('.format-btn').forEach(b => {
           b.classList.add('btn-disabled');
           b.classList.remove('active');
         });
         btnDirectImport.classList.add('btn-disabled');
         currentFormat = 'direct';
         updateStatus(t('warnLocalFile'), "info");
         updateCaptureButtonLabel();
       } else {
         // === Fichier distant : bouton Import Direct normal ===
         applyButtonVisibility(result);
       }
     }
   } catch (e) {
      console.warn('[MC] Détection fichier échouée:', e.message);
   }
}

/**
 * Applique la matrice de visibilité des boutons selon le type de fichier détecté.
 * 
 * Règles :
 * - Image/Audio/Video : PDF et MD grisés (n'ont pas de sens)
 * - Audio/Video : Screenshot grisé aussi
 * - Fichier local (file://) : URL grisé 
 */
function applyButtonVisibility(fileInfo) {
   const pdfBtn = uiFormatToggle.querySelector('[data-format="pdf"]');
   const mdBtn = uiFormatToggle.querySelector('[data-format="md"]');
   const urlBtn = uiFormatToggle.querySelector('[data-format="url"]');
   const screenshotBtn = uiFormatToggle.querySelector('[data-format="screenshot"]');

   // Images : PDF/MD n'ont pas de sens (Readability sur un viewer d'image = garbled)
   if (fileInfo.category === 'image') {
     pdfBtn.classList.add('btn-disabled');
     mdBtn.classList.add('btn-disabled');
   }

   // Audio/Vidéo : PDF/MD/Screenshot n'ont aucun sens
   if (fileInfo.category === 'audio' || fileInfo.category === 'video') {
     pdfBtn.classList.add('btn-disabled');
     mdBtn.classList.add('btn-disabled');
     screenshotBtn.classList.add('btn-disabled');
   }

   // Fichier local : URL grisé (Google ne peut pas scraper file://)
   if (fileInfo.isLocal) {
     urlBtn.classList.add('btn-disabled');
   }

   // Si le format actif est maintenant désactivé, basculer sur Import Direct
   const activeBtn = uiFormatToggle.querySelector('.format-btn.active');
   if (activeBtn && activeBtn.classList.contains('btn-disabled')) {
     activeBtn.classList.remove('active');
     btnDirectImport.classList.add('active');
     currentFormat = 'direct';
     updateCaptureButtonLabel();
   }
}

/**
 * Vérifie s'il y a une sélection de texte en attente (capturée via le menu contextuel).
 * Si oui, affiche le bandeau et bascule sur le format "selection".
 */
async function checkPendingSelection() {
   try {
     const data = await browser.storage.local.get('nwc_pending_selection');
     const sel = data.nwc_pending_selection;
     
     if (!sel || !sel.text) return;
     
     // Ignorer les sélections trop anciennes (> 2 min)
     if (Date.now() - sel.timestamp > 2 * 60 * 1000) {
       await browser.storage.local.remove('nwc_pending_selection');
       return;
     }
     
     pendingSelection = sel;
     
     // Afficher le bandeau avec aperçu
     const wordCount = sel.text.split(/\s+/).filter(w => w.length > 0).length;
     const preview = sel.text.substring(0, 60) + (sel.text.length > 60 ? '…' : '');
     uiSelectionPreview.textContent = `"${preview}" (${wordCount})`;
     uiSelectionBanner.classList.remove('hidden');
     
     // Basculer sur le format "selection" et griser TOUS les boutons de format
     // (la sélection ne supporte qu'un seul mode : texte source)
     uiFormatToggle.querySelectorAll('.format-btn').forEach(b => {
       b.classList.remove('active');
       b.classList.add('btn-disabled');
     });
     // Griser aussi le bouton Import Direct s'il est visible
     if (btnDirectImport) btnDirectImport.classList.add('btn-disabled');
     
     currentFormat = 'selection';
     updateCaptureButtonLabel();
     
     // Activer le bouton si un carnet est déjà sélectionné
     if (currentSelectedNotebookId) {
       btnCapture.disabled = false;
     }
     
     // Marquer la sélection comme vue (elle sera supprimée au prochain checkPendingSelection)
     await browser.storage.local.remove('nwc_pending_selection');
   } catch (e) {
      console.warn('[MC] Erreur vérification sélection:', e.message);
   }
}

/** Restaure l'état initial de l'UI après une capture réussie ou échouée. */
function resetUI() {
  btnCapture.disabled = false;
  uiSearchInput.disabled = false;
  btnCustomSpinner.classList.add('hidden');
}

/** Met à jour le message de statut, avec lien optionnel vers le carnet et bouton de téléchargement. */
function updateStatus(message, type, linkUrl, showDownload) {
  // Construction DOM sécurisée (pas de innerHTML)
  uiStatusMessage.replaceChildren();
  uiStatusMessage.appendChild(document.createTextNode(message));
  
  if (linkUrl) {
    const link = document.createElement('a');
    link.href = linkUrl;
    link.target = '_blank';
    link.textContent = ' ' + t('linkOpenNotebook');
    link.style.cssText = 'color: #1a73e8; text-decoration: underline; cursor: pointer; margin-left: 4px;';
    uiStatusMessage.appendChild(link);
  }
  
  if (showDownload) {
    const ext = currentFormat === "md" ? ".md" : ".pdf";
    const dlLink = document.createElement('a');
    dlLink.href = '#';
    dlLink.textContent = ' ' + t('linkDownloadFile').replace('{ext}', ext);
    dlLink.style.cssText = 'color: #34a853; text-decoration: underline; cursor: pointer; margin-left: 8px; font-size: 12px;';
    dlLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dlLink.textContent = ' ' + t('linkDownloading');
      browser.runtime.sendMessage({ action: "DOWNLOAD_CAPTURE" }).then(res => {
        if (res && res.ok) {
          dlLink.textContent = ' ' + t('linkDownloaded');
        } else {
          dlLink.textContent = ' ' + t('errDownload');
        }
      }).catch(() => {
        dlLink.textContent = ' ' + t('errDownload');
      });
    });
    uiStatusMessage.appendChild(dlLink);
  }
  
  if(type === "error") uiStatusMessage.style.color = "var(--status-error)";
  else if (type === "success") uiStatusMessage.style.color = "var(--status-success)";
  else uiStatusMessage.style.color = "var(--text-muted)";
}

/** Met à jour le badge d'état de connexion (texte + classe CSS). */
function updateAuthStatus(text, cssClass) {
  uiAuthStatus.textContent = text;
  uiAuthStatus.className = `status-badge ${cssClass}`;
}

// Bouton Fermer (en bas de la popup, autonome pour mobile et desktop)
document.getElementById('btn-close').addEventListener('click', () => {
  window.close();
});

browser.runtime.onMessage.addListener(message => {
  if (message.type === "STATUS_UPDATE") {
    let displayText;
    if (message.i18nKey) {
        let subs = message.i18nSubs;
        // background.js envoie parfois un objet {ext: "PDF"}, on le convertit en tableau pour t()
        if (subs && typeof subs === 'object' && !Array.isArray(subs)) {
            subs = Object.values(subs);
        }
        displayText = t(message.i18nKey, subs);
    } else {
        displayText = message.status === "error"
            ? (message.text || message.userMessage || t('errGenericOccurred'))
            : (message.text || message.userMessage || "");
    }
    updateStatus(displayText, message.status, message.linkUrl, message.showDownload);
    if(message.status === "error" || message.status === "success") {
      resetUI();
      if (message.status === "success") {
        if (intentInput) intentInput.value = "";
        if (intentCounter) intentCounter.textContent = "0 / 300";
      }
    }
  }
});

// Intercepter les clics sur les liens dans la zone de statut
// (les <a href> dans une popup d'extension ne s'ouvrent pas naturellement)
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (link && link.href && !link.href.startsWith('#') && link.href !== '#') {
    e.preventDefault();
    browser.tabs.create({ url: link.href });
  }
});
