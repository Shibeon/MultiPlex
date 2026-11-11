# MultiPlex

Client Plex **communautaire**, rapide et personnalisable, pensé pour tourner partout à partir d'un seul code.

> Projet non officiel, sans lien avec Plex Inc. Nécessite votre propre Plex Media Server.

## Démarrer

```bash
pnpm install
pnpm dev        # http://localhost:5173 — « Essayer le mode démo » fonctionne sans compte
pnpm test       # tests unitaires du cœur
pnpm typecheck
pnpm build      # apps/web/dist : site statique, hébergeable n'importe où
pnpm desktop    # application de bureau (Electron)
```

## Ce qui existe (v0.1)

- **Connexion Plex** par lien ou par code à 4 caractères (plex.tv/link, pratique sur TV), connexion manuelle adresse + jeton, mode démo.
- **Découverte des serveurs** : toutes les connexions testées en parallèle, priorité local > distant > relais ; redémarrage instantané sur la dernière adresse connue.
- **Navigation** : accueil (rangées du serveur), bibliothèques films / séries, tri, filtre « non vus », fiches, saisons, épisodes, recherche.
- **Lecteur** : lecture directe quand le navigateur sait lire le fichier, sinon transcodage HLS avec repli automatique ; choix audio / sous-titres / qualité, reprise, suivi de progression, épisode suivant, saut d'intro et de générique.
- **Personnalisation** : thèmes, couleur d'accent, taille et arrondi des affiches, échelle de l'interface, ordre et masquage des rangées d'accueil, CSS libre appliqué en direct, import / export des réglages (partage de thèmes).
- **Télécommande et clavier** : navigation spatiale aux flèches, touches Retour Tizen / webOS.
- **Français et anglais**, PWA installable.

Vérifié contre un vrai Plex Media Server (bibliothèques de plusieurs milliers de titres) : connexion, découverte, grille, fiches, recherche, lecture directe 4K HEVC, transcodage HLS, avance rapide, remontée de progression, vu / non vu. Limite connue : les sous-titres intégrés au fichier ne peuvent pas être servis à part par le serveur, ils imposent donc un transcodage vidéo.

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
| macOS / Linux | Même commande, à lancer sur chaque système (dmg, AppImage, deb) ; non testé |
| Android, Android TV, Fire TV (Capacitor) | APK de débogage compilé (`pnpm mobile:sync` puis `gradlew assembleDebug` dans `apps/mobile/android`, avec JDK 21 et SDK Android 35) ; vérifié dans les émulateurs Android 15 (téléphone) et Android TV 14 (télécommande), pas sur un appareil physique |
| iOS / iPadOS (Capacitor) | `pnpm --filter @multiplex/mobile exec cap add ios` sur un Mac ; non testé |
| Samsung Tizen | `.wgt` produit (`pnpm package:tv` puis `tizen package -t wgt -s <profil>`) ; un vrai téléviseur exige un certificat Samsung lié à votre compte ; non testé sur téléviseur |
| LG webOS | `.ipk` produit (`pnpm package:tv` puis `ares-package dist-platforms/webos`) ; non testé sur téléviseur |

Les paquets TV et mobiles embarquent exactement le même build web : navigation à la télécommande, touches Retour et touches multimédia y sont déjà gérées.

Une fois le dépôt poussé sur GitHub, `.github/workflows/build.yml` compile à chaque envoi le site, les dossiers TV, les applications Windows / macOS / Linux et l'APK Android, et les publie comme artefacts.

## Feuille de route

- Lecteur natif (mpv) sur ordinateur pour la lecture directe de tout format (MKV, HEVC, DTS, sous-titres ASS).
- Sous-titres intégrés sans transcodage vidéo, choix de la version du fichier.
- Musique, photos, listes de lecture, collections, filtres avancés.
- Utilisateurs Plex Home, multi-serveurs simultanés.
- Galerie de thèmes communautaires et système d'extensions.
- Téléchargements hors ligne.

## Contribuer

Les contributions sont bienvenues : un thème n'est qu'un jeu de variables CSS (`apps/web/src/settings.ts`), une langue un dictionnaire (`apps/web/src/i18n.ts`). Licence MIT.
