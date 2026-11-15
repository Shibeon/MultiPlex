# Relais « Regarder ensemble »

Petit serveur qui fait suivre les messages d'une séance « Regarder ensemble » entre les
participants. Il ne lit rien : les applications chiffrent tout de bout en bout, avec une clé qui
n'existe que dans l'invitation. Le relais ne voit ni les titres, ni les pseudos, ni les positions.

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
séance), `TRUST_PROXY` (voir [Sécurité](#sécurité-des-codes-courts)).

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
