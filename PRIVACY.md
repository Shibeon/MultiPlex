# Politique de confidentialité de MultiPlex

S'applique à toutes les versions de MultiPlex : la version web (navigateur, PWA, site hébergé
soi-même), l'application de bureau (Windows, macOS, Linux), l'application Android (téléphone,
tablette, Android TV, Fire TV) et les paquets pour téléviseurs LG webOS et Samsung Tizen, qui
embarquent la version web.

## En bref

- MultiPlex est un **client Plex communautaire et non officiel**, sans lien avec Plex Inc. Il est
  publié en code source ouvert (licence MIT) par des bénévoles.
- **Le développeur ne reçoit rien.** MultiPlex ne contient ni statistiques d'usage, ni mesure
  d'audience, ni rapport de plantage, ni publicité, et ne fait appel à aucun serveur tenu par le
  développeur. Il n'y a pas de compte MultiPlex.
- L'application parle **directement** à vos serveurs Plex et aux services de Plex (plex.tv). Ce que
  Plex en fait relève de [la politique de confidentialité de Plex](https://www.plex.tv/about/privacy-legal/).
- Quelques services tiers ne sont contactés que pour une fonction précise, décrite ci-dessous, et
  la plupart se désactivent.
- Vos réglages et votre connexion restent **sur votre appareil**.

## Ce qui part, vers qui, quand et pourquoi

### Vos serveurs Plex Media Server

- **Qui** : le ou les serveurs Plex auxquels votre compte a accès (le vôtre, ou celui d'un ami qui
  vous le partage). C'est leur propriétaire qui les opère.
- **Quoi** : le jeton d'accès à ce serveur, l'identité de l'application (nom « MultiPlex », version,
  système, type d'appareil, identifiant aléatoire propre à cette installation), et ce que vous y
  faites : navigation, recherches dans la bibliothèque, lecture, position de lecture, « vu / non
  vu ». Comme avec toute application Plex, le propriétaire du serveur voit qui regarde quoi.
- **Quand** : dès que vous utilisez une bibliothèque.

### plex.tv (Plex Inc.)

- **Connexion** (`plex.tv`, `app.plex.tv`) : création du code de connexion, validation, lecture de
  votre compte. Sur téléviseur, le QR code mène à `app.plex.tv` sur votre téléphone.
- **Serveurs** : la liste des serveurs de votre compte et de leurs adresses.
- **Plex Home** : la liste des profils du foyer, et le changement de profil (avec son code PIN,
  s'il en a un).
- **Amis** (`plex.tv/api/users/`) : la liste de vos amis Plex, lue avec votre jeton depuis votre
  appareil, seulement pour « Regarder ensemble » quand vous rendez une séance visible (voir plus
  bas).
- **Catalogue et liste de suivi** (`discover.provider.plex.tv`, `metadata.provider.plex.tv`) :
  « Ma liste », fiches des titres absents de votre serveur, épisodes à venir, pages des
  personnes, ajout ou retrait de la liste de suivi. Le texte tapé dans la recherche (à partir de
  deux caractères) y part aussi pour trouver des personnes.
- **Activité des amis** (`community.plex.tv`) : le fil de ce que vos amis ont regardé (page
  « Amis »), et le réglage « Montrer à mes amis ce que je regarde ». Ce réglage est celui de
  **votre compte Plex** : l'interrupteur de MultiPlex le lit et le modifie chez Plex, et il vaut
  pour toutes les applications Plex.

Ces échanges portent votre jeton plex.tv et l'identité de l'application décrite plus haut. Rien de
tout cela n'a lieu en mode démo.

### Mode démo

Le mode démo (« Essayer le mode démo ») ne contacte ni Plex ni aucun serveur Plex : ses titres
sont inventés. Seule la lecture d'une vidéo de démonstration télécharge une vidéo d'essai publique
depuis `test-streams.mux.dev` (Mux), sans aucune donnée vous concernant au-delà de la demande
elle-même (adresse IP, navigateur).

### Images des fiches

Les affiches, photos d'acteurs et avatars dont Plex donne une adresse complète sont chargés
directement depuis cette adresse : serveurs d'images de Plex (par exemple
`metadata-static.plex.tv`) ou de TMDB (`image.tmdb.org`). Ces serveurs reçoivent la
demande de l'image (adresse IP, navigateur), sans votre jeton.

### Mises à jour (application de bureau seulement)

- **Qui** : GitHub, où sont publiées les versions
  ([Shibeon/MultiPlex-releases](https://github.com/Shibeon/MultiPlex-releases)).
- **Quoi** : une demande de fichier ordinaire (adresse IP, version de l'application), sans
  aucune donnée de compte. GitHub tient des compteurs de téléchargements des versions.
- **Quand** : quelques secondes après le lancement, puis toutes les six heures.
- **Réglage** : Réglages → Mises à jour. Couper « Installer automatiquement les mises à jour »
  empêche le téléchargement sans votre accord ; la vérification de la version, elle, a toujours
  lieu.
- L'application Android, les paquets TV et la version web ne vérifient pas de mises à jour.

### IntroDB (application de bureau seulement)

- **Quoi** : l'identifiant IMDb de la série, le numéro de saison et celui de l'épisode. Rien du
  compte ni du serveur.
- **Quand** : au lancement d'un épisode dont Plex ne fournit pas les repères d'intro et de
  générique.
- **Réglage** : Réglages → Lecture → « Compléter les repères d'intro et de générique avec
  IntroDB » (allumé par défaut).

### Reconnaissance des acteurs à la pause (application de bureau seulement)

La reconnaissance des visages se calcule **sur votre ordinateur**, avec un modèle embarqué :
l'image en pause ne quitte pas l'appareil. Seules les photos des acteurs sont téléchargées, et
seulement depuis `metadata-static.plex.tv` ou `image.tmdb.org`. Réglage : Réglages → Lecture →
« À la pause, reconnaître les acteurs présents à l'écran ».

### Envoi vers un téléviseur (Chromecast)

- **Navigateur Chrome / Edge** : au premier envoi seulement, le navigateur charge le kit Google
  Cast depuis `www.gstatic.com` (Google).
- **Android** : le kit Google Cast des services Google Play est utilisé.
- **Bureau** : les appareils sont cherchés sur le réseau local.
- Dans tous les cas, l'appareil choisi reçoit l'adresse de la vidéo et de son affiche sur votre
  serveur Plex, avec un **jeton temporaire** délivré par ce serveur (pas votre jeton de compte),
  et lance le lecteur multimédia par défaut de Google.

### Galerie de thèmes en ligne (facultative)

Seulement si vous saisissez une adresse de galerie : l'application télécharge ce fichier à cette
adresse. Les thèmes ne peuvent contenir que des couleurs : ni script ni adresse.

### Liens

Les liens vers Letterboxd, app.plex.tv ou les réseaux sociaux d'une personne ne sont ouverts que
si vous cliquez dessus.

### La version web hébergée

Le serveur qui héberge la version web (par exemple l'image Docker sur votre NAS) ne sert que les
fichiers de l'application : il voit les demandes ordinaires de ces fichiers, comme n'importe quel
site. Ni jeton, ni vidéo, ni réglage ne passe par lui ; le navigateur parle directement à Plex.

## Regarder ensemble

« Regarder ensemble » synchronise la lecture entre amis grâce à un **relais**, un petit serveur
que **chacun héberge soi-même**, en général le propriétaire du serveur Plex sur son NAS (par
exemple `https://relais.exemple.fr`, ou `https://plex.exemple.fr/multiplex-relay`). Aucune
adresse de relais n'est écrite dans MultiPlex, et le développeur n'en opère aucun.

**Comment le relais est trouvé.** Celui qui lance une séance indique son relais dans Réglages →
Relais « Regarder ensemble ». L'application d'un invité le cherche sur les adresses publiques des
serveurs Plex qu'il voit (les « URL d'accès personnalisées » publiées par plex.tv), en demandant
à chacune, sans jeton, si elle connaît la séance. Une invitation peut aussi contenir l'adresse du
relais (`MPX-K7Q2-9XFD@relais.exemple.fr`).

**Chiffrement de bout en bout.** L'invitation est un code court non répertorié. La clé de
chiffrement en est tirée sur les appareils et ne part jamais : le relais ne reçoit qu'un numéro de
salle. Tout ce qui circule dans la séance (pseudos, avatars, titre, position, lecture / pause)
est chiffré (AES-GCM) et le relais ne fait que le transmettre. Le volume, les sous-titres,
l'audio et la qualité de chacun ne quittent pas son appareil.

**Ce que voit toujours le relais** : les adresses IP des participants, le numéro de salle, le
nombre de participants, le moment et la taille des messages. Il ne garde rien sur disque : tout
est en mémoire, et une salle ferme d'elle-même au bout de 12 heures. Le proxy inverse placé devant
lui peut tenir son propre journal.

**Séances visibles par vos amis.** Quand l'interrupteur « Visible par mes amis Plex » est allumé
(par défaut, modifiable à chaque séance, et pour toutes dans Réglages → « Mes séances « Regarder
ensemble » visibles par mes amis Plex »), et seulement si le relais sait réserver
la liste aux amis :

- la séance apparaît chez **vos seuls amis Plex** qui ont accès à ce serveur, et nulle part
  ailleurs ;
- le relais reçoit alors une petite fiche : votre nom Plex, le titre (et l'épisode), la position
  et lecture / pause ; plus la liste des **numéros de compte plex.tv** de vos amis (lue par votre
  appareil sur plex.tv, gardée en mémoire le temps de la séance) ;
- pour savoir qui demande la liste, l'application présente au relais le jeton propre à **ce
  serveur Plex** (ou un jeton délégué par lui), jamais votre jeton de compte plex.tv, et seulement
  à un relais trouvé aux adresses de ce même serveur. Le relais n'en garde que l'empreinte.

Une séance non visible n'est jamais annoncée : elle ne se rejoint qu'avec l'invitation.

**Relevé des séances des amis.** Tant que vous êtes connecté et que « Me prévenir quand un ami
lance une séance » est allumé (par défaut), l'application interroge de temps en temps (environ
toutes les 45 secondes, au premier plan) les relais des serveurs que vous voyez, comme décrit
ci-dessus. Coupez ce réglage pour l'arrêter ; la page « Amis » et la fenêtre « Regarder
ensemble » relèvent encore la liste quand vous les ouvrez.

Le relais lui-même (code et fonctionnement détaillé) est décrit dans
[apps/relay/README.md](apps/relay/README.md). Celui qui l'héberge doit lui confier le jeton
plex.tv de son propre compte (`PLEX_TOKEN`) pour les séances visibles : ce jeton reste sur sa
machine et n'est envoyé qu'à plex.tv.

## Ce qui est gardé sur votre appareil

Dans le stockage local de l'application (le `localStorage` du navigateur ou de l'application) :

| Donnée | Pourquoi |
| --- | --- |
| Jeton plex.tv et fiche du compte (nom, avatar, identifiant) | Rester connecté |
| Dernier serveur utilisé (nom, adresse, jeton de ce serveur) | Redémarrer directement dessus |
| Identifiant aléatoire de l'installation | Identité de l'appareil auprès de Plex |
| Réglages, ordre des rangées d'accueil | Vos préférences |
| Recherches récentes (par profil) | Les reproposer ; désactivable dans Réglages |
| File d'attente de lecture | « Mettre à la suite » |
| Dernière version vue | Afficher les nouveautés une fois |
| Empreintes de visages des acteurs (bureau) | Reconnaissance des acteurs plus rapide |

L'application de bureau garde en plus, sur le disque : les titres téléchargés pour une lecture
hors ligne et leur index (dans le dossier choisi, par défaut `Vidéos/MultiPlex`), et la mise à
jour en attente. La version web met en cache ses propres fichiers (service worker), jamais les
réponses des serveurs Plex.

Rien de tout cela n'est envoyé au développeur.

## Effacer vos données

- **Se déconnecter** (Réglages → Compte) efface le jeton, la fiche du compte et le serveur
  retenu.
- **Tout réinitialiser** (Réglages → Avancé) remet les réglages par défaut.
- **Recherches récentes** : « Tout effacer » sur la page Recherche. Le réglage les empêche d'être
  gardées à l'avenir, mais n'efface pas celles déjà gardées.
- **Titres téléchargés** (bureau) : « Supprimer du disque » sur la page Hors ligne.
- **Tout d'un coup** : effacer les données du site dans le navigateur ; sur Android, Paramètres →
  Applications → MultiPlex → Stockage → Effacer les données ; sur ordinateur ou téléviseur,
  désinstaller l'application (sur ordinateur, son dossier de données et le dossier des
  téléchargements peuvent rester et se suppriment à la main).
- **Chez Plex** : vos données de compte, l'historique de visionnage et l'appareil « MultiPlex »
  se gèrent sur plex.tv (Paramètres → Appareils autorisés), selon
  [la politique de Plex](https://www.plex.tv/about/privacy-legal/).

## Contact

Une question ou un problème : ouvrez une demande sur
[github.com/Shibeon/MultiPlex/issues](https://github.com/Shibeon/MultiPlex/issues). Ne joignez
jamais de jeton, d'adresse de serveur ni de capture contenant des données personnelles.

Cette politique décrit le code de ce dépôt ; elle est mise à jour avec lui.
