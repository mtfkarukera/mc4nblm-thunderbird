# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

## [1.6.0] — 2026-11-12

### Ajouté
- **Migration complète vers Manifest V3 (`Thunderbird 128.0+ ESR`)** : passage à une Event Page non persistante pilotée par événements (`runtime.onInstalled`, `runtime.onStartup`, `alarms.onAlarm`, `tabs.onUpdated`, `downloads.onChanged`), stockage éphémère via `browser.storage.session` et migration vers `messenger.messageDisplay.getDisplayedMessages()`.
- **Consentement opt-in explicite ATN & Déconnexion en un clic** : ajout d'une case de consentement au premier lancement (`ntc_data_consent`, exigée par la politique ATN `data-exfiltration`), déclaration `data_collection_permissions: ["personalCommunications"]` et bouton **Déconnecter** dans la popup pour révoquer localement la session et le consentement à tout moment.
- **Mise à jour sécurité `jsPDF 4.2.1` & Déclaration officielle `VENDOR.md`** : mise à niveau vers le binaire officiel intact `jsPDF 4.2.1` (corrigeant les vulnérabilités CVE de la branche 2.5.x, SHA-256 vérifié), ajout de `VENDOR.md` à la racine et génération des icônes dédiées `16x16` et `32x32` pour les barres d'outils Thunderbird.
- **Support des courriels composés uniquement de pièces jointes** : un courriel dépourvu de texte mais comportant des pièces jointes supportées ouvre désormais normalement la popup en grisant uniquement les boutons PDF/Markdown tout en permettant l'import direct des pièces jointes.
- **Avertissement PDF caractères non latins & Noms des pièces jointes en échec** : détection des glyphes hors Latin-1/CP1252 dans le générateur PDF avec conseil non bloquant vers l'export Markdown UTF-8, et affichage précis des noms de fichiers en cas d'import partiel d'un lot de pièces jointes.
- **Documentation d'ingénierie** : ajout de `CONTRIBUTING.md` et synchronisation complète en 7 langues (`en`, `fr`, `de`, `es`, `vi`, `ja`, `pt` — 82 clés).

### Modifié
- **Rebranding `Magic Clipper for Gemini Notebook` & Bouton court `"Notebook"`** : passage intégral à **Gemini Notebook** sur les 7 langues et la documentation, et séparation de `default_label` (**Notebook** sur le bouton d'en-tête) et `default_title` (**Clipper vers Gemini Notebook** en infobulle au survol) dans `manifest.json`.
- **Barre de session supérieure (`.ready-header`)** : repositionnement du bouton **Déconnecter** et du sélecteur multi-comptes tout en haut de `#state-ready` (au-dessus des métadonnées du courriel), afin d'éviter tout clic réflexe en bas de formulaire tout en conservant le focus clavier initial sur la recherche de carnet.
- **Protocole RPC Gemini Notebook (`notebook.google.com`)** : passage dynamique de `source-path=/notebook/{notebookId}` sur les écritures de sources (`izAoDd`, `o4cbdc`), alignement du payload d'enregistrement `o4cbdc` à 3 éléments et table de secours MIME par extension dans `uploadFileSource()`.
- **Générateur PDF (`email_pdf_generator.js`)** : pagination ligne par ligne sur tous les blocs (y compris les longs paragraphes, citations, tableaux et blocs `<pre>`), prise en charge unifiée des `<div>`/`<p>` imbriqués avec images `<img>` inline, fond blanc `#ffffff` appliqué aux PNG transparents avant encodage JPEG et libération immédiate de la mémoire Canvas.
- **Accessibilité WCAG 2.1 AA & Design UI (`popup.html`, `popup.css`, `popup.js`)** : déclaration `color-scheme: dark / light`, contrastes vérifiés en modes clair et sombre (`>= 4.5:1` texte, `>= 3:1` bordures/focus), grille CSS multilingue pour les métadonnées email, erreurs de validation inline non destructives, désactivation sans saut de layout de la note d'intention, mise à jour dynamique de `aria-valuenow`/`aria-valuetext` sur la barre de progression et gestion fine du focus clavier.
- **Maintien des quotas natifs Gemini Notebook (`200 Mo` / `500 000 mots`)** : maintien de l'Event Page MV3 active tant que le bouton de téléchargement local est affiché sur l'écran de succès, suivi d'une purge mémoire automatique dès la fermeture de la popup (`PURGE_CAPTURE`) ou après 5 minutes (`ntc-purge-capture`).

### Corrigé
- ** Suppression de l'API MV2 obsolète `messageDisplayScripts.register()`** qui exigeait la permission invasive `messagesModify` et provoquait un rejet au linter officiel ATN.
- **Gestion multi-comptes & état des carnets** : vérification de l'existence réelle du dernier carnet mémorisé dans le compte actif après changement de compte Google, et réinitialisation systématique de l'état des pièces jointes entre deux courriels.
- **Extraction MIME (`extractEmailBodyFromFull`)** : prise en charge des courriels mono-partie sans tableau `parts[]` et exclusion stricte des pièces jointes MIME (`Content-Disposition: attachment`) du corps Markdown.
- **Cycle de vie de l'onglet d'authentification & Timeouts** : retour automatique à l'écran de connexion si l'utilisateur ferme l'onglet WebContent sans se connecter (`auth_closed`), maintien de l'`AbortController` pendant la lecture complète des flux `.text()`, réinitialisation du timeout de 120 s à chaque progression d'un lot de pièces jointes et révocation sans course des URLs `blob:` via `downloads.onChanged`.

### Sécurité
- **HTTPS exclusif** : remplacement de `*://*.google.com/*` par `https://*.google.com/*` et `https://*.googleapis.com/*` dans `host_permissions`.
- **Cloisonnement IPC & Durcissement des entrées** : séparation stricte des messages issus des onglets courriel (`sender.tab`) et de la popup dans `background.js`, filtrage des schémas d'URL dangereux (`javascript:`, `data:`, `vbscript:`) et limite de profondeur DOM dans `htmlToMarkdown()`, durcissement Windows/macOS/Linux de `sanitizeFilename()` et assainissement strict de `authuser` dans `buildNotebookUrl()`.

---

## [1.5.1] — 2026-07-31

### 🔴 Correctif Critique — Migration vers notebook.google.com
- **Migration Domaine Google** : Alignement du Web Clipper Thunderbird MailExtension sur le nouveau domaine officiel `notebook.google.com`.
- **Authentification & RPC** : Mise à jour de `NBLM_URL`, `GOOGLE_DOMAINS`, `RotateCookies`, des endpoints RPC `batchexecute`, de l'upload resumable et des en-têtes `Origin`/`Referer`.

---

## [1.5.0] — 2026-06-29

### Ajouté
- Touche `Escape` dans la listbox des carnets (pattern ARIA Authoring Practices) — renvoie le focus au champ de recherche.
- Support du media query `prefers-reduced-motion` : toutes les animations CSS sont désactivées pour les utilisateurs sensibles.
- `role="progressbar"` avec `aria-valuemin/max/now` sur la barre de progression des pièces jointes.
- `aria-label` sur les boutons icônes `+`, `✓`, `✕` (via `data-i18n-aria-label`) — fiable pour les lecteurs d'écran.
- Clé i18n `labelProgressbar` dans les 7 locales.
- Variable `_pdfTimeoutId` pour stocker et annuler proprement le timer de sécurité PDF 30s.

### Modifié
- `#btn-open-notebook` converti de `<a>` en `<button>` — l'URL est désormais stockée dans `dataset.notebookUrl` et l'ouverture se fait via `browser.tabs.create()`.
- `--c-text-secondary` (mode sombre) : `#94a3b8` → `#b0bec8` (ratio ≈ 4.5:1 sur `#0f1117`, WCAG AA réel).
- `--c-text-muted` (mode sombre) : `#8fa1b5` → `#aabccd` (ratio ≈ 4.6:1, correctif du commentaire erroné de v1.4.1).
- `.attachment-size` et `.attachment-flag` : `9-10px` → `11px` (minimum lisible WCAG).
- `backdrop-filter` : `blur(8px)` → `blur(14px)` + `-webkit-backdrop-filter` pour le glassmorphism.
- `applyI18n()` : ajout du support de l'attribut `data-i18n-aria-label`.
- `showState()` : gestion dynamique de `aria-busy` sur `#state-capturing`.

### Corrigé
- **[BLOQUANT]** Timer PDF fantôme : `setTimeout` de 30s correctement stocké dans `_pdfTimeoutId` et annulé dans `handlePdfReady` et `handleCaptureError`.
- **[BLOQUANT]** Promise PDF suspendue : exception synchrone de `browser.tabs.sendMessage()` entraîne désormais un `reject()` immédiat (plus de blocage de `_captureInProgress` pendant 30s).
- **[SÉCURITÉ]** MIME type corrompu `'video/bold-italic'` pour `.mpg` → `'video/mpeg'`.
- **[SÉCURITÉ]** Validation de `sender.id` dans `runtime.onMessage` — messages d'origines externes rejetés.
- **[SÉCURITÉ]** Validation de `message.index` dans `SET_ACCOUNT` — NaN ou index hors `[0,4]` retourne une erreur.
- `schedulePurge()` appelé dans le `catch` de l'upload PDF pour purger `_lastCapturePdfB64` même en cas d'échec.
- `btn-back` et `btn-new-import` remettent `_isCapturing = false` avant navigation pour éviter le blocage du verrou popup.
- Garde défensive `(size || 9) * 1.2` dans `email_pdf_generator.js` pour éviter `NaN` si `size` est indéfini.
- État `:active` ajouté sur tous les boutons (`.btn:active`, `.btn-import:active`) — feedback visuel au clic.
- Bordure gauche sur `.notebook-item.selected` pour une meilleure différenciation visuelle.

## [1.4.1] — 2026-06-29

### Ajouté
- Titres sémantiques masqués pour lecteurs d'écran (états ready, loading, capturing, success, error) et labels explicites (create-notebook-name, listes).
- Navigation clavier complète pour la sélection de carnet (ArrowUp/ArrowDown/Enter/Space).
- Design premium : flou de dépoli glassmorphic à 12px, reflets colorés au survol sur boutons d'import, transitions en cascade, translation fluide de liste au survol, shimmer sur barre de progression et spinner conique.

### Modifié
- Encapsulation des modules de background `auth.js` et `rpc_client.js` dans des IIFE pour éviter la pollution du namespace global `window`.

### Corrigé
- Fuite mémoire potentielle en purgeant `_lastRawText` en cas d'erreur de parsing dans `rpc_client.js`.
- Condition de course sur le timer de purge mémoire de 5 minutes après captures successives dans `background.js`.
- Ratios de contraste WCAG AA pour le texte muet `--c-text-muted` en thèmes sombre et clair.

## [1.4.0] — 2026-06-14

### Ajouté
- Retry avec backoff exponentiel et gestion de l'en-tête `Retry-After` lors de la réception d'une erreur HTTP 429 (Too Many Requests).
- Correlation ID (`captureId`) unique généré pour chaque capture PDF pour éviter les collisions de promesses de capture entre différents onglets/fenêtres.
- Limitation de la profondeur de récursion de parsing DOM à 200 niveaux dans le générateur PDF.
- Limitation de la profondeur de parcours de l'arbre MIME à 20 niveaux lors de l'extraction du corps des e-mails.
- Avertissement soft en console (`console.warn`) pour les e-mails très volumineux (> 50 000 mots).
- Charte de confidentialité (`PRIVACY-POLICY.md`) publique requise pour la permission `sensitiveDataUpload`.
- Définition dynamique de la langue du document (`<html lang>`) dans la popup d'après la langue de l'UI de Thunderbird.

### Modifié
- Troncature des noms de fichiers de sortie à un maximum de 200 caractères dans `sanitizeFilename` pour éviter les erreurs d'écriture sur les OS restrictifs.
- Amélioration UX de la popup : le bouton Retour recharge entièrement les métadonnées et la liste des carnets via `loadEmailMeta()`.
- Variables CSS pour les couleurs de succès, d'erreur et d'avertissement avec surcharges spécifiques en mode clair (`prefers-color-scheme: light`) pour un contraste optimal.

## [1.3.0] — 2026-06-14

### Ajouté
- Focus ring visible autour des boutons actifs pour les utilisateurs naviguant au clavier (accessibilité).
- Attribut `aria-live="polite"` sur le conteneur principal d'état prêt pour annoncer dynamiquement les transitions aux lecteurs d'écran.

### Modifié
- Factorisation de la gestion des erreurs avec le helper centralisé `NtcUtils.ntcError()`.
- Centralisation de la conversion Base64 vers Blob avec `NtcUtils.base64ToBlob()`.
- Factorisation du flux d'authentification avec `ensureAuthenticated()`.
- Hoisting des constantes et de la configuration MIME au niveau global dans `background.js`.

### Corrigé
- Correction de la régression de mise en page des tableaux PDF : remplacement de l'utilisation instable de `:scope` dans les sélecteurs par des APIs DOM robustes (`row.cells`, `closest('table')` et `.children`), résolvant le problème de tronquage complet des tableaux et des paragraphes adjacents dans les e-mails complexes.

### Supprimé
- Nettoyage des permissions : suppression de `"accountsRead"` inutile dans `manifest.json`.
- Nettoyage du code mort : retrait de `blobToBase64()` dans `utils.js` et des sentinelles `__ntc_pdf_generator`/`void 0` inutilisées dans `email_pdf_generator.js`.

## [1.2.0] — 2026-06-14

### Ajouté
- Internationalisation (i18n) complète des pipelines d'import (PDF, Markdown, Pièces jointes). Les libellés d'intention, d'en-têtes et de métadonnées s'adaptent désormais à la langue de l'utilisateur (7 locales : français, anglais, allemand, espagnol, portugais, japonais et vietnamien).
- Messages d'erreur et de repli (fallbacks) de métadonnées localisés (titre de carnet invalide, capture PDF en cours, pièces jointes manquantes ou en échec total).

## [1.1.0] — 2026-06-14

### Ajouté
- Timeouts réseau sur tous les `fetch()` : 30s pour les appels RPC, 120s pour
  les uploads fichier, 15s pour le CSRF, 10s pour RotateCookies et la détection
  de comptes — l'UI ne reste plus jamais bloquée sur un spinner infini.
- Verrou global `_captureInProgress` : empêche les captures parallèles sur les
  3 pipelines (PDF, MD, PJ). Les boutons d'import sont grisés pendant la capture.
- Timeout de secours dans la popup (120s) : si le background ne répond pas,
  la popup bascule automatiquement en état d'erreur récupérable.
- Validation du domaine `uploadUrl` : vérifie que l'URL de l'upload resumable
  pointe bien vers `*.google.com` ou `*.googleapis.com` avant d'envoyer les
  credentials.
- Détection 401/403 sur les étapes 2 et 3 de l'upload resumable : l'erreur
  `AUTH_EXPIRED` est correctement remontée au lieu d'un message générique.
- Guard sur les pièces jointes de 0 octets et les fichiers inaccessibles (`null`) :
  elles sont ignorées avec un warning au lieu de provoquer un upload vide.
- Compteur d'échecs consécutifs de `RotateCookies` : warning en console après
  3 échecs pour alerter sur une expiration imminente de session.

### Corrigé
- Purge automatique de `_lastCapturePdfB64` et `_lastCaptureMdText` après
  download (immédiat) et après 5 minutes (TTL) — réduit la pression mémoire.
- Purge de `_lastRawText` (réponse RPC brute) après extraction du résultat
  dans `batchExecute()`.

## [1.0.6] — 2026-06-11

### Corrigé
- L'extension échouait avec « Ouvrez un email… » quand le message était ouvert
  dans son propre onglet ou sa propre fenêtre (double-clic sur un email).
  Cause : `mailTabs.query()` ne retourne que les onglets 3-pane.
  Fix : résolution universelle via `tabs.query()` + `messageDisplay.getDisplayedMessage()`.
- Les scripts PDF (bridge + jsPDF) n'étaient pas injectés dans les onglets/fenêtres
  message déjà ouverts au démarrage. Ajout d'un rattrapage au boot + fallback
  à la demande (3-tier injection).

## [1.0.5] — 2026-06-11

### Corrigé
- Création de carnet réparée : `window.prompt()` non supporté dans les popups
  Thunderbird (fenêtre détachée + échec silencieux). Remplacement par une
  saisie inline intégrée à la popup.
- Payload RPC `createNotebook` : `[title, null, null, [2], [1]]` (canonique)
  au lieu de `[[title]]` — l'ancien format provoquait un gRPC 3 (Invalid argument).
- L'état « prêt » n'est confirmé qu'après vérification du jeton CSRF —
  plus de faux état prêt qui n'échouait qu'au premier import.

### Supprimé
- Code mort : `buildCookieString()`, stockage de `FdrFJe` (jamais consommé),
  variable `_sessionId`, écritures `AUTH_READY` dans storage.

## [1.0.4] — 2026-06-10

### Corrigé
- Messages d'erreur fiables : mapping par `err.message` (Gecko ne sérialise
  que `message` dans les rejets de `runtime.sendMessage`).
- Type MIME `video/quicktime` ajouté (`.mov`) ; `video/mov` (inexistant) retiré.
- Nom de fichier de téléchargement issu du sujet brut, assaini via
  `sanitizeFilename()`.
- Détection immédiate d'un jeton CSRF absent → `AUTH_EXPIRED` explicite.
- Nettoyage du listener `onUpdated` si l'onglet d'auth est fermé manuellement.
- Header `Cookie` interdit retiré de `rotateCookiesIfNeeded()`.
- Date manquante : libellé localisé au lieu de « Invalid Date ».

### Modifié
- PJ > 200 MB : affichées grisées avec mention de la limite (au lieu
  d'être masquées en silence).
- PJ sans extension : proposées explicitement (décochées par défaut,
  import texte sur opt-in).
- Logs de diagnostic désactivés en production (flag `NtcUtils.DEBUG`).
- Fuites mémoire : `URL.revokeObjectURL()` après téléchargement.

### Supprimé
- Pipeline URL (jamais exposé dans l'UI) : code retiré.
- Permissions inutilisées : `notifications`, `messagesModify`.
- `web_accessible_resources` (injection interne uniquement).

### Sécurité
- Retrait du header `Cookie` manuel (interdit par Gecko, ignoré silencieusement).
- Logs sensibles (payloads RPC, cookies) gatés par `NtcUtils.DEBUG = false`.

## [1.0.3] — 2026-06-10

### Corrigé
- Qualité des icônes : restructuration vectorielle haute résolution
  (`icon.png`, `icon@2x.png`, `icon-128.png`).
- Compatibilité d'affichage dans le Gestionnaire de modules complémentaires.

## [1.0.2] — 2026-06-10

### Ajouté
- Localisation complète : 7 locales (EN, FR, DE, ES, VI, JA, PT).
- Icônes PNG carrées haute fidélité.

### Sécurité
- Règle ESLint stricte de blocage d'`innerHTML`.

## [1.0.1] — 2026-06-10

### Corrigé
- Renommage officiel : « Magic Clipper for NotebookLM ».
- Rejet automatique des imports PDF simultanés (concurrence de callbacks).
- Déconnexion immédiate de la rotation cookies sur `AUTH_EXPIRED`.
- Ciblage `:scope` pour tables imbriquées (Markdown et PDF).
- Estimation de mots : retrait des `<style>` et `<script>` avant décompte.
- Noms de PJ : retrait du `⚡ ` et des accents pour compatibilité Google.

### Sécurité
- Remplacement de `.document.write` statique dans jsPDF par `.document['write']`
  dynamique (warning ATN bloquant).

## [1.0.0] — 2026-06-09

### Ajouté
- Première version officielle pour Thunderbird (MailExtension MV2).
- 3 modes d'import : Email → PDF, Email → Markdown, Pièce jointe → Direct.
- Authentification par cookies Gecko + rotation automatique (550s).
- Multi-comptes Google (authuser 0-4).
- Fast Research (debounce 300ms) pour la sélection de carnet.
- Note d'intention optionnelle (PDF et Markdown).
- Import groupé séquentiel de pièces jointes avec progression.
- 7 locales (EN, FR, DE, ES, VI, JA, PT).
- Glassmorphism UI avec thème sombre/clair automatique.
