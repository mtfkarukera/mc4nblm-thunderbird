# Guide de Contribution et Standards d'Ingénierie — Magic Clipper for Gemini Notebook

Merci de contribuer à **Magic Clipper for Gemini Notebook** pour Thunderbird (développé par **MTF Karukera**). Ce document récapitule les conventions techniques, les garde-fous de sécurité et la procédure de validation obligatoire avant toute soumission.

---

## 1. Prérequis Techniques

- **Thunderbird** : version **128.0 ESR** ou supérieure (architecture MailExtension Manifest V3).
- **Node.js** : version 20 LTS ou supérieure (utilisé uniquement pour le linting local, la vérification i18n et l'empaquetage — aucun bundler ne modifie le code source embarqué).

Installation des outils de vérification locaux :
```bash
npm install
```

---

## 2. Règles d'Architecture et Anti-Patterns Interdits

### Sécurité DOM & Conformité CSP Manifest V3
- **Zéro injection HTML brute** : l'utilisation de `innerHTML`, `outerHTML` et `insertAdjacentHTML` est **strictement interdite** (bloquée par ESLint). Construire tous les nœuds DOM via `document.createElement()`, `textContent` et `appendChild()`.
- **Zéro évaluation dynamique** : `eval()`, `new Function()` et `setTimeout("...", ...)` sont interdits par la politique `content_security_policy` MV3.
- **Bibliothèque tierce intacte** : ne jamais modifier `lib/jspdf.umd.min.js`. Sa somme de contrôle doit correspondre exactement à la release officielle `jspdf@4.2.1` déclarée dans `VENDOR.md`.

### Spécificités Thunderbird 128+ ESR (Manifest V3)
- **Event Page non persistante** : enregistrer tous les écouteurs (`runtime.onInstalled`, `runtime.onStartup`, `runtime.onMessage`, `alarms.onAlarm`, `tabs.onUpdated`, `downloads.onChanged`) de façon synchrone au top-level des scripts de background. Ne jamais utiliser `setInterval` dans le background (utiliser `browser.alarms`).
- **Séparation des namespaces** :
  - `messenger.*` pour les APIs courriel propres à Thunderbird (`messages`, `messageDisplay`, `scripting.messageDisplay`, `tabs`).
  - `browser.*` pour les APIs WebExtension standard (`runtime`, `storage`, `cookies`, `downloads`, `alarms`, `i18n`).
- **Interdiction des dialogues natifs bloquants** : ne jamais appeler `window.alert()`, `window.prompt()` ni `window.confirm()` dans la popup Thunderbird (provoque des fenêtres détachées ou des échecs silencieux). Toute interaction passe par des composants HTML inline accessibles.
- **Imports séquentiels** : ne jamais paralléliser (`Promise.all`) le téléversement d'un lot de pièces jointes vers Gemini Notebook afin d'éviter le rate-limiting HTTP 429 et les collisions de sources.

---

## 3. Internationalisation (`_locales/`)

L'extension maintient une parité stricte sur **7 locales** : `en` (référence), `fr`, `de`, `es`, `vi`, `ja`, `pt`.
- Dans `src/popup/popup.js`, toute chaîne affichée passe par le helper `t(key, substitutions)` ou les attributs déclaratifs `data-i18n*`.
- Dans `src/background/background.js`, utiliser `browser.i18n.getMessage()`.
- Les champs destinés au gestionnaire de modules et à la barre d'en-tête Thunderbird (`extensionName`, `extensionDescription`, `actionLabel`, `actionTitle`) ne doivent contenir **aucun émoji** (compatibilité ATN).

---

## 4. Procédure de Vérification et de Build

Avant toute proposition de modification ou création de release, les 4 contrôles suivants doivent réussir sans aucune erreur ni avertissement :

1. **Analyse statique ESLint** :
   ```bash
   npm run lint
   ```
2. **Parité des 7 fichiers de langue** :
   ```bash
   npm run check:i18n
   ```
3. **Construction de l'archive `.xpi` (vérifie automatiquement que `DEBUG = false`)** :
   ```bash
   npm run build
   ```
4. **Validation par le linter officiel Thunderbird ATN (`thunderbird/webext-linter`)** :
   ```bash
   node ~/.cache/thunderbird-webext-linter/verify.js --warnings-as-errors "$(readlink -f dist/notebooklm-clipper-tb.xpi)"
   ```

---

## 5. Licence

Ce projet est distribué sous licence publique Mozilla (**MPL 2.0** — voir le fichier [LICENSE](LICENSE)).
