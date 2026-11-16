# MultiPlex

Client Plex **communautaire**, rapide et personnalisable, pensé pour tourner partout à partir d'un seul code.

> Projet non officiel, sans lien avec Plex Inc. Nécessite votre propre Plex Media Server.

Confidentialité : MultiPlex n'envoie rien à son développeur ; ce qui part vers Plex et les autres services, et ce qui reste sur l'appareil, est décrit dans [PRIVACY.md](PRIVACY.md) (aussi dans l'application : Réglages → Compte → Confidentialité).

## Démarrer

```bash
pnpm install
pnpm dev        # http://localhost:5173 — « Essayer le mode démo » fonctionne sans compte
pnpm test       # tests unitaires du cœur
pnpm typecheck
pnpm build      # apps/web/dist : site statique, hébergeable n'importe où
pnpm desktop    # application de bureau (Electron)
```

### Héberger la version web (Docker)

L'image `ghcr.io/shibeon/multiplex-web` est publiée avec chaque version web (amd64 et arm64 ; l'archive du site est aussi jointe à la version `web-v…`) : coller
[`apps/web/compose.yml`](apps/web/compose.yml) dans une stack, puis la rendre joignable en HTTPS
par un proxy inverse (port 8080 du conteneur). Le serveur ne sert que les fichiers de
l'application : les navigateurs parlent directement à Plex. Pour la construire soi-même :
`docker build -f apps/web/Dockerfile -t multiplex-web .` depuis la racine du dépôt.

## Ce qui existe (v0.1)

- **Connexion Plex** par lien ou par code à 4 caractères (plex.tv/link, pratique sur TV), connexion manuelle adresse + jeton, mode démo.
- **Découverte des serveurs** : toutes les connexions testées en parallèle, priorité local > distant > relais ; redémarrage instantané sur la dernière adresse connue.
- **Navigation** : accueil (rangées du serveur), bibliothèques films / séries, tri, filtre « non vus », fiches, saisons, épisodes, recherche.
- **Lecteur** : lecture directe quand le navigateur sait lire le fichier, sinon transcodage HLS avec repli automatique ; choix audio / sous-titres / qualité, reprise, suivi de progression, épisode suivant, saut d'intro et de générique.
- **Personnalisation** : thèmes, couleur d'accent, taille et arrondi des affiches, échelle de l'interface, ordre et masquage des rangées d'accueil, CSS libre appliqué en direct, import / export des réglages (partage de thèmes).
- **Télécommande et clavier** : navigation spatiale aux flèches, touches Retour Tizen / webOS.
- **Français et anglais**, PWA installable.

Vérifié contre un vrai Plex Media Server (bibliothèques de plusieurs milliers de titres) : connexion, découverte, grille, fiches, recherche, lecture directe 4K HEVC, passage par le serveur, pistes audio, sous-titres, chapitres, vitesse, avance rapide, remontée de progression, vu / non vu, lectures en cours.

### Lecture : ce que fait le navigateur, et ses limites

Le lecteur cherche toujours à toucher le moins possible au fichier :

1. **Lecture directe** quand le navigateur sait tout lire. La décision repose sur la chaîne de codec exacte de la piste (profil, niveau, profondeur 8 / 10 bits), pas sur le seul nom du codec.
2. **Vidéo d'origine conservée** quand seul le reste bloque (audio DTS / TrueHD, piste audio secondaire, sous-titres intégrés) : le serveur copie la vidéo telle quelle — 4K, HDR10 et couche HDR10 du Dolby Vision compris —, convertit l'audio en AAC et livre les sous-titres texte à part en WebVTT.
3. **Conversion vidéo** en dernier recours : qualité limitée, sous-titres image (PGS, VobSub), Dolby Vision profil 5 (sans couche HDR10, que seul un décodeur Dolby Vision affiche correctement), codec vidéo inconnu du navigateur.

Ce qu'un navigateur ne sait pas faire, quel que soit le client :

| Fonction | Plex pour Windows (lecteur natif) | MultiPlex dans un navigateur |
| --- | --- | --- |
| HEVC 10 bits, HDR10 | Oui | Oui (Chrome / Edge récents avec décodage matériel) ; adapté par le navigateur sur un écran SDR |
| Dolby Vision | Selon matériel | Couche HDR10 seulement ; profil 5 converti par le serveur |
| AV1, VP9 | Oui | Oui selon navigateur |
| DTS, DTS-HD, TrueHD, Atmos | Décodage ou transmission à l'ampli | Converti en AAC stéréo par le serveur ; pas de transmission à l'ampli |
| Sous-titres ASS / SSA stylés | Rendu complet | Texte seul (mise en forme perdue) |
| Sous-titres image PGS / VobSub | Sans conversion | Incrustés par le serveur (conversion vidéo) |

### Lecteur natif de l'application de bureau

L'application Windows embarque **mpv** et s'en sert par défaut : il reçoit l'adresse du fichier d'origine et le lit tel quel, sans conversion par le serveur — tous les codecs vidéo, HDR10, HLG, Dolby Vision (conversion des tons par libplacebo), DTS / TrueHD / Atmos (décodés, ou transmis à l'ampli avec l'option correspondante), sous-titres ASS stylés et PGS. La progression, l'enchaînement des épisodes et le saut automatique d'intro restent gérés par MultiPlex.

Pendant la lecture, ce sont les commandes de mpv qui s'affichent : espace (pause), flèches (avance), `a` (piste audio), `s` (sous-titres), `i` (statistiques), `f` ou double-clic (plein écran), Échap (retour à MultiPlex). Le lecteur intégré du navigateur reste disponible dans Réglages → Lecture.

`pnpm fetch:mpv` télécharge mpv (builds de shinchiro référencés par mpv.io, GPL v2+, lancé comme programme séparé) dans `apps/desktop/vendor/mpv`. Sous Linux et macOS, le mpv du système est utilisé s'il est installé.

## Performance

- Preact + signaux : ~30 Ko gzip pour toute l'application ; `hls.js` n'est chargé que si un transcodage est nécessaire.
- Grille virtualisée : seules les rangées visibles sont dans le DOM, quelle que soit la taille de la bibliothèque.
- Requêtes « simples » au sens CORS (pas de pré-requête OPTIONS), images redimensionnées par le serveur à la taille affichée, cache mémoire avec rafraîchissement en arrière-plan.

## Architecture

```
packages/core   Client Plex en TypeScript pur (aucune dépendance DOM, testé sous Node)
                auth.ts · server.ts · playback.ts · demo.ts — contrat `MediaServer`
apps/web        Interface Preact : pages, lecteur, thèmes, navigation spatiale, PWA
apps/desktop    Coque Electron autour du build web
```

L'interface ne dépend que du contrat `MediaServer` : ajouter un autre backend revient à l'implémenter.

## Plateformes

| Plateforme | État |
| --- | --- |
| Navigateurs (ordinateur, mobile), PWA | Fonctionne |
| Windows | `pnpm desktop:dist` → installeur et version portable dans `apps/desktop/release` (non signés) |
| macOS / Linux | Compilés et publiés par le workflow à chaque version (dmg et zip Apple Silicon, AppImage, deb) ; jamais lancés sur une vraie machine |
| Android, Android TV, Fire TV (Capacitor) | APK signé publié avec chaque version Android (secrets ci-dessous) ; APK de débogage (`pnpm mobile:sync` puis `gradlew assembleDebug` dans `apps/mobile/android`, avec JDK 21 et SDK Android 35) ; vérifié dans les émulateurs Android 15 (téléphone) et Android TV 14 (télécommande), pas sur un appareil physique |
| iOS / iPadOS (Capacitor) | `pnpm --filter @multiplex/mobile exec cap add ios` sur un Mac ; non testé |
| Samsung Tizen | Dossier publié (zip) avec chaque version TV, à signer soi-même : `.wgt` produit (`pnpm package:tv` puis `tizen package -t wgt -s <profil>`) ; un vrai téléviseur exige un certificat Samsung lié à votre compte ; non testé sur téléviseur |
| LG webOS | `.ipk` publié avec chaque version TV, installable en mode développeur (ou `pnpm package:tv` puis `ares-package dist-platforms/webos`) ; non testé sur téléviseur |

Les paquets TV et mobiles embarquent exactement le même build web : navigation à la télécommande, touches Retour et touches multimédia y sont déjà gérées.

Une fois le dépôt poussé sur GitHub, `.github/workflows/build.yml` lance les tests à chaque envoi ; chaque plateforme est compilée et publiée quand son numéro de version change sur `main`, ou à la demande (sans publication).

## Mises à jour automatiques

L'application de bureau vérifie au démarrage, puis toutes les six heures, si une version plus récente a été publiée sur GitHub. Elle l'annonce par un bandeau ; rien n'est téléchargé ni installé sans accord (« Mettre à jour », puis « Redémarrer »). La vérification peut être désactivée dans Réglages → Mises à jour.

Chaque plateforme a son propre numéro de version, dans `versions.json` : `desktop` (Windows, macOS, Linux), `web`, `android` (téléphone, tablette, Android TV, Fire TV) et `tv` (LG webOS, Samsung Tizen). L'application affiche celui de la plateforme où elle tourne (Réglages → Mises à jour).

Publier une version :

1. `pnpm release <plateformes…>` (par exemple `pnpm release android tv`, ou `pnpm release all`) : monte le dernier chiffre de ces plateformes (`--set 1.2.0` pour un autre numéro) et ajoute en tête de `apps/web/src/changelog.json` une entrée à remplir, en français et en anglais. L'application montre ces nouveautés une fois après la mise à jour, et les propose avant (« Quoi de neuf ? ») ; chaque plateforme ne voit que les entrées qui la concernent. Le build échoue si une entrée manque ou est vide (`pnpm check:versions`).
2. Envoyer sur `main`. Le workflow publie chaque plateforme dont le numéro n'est pas encore publié, et seulement celles-là :
   - bureau : version en brouillon, Windows, macOS et Linux y déposent leurs installeurs et le fichier que lit la mise à jour automatique, puis elle devient publique avec l'étiquette `v…` — seulement si les trois ont réussi ; sinon le brouillon reste, et l'envoi suivant le reprend ;
   - web : archive du site (version `web-v…`) et image Docker ;
   - Android : APK signé (`android-v…`) ;
   - TV : `.ipk` LG et dossier Tizen à signer (`tv-v…`).

   Seule la version du bureau est marquée « Latest » : c'est celle que lit sa mise à jour automatique.

Les versions doivent être lisibles sans authentification : une application installée ne peut pas interroger un dépôt privé. Le code reste donc dans ce dépôt, et les versions sont publiées dans un dépôt public à part, [Shibeon/MultiPlex-releases](https://github.com/Shibeon/MultiPlex-releases), qui ne contient que les installeurs. Son adresse est dans `apps/desktop/package.json` (`build.publish`).

Mise en place, une seule fois :

1. Créer le dépôt public `MultiPlex-releases`, **avec un README** (une version ne peut pas être publiée dans un dépôt vide).
2. Créer un jeton d'accès limité à ce dépôt, avec le droit « Contents : Read and write ».
3. L'enregistrer dans ce dépôt-ci comme secret `RELEASES_TOKEN` (Settings → Secrets and variables → Actions).

Android : Android n'installe une mise à jour que si elle est signée avec la même clé que la version installée. Cette clé se crée une fois, se garde précieusement (perdue, il faut désinstaller l'application pour installer les versions suivantes) et ne se met jamais dans le dépôt :

1. `keytool -genkeypair -v -keystore multiplex.keystore -alias multiplex -keyalg RSA -keysize 2048 -validity 10000` (fourni avec Java).
2. Secrets du dépôt : `ANDROID_KEYSTORE` (le fichier en base64 : `base64 -w0 multiplex.keystore` sous Linux, `base64 -i multiplex.keystore` sous macOS, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("multiplex.keystore"))` sous PowerShell), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`multiplex`) et `ANDROID_KEY_PASSWORD` (si différent du mot de passe du keystore).

Sans ces secrets, la version Android n'est pas publiée (un avertissement l'indique dans le build) ; elle le sera au premier envoi sur `main` après leur ajout. Un APK de débogage déjà installé doit être désinstallé avant d'installer l'APK signé (clés différentes).

TV : le `.ipk` LG s'installe sur un téléviseur en mode développeur (application « Developer Mode » de LG). Le dossier Tizen doit être signé avec un certificat Samsung lié à votre compte et à votre téléviseur (Tizen Studio) : le build ne peut pas le faire à votre place.

L'application installée lit l'adresse des versions dans le fichier `app-update.yml` que la compilation y dépose, compilations locales comprises.

Limites : l'installeur Windows n'est pas signé (Windows affiche un avertissement à l'installation) ; sur macOS, la mise à jour automatique exige une application signée ; la version portable, l'APK Android et les paquets TV ne se mettent pas à jour seuls : leurs nouvelles versions se téléchargent sur la page des versions.

## Ce que Plex réserve, et comment MultiPlex fait

- **Repères d'intro et de générique** : Plex ne les transmet qu'aux comptes Plex Pass. Pour les autres, l'application de bureau complète avec [IntroDB](https://introdb.app), base communautaire libre (seuls l'identifiant IMDb de la série et le numéro de l'épisode lui sont envoyés ; désactivable dans les réglages). Les navigateurs et les téléviseurs ne peuvent pas interroger IntroDB.
- **Lectures en cours** : seul le propriétaire d'un serveur les voit. Pour tout le monde, la page « Amis » montre ce que les amis Plex ont regardé récemment (activité partagée par Plex entre amis), avec un interrupteur pour ne pas partager ses propres lectures — c'est le réglage de confidentialité du compte Plex.

## Feuille de route

- **Liste de suivi Plex (prioritaire)** : afficher la liste de suivi du compte, et rechercher comme dans Plex — y compris des titres absents du serveur — pour les y ajouter. Un outil comme Seerr, branché sur la liste de suivi, se charge alors de les récupérer.
- Lecteur natif : commandes aux couleurs de MultiPlex par-dessus la vidéo (aujourd'hui celles de mpv), choix des pistes depuis l'interface.
- Sous-titres intégrés sans transcodage vidéo, choix de la version du fichier.
- Musique, photos, listes de lecture, collections, filtres avancés.
- Utilisateurs Plex Home, multi-serveurs simultanés.
- Galerie de thèmes en ligne, alimentée par le dépôt une fois publié (la galerie embarquée existe déjà).
- Téléchargements hors ligne.

## Idées mises de côté

Pistes retenues pour plus tard, pas encore commencées.

**Communauté**

- **Regarder ensemble** : une salle où plusieurs personnes lisent le même titre, synchronisées (pause, avance), avec un petit chat. Demande un service de synchronisation, pensé pour tourner sur la machine d'un des participants.
- **Activité des amis enrichie** : sur la page « En direct », voir ce qu'ils ont regardé récemment et rejoindre leur lecture.
- **Recommandations entre amis** : conseiller un titre à quelqu'un, qui le retrouve dans une rangée « Recommandé par… ».
- **Extensions** : des modules pour ajouter des rangées, des sources de métadonnées ou des boutons.

**Discord**

- **Statut d'activité** : « Regarde … » sur le profil, avec progression et pause / lecture. Passe par l'application de bureau (Discord local) ; demande un identifiant d'application Discord et des affiches publiques (TMDB) ou une icône générique ; à rendre désactivable.
- **Invitation** : bouton « Rejoindre » sur le statut, branché sur « Regarder ensemble ».
- **Annonces dans un salon** : message automatique au début d'un film, ou récapitulatif des ajouts de la semaine, par webhook.
- **Bot** : commandes `/en-direct`, `/quoi-regarder`, `/recommander` ; demande un hébergement permanent.
- **Activité intégrée** : MultiPlex dans un salon vocal. Le plus lourd : validation par Discord et relais des flux.

## Contribuer

Les contributions sont bienvenues. Licence MIT.

### Proposer un thème

La galerie de l'application (Réglages → Ouvrir la galerie) affiche les thèmes du dossier `themes/`. Pour en ajouter un, créez `themes/mon-theme.json` :

```json
{
  "id": "mon-theme",
  "name": "Mon thème",
  "author": "Votre nom",
  "description": "Une phrase pour le présenter.",
  "mode": "dark",
  "vars": {
    "--bg": "#101014",
    "--surface": "#1a1a20",
    "--surface-2": "#26262e",
    "--text": "#f2f2f5",
    "--muted": "#9a9aa6",
    "--accent": "#ff8a3d"
  },
  "radius": 14
}
```

- `id` reprend le nom du fichier ; les six couleurs de `vars` sont obligatoires, `--on-accent` (texte sur la couleur d'accent), `--backdrop-opacity` et `radius` sont facultatifs.
- Un thème ne contient que des couleurs (`#rrggbb`, `rgb()`, `hsl()`) : ni CSS libre ni adresse, pour qu'un thème reçu d'ailleurs ne puisse rien charger ni exécuter.
- **Illustration (facultative)** : un portrait ou un emblème, déposé à côté du thème sous le même nom (`themes/mon-theme.webp`, `.jpg` ou `.png`, 200 Ko au plus) et déclaré par `"image": "mon-theme.webp"` avec un `"imageCredit"` obligatoire (auteur et licence). L'application l'affiche en médaillon dans la navigation, en filigrane dans le fond des pages et à la place de l'indicateur de chargement. L'image est incorporée au thème à la compilation : une adresse en ligne est toujours refusée. N'utilisez que des images dont la licence permet la réutilisation.
- Le plus simple pour partir de l'existant : réglez l'apparence dans l'application, puis « Partager mon thème » enregistre le fichier.
- `node scripts/build-themes.mjs` vérifie tous les thèmes ; il tourne aussi avant `pnpm dev`, `pnpm build` et `pnpm typecheck`.

Une langue est un dictionnaire dans `apps/web/src/i18n.ts`.

### Crédits des illustrations

Le code est sous licence MIT ; les illustrations de thèmes gardent leur propre licence.

- `themes/le-glucks.webp` : d'après « Raphaël Glucksmann-1040795 (cropped) » de Harald Krichel, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Rapha%C3%ABl_Glucksmann-1040795_(cropped).jpg). Image recadrée et passée en bichromie ; cette version est diffusée sous la même licence.
- `themes/christ-cosmique.webp` : d'après « Sylvain Durif, sur une aire d'autoroute, en 2013 » de chatzefratz, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sylvain_Durif,_sur_une_aire_d%27autoroute,_en_2013.png). Image recadrée, passée en bichromie, halo et étoiles ajoutés.
