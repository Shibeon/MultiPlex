# Relais « Regarder ensemble »

Petit serveur qui fait suivre les messages d'une séance « Regarder ensemble » entre les
participants. Il ne lit rien : les applications chiffrent tout de bout en bout, avec une clé qui
n'existe que dans l'invitation. Le relais ne voit ni les titres, ni les pseudos, ni les positions.

Aucune adresse de relais n'est écrite dans MultiPlex : chacun héberge le sien (ou utilise celui
d'un ami) et le renseigne dans **Réglages → Relais « Regarder ensemble »**. Les invités n'ont rien
à régler : l'invitation contient l'adresse du relais de l'hôte.

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
séance), `MAX_ROOMS` (500 séances en même temps).

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
et cliquer sur **Tester**.
