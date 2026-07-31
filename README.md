# 📎 Magic Clipper for NotebookLM

![version](https://img.shields.io/badge/version-1.5.1-blue) ![platform](https://img.shields.io/badge/Thunderbird-115%2B-0a84ff)


**Magic Clipper for NotebookLM** est une MailExtension Thunderbird (Manifest V2) qui permet d'importer le contenu d'un email (corps, pièces jointes) directement dans un carnet **Google NotebookLM** en un seul clic depuis le panneau de lecture.

Optimisé pour l'analyse par Gemini, il intègre un grounding IA complet et prend en compte les contextes de sécurité spécifiques au panneau de lecture de Thunderbird.

---

## ✨ Fonctionnalités

| Fonctionnalité | Description |
| --- | --- |
| **3 modes d'import** | 📄 PDF, 📝 Markdown, ⚡ Import Direct de pièces jointes |
| **📄 Email → PDF** | Rendu PDF haute fidélité du DOM de l'email via jsPDF avec grounding IA complet en en-tête. |
| **📝 Email → Markdown** | Extraction et conversion propre du HTML en Markdown structuré (support complet des listes imbriquées, blockquotes, code blocks, et tableaux). |
| **⚡ Import Direct (PJ)** | Détecte et importe individuellement ou par lot les pièces jointes (PDF, images, audio, vidéo, documents) via le protocole Google Scotty. |
| **Filtrage des médias** | Les images base64 ou volumineuses en pièces jointes sont gérées de façon à éviter tout blocage de quota de l'API. |
| **Fast Research** | Filtrage dynamique en temps réel avec debounce (300ms) pour trouver instantanément votre carnet cible. |
| **Multi-comptes** | Menu déroulant intégré pour basculer facilement entre vos différents profils et comptes Google. |
| **Internationalisation** | Support complet en 7 langues (EN, FR, DE, ES, VI, JA, PT) avec basculement automatique selon la locale de Thunderbird. |

---

## 🏗️ Architecture et Flux de Données

```text
┌───────────────────────────┐      ┌─────────────────────────────┐      ┌─────────────────────────────┐
│        Popup (UI)         │─────▶│       Background.js         │─────▶│      NotebookLM API         │
│  Logique états et boutons │      │       (Persistent MV2)      │      │      /batchexecute          │
│  Fast Research            │◀─────│       Auth Gecko & CSRF     │◀─────│      /upload/_/ (Scotty)    │
└───────────────────────────┘      └──────────────┬──────────────┘      └─────────────────────────────┘
                                                  │
                                                  │ (messageDisplayScripts)  
                                           ┌──────▼──────────────────────┐
                                           │    Content Bridge Script    │
                                           │    email_bridge.js          │
                                           │    email_pdf_generator.js   │
                                           └─────────────────────────────┘
```

* **CORS et Réseau** : Toutes les requêtes réseau vers Google passent par le script d'arrière-plan (`background.js`), exempté des règles de CORS appliquées à l'affichage des emails.
* **Extraction MIME récursive** : L'extension parcourt récursivement l'arbre MIME des emails pour restituer le contenu sous son meilleur format structurel (HTML ou texte brut).
* **Scripts PDF pré-enregistrés** : La bibliothèque `jspdf.umd.min.js` et le script de génération `email_pdf_generator.js` sont enregistrés comme messageDisplayScripts au démarrage du background — la capture PDF est ainsi disponible immédiatement, sans injection à la volée.

Pour une description détaillée des flux de données, de la gestion de l'authentification et du protocole d'upload, consulte le document d'[Architecture Technique (ARCHITECTURE.md)](ARCHITECTURE.md).

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
4. Cliquez sur **Charger un module temporaire...** et sélectionnez le fichier `manifest.json` à la racine du projet.

---

### Méthode 2 : Packaging et Installation permanente

1. Packagez le projet en archive ZIP/XPI depuis la racine :
   ```bash
   npx web-ext build --source-dir .
   ```
2. Renommez l'archive produite en `.xpi` (ex: `notebooklm-clipper-tb-1.4.0.xpi`).
3. Dans Thunderbird ➡️ **Gestionnaire de modules complémentaires** ➡️ cliquez sur l'icône engrenage ⚙️ ➡️ **Installer un module depuis un fichier...** ➡️ Sélectionnez votre fichier `.xpi`.

---

## 📁 Structure du Projet

```text
notebooklm-clipper-thunderbird/
├── manifest.json                    # Manifest V2 MailExtension
├── _locales/                        # Fichiers de traduction native (EN, FR, DE, ES, VI, JA, PT)
├── lib/
│   └── jspdf.umd.min.js            # jsPDF 2.5.2 standalone (pré-enregistré)
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

L'historique complet et détaillé des modifications de chaque version est disponible dans le fichier [CHANGELOG.md](CHANGELOG.md).

- **v1.5.0** (2026-06-29) : Corrections d'audit (robustesse, accessibilité WCAG AA, sécurité et design).
- **v1.4.1** (2026-06-29) : Amélioration des thèmes de couleurs et contrastes au survol pour conformité WCAG.
- **v1.0.6** (2026-06-26) : Détection de l'email actif unifiée sur les onglets et fenêtres autonomes Thunderbird.
- **v1.0.5** (2026-06-25) : Saisie inline pour la création de carnets et fiabilisation de l'authentification.
- **v1.0.4** (2026-06-24) : Traduction des codes d'erreurs Gecko et gestion des grosses pièces jointes.
- **v1.0.3** (2026-06-23) : Remplacement et vectorisation haute définition des icônes d'extension.
- **v1.0.2** (2026-06-18) : Localisation en 7 langues et protection stricte contre l'utilisation d'innerHTML.
- **v1.0.1** (2026-06-12) : Remplacement de l'upload Scotty et prévention des imports PDF concurrents.
- **v1.0.0** (2026-06-10) : Version initiale officielle MailExtension Manifest V2 pour Thunderbird.

---
*Développé par **MTF Karukera**. Découvre toutes les solutions logicielles et outils de productivité de la suite **magic-softs** sur [magic-clipper.mtfk.fr](https://magic-clipper.mtfk.fr/).*

