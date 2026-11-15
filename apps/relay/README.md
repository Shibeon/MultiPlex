# Relais « Regarder ensemble »

Petit serveur qui fait suivre les messages d'une séance « Regarder ensemble » entre les
participants. Il ne lit rien : les applications chiffrent tout de bout en bout, avec une clé qui
n'existe que dans l'invitation. Le relais ne voit ni les titres, ni les pseudos, ni les positions
— sauf pour une séance que l'hôte a rendue visible par ses amis, dont il connaît la petite fiche
(voir [Séances visibles par vos amis](#séances-visibles-par-vos-amis)).

Aucune adresse de relais n'est écrite dans MultiPlex : chacun héberge le sien (ou utilise celui
d'un ami) et le renseigne dans **Réglages → Relais « Regarder ensemble »**. Les invités n'ont rien
à régler : l'invitation est un code court (`MPX-K7Q2-9XFD`), sans adresse, et leur application
retrouve le relais grâce au serveur Plex que l'hôte partage avec eux (voir
[Pour que vos amis trouvent le relais](#pour-que-vos-amis-trouvent-le-relais)).

## Pour que vos amis trouvent le relais

L'application d'un invité connaît les adresses publiques des serveurs Plex partagés avec lui :
plex.tv les lui donne, dont les **URL d'accès personnalisées** du serveur (Plex → Réglages →
Réseau → *URL d'accès personnalisées*, « publiées sur plex.tv pour la découverte du serveur »).
Sur chacun de ces noms (en `https`, hors adresses IP et `*.plex.direct`), elle essaie, en même
temps et quelques secondes au plus :

1. `https://<nom>:<port>/multiplex-relay`, puis `https://<nom>:<port>` ;
2. `https://<nom>/multiplex-relay`, puis `https://<nom>` (port 443).

et demande à chacun s'il connaît la séance (`GET …/rooms`). Le relais qui la connaît est le bon.
Il suffit donc que le relais soit joignable à l'une de ces adresses. Au choix :

- **Plex est déjà servi par votre proxy sous un nom** (par exemple `https://plex.exemple.fr`,
  inscrit dans les URL d'accès personnalisées) : ajoutez à cette règle un emplacement
  `/multiplex-relay/` vers le relais (exemple Nginx [plus bas](#sous-un-chemin-dun-nom-existant)),
  et indiquez `https://plex.exemple.fr/multiplex-relay` dans MultiPlex ;
- **le relais a déjà son adresse** (par exemple `https://relais.exemple.fr:1744`) : inscrivez cette
  adresse dans les URL d'accès personnalisées du serveur Plex (à la suite des autres, séparées par
  des virgules). Plex l'essaiera sans succès pour lui-même, ce qui ne gêne rien, et vos amis
  trouveront le relais. Pour revenir en arrière, il suffit de l'effacer.

MultiPlex n'écrit jamais rien sur votre serveur Plex : ce réglage, c'est vous qui le faites. Le
bouton **Tester** des réglages dit si le relais est assez récent, et à la création d'une séance
MultiPlex prévient quand vos amis ne le trouveront pas ; il propose alors de copier l'invitation
avec l'adresse (`MPX-K7Q2-9XFD@relais.exemple.fr`), qui marche dans tous les cas. Un invité peut
aussi indiquer le relais de l'hôte dans ses propres réglages : il est toujours essayé en premier.

## Sécurité des codes courts

Le code (8 signes parmi 31, ≈ 8,5 × 10¹¹ possibilités, ≈ 39,6 bits) donne, avec l'identifiant
du serveur Plex de l'hôte, la clé de chiffrement et le numéro de salle (PBKDF2-SHA256, 200 000
tours, puis HKDF). Le relais ne reçoit que le numéro de salle. Pour borner les essais au hasard,
il compte chaque salle demandée et chaque entrée dans une salle : 30 par minute et par adresse
(60 d'avance), et 10 salles inexistantes par seconde pour tout le monde ; au-delà il répond 429.
Une salle ferme d'elle-même au bout de `ROOM_TTL_HOURS` (12 h). Derrière un proxy inverse,
l'adresse du client est la dernière de `X-Forwarded-For` quand la connexion vient d'une adresse
privée (`TRUST_PROXY=0` pour ne jamais s'y fier, `TRUST_PROXY=1` pour toujours s'y fier).

## Séances visibles par vos amis

Avec `PLEX_URL`, vos amis qui ont accès à votre serveur Plex voient vos séances dans MultiPlex
(Activité, et la fenêtre « Regarder ensemble ») et les rejoignent d'un geste, sans code. Les
autres continuent d'utiliser l'invitation par code, qui ne change pas.

**Qui voit quoi.** À la création d'une séance, l'interrupteur « Visible par mes amis » est allumé
par défaut ; on peut l'éteindre pour cette séance, ou pour toutes dans **Réglages**. Une séance
privée n'est jamais annoncée au relais : elle n'apparaît dans aucune liste. Une séance visible
publie une fiche, et rien d'autre : le **pseudo de l'hôte**, le **titre** (et l'épisode), la
**position** et lecture/pause, plus le **nombre de participants** que le relais compte lui-même.
Ni appareil, ni adresse, ni flux, ni qualité, ni sous-titres. Le relais retire la fiche quand
l'hôte ferme la séance, la rend privée ou se déconnecte.

**Une séance, un hôte.** Le premier qui annonce une séance en devient l'hôte auprès du relais :
il présente une *preuve d'hôte* tirée du secret de la séance (connue de ses seuls membres, et qui
ne donne ni la clé ni le secret), dont le relais garde l'empreinte. Tant qu'il est là, personne
d'autre ne peut annoncer la séance, la modifier, la retirer, ni recevoir les demandes d'entrée. S'il
la rend privée, elle le reste : personne d'autre ne peut la relancer. S'il part ou passe la main,
la fiche disparaît, et un membre de la séance (qui a la même preuve) peut la reprendre ; un
utilisateur qui ne connaît que le numéro de salle listé, lui, ne le peut pas.

**Le pseudo n'est pas vérifié.** Le relais vérifie l'*accès* au serveur, pas l'identité (voir
ci-dessous) : le pseudo affiché sur une fiche est celui que l'hôte déclare. Un utilisateur de
votre serveur pourrait donc ouvrir une séance sous le pseudo d'un autre. Il n'en tire rien de plus
que ce qu'il a déjà (il ne voit que les séances listées de ce serveur, et n'entre dans aucune
séance sans que son hôte lui remette la clé), mais n'utilisez pas le pseudo comme une preuve.

**Comment le relais vérifie l'accès.** L'application d'un ami envoie `POST …/friends` avec, dans
le corps (jamais dans l'adresse), le jeton que *ce serveur Plex-là* lui a attribué : le
`accessToken` du partage que plex.tv donne pour ce serveur. Le relais demande à votre Plex
`GET {PLEX_URL}/library/sections` avec ce jeton : 200, l'ami a accès ; 401 ou 403, il n'a pas
accès et reçoit 403. C'est exactement la règle de Plex lui-même (un jeton d'un autre serveur, ou
inventé, est refusé avec 401). Le relais ne cherche pas *qui* est l'ami : Plex ne documente aucun
point d'accès qui nomme l'utilisateur derrière un jeton de serveur, et l'accès suffit.

- **Jamais le jeton du compte plex.tv.** Il ouvre tout le compte ; il n'est jamais envoyé au
  relais. Quand le jeton du serveur est le même que celui du compte (c'est le cas de l'hôte sur
  son propre serveur), l'application demande à son Plex un jeton délégué
  (`/security/token?type=delegation&scope=all`, le jeton temporaire que Plex prévoit pour les
  appareils tiers) et envoie celui-là.
- **Seulement au relais de ce serveur.** L'application n'envoie le jeton d'un serveur qu'à un relais
  trouvé aux adresses publiques de ce même serveur (voir
  [plus haut](#pour-que-vos-amis-trouvent-le-relais)), et seulement après avoir lu, sans jeton,
  l'identifiant du Plex de ce relais (`server` dans la réponse à `GET …/rooms`, le même que le
  `/identity` public de Plex) : s'il n'est pas celui du serveur, aucun jeton ne part. Un relais
  injoignable, sans liste ou d'un autre serveur est redemandé de plus en plus rarement (1 minute,
  puis le double à chaque fois, jusqu'à 1 heure).
- **Contre-épreuve.** Au démarrage, puis toutes les 10 minutes, le relais essaie un jeton tiré au
  hasard. Si votre Plex l'accepte (réglage « Adresses autorisées sans authentification » qui
  couvre le relais), la liste est désactivée (`503`) plutôt que d'ouvrir vos séances à tous :
  donnez au relais une adresse que Plex ne dispense pas d'authentification.
- **Ce que le relais garde.** Aucun jeton : seulement leur empreinte SHA-256 avec le verdict
  (5 minutes si l'accès est accordé, 1 minute sinon, 2 000 au plus). Une vérification nouvelle
  coûte d'abord à l'adresse (5 d'avance, puis une toutes les 30 secondes), puis à la réserve
  commune (2 par seconde, 30 d'avance) : quelques adresses ne peuvent pas priver les autres de
  vérification. Les adresses IPv6 sont comptées par préfixe /64 (qu'un abonné peut faire tourner
  à volonté), pour toutes les limites du relais. Chaque demande de liste coûte aussi un jeton à
  l'adresse, comme les autres requêtes. Beaucoup d'adresses IPv4 différentes pourraient encore
  épuiser la réserve commune : la liste répond alors `429` un moment, sans rien ouvrir.

**Comment l'ami entre sans code.** Une réponse positive donne la liste et un *ticket* (aléatoire,
valable 2 minutes). L'ami ouvre la salle d'une séance listée (`WS /r/<salle>`) et, dans son premier
message (jamais dans l'adresse, que les proxys journalisent), présente le ticket avec une clé
publique éphémère (ECDH P-256). Le relais ne fait suivre la demande qu'à l'hôte d'une séance listée,
et un ticket ne sert qu'une fois par salle ; sans ticket valable, c'est refusé. L'application de
l'hôte renvoie le secret de la séance chiffré pour cet ami seul (HKDF-SHA256 puis AES-GCM), avec la
position courante, et l'ami vérifie que ce secret donne bien la salle listée. L'ami arrive donc à
l'endroit où en est la séance, synchronisé tout de suite.

**Un flot de demandes ne fait pas taire l'hôte.** Les messages adressés au relais ont leur propre
budget (20 par 10 secondes et par connexion), à part de celui des messages de la séance (40 par
10 secondes). Le relais ne fait suivre à l'hôte que quelques demandes d'entrée (3 d'avance, puis une
toutes les 5 secondes par salle) ; l'hôte répond une seule fois à chaque demandeur, et 5 fois au
plus par 10 secondes. L'hôte ne réannonce pas sa fiche à chaque geste : seulement quand elle change
(titre, lecture/pause), au plus toutes les 5 secondes, et toutes les 15 secondes pour la position.
Quand le relais ne peut pas lister la séance (relais ancien, sans `PLEX_URL`, introuvable par les
amis), l'application l'indique une fois et réessaie de plus en plus rarement (1 minute, doublée
jusqu'à 30 minutes).

**Ce qu'il faut savoir.** Le relais est opéré par le propriétaire du serveur Plex, qui voit déjà
dans Plex qui regarde quoi : la fiche d'une séance visible ne lui apprend rien de plus. Les
messages de la séance restent chiffrés de bout en bout. En revanche, pour l'entrée sans code, le
relais choisit qui reçoit la demande de clé et à qui revient la réponse : un relais modifié
exprès pourrait s'interposer et lire *cette* séance. On fait confiance au relais pour décider qui
a accès ; une séance privée ou une invitation par code n'en dépend pas.

## Protocole de synchronisation

Messages chiffrés (binaires, AES-GCM, `iv` de 12 octets suivi du chiffré d'un JSON), suivis tels
quels par le relais :

```text
tick   {t:'tick', id, name, thumb?, host, playing, time, item?, live, c, by, vis?, hc?, want?}
intent {t:'intent', id, name, action:'play'|'pause'|'seek', playing, time, item?, c}
bye    {t:'bye', id}
```

- Chacun envoie un `tick` toutes les 3 secondes ; un membre muet depuis 12 secondes est parti.
  `want: true` (à l'arrivée ou au retour) demande aux autres un `tick` immédiat (une fois par
  seconde au plus).
- **Hôte et participants** peuvent lire, mettre en pause, avancer, reculer et passer : chaque geste
  devient un `intent` envoyé à tous. Seuls la position et lecture/pause circulent ; le volume, les
  sous-titres, l'audio et la qualité de chacun ne quittent jamais son appareil.
- **Ordre** : chaque commande porte une horloge de Lamport `c` et son auteur `by` (l'`id` de
  l'intent). La plus récente gagne : `c` plus grand, puis `by` plus grand à égalité — tout le monde
  converge vers la même, quel que soit l'ordre d'arrivée. Un `intent` sans `c` (version
  précédente) est daté à son arrivée.
- **Pertes et reconnexions** : le `tick` porte la dernière commande vue (`c`, `by`). Un `tick` plus
  récent que la mienne venant d'un membre présent est appliqué tel quel (je rattrape une commande
  perdue ou manquée) ; à égalité, je suis la position de l'hôte en douceur (dérive des horloges) ;
  plus ancien, il est ignoré. Un geste fait hors ligne n'est pas envoyé : au retour, la séance
  l'emporte.
- `vis` (de l'hôte) dit que la séance est visible : à un changement d'hôte, le nouveau la
  réannonce.
- **Changement d'hôte** : l'hôte muet depuis 12 secondes est remplacé par le participant au plus
  petit `id`, qui note `hc` (son horloge de Lamport + 1 ; l'hôte d'origine a `hc: 0`). Si l'ancien
  hôte revient, il y a deux hôtes : celui dont la prise de main est la plus récente (`hc` plus grand,
  puis `id` plus grand) reste ; l'autre redevient participant et libère l'annonce (`release`).

Messages au relais (texte JSON, jamais renvoyés tels quels) :

```text
→ {t:'announce', ticket?, proof, card}  hôte : publier ou rafraîchir la fiche (ticket la 1re fois)
→ {t:'unlist'}                          hôte : retirer la fiche ; la séance devient privée
→ {t:'release'}                         hôte : céder l'annonce (départ, passage de main)
→ {t:'key-request', ticket, pub}        ami : demander la clé (ticket : une fois par salle)
→ {t:'key-grant', peer, pub, box}       hôte : réponse pour cet ami seul
← {t:'announced'}
← {t:'error', error:'ticket'|'proof'|'owner'|'private'|'card'|'unavailable'|'nohost'|'busy'}
← {t:'key-request', peer, pub}          à l'hôte
← {t:'key-grant', pub, box}             à l'ami qui a demandé
```

`proof` : 22 caractères base64url, tirés du secret de la séance par HKDF-SHA256 (info
`multiplex-together-owner`, à côté de `multiplex-together-room` et `multiplex-together-key`).

`POST …/friends` (corps `{"token":"…"}`, en `text/plain`) répond `200
{multiplex:'relay', server, ticket, ttl:120, sessions:[{room, card, count, age}]}`, `403` (pas
d'accès), `404 {friends:false}` (pas de `PLEX_URL`), `429` (trop de demandes) ou `503`
(Plex injoignable ou trop permissif). `GET /rooms` indique `friends: true|false` et, quand il
liste, `server` (identifiant du Plex du relais), à comparer avant d'envoyer un jeton.

## Installation dans une stack (le plus simple)

L'image est publiée sur `ghcr.io/shibeon/multiplex-relay` (NAS Intel/AMD et ARM). Copier le
contenu de [`compose.yml`](compose.yml) dans une nouvelle stack (Portainer, Dockge, Container
Manager…) et la déployer : rien à compiler, rien à copier sur le NAS. Mise à jour : « Pull and
redeploy » (ou `docker compose pull && docker compose up -d`).

## Installation avec Docker, en compilant

Copier ce dossier sur le NAS (ou le serveur), puis :

```sh
docker compose up -d --build
```

Le relais écoute sur le port **8787**. Vérification : `http://<adresse-du-nas>:8787/health` répond `ok`.

Réglages possibles (variables d'environnement) : `PORT` (8787), `MAX_PEERS` (16 personnes par
séance), `MAX_ROOMS` (500 séances en même temps), `ROOM_TTL_HOURS` (12 : durée de vie d'une
séance), `TRUST_PROXY` (voir [Sécurité](#sécurité-des-codes-courts)), `PLEX_URL` (adresse de
votre serveur Plex vue depuis le relais, par exemple `http://192.168.1.10:32400` : active les
[séances visibles par vos amis](#séances-visibles-par-vos-amis) ; sans elle, seules les
invitations par code marchent).

Mise à jour : les invitations courtes demandent un relais récent (qui répond à `/rooms`) ;
redéployez-le (« Pull and redeploy », ou `docker compose pull && docker compose up -d`).

## Le rendre joignable depuis Internet (en HTTPS)

Vos amis sont hors de chez vous : le relais doit être accessible de l'extérieur, en HTTPS (obligatoire
pour la version web et les téléviseurs). Au choix :

1. **Proxy inverse du NAS** (le plus simple sur Synology / QNAP) : créer une règle
   `https://relais.votre-nom.synology.me` → `http://localhost:8787`, en activant **WebSocket**
   (Synology : en-têtes personnalisés → « Créer → WebSocket »), avec un certificat Let's Encrypt.
   Le port 443 doit être redirigé vers le NAS sur la box.
2. **Tunnel** (rien à ouvrir sur la box) : Cloudflare Tunnel ou Tailscale Funnel vers
   `http://localhost:8787`.
3. **Votre propre proxy** (Caddy, Nginx, Traefik) avec votre nom de domaine.

### Sous un chemin d'un nom existant

Le relais accepte d'être servi sous un chemin (`https://mon-nom.myasustor.com/multiplex-relay`) :
le proxy transmet l'adresse telle quelle, sans retirer le préfixe. Exemple Nginx (ou « Advanced »
de Nginx Proxy Manager) :

```nginx
location /multiplex-relay/ {
    proxy_pass http://192.168.1.10:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
}
```

### Sur un port dédié d'un nom existant

Si votre proxy inverse sert déjà votre nom, vous pouvez lui réserver un port (par exemple
`https://mon-nom.myasustor.com:1744`) : règle `https://mon-nom.myasustor.com:1744` →
`http://<adresse-du-nas>:8787`, **WebSocket activé**, et le port 1744 redirigé (TCP) vers le proxy
sur la box. Le relais, lui, reste sur 8787 : ne lui donnez pas le même port que le proxy.

### NAS sans proxy inverse intégré (Asustor…) : relais + HTTPS en un seul fichier

`docker-compose.https.yml` lance le relais **et** Caddy, qui obtient et renouvelle seul le
certificat HTTPS. Il faut :

- un nom qui pointe vers votre box (Asustor : ADM → **EZ-Connect** → **DDNS**, par exemple
  `mon-nom.myasustor.com`) ;
- les ports **80** et **443** de la box redirigés (TCP) vers l'adresse locale du NAS, et libres
  sur le NAS (ADM utilise 8000/8001 par défaut ; attention à l'app « Web Center »).

```sh
cp .env.example .env        # puis y mettre RELAY_DOMAIN=mon-nom.myasustor.com
docker compose -f docker-compose.https.yml up -d
```

Vérification : `https://mon-nom.myasustor.com/health` répond `ok` (le premier démarrage prend
une minute, le temps d'obtenir le certificat).

Puis, dans MultiPlex : **Réglages → Relais « Regarder ensemble »**, saisir `https://relais.votre-nom…`
et cliquer sur **Tester**. Pour que vos amis le trouvent sans adresse dans l'invitation, voir
[Pour que vos amis trouvent le relais](#pour-que-vos-amis-trouvent-le-relais).
