#!/usr/bin/env bash
# Publie la version en cours d'une plateforme (hors bureau) dans le dépôt public des
# versions, avec ses nouveautés, puis étiquette le commit publié dans ce dépôt-ci.
#
#   scripts/publish-release.sh <web|android|tv> <fichiers…>
#
# GH_TOKEN doit pouvoir écrire dans le dépôt des versions (secret RELEASES_TOKEN).
# Ces versions ne sont jamais marquées « Latest » : la mise à jour automatique du
# bureau lit la version « Latest », qui doit rester celle du bureau.
set -euo pipefail

platform=$1
shift
repo=$(node -p "const p = require('./apps/desktop/package.json').build.publish[0]; p.owner + '/' + p.repo")
version=$(node scripts/versions.mjs get "$platform")
tag="$platform-v$version"
notes=$(mktemp)
node scripts/versions.mjs notes "$platform" "$notes"

case $platform in
  web) title="Web $version" ;;
  android) title="Android $version" ;;
  tv) title="TV $version" ;;
  *) echo "Plateforme inconnue : $platform" >&2; exit 1 ;;
esac

# Brouillon d'abord, rendu public une fois tous les fichiers déposés : un envoi
# interrompu laisse un brouillon, que le build suivant reprend.
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release upload "$tag" "$@" --repo "$repo" --clobber
  gh release edit "$tag" --repo "$repo" --notes-file "$notes"
else
  gh release create "$tag" "$@" --repo "$repo" --draft --title "$title" --notes-file "$notes"
fi
gh release edit "$tag" --repo "$repo" --draft=false --latest=false
echo "$title publiée ($tag)."

if ! git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  git tag "$tag" "${GITHUB_SHA:-HEAD}"
  git push origin "$tag"
fi
