# 📖 Enseignements Techniques & Résolution de Problèmes

Ce document rassemble les découvertes d'ingénierie et les solutions d'architecture implémentées pour le développement du **NotebookLM Clipper for Thunderbird**. Il sert de guide pour éviter toute régression lors de futures évolutions du code.

---

## 1. Contexte du Bac à Sable jsPDF (Gecko / Thunderbird)

### Problématique
Dans l'environnement de Thunderbird, les `MessageDisplayScripts` s'exécutent dans un bac à sable (sandbox) où l'objet global `window` est soumis à un Xray Wrapper de Firefox.
* Les bibliothèques tierces au format UMD (comme `jspdf.umd.min.js`) s'exécutent et attachent leur constructeur au contexte global du bac à sable (`globalThis` ou `self`) plutôt qu'à `window`.
* L'accès direct à `window.jspdf` renvoie `undefined` et cause un plantage critique à l'initialisation de la capture.

### Solution
L'acquisition de la classe `jsPDF` doit se faire de manière défensive en scannant l'ensemble des namespaces potentiels :
```javascript
const jsPDFClass = (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) ? window.jspdf.jsPDF :
                   (typeof jspdf !== 'undefined' && jspdf.jsPDF) ? jspdf.jsPDF :
                   (typeof window.jsPDF !== 'undefined') ? window.jsPDF :
                   (typeof globalThis !== 'undefined' && globalThis.jsPDF) ? globalThis.jsPDF : null;
```
Pour éviter les erreurs ESLint de type `no-undef`, toute vérification de variable globale non déclarée dans la configuration doit utiliser `typeof globalThis.variable` plutôt que `typeof variable`.

---

## 2. Distinction entre Tables de Données et Tables de Mise en Page (Markdown)

### Problématique
Les e-mails HTML professionnels (newsletters, confirmations d'achat) utilisent des structures de tables complexes et imbriquées (`<table>` dans `<table>`) uniquement pour aligner le texte et caler le design.
* Si on convertit aveuglément chaque table en tableau Markdown, on se retrouve avec des lignes de barres `|||` vides et des caractères d'échappement `\|` illisibles (les pipes de la table interne étant échappés par le parser de la table externe).

### Solution
Nous avons introduit une fonction d'analyse de structure `isLayoutTable()` :
* **Détection de Layout** : Une table est considérée comme une table de mise en page (et non de données) si :
  1. Elle contient au moins une sous-table (`node.querySelector('table') !== null`).
  2. Elle n'a qu'une seule ligne (`rows.length === 1`).
  3. Elle n'a qu'une seule colonne (le nombre max de cellules par ligne est de 1).
* **Traitement** : Les tables de layout sont parcourues comme de simples conteneurs de blocs (comme des `div`). Leurs lignes (`tr`) insèrent des retours à la ligne, et leurs cellules (`td`/`th`) insèrent des espaces de padding.
* **Résultat** : Seuls les vrais tableaux de données conservent le formatage Markdown `| --- |`, et le texte des e-mails redevient propre et lisible.

---

## 3. Limites de Taille de l'API Google `addTextSource` & Traitement du Base64

### Problématique
Certains emails (ex. SNCF Connect) intègrent de nombreuses images ou codes-barres directement dans le code HTML sous forme de **Data URIs Base64** (`<img src="data:image/png;base64,...">`).
* En mode Markdown, ces gigantesques blocs de texte base64 (pouvant faire plusieurs mégaoctets chacun) étaient intégrés au document final.
* L'API RPC de Google NotebookLM (`izAoDd` pour les sources textuelles) rejetait la requête avec l'erreur gRPC `Failed precondition` (status code 9) car le payload dépassait la taille maximale autorisée pour une note textuelle.

### Solution
Le convertisseur de HTML en Markdown doit filtrer activement les sources de données :
* Les images dont la source commence par `data:` sont converties en simple placeholder textuel `[Image]` (ou le texte alternatif de l'image).
* Les liens (`<a>`) ayant une adresse `data:` sont nettoyés pour n'extraire que le libellé brut sans le lien base64.
* Cette sanitisation empêche le gonflement artificiel de la taille du payload de plus de 95%, garantissant des imports instantanés sans erreur gRPC.

---

## 4. Transmission des Types MIME pour l'OCR d'Images (Google Scotty)

### Problématique
Lors de l'envoi de pièces jointes, Thunderbird peut récupérer des fichiers avec un type MIME générique comme `application/octet-stream` (surtout si les en-têtes MIME de l'e-mail d'origine étaient imprécis).
* Si Google Scotty reçoit un fichier JPG ou PNG qualifié en `application/octet-stream`, NotebookLM l'ingère comme un fichier binaire brut. Le traitement échoue en tâche de fond (source marquée en rouge sur l'interface).

### Solution
Le protocole de téléversement Scotty (`uploadFileSource`) a été mis à jour pour accepter un paramètre `contentType` explicite et le transmettre dans l'en-tête de démarrage de session :
```javascript
'x-goog-upload-header-content-type': contentType || fileBlob.type || 'application/octet-stream'
```
Dans `background.js`, le type de contenu de la pièce jointe (déterminé par l'extension du fichier ou les métadonnées de Thunderbird) est systématiquement transmis pour forcer Google à router l'image vers le pipeline d'OCR.

---

## 5. Gestion de la Multi-authentification Google (authuser)

### Problématique
Les utilisateurs de Thunderbird utilisent souvent plusieurs profils de messagerie connectés à différents comptes Google. L'API de NotebookLM utilise le paramètre standard de query string `?authuser=N` pour distinguer les sessions actives.

### Solution
* L'extension interroge séquentiellement les cookies pour les indices `0` à `4`.
* Elle extrait les adresses e-mail correspondantes pour les présenter dans un sélecteur dans la popup.
* L'index actif choisi par l'utilisateur est stocké dans le stockage local de l'extension et transmis à chaque appel RPC et Scotty (`x-goog-authuser` et paramètre `authuser` dans les URLs).
