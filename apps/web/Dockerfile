# Version web de MultiPlex, servie par nginx. À construire depuis la racine du dépôt :
#   docker build -f apps/web/Dockerfile -t multiplex-web .
# Image publiée : ghcr.io/shibeon/multiplex-web (voir apps/web/compose.yml).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
# Manifestes d'abord (couche d'installation réutilisée tant qu'ils ne changent pas). Tous ceux de
# l'espace de travail sont copiés pour que le fichier de verrouillage reste valide, mais seules les
# dépendances de la version web sont installées (ni Electron, ni Android).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json versions.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile --filter "@multiplex/web..."
COPY scripts/build-themes.mjs scripts/
COPY themes themes
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @multiplex/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
