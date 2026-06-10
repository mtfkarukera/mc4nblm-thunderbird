# 📎 Magic Clipper for NotebookLM

![version](https://img.shields.io/badge/version-1.0.5-blue) ![platform](https://img.shields.io/badge/Thunderbird-115%2B-0a84ff)

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
2. Renommez l'archive produite en `.xpi` (ex: `notebooklm-clipper-tb-1.0.5.xpi`).
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

### v1.0.5 — Notebook Creation Fix — Juin 2026
* **Création de carnet réparée** : le bouton `+` ouvrait une fenêtre détachée (`window.prompt`, non supporté dans les popups Thunderbird) qui échouait silencieusement. Remplacement par une saisie intégrée à la popup : le nom est prérempli avec le terme du champ de recherche, Entrée crée, Échap annule.
* **Plus d'échec silencieux** : toute erreur de création affiche un message localisé ; une session expirée bascule directement sur l'écran de reconnexion.
* **Fin de connexion fiabilisée** : l'état « prêt » n'est confirmé qu'après vérification effective de l'accès à NotebookLM (jeton CSRF) — fini le faux état prêt qui n'échouait qu'au premier import.
* **Nettoyage interne** : suppression de code mort hérité (chaîne de cookies inutilisée, identifiant de session FdrFJe jamais consommé, clé de stockage obsolète).

### v1.0.4 — Code Review Release — Juin 2026
* **Messages d'erreur fiables** : Les codes d'erreur du background sont désormais correctement reconnus par la popup (Gecko ne sérialise que `message` lors d'un rejet de `runtime.sendMessage`) — fini les "erreur inconnue" génériques pour une session expirée ou un email non sélectionné.
* **Pièces jointes .mov acceptées** : Ajout du type MIME `video/quicktime` (et retrait du type inexistant `video/mov`).
* **Pièces jointes transparentes** : Les PJ > 200 MB apparaissent grisées avec la mention de la limite (au lieu d'être masquées en silence) ; les fichiers sans extension reconnue sont proposés explicitement (décochés par défaut, import texte sur opt-in).
* **Téléchargement local robuste** : Nom de fichier issu du sujet brut de l'email, assaini — fini les échecs de téléchargement pour cause de caractères invalides ou d'ellipse de troncature.
* **Session plus sûre** : Détection immédiate d'un jeton CSRF absent (session expirée explicite), nettoyage des écouteurs si l'onglet de connexion est fermé manuellement, retrait d'un header `Cookie` interdit et inopérant.
* **Date manquante** : Affichage d'un libellé localisé au lieu de "Invalid Date" (popup, PDF et Markdown).
* **Allègement et sécurité** : Retrait des permissions inutilisées (`notifications`, `messagesModify`) et de `web_accessible_resources` ; logs de diagnostic désactivés en production (flag DEBUG) ; fuites mémoire des téléchargements corrigées (révocation des object URLs).
* **Retrait du mode URL** : Le pipeline d'import d'URL (jamais exposé dans l'interface) est retiré du code — réintroduction propre envisagée dans une version future.

### v1.0.3 — Bug Fix & Asset Quality Release — Juin 2026
* **Amélioration de la qualité des icônes** : Restructuration et rendu vectoriel de haute qualité pour les icônes `icon.png`, `icon@2x.png` et ajout de `icon-128.png` pour une netteté maximale dans le gestionnaire de modules de Thunderbird.
* **Compatibilité des icônes** : Utilisation de formats PNG haute résolution dans `manifest.json` pour assurer un affichage parfait dans le Gestionnaire de modules complémentaires.

### v1.0.2 — Localization & Assets Release — Juin 2026
* **Localisation complète** : Finalisation et correction des traductions pour l'allemand, l'espagnol, l'vietnamien, le japonais et le portugais (7 locales supportées).
* **Ressources icônes** : Génération des icônes PNG carrées haute fidélité (`icon.png` et `icon@2x.png`) pour Thunderbird.
* **Sécurisation ESLint** : Ajout d'une règle stricte de blocage d'`innerHTML` pour prévenir les vulnérabilités XSS et respecter les recommandations ATN.

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
