# Charte de Confidentialité — Magic Clipper for Gemini Notebook (Thunderbird)

Dernière mise à jour : 12 novembre 2026

Cette charte de confidentialité décrit comment l'extension **Magic Clipper for Gemini Notebook** pour Thunderbird (la « MailExtension », développée par **MTF Karukera**) accède aux données de vos courriels, les traite localement et les transmet uniquement sur votre demande explicite.

---

## 1. Données traitées et Consentement Explicite

L'extension fonctionne selon un principe strict d'**opt-in explicite désactivé par défaut** : aucun appel réseau n'est émis tant que vous n'avez pas validé le consentement de transfert lors de la configuration initiale, puis cliqué manuellement sur un bouton d'importation.

### Quelles données sont lues localement ?
Lorsque vous ouvrez la popup de l'extension sur un courriel affiché dans Thunderbird et déclenchez une importation, l'extension accède localement aux éléments suivants :
- **Métadonnées du courriel** : Objet, expéditeur, destinataire(s), date et heure.
- **Contenu du message** : Corps du courriel (texte brut MIME pour le mode Markdown, ou rendu DOM local pour la génération PDF).
- **Pièces jointes sélectionnées** : Uniquement les fichiers joints que vous cochez manuellement dans la liste avant de cliquer sur le bouton d'importation.
- **Cookies de session Google** : Lecture locale dans le magasin de cookies de Thunderbird pour `https://notebook.google.com` (avec repli sur `https://notebooklm.google.com`) et `https://accounts.google.com` afin d'authentifier vos requêtes auprès de votre propre compte Google Gemini Notebook.

### Justification des permissions déclarées (`manifest.json` MV3)
- `messagesRead` : Lecture des métadonnées, du corps et des pièces jointes du seul courriel affiché lorsque vous ouvrez l'extension.
- `scripting` : Injection locale du générateur PDF (`jsPDF`) dans le panneau d'affichage du courriel lors d'un export PDF.
- `cookies` et `host_permissions` (`https://*.google.com/*`, `https://*.googleapis.com/*`) : Authentification et téléversement direct en HTTPS vers les serveurs officiels Google Gemini Notebook.
- `storage` : Mémorisation locale dans Thunderbird de votre consentement, du dernier carnet sélectionné et de l'index de compte actif (`storage.local`), ainsi que des métadonnées techniques éphémères de session (`storage.session`). Aucun contenu d'e-mail, cookie ou jeton secret n'est jamais écrit sur disque.
- `downloads` : Enregistrement sur votre poste local du fichier PDF ou Markdown généré lorsque vous cliquez sur « Télécharger ».
- `alarms` : Planification périodique du maintien de session Google et purge automatique de la mémoire vive au bout de 5 minutes maximum après un import.
- `sensitiveDataUpload` & `data_collection_permissions` (`personalCommunications`) : Déclaration officielle auprès de Thunderbird indiquant que l'extension permet à l'utilisateur d'envoyer le contenu de courriels choisis vers un service distant (Google Gemini Notebook).

---

## 2. Transfert Direct, Sécurité et Absence de Serveur Tiers

- **Zéro serveur intermédiaire, zéro télémétrie** : Vos courriels, pièces jointes et identifiants ne transitent par **aucun serveur appartenant à MTF Karukera ou à un tiers**. Toutes les communications s'effectuent directement en HTTPS (`TLS`) depuis votre client Thunderbird vers les serveurs officiels de Google (`https://notebook.google.com`, `https://accounts.google.com` et `https://upload.googleapis.com`).
- **Rétention mémoire éphémère (TTL 5 minutes)** : Afin de vous permettre de télécharger localement une copie du PDF ou du Markdown juste après un import réussi, le document généré est conservé uniquement dans la mémoire vive locale de Thunderbird tant que l'écran de succès est affiché, et est systématiquement purgé à la fermeture de la popup, au démarrage d'un nouvel import ou au plus tard après **5 minutes**.
- **Aucune exploitation commerciale** : L'extension ne collecte aucune statistique d'usage, ne dépose aucun traceur publicitaire et ne partage aucune donnée. Une fois téléversées dans votre carnet Google Gemini Notebook, vos sources sont soumises aux conditions d'utilisation et aux règles de confidentialité de votre propre compte Google.

---

## 3. Contrôle de l'Utilisateur et Révocation

Vous conservez un contrôle total à chaque instant :
- **Action manuelle systématique** : Aucune capture automatique ni synchronisation en arrière-plan des courriels entrants ou sortants n'existe dans l'extension.
- **Déconnexion et révocation en un clic** : Vous pouvez à tout moment utiliser le bouton « Déconnecter » situé en haut de la popup de l'extension pour révoquer localement la session active et le consentement enregistré, ou supprimer les cookies Google dans les paramètres de Thunderbird.

---

## 4. Contact

Pour toute question relative à la confidentialité ou à la sécurité du code source, vous pouvez ouvrir un ticket sur le dépôt GitHub officiel du projet ou contacter l'auteur via https://mtfk.fr/.
