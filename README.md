# 📎 Magic Clipper for Gemini Notebook (Thunderbird)

![version](https://img.shields.io/badge/version-1.6.0-blue) ![platform](https://img.shields.io/badge/Thunderbird-128%2B%20ESR-0a84ff) ![manifest](https://img.shields.io/badge/Manifest-V3-2ea44f)

**Magic Clipper for Gemini Notebook** est une MailExtension Thunderbird (**Manifest V3**, compatible **Thunderbird 128.0+ ESR**) permettant d'importer le contenu d'un courriel (corps et pièces jointes) directement dans un carnet **Google Gemini Notebook** (anciennement NotebookLM, `notebook.google.com`) en un clic depuis le panneau de lecture.

Optimisée pour l'analyse par Gemini, l'extension injecte automatiquement le contexte complet du courriel (*grounding IA* : objet, expéditeur, destinataires, date et note d'intention optionnelle) tout en respectant l'isolation stricte des courriels dans Thunderbird.

---

## ✨ Fonctionnalités

| Fonctionnalité | Description |
| --- | --- |
| **3 pipelines d'import** | 📄 Courriel → PDF, 📝 Courriel → Markdown, ⚡ Pièces jointes → Import Direct |
| **📄 Courriel → PDF** | Rendu PDF paginé du courriel affiché via `jsPDF`, avec en-tête de contexte IA, tableaux et images intégrées. |
| **📝 Courriel → Markdown** | Extraction MIME récursive et conversion HTML → Markdown fidèle (titres, listes imbriquées, citations, blocs de code, tableaux), idéale pour toutes les écritures UTF-8 / CJK. |
| **⚡ Import Direct (PJ)** | Détection et import séquentiel de vos pièces jointes (PDF, documents Office, images, audio, vidéo, texte/CSV jusqu'à 200 Mo) via le protocole Google Scotty, y compris sur les courriels sans texte d'accompagnement. |
| **Note d'intention IA** | Champ optionnel injecté en tête du PDF ou du Markdown pour guider l'analyse de Gemini Notebook. |
| **Fast Research & Création** | Recherche instantanée de carnets (debounce 300 ms) et création de nouveau carnet directement depuis la popup. |
| **Multi-comptes Google** | Bascule fluide entre vos différents comptes Google connectés (`authuser` 0 à 4). |
| **Respect de la vie privée** | Opt-in explicite au premier lancement, transfert HTTPS direct vers Google (zéro serveur tiers, zéro télémétrie) et bouton de déconnexion en un clic. |
| **Accessibilité & 7 langues** | Interface Glassmorphism sombre/clair conforme WCAG 2.1 AA, traduite en 7 langues (`EN`, `FR`, `DE`, `ES`, `VI`, `JA`, `PT`). |

---

## 🏗️ Architecture et Sécurité

* **Event Page Manifest V3** : aucune exécution permanente inutile en arrière-plan ; réveil à la demande lors de l'ouverture de la popup ou des alarmes système (`browser.alarms`).
* **Réseau 100 % HTTPS isolé** : toutes les requêtes vers `https://notebook.google.com` et `https://upload.googleapis.com` transitent par l'Event Page d'arrière-plan avec vérification stricte des domaines d'upload.
* **Sécurité DOM stricte** : zéro `innerHTML`, zéro `eval()`, code source lisible non minifié et bibliothèque `jsPDF 4.2.1` officielle intacte ([VENDOR.md](VENDOR.md)).

Consultez [ARCHITECTURE.md](ARCHITECTURE.md) pour le détail technique complet, [PRIVACY-POLICY.md](PRIVACY-POLICY.md) pour la charte de confidentialité et [CONTRIBUTING.md](CONTRIBUTING.md) pour les standards de développement.

---

## 🚀 Installation et Utilisation

### 1. Configuration initiale (première utilisation)

1. Ouvrez un courriel dans Thunderbird et cliquez sur le bouton **Notebook** (*Clipper vers Gemini Notebook*) dans l'en-tête du message.
2. Cochez la case autorisant l'envoi des courriels que vous sélectionnez vers votre compte Google Gemini Notebook, puis cliquez sur **Se connecter à Gemini Notebook**.
3. Un onglet WebContent interne s'ouvre sur `https://notebook.google.com/`. Connectez-vous à votre compte Google.
4. Dès la session validée, l'onglet se referme automatiquement et la liste de vos carnets s'affiche.

### 2. Chargement temporaire (Développement)

1. Ouvrez Thunderbird (**128.0 ESR** ou plus récent).
2. Ouvrez le menu **Outils** → **Boîte à outils de développement** → **Débogage des modules**.
3. Cliquez sur **Charger un module temporaire…** et sélectionnez le fichier `manifest.json` à la racine du dépôt.

### 3. Compilation et installation d'une archive `.xpi`

1. Installez les outils de développement et construisez le paquet depuis la racine du projet :
   ```bash
   npm install
   bash build.sh
   ```
2. L'archive prête à l'emploi est générée dans `dist/notebooklm-clipper-tb-1.6.0.xpi`.
3. Dans Thunderbird → **Gestionnaire de modules complémentaires** → icône engrenage ⚙️ → **Installer un module depuis un fichier…**, sélectionnez le fichier `.xpi`.

---

## 📋 Historique des versions

L'historique exhaustif est maintenu dans [CHANGELOG.md](CHANGELOG.md).

- **v1.6.0** (2026-11-12) : Migration complète vers **Manifest V3 (Thunderbird 128+ ESR)**, conformité officielle ATN (jsPDF intact + `VENDOR.md`, consentement opt-in explicite, HTTPS strict), refonte de la pagination PDF, support des courriels PJ-seules, mise en conformité accessibilité WCAG 2.1 AA, rebranding complet **Magic Clipper for Gemini Notebook**, bouton court **Notebook** et barre de session supérieure.
- **v1.5.1** (2026-07-31) : Migration vers le domaine officiel `notebook.google.com`.
- **v1.5.0** (2026-06-29) : Renforcements d'accessibilité clavier, sécurité des messages IPC et design Glassmorphism.
- **v1.4.1** (2026-06-29) : Amélioration des contrastes en modes sombre et clair et navigation clavier de la liste des carnets.
- **v1.4.0** (2026-06-14) : Gestion du rate-limiting HTTP 429, identifiant de corrélation PDF et charte de confidentialité.
- **v1.0.0** (2026-06-09) : Première version officielle MailExtension pour Thunderbird.

---
*Développé par **MTF Karukera**. Découvre toutes les solutions logicielles et outils de productivité de la suite **magic-softs** sur [mtfk.fr](https://mtfk.fr/).*
