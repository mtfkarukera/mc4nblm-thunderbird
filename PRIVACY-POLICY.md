# Charte de Confidentialité — NotebookLM Clipper for Thunderbird

Dernière mise à jour : 14 juin 2026

Cette charte de confidentialité décrit comment l'extension **NotebookLM Clipper for Thunderbird** (la "MailExtension") collecte, utilise et protège vos données personnelles lorsque vous utilisez l'application.

---

## 1. Données collectées et Permission `sensitiveDataUpload`

Pour assurer son fonctionnement, l'extension nécessite et utilise la permission **`sensitiveDataUpload`** (transmission de données sensibles). 

### Quelles données sont lues ?
Lorsque vous demandez explicitement l'importation d'un e-mail ou d'une pièce jointe, l'extension accède localement dans votre client de messagerie Thunderbird aux données suivantes :
- **Métadonnées de l'e-mail** : Sujet, expéditeur, destinataire(s), date et heure.
- **Contenu du message** : Le corps du courriel (texte brut ou code HTML rendu).
- **Pièces jointes** : Les fichiers attachés au courriel que vous sélectionnez manuellement pour l'import.

### Pourquoi ces données sont-elles lues ?
La lecture de ces données a pour unique but de les formater (en PDF, Markdown, ou transmission de fichier binaire) afin de les téléverser dans votre espace personnel **Google NotebookLM** pour qu'elles y soient analysées par l'outil de recherche de Google.

---

## 2. Utilisation, Transfert et Sécurisation des Données

L'extension applique une politique stricte de **direct-to-destination** et de respect de votre vie privée :
- **Pas de serveur tiers** : Vos e-mails et pièces jointes ne transitent par **aucun serveur tiers ou intermédiaire**. Les données sont envoyées directement depuis votre client de Thunderbird vers les serveurs officiels de Google via des requêtes HTTPS sécurisées (`https://notebooklm.google.com`).
- **Aucun stockage persistant externe** : L'extension ne stocke aucun de vos e-mails ou fichiers. Une fois l'importation terminée (réussie ou échouée), les copies temporaires en mémoire (mémoire vive locale de Thunderbird) sont immédiatement purgées.
- **Aucune revente ni partage** : Vos données ne sont ni partagées, ni vendues, ni utilisées à des fins publicitaires ou d'entraînement de modèles d'IA par les concepteurs de cette extension. Elles appartiennent exclusivement à votre compte Google NotebookLM.

---

## 3. Contrôle de l'Utilisateur et Consentement

Vous conservez le contrôle total sur vos données à tout moment :
- **Déclenchement manuel** : L'extension n'effectue aucune capture ou transmission automatique en arrière-plan. Chaque transfert de données nécessite une action manuelle et explicite de votre part (clic sur le bouton "Importer" dans la popup de l'extension).
- **Sélection des éléments** : Vous pouvez choisir d'importer uniquement le corps du courriel (en PDF ou Markdown) et de cocher/décocher individuellement les pièces jointes à joindre ou à ignorer.
- **Déconnexion** : Vous pouvez vous déconnecter de NotebookLM à tout moment en fermant votre session dans l'onglet NotebookLM ou en purgeant les cookies de Thunderbird.

---

## 4. Contact

Pour toute question concernant cette charte de confidentialité ou le traitement de vos données, vous pouvez ouvrir une issue sur le dépôt officiel du projet.
