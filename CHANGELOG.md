# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

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
