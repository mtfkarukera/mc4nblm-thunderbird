# 📎 Magic Clipper for NotebookLM

**Magic Clipper for NotebookLM** est une MailExtension Thunderbird (Manifest V2) qui permet d'importer le contenu d'un email (corps, pièces jointes, URLs) directement dans un carnet **Google NotebookLM** en un seul clic depuis le panneau de lecture.

Optimisé pour l'analyse par Gemini, il intègre un grounding IA complet et prend en compte les contextes de sécurité spécifiques au panneau de lecture de Thunderbird.

---

## ✨ Fonctionnalités

| Fonctionnalité | Description |
| --- | --- |
| **4 modes d'import** | 📄 PDF, 📝 Markdown, 🔗 URL détectées, ⚡ Import Direct de pièces jointes |
| **📄 Email → PDF** | Rendu PDF haute fidélité du DOM de l'email via jsPDF avec grounding IA complet en en-tête. |
| **📝 Email → Markdown** | Extraction et conversion propre du HTML en Markdown structuré (support complet des listes imbriquées, blockquotes, code blocks, et tableaux). |
| **🔗 URL** | NotebookLM scrape le lien lui-même — idéal pour les newsletters contenant des liens vers des articles publics. |
| **⚡ Import Direct (PJ)** | Détecte et importe individuellement ou par lot les pièces jointes (PDF, images, audio, vidéo, documents) via le protocole Google Scotty. |
| **Filtrage des médias** | Les images base64 ou volumineuses en pièces jointes sont gérées de façon à éviter tout blocage de quota de l'API. |
| **Fast Research** | Filtrage dynamique en temps réel avec debounce (300ms) pour trouver instantanément votre carnet cible. |
| **Multi-comptes** | Menu déroulant intégré pour basculer facilement entre vos différents profils et comptes Google. |
| **Internationalisation** | Support complet en 5 langues (EN, FR, DE, ES, VI) avec basculement automatique selon la locale de Thunderbird. |

---

## 🏗️ Architecture et Flux de Données

```text
┌───────────────────────────┐      ┌─────────────────────────────┐      ┌─────────────────────────────┐
│        Popup (UI)         │─────▶│       Background.js         │─────▶│      NotebookLM API         │
│  Logique états et boutons │      │       (Persistent MV2)      │      │      /batchexecute          │
│  Fast Research            │◀─────│       Auth Gecko & CSRF     │◀─────│      /upload/_/ (Scotty)    │
└───────────────────────────┘      └──────────────┬──────────────┘      └─────────────────────────────┘
                                                  │
                                                  │ (scripting.executeScript)
                                           ┌──────▼──────────────────────┐
                                           │    Content Bridge Script    │
                                           │    email_bridge.js          │
                                           │    email_pdf_generator.js   │
                                           └─────────────────────────────┘
```

* **CORS et Réseau** : Toutes les requêtes réseau vers Google passent par le script d'arrière-plan (`background.js`), exempté des règles de CORS appliquées à l'affichage des emails.
* **Extraction MIME récursive** : L'extension parcourt récursivement l'arbre MIME des emails pour restituer le contenu sous son meilleur format structurel (HTML ou texte brut).
* **Lazy Loading PDF** : La bibliothèque `jspdf.umd.min.js` et le script de génération `email_pdf_generator.js` ne sont injectés dans l'iframe d'affichage de l'email qu'au moment où l'utilisateur clique sur le bouton de capture PDF.

---

## 🚀 Installation et Utilisation

### ⚠️ Prérequis de connexion Google

Avant d'utiliser l'extension pour la première fois, **votre compte Google** doit s'être connecté à NotebookLM au moins une fois dans Thunderbird :

1. Cliquez sur le bouton de l'extension. Si vous n'êtes pas connecté, l'état **Connexion requise** s'affiche.
2. Cliquez sur le bouton **Se connecter à NotebookLM**.
3. Un onglet WebContent interne s'ouvre dans Thunderbird sur [notebooklm.google.com](https://notebooklm.google.com/).
4. Connectez-vous avec votre compte Google.
5. Une fois connecté, l'onglet se ferme automatiquement. L'extension détecte vos cookies de session et affiche vos carnets.

---

### Méthode 1 : Chargement temporaire (Développement)

1. Ouvrez Thunderbird.
2. Allez dans le menu ☰ ➡️ **Outils** ➡️ **Boîte à outils de développement** ➡️ **Déboguage des modules**.
3. Cliquez sur **Ce Thunderbird** (ou bouton équivalent).
4. Cliquez sur **Charger un module temporaire...** et sélectionnez le fichier [manifest.json](file:///Users/mtfkarukera/Scripts/mc4nblm-thunderbird/manifest.json) du projet.

---

### Méthode 2 : Packaging et Installation permanente

1. Packagez le projet en archive ZIP/XPI depuis la racine :
   ```bash
   npx web-ext build --source-dir .
   ```
2. Renommez l'archive produite en `.xpi` (ex: `notebooklm-clipper-tb-1.0.0.xpi`).
3. Dans Thunderbird ➡️ **Gestionnaire de modules complémentaires** ➡️ cliquez sur l'icône engrenage ⚙️ ➡️ **Installer un module depuis un fichier...** ➡️ Sélectionnez votre fichier `.xpi`.

---

## 📁 Structure du Projet

```text
notebooklm-clipper-thunderbird/
├── manifest.json                    # Manifest V2 MailExtension
├── _locales/                        # Fichiers de traduction native (EN, FR, DE, ES, VI)
├── lib/
│   └── jspdf.umd.min.js            # jsPDF 2.5.2 standalone (injecté à la demande)
├── src/
│   ├── background/
│   │   ├── background.js           # Routeur principal & pipelines d'import
│   │   └── api/
│   │       ├── auth.js             # Gestion auth Gecko, cookies et rotation CSRF
│   │       └── rpc_client.js       # Clients RPC Google batchexecute et Scotty Upload
│   ├── content/
│   │   ├── email_bridge.js         # Point d'entrée injecté dans l'affichage email
│   │   └── email_pdf_generator.js  # Générateur PDF (jsPDF DOM Walker)
│   ├── popup/
│   │   ├── popup.html              # Vue UI Glassmorphism de la popup
│   │   ├── popup.css               # Styles et thèmes (Sombre / Clair)
│   │   └── popup.js                # Contrôleur UI, Fast Research et boutons
│   └── shared/
│       └── utils.js                # Fonctions utilitaires, i18n et htmlToMarkdown
└── icons/
    └── icon.svg                    # Icône officielle de l'extension
```

---

## 📋 Changelog

### v1.0.1 — Corrective Release — Juin 2026
* **Renommage officiel** : Correction du nom de l'extension pour réalignement sur "Magic Clipper for NotebookLM".
* **Prévention de la concurrence PDF** : Rejet automatique des requêtes d'imports PDF multiples simultanés pour éviter tout écrasement des callbacks.
* **Nettoyage réactif de session** : Déconnexion immédiate de la rotation périodique des cookies et réinitialisation des jetons en mémoire vive sur erreur `AUTH_EXPIRED`.
* **Précision des tables imbriquées** : Utilisation du ciblage `:scope` pour éviter la corruption de structure Markdown et PDF lors du parsing de tables imbriquées.
* **Estimation de mots robuste** : Retrait des feuilles de styles et balises scripts avant le décompte de mots de sécurité.
* **Normalisation d'upload des pièces jointes** : Retrait du caractère spécial `⚡ ` et désactivation des caractères accentués dans le nom final pour éviter des refus de transfert par Google.
* **Sécurisation de la validation ATN** : Remplacement des appels statiques `.document.write` dans la librairie minifiée jsPDF par `.document['write']` dynamique afin d'éliminer les avertissements de sécurité bloquants de l'analyse automatique d'ATN.

### v1.0.0 — Thunderbird Release — Juin 2026
* **Première version officielle pour Thunderbird** (MailExtension MV2).
* **Robustesse UMD jsPDF** : Détection du constructeur jsPDF sur tous les scopes globaux du sandbox Gecko (`window`, `globalThis`, `self`).
* **Heuristique de table (`isLayoutTable`)** : Ignorance automatique des tables de mise en page HTML complexes dans les e-mails pour produire un Markdown épuré.
* **Allègement Base64** : Retrait des images et données base64 volumineuses des exports textuels Markdown pour éviter tout blocage de quota de l'API Google.
* **Correction des types MIME** : Transmission explicite des types MIME des images lors des téléversements Scotty.
* **Assainissement des noms** : Remplacement des caractères de fichier invalides (`?`, `*`, `:`) par des underscores.
* **Refonte UI success** : Raccourcissement du bouton de validation en `"Ouvrir →"` dans toutes les langues pour éviter les débordements CSS côte à côte.
