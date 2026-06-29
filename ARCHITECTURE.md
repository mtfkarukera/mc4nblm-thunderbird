# ARCHITECTURE.md — NotebookLM Clipper for Thunderbird
## État de référence — document vivant (mis à jour à chaque sprint ; version : voir `manifest.json`)

Ce document décrit l'architecture réelle et les flux de données du projet.
Il est destiné aux agents IA pour éviter la rétro-ingénierie du code à chaque session.

> ⚠️ Ce fichier est PRIVÉ. Il ne doit jamais être poussé sur GitHub.
> En cas de conflit avec une skill, **ce fichier prime sur les skills**.
> En cas de conflit avec AGENTS.md, **AGENTS.md prime sur ce fichier**.

---

## 1. Vue d'Ensemble

NotebookLM Clipper for Thunderbird est une MailExtension Thunderbird Manifest V2
qui permet d'importer le contenu d'un email (corps, pièces jointes)
directement dans un carnet Google NotebookLM, via 3 modes d'import
(PDF, Markdown, PJ directes — le mode URL a été retiré en revue 2026-06-10).

**Stack technique :**
- Vanilla JS — zéro bundler, zéro npm, zéro framework
- jsPDF 2.5.2 (bundlé dans `lib/`, ne pas modifier)
- Thunderbird Manifest V2 — Background persistant
- Système i18n natif WebExtension (`_locales/`) — 7 locales, sans gcf

**Ce qui N'est PAS utilisé (différence clé avec Firefox v6.0.0) :**
- ❌ Readability.js — remplacé par `messenger.messages.getFull()`
- ❌ Manifest V3 — Thunderbird 128 ESR cible MV2
- ❌ `browser_action` / `action` — remplacé par `message_display_action`
- ❌ `content_scripts` sur `<all_urls>` — remplacé par `messageDisplayScripts`
- ❌ Locale `gcf` — mise en veille, retrait du sélecteur de locale

---

## 2. Structure des Fichiers

```
notebooklm-clipper-thunderbird/
├── manifest.json
│     MV2 Thunderbird | message_display_action | gecko ≥ 115
│     default_locale: "en" | sensitiveDataUpload permission
├── _locales/
│   ├── en/messages.json       Locale de référence — fallback officiel
│   ├── fr/messages.json       Français
│   ├── de/messages.json       Allemand
│   ├── es/messages.json       Espagnol
│   ├── vi/messages.json       Vietnamien
│   ├── ja/messages.json       Japonais  🆕
│   └── pt/messages.json       Portugais 🆕
├── lib/
│   └── jspdf.umd.min.js       jsPDF 2.5.2 — NE PAS MODIFIER
├── src/
│   ├── background/
│   │   ├── background.js      Routeur central — 3 pipelines + injection bridge + auth
│   │   └── api/
│   │       ├── auth.js        Cookies Gecko TB + RotateCookies + CSRF + WebContent tab
│   │       └── rpc_client.js  batchexecute + upload resumable 3 étapes (hérité Firefox)
│   ├── content/
│   │   ├── email_bridge.js    MessageDisplayScript — point d'entrée + relais PDF
│   │   │                      ⚑ Sentinelle : window.__ntc_email_bridge = true
│   │   └── email_pdf_generator.js  jsPDF Custom Walker depuis DOM email
│   │                               ⚑ Sentinelle : window.__ntc_pdf_generator = true
│   │                               Expose : window.__ntc_generate_pdf(grounding, intentNote)
│   ├── popup/
│   │   ├── popup.html         6 états + PJ checkboxes + intent
│   │   ├── popup.css          Glassmorphism + .hidden + états
│   │   ├── popup.js          Logique UI + applyI18n() + Fast Research + keepAlive
│   │   └── pre_loader.js     Écran d'erreur précoce (chargé avant popup.js)
│   └── shared/
│       └── utils.js           t(), blobToBase64(), buildNotebookUrl(),
│                              sanitizeFilename(), htmlToMarkdown(),
│                              DEBUG/log(), STORAGE_KEYS (revue 2026-06-10)
└── icons/
    ├── icon.svg
    ├── icon.png
    ├── icon-128.png
    └── icon@2x.png
```

---

## 3. Composants — Responsabilités Détaillées

### 3.1 manifest.json

| Clé | Valeur | Note |
|---|---|---|
| `manifest_version` | `2` | MV2 — Thunderbird 128 ESR |
| `background.scripts` | `["src/shared/utils.js", "src/background/api/auth.js", "src/background/api/rpc_client.js", "src/background/background.js"]` | 4 scripts — pas de `"type": "module"` |
| `message_display_action.default_popup` | `"src/popup/popup.html"` | Bouton panneau lecture |
| `permissions` | voir liste complète §3.1.1 | Inclut `sensitiveDataUpload` |
| `permissions` (host) | `*://*.google.com/*` | Inclus dans le tableau `permissions` (MV2 n'a pas de clé `host_permissions` séparée) |
| `strict_min_version` | `"115.0"` | TB 115 ESR minimum |

#### 3.1.1 Permissions Déclarées et Usage

| Permission | Utilisée dans | Usage concret |
|---|---|---|
| `messagesRead` | `background.js` | `messenger.messages.getFull()`, `listAttachments()` |
| `accountsRead` | `background.js` | Contexte compte pour grounding |
| `storage` | `auth.js`, `background.js` | Persistance `ntc_auth_ready`, `ntc_last_notebook_id` |
| `cookies` | `auth.js` | `browser.cookies.getAll()` — lecture cookie store Gecko |
| `downloads` | `background.js` | `browser.downloads.download()` — export local PDF/MD |
| `scripting` | `background.js` | `messenger.scripting.executeScript()` — injection PDF |
| `sensitiveDataUpload` | ATN review | Contenu email envoyé vers NotebookLM |

### 3.2 background.js

**Script persistant MV2** — tourne tant que Thunderbird est ouvert.

**State en mémoire :**
```javascript
let _activeAuthuserIndex = 0;   // Compte Google actif
let _csrfToken = null;           // SNlM0e — refetché avant chaque capture
// _sessionId (FdrFJe) : SUPPRIMÉ au sprint 2 — assigné mais jamais lu
let _lastCapturePdfB64 = null;   // Dernier PDF généré (pour téléchargement local)
let _lastCaptureMdText = null;
let _lastCaptureTitle = null;    // Sujet brut du dernier email capturé
let _pendingPdfResolve = null;   // Résolution Promise en attente de PDF_READY
let _pendingPdfReject = null;    // Rejet Promise en attente de CAPTURE_ERROR
```

**Handlers enregistrés :**
`GET_AUTH_STATUS`, `CONNECT_AUTH`, `GET_ACTIVE_EMAIL_META`, `GET_NOTEBOOKS`,
`CREATE_NOTEBOOK`, `GET_ACCOUNTS`, `SET_ACCOUNT`, `START_CAPTURE`,
`DOWNLOAD_CAPTURE`, `PING`, `PDF_READY`, `CAPTURE_ERROR`

**Pipelines orchestrés (3) :**

| Pipeline | Handler interne | Injection |
|---|---|---|
| Email → PDF | `handlePdfCapture()` | `jspdf.umd.min.js` + `email_pdf_generator.js` |
| Email → MD | `handleMdCapture()` | Aucune |
| PJ → Direct | `handleAttachmentCapture()` | Aucune |

> Le pipeline Email → URL (`handleUrlCapture()`) a été supprimé en revue de code
> (2026-06-10) — backend jamais câblé côté UI. Réintroduction éventuelle : v1.x.

### 3.3 auth.js

**Fonctions exposées :**

| Fonction | Description |
|---|---|
| `collectGoogleCookies()` | Collecte depuis tous les domaines Google requis |
| `validateCookies(cookieMap)` | Vérifie Tier 1 (SID + PSIDTS) + Tier 2 — retourne `{ valid }` (sprint 2 : `cookieString`/`buildCookieString` supprimés, plus aucun consommateur) |
| `fetchCSRFTokens(authuserIndex)` | Fetch de notebooklm.google.com → `{ csrfToken }` ; throw `AUTH_EXPIRED` si SNlM0e introuvable (sprint 2 : FdrFJe/`sessionId` plus extrait — jamais consommé ; voir API-REFERENCE.md si besoin futur) |
| `rotateCookiesIfNeeded()` | POST RotateCookies avec throttle 60s, cadence 550s |
| `startCookieRotationSchedule()` | Lance `setInterval(rotateCookiesIfNeeded, 550_000)` |
| `openAuthWebContentTab()` | `browser.tabs.create({ url: NBLM_URL })` + écoute `tabs.onUpdated` |

**State en mémoire (auth.js) :**
```javascript
let _rotationTimer = null;       // setInterval() RotateCookies
let _authTabId = null;           // Tab WebContent auth ouvert (évite doublons)
```

**Hiérarchie des cookies (Tier 1 bloquant) :**
- `SID` + `__Secure-1PSIDTS` — obligatoires avant tout appel RPC
- `OSID` ou (`APISID` + `SAPISID`) — Tier 2, avertissement si absent

**RotateCookies :**
- `POST https://accounts.google.com/RotateCookies`
- `credentials: 'include'` — les Set-Cookie sont gérés automatiquement par Gecko
- Throttle client : minimum 60s entre deux appels
- Cadence planifiée : toutes les 550s

### 3.4 rpc_client.js

**Repris de Firefox v6.0.0** (`addUrlSource` retiré en revue de code 2026-06-10).

| Fonction | RPC ID | Usage |
|---|---|---|
| `addTextSource(csrfToken, text, title, notebookId, authuserIndex)` | `izAoDd` | Import MD email |
| `uploadFileSource(blob, title, nbId)` | `o4cbdc` + resumable | Import PDF email + PJ |
| `listNotebooks(authuserIndex)` | voir API-REFERENCE.md | Chargement liste carnets |
| `createNotebook(title)` | voir API-REFERENCE.md | Création nouveau carnet |

**Fonctions internes (ne pas réécrire) :**
`parseChunkedResponse()`, `extractRpcResult()`
→ traduction exacte de `decoder.py` (notebooklm-py) — toute réécriture partielle
casse les JSONs multi-lignes. (Le stripping anti-XSSI est effectué inline
dans `parseChunkedResponse()`, pas via une fonction séparée.)

### 3.4bis Injection du bridge — 3 mécanismes complémentaires (hotfix R9.3)

1. **Enregistrement au démarrage** (`scripting.messageDisplay.registerScripts`) —
   couvre tous les messages affichés APRÈS l'enregistrement (re-rendu 3-pane inclus).
2. **Rattrapage au boot** — balayage `tabs.query` des onglets mail/messageDisplay
   déjà ouverts + `scripting.executeScript` (pattern officiel de la doc TB).
3. **Fallback à la demande** (`handlePdfCapture`) — PING_BRIDGE ; si « Receiving
   end does not exist » → injection one-shot + re-ping.
Les sentinelles (`__ntc_email_bridge`) rendent toute ré-injection inoffensive.

### 3.5 email_bridge.js (MessageDisplayScript)

- Enregistré au démarrage de `background.js` via `messenger.scripting.messageDisplay.registerScripts()` (TB 128+), avec fallback legacy `messenger.messageDisplayScripts.register()` (TB 115-127)
- Pose la sentinelle `window.__ntc_email_bridge = true`
- Écoute uniquement `CAPTURE_EMAIL_PDF` (le seul message qui lui est adressé)
- Appelle `window.__ntc_generate_pdf(grounding, intentNote)` exposé par `email_pdf_generator.js`
- Retourne `{ action: 'PDF_READY', pdfBase64, title }` au background

### 3.6 email_pdf_generator.js

- Injecté via les 3 mécanismes du §3.4bis, toujours après `jspdf.umd.min.js`
- Pose la sentinelle `window.__ntc_pdf_generator = true`
- Expose `window.__ntc_generate_pdf(grounding, intentNote)` → `Promise<string>` (base64)
- **Source** : DOM live de `document.body` (email rendu par Thunderbird)
- **Custom Walker** : hérité de Firefox `pdf_generator.js` — mêmes règles jsPDF
- **Grounding** : objet, expéditeur, destinataires, date (au lieu de titre/URL/site)
- **Intent Note** : injectée avant le grounding si non-null
- **Variable curseur** : `y` (locale dans `generate()`) — **jamais `doc.y`**

### 3.7 popup.js

**États gérés :**
`AUTH_REQUIRED` → `LOADING_EMAIL` → `READY` → `CAPTURING` → `SUCCESS` | `ERROR`
(`URL_SELECTOR` supprimé — revue de code 2026-06-10.)

**Création de carnet (sprint 2 — v1.0.5) :** UI inline dans popup.html
(`#create-notebook-row` : input prérempli avec le terme de recherche + ✓/✕,
Entrée/Échap). ⚠️ `window.prompt()` est INTERDIT : non supporté dans les
popups TB (fenêtre détachée + échec silencieux — constat terrain 2026-06-10).
Échec de création → erreur inline i18n ; AUTH_EXPIRED → écran reconnexion.

**Spécificités Thunderbird :**
- Rendu des métadonnées email (objet, de, date) en haut de popup
- Liste des PJ avec cases à cocher (sélection partielle ou totale)
- PJ > 200 MB grisées (case désactivée) ; PJ de type inconnu décochées par
  défaut, import `text/plain` sur opt-in explicite
- Bouton "Importer la sélection (N)" dynamique
- Note d'intention masquée si contexte = import PJ
- Barre de progression `(N/total)` pour import groupé
- Erreurs background mappées par `e.message` (Gecko ne sérialise pas `err.code`)

### 3.8 utils.js

**Fonctions et constantes exposées :**

| Export | Type | Description |
|---|---|---|
| `DEBUG` | `const` (flag) | Mode debug — gaté à `false` en release |
| `log(...args)` | fonction | Console gated par `DEBUG` — ne JAMAIS y passer de payload sensible |
| `STORAGE_KEYS` | `const` (objet) | Clés `browser.storage.local` — source unique partagée |
| `t(key, substitutions)` | fonction | Wrapper i18n — appelle `browser.i18n.getMessage()`, log si clé manquante |
| `blobToBase64(blob)` | fonction | Blob → string base64 (pour PDF avant envoi au background) |
| `buildNotebookUrl(notebookId)` | fonction | Construit l'URL NotebookLM d'un carnet |
| `htmlToMarkdown(html)` | fonction | Conversion HTML → Markdown (utilisé par pipeline MD) |
| `sanitizeFilename(name)` | fonction | Nettoyage noms de fichiers (caractères interdits, troncature) |

---

## 4. Flux de Données — Résumé

### 4.1 Setup Auth (premier lancement) — révisé sprint 2 (v1.0.5)

```
[Popup] DOMContentLoaded
  → GET_AUTH_STATUS
  → [Background] collectGoogleCookies() → validateCookies() → ÉCHEC
  → [Popup] showState('AUTH_REQUIRED')
  → [Utilisateur] clique "Se connecter"
  → [Background] openAuthWebContentTab()
  → [TB] Onglet WebContent : notebooklm.google.com
  → [Utilisateur] se connecte à Google
  → [Background] tabs.onUpdated (+ tabs.onRemoved pour le nettoyage)
                 → collectGoogleCookies() → validateCookies() → OK
                 → browser.tabs.remove(authTabId)
                 → fetchCSRFTokens() → SNlM0e en mémoire
                    ├─ SUCCÈS → startCookieRotationSchedule()
                    │           → notifyUI({ status: 'auth_ready' })
                    └─ ÉCHEC  → notifyUI({ status: 'error', code: 'AUTH_EXPIRED' })
                                (sprint 2 : plus de faux 'auth_ready' qui
                                 n'échouerait qu'à la première capture)
  → [Popup] recharge via GET_ACTIVE_EMAIL_META (ou écran Reconnecter)
```

### 4.2 Pipeline PDF

> **Sprint 3 (v1.0.6) :** la résolution d'onglet utilise
> `messenger.tabs.query({ active, currentWindow })` (et plus `mailTabs.query()`,
> qui ne voyait que les onglets 3-pane — les onglets message et fenêtres
> autonomes retournaient un faux NO_EMAIL_DISPLAYED).

```
[Popup] START_CAPTURE { format: 'pdf', notebookId, intentNote }
  → [Background]
      1. messenger.tabs.query({ active, currentWindow }) → tab (tout contexte)
      2. messenger.messageDisplay.getDisplayedMessage(tab.id) → header
      3. buildGrounding(header)
      4. fetchCSRFTokens() → tokens frais
      5. PING_BRIDGE → si bridge absent : injectMessageScripts(tab.id)
         (scripting.executeScript, 3 fichiers MESSAGE_SCRIPTS) + re-ping
      6. (les scripts sont sinon déjà présents : enregistrés ou rattrapés au boot)
      7. browser.tabs.sendMessage(tab.id, { action: 'CAPTURE_EMAIL_PDF', ... })
  → [email_bridge.js]
      8. window.__ntc_generate_pdf(grounding, intentNote)
      9. browser.runtime.sendMessage({ action: 'PDF_READY', pdfBase64, title })
  → [Background] handlePdfReady()
     10. base64 → Blob
     11. uploadFileSource(blob, title, notebookId) — upload resumable
     12. notifyUI({ status: 'success', linkUrl, showDownload: true })
  → [Popup] showState('SUCCESS')
```

### 4.3 Pipeline MD

```
[Popup] START_CAPTURE { format: 'md', notebookId, intentNote }
  → [Background] handleMdCapture()
      1. messenger.tabs.query({ active, currentWindow }) → tab
      2. messenger.messageDisplay.getDisplayedMessage(tab.id) → header
      3. messenger.messages.getFull(header.id) → fullMessage
      4. extractEmailBody(fullMessage.parts) → { html, text }
      5. buildGrounding(header)
      6. Assemblage inline via mdLines.push() :
         - Intent note (si présente) → blockquote
         - Grounding (from, subject, date) → blockquote
         - Corps : htmlToMarkdown(body.html) ou body.text
         → mdText = mdLines.join('\n')
      7. addTextSource(csrfToken, mdText, filename, notebookId, authuserIndex)
      8. notifyUI({ status: 'success', notebookId, showDownload: true })
  → [Popup] showState('SUCCESS')
```

> **Note :** il n'existe PAS de fonction `generateEmailMarkdown()` séparée —
> le texte Markdown est construit entièrement inline dans `handleMdCapture()`.

### 4.4 Pipeline URL — SUPPRIMÉ

> **Revue de code 2026-06-10 :** pipeline retiré (backend jamais câblé côté UI).
> `format: 'url'` n'est plus un format valide de `START_CAPTURE`.
> Réintroduction éventuelle : roadmap v1.x (AGENTS.md §14).

### 4.5 Pipeline Attachment (groupé séquentiel)

```
[Popup] START_CAPTURE { format: 'attachment', attachments: [...], notebookId }
  → [Background] importAttachmentsBatch(attachments, messageId, notebookId)
      Pour chaque PJ (séquentiellement) :
        1. notifyUI({ status: 'info', batchProgress: { current, total } })
        2. messenger.messages.getAttachmentFile(messageId, partName) → File
        3. cleanName = att.name NFD-normalisé (accents retirés)
           uploadFileSource(csrfToken, fileBlob, `[PJ] ${cleanName}`, notebookId, authuserIndex, contentType)
      En fin de boucle :
        4. notifyUI({ status: 'success' | 'error', warnings: [...] })
  → [Popup] showState('SUCCESS') ou showState('ERROR')
```

---

## 5. Décisions Techniques Documentées

| Décision | Choix retenu | Raison |
|---|---|---|
| Source du contenu email | `messenger.messages.getFull()` | API directe TB — plus propre que DOM scraping |
| Génération PDF | Injection dans onglet email (DOM) | jsPDF nécessite un `document` live |
| Génération MD | Entièrement dans background | Texte pur — pas de DOM requis |
| Auth | Cookies Gecko TB via WebContent tab | Même moteur que Firefox — seule méthode disponible sans OAuth |
| Import groupé PJ | Séquentiel (boucle `for...of`) | Évite rate limiting Google et collisions dans le carnet |
| Locale hybride gcf | Mise en veille | Simplification pour v1 — réintégration future |
| MV2 vs MV3 | MV2 | TB 128 ESR stable — MV3 TB non stabilisé en juin 2026 |
| Readability.js | Abandonné | Inexistant dans le flux email — `getFull()` suffit |
| Résilience Réseau | Retry-After + Backoff Exponentiel sur HTTP 429 | Gère proprement le rate-limiting NotebookLM en évitant les surcharges |
| Correlation ID | `captureId` unique généré via `crypto.randomUUID()` | Élimine les risques de collision de promesses asynchrones si captures multiples |
| Limite Profondeur | DOM max 200, MIME max 20 | Évite les stack overflow et freezes sur les structures DOM/MIME complexes ou récursives |
| Troncature de noms | `sanitizeFilename` max 200 caractères | Prévient les échecs silencieux du module de téléchargement sur les OS avec des limites strictes de chemin de fichier |
| Accessibilité Thème | CSS variables + overrides @media `prefers-color-scheme: light` | Assure un contraste élevé pour les textes et états de statut (succès/erreur/warning) sous le thème clair de Thunderbird |

---

## 6. Risques Techniques

| Risque | Impact | Plan de contingence |
|---|---|---|
| jsPDF incompatible avec contexte messageDisplay TB | Bloquant pour pipeline PDF | Basculer vers génération background (sans DOM, texte seul) |
| `messenger.messages.getAttachmentFile()` indisponible TB 115 | Bloquant pour pipeline Attachment | Relever `strict_min_version` à `"128.0"` |
| Google modifie l'API batchexecute | Bloquant pour tous les imports | Code `API_CHANGED` + message user (hérité Firefox v6) |
| DBSC déployé sur RotateCookies | Auth impossible sans Chrome | Surveillance — plan documenté dans skill `notebooklm-cookie-auth-refresh` §7 |

---

## 7. Différences Fondamentales avec Firefox v6.0.0

| Aspect | Firefox v6.0.0 | Thunderbird v1.0.0 |
|---|---|---|
| Manifest | MV3 | MV2 |
| Background | Event Page (suspendue) | Persistant |
| Source contenu | DOM page via Readability | `messenger.messages.getFull()` |
| Modes d'import | 7 (PDF, MD, URL, Screenshot, Direct, Sélection, Drive) | 3 (PDF, MD, PJ groupées) — URL retiré en revue 2026-06-10 |
| Injection scripts | Orchestrator + 4 scripts à la demande | Email bridge + PDF generator (PDF only) |
| Auth cookie source | Firefox cookie store | Gecko de Thunderbird (profil TB) |
| Grounding IA | Titre + URL + site + date | Objet + expéditeur + destinataires + date |
| Publication | Firefox AMO | Thunderbird ATN |
| Locale spéciale | `gcf` (hybride custom) | Aucune (7 locales natives) |