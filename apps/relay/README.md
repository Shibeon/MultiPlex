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
  [plus haut](#pour-que-vos-amis-trouvent-le-relais)), et ignore un relais dont le Plex n'a pas le
  même identifiant (`GET /identity`).
- **Contre-épreuve.** Au démarrage, puis toutes les 10 minutes, le relais essaie un jeton tiré au
  hasard. Si votre Plex l'accepte (réglage « Adresses autorisées sans authentification » qui
  couvre le relais), la liste est désactivée (`503`) plutôt que d'ouvrir vos séances à tous :
  donnez au relais une adresse que Plex ne dispense pas d'authentification.
- **Ce que le relais garde.** Aucun jeton : seulement leur empreinte SHA-256 avec le verdict
  (5 minutes si l'accès est accordé, 1 minute sinon, 2 000 au plus). Les vérifications nouvelles
  sont bornées pour tout le monde (2 par seconde, 30 d'avance) et chaque demande de liste coûte un
  jeton à l'adresse IP, comme les autres requêtes.

**Comment l'ami entre sans code.** Une réponse positive donne la liste et un *ticket* (aléatoire,
valable 2 minutes). Avec lui, l'ami entre dans la salle d'une séance listée (`WS /r/<salle>?ticket=…`) ;
sans ticket valable, ou pour une salle non listée, c'est 403. Il n'a toujours pas la clé : il
envoie une clé publique éphémère (ECDH P-256), l'application de l'hôte lui renvoie le secret de la
séance chiffré pour lui seul (HKDF-SHA256 puis AES-GCM), avec la position courante, et l'ami
vérifie que ce secret donne bien la salle listée. L'ami arrive donc à l'endroit où en est la
séance, synchronisé tout de suite.

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
tick   {t:'tick', id, name, thumb?, host, playing, time, item?, live, c, by, vis?, want?}
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

Messages au relais (texte JSON, jamais renvoyés tels quels) :

```text
→ {t:'announce', ticket?, card}      hôte : publier ou rafraîchir la fiche (toutes les 15 s)
→ {t:'unlist'}                       hôte : retirer la fiche
→ {t:'key-request', pub}             ami entré avec un ticket : demander la clé
→ {t:'key-grant', peer, pub, box}    hôte : réponse pour cet ami seul
← {t:'announced'} | {t:'error', error:'ticket'|'card'|'unavailable'|'nohost'}
← {t:'key-request', peer, pub}       à l'hôte
← {t:'key-grant', pub, box}          à l'ami qui a demandé
```

`POST …/friends` (corps `{"token":"…"}`, en `text/plain`) répond `200
{multiplex:'relay', server, ticket, ttl:120, sessions:[{room, card, count, age}]}`, `403` (pas
d'accès), `404 {friends:false}` (pas de `PLEX_URL`), `429` (trop de demandes) ou `503`
(Plex injoignable ou trop permissif). `GET /rooms` indique `friends: true|false`.

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
