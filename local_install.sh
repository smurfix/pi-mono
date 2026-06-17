#!/bin/bash
#
# local_install.sh
#
# Merge the latest upstream release tag into the current branch, rebuild
# the workspace, and install the resulting coding-agent globally.
#
# Designed for a fork that tracks upstream via the "origin" remote:
#
#   origin   git@github.com:badlogic/pi-mono.git   (upstream)
#   <fork>   git@github.com:<you>/pi-mono.git      (your fork)
#
# Override with UPSTREAM_REMOTE=<name> if your layout differs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
TAG_PATTERN="${TAG_PATTERN:-v*}"

log() { printf '\n=== %s ===\n' "$*"; }

# --- sanity checks --------------------------------------------------------

if ! command -v git >/dev/null; then
  echo "git not found" >&2; exit 1
fi
if ! command -v npm >/dev/null; then
  echo "npm not found" >&2; exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not inside a git work tree" >&2; exit 1
fi
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "remote '$UPSTREAM_REMOTE' does not exist" >&2; exit 1
fi

CURRENT_BRANCH=$(git symbolic-ref --quiet --short HEAD || true)
if [ -z "$CURRENT_BRANCH" ]; then
  echo "detached HEAD; check out a branch first" >&2; exit 1
fi

# Refuse to run with a dirty work tree so that a merge conflict (or biome
# auto-fixes during `npm run check`) cannot get tangled up with pre-existing
# local edits.
git restore \
   package-lock.json \
   packages/ai/src/models.generated.ts \
   packages/coding-agent/npm-shrinkwrap.json \
   #
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree has uncommitted changes; commit or stash first" >&2
  git status --short >&2
  exit 1
fi

# --- find and merge the latest upstream tag -------------------------------

log "Fetching tags from '$UPSTREAM_REMOTE'"
git fetch --tags --prune "$UPSTREAM_REMOTE"

LATEST_TAG=$(git tag --list "$TAG_PATTERN" --sort=-v:refname | head -n1)
if [ -z "$LATEST_TAG" ]; then
  echo "no tags matching '$TAG_PATTERN' found" >&2; exit 1
fi
echo "Latest tag: $LATEST_TAG"
echo "Current branch: $CURRENT_BRANCH"

if false # git merge-base --is-ancestor "$LATEST_TAG" HEAD
then
  if [ "${FORCE:-0}" = "1" ]; then
    echo "$LATEST_TAG already merged into $CURRENT_BRANCH; continuing because FORCE=1."
  else
    echo "$LATEST_TAG already merged into $CURRENT_BRANCH; nothing to do."
    echo "Set FORCE=1 to rebuild and reinstall anyway."
    exit 0
  fi
else
  log "Merging $LATEST_TAG into $CURRENT_BRANCH"
  if ! git merge --no-edit --no-ff "$LATEST_TAG"; then
    echo >&2
    echo "merge conflict while merging $LATEST_TAG into $CURRENT_BRANCH" >&2
    echo "resolve conflicts, commit, then rerun this script" >&2
    exit 1
  fi
fi

# --- hydrate workspace ----------------------------------------------------

# Per AGENTS.md: never run lifecycle scripts during dep hydration. The build
# step below explicitly invokes the scripts we actually want to run.
log "Installing workspace dependencies (npm install --ignore-scripts)"
npm install --ignore-scripts

log "Rebuilding shrinkwrap"
npm run shrinkwrap:coding-agent

# --- build and verify ------------------------------------------------------

log "Building all packages (npm run build)"
npm run build

log "Running checks (npm run check)"
npm run check

# The build regenerates models.generated.ts / image-models.generated.ts.
# Surface that so the user can decide whether to commit the deltas.
if ! git diff --quiet -- packages/ai/src/models.generated.ts \
                         packages/ai/src/image-models.generated.ts; then
  echo
  echo "note: regenerated model lists differ from the committed copies:"
  git --no-pager diff --stat -- packages/ai/src/models.generated.ts \
                                packages/ai/src/image-models.generated.ts
fi

# --- global install --------------------------------------------------------
# `npm install -g ./packages/coding-agent` would resolve workspace sibling
# deps (@earendil-works/pi-ai, pi-tui, pi-agent-core) from the npm registry
# instead of using the locally-built copies. We pack each workspace package
# into a tarball, install them together so npm deduplicates correctly, then
# copy the self-contained tree into the global npm prefix.

log "Packing workspace packages for global install"
INSTALL_STAGING=$(mktemp -d)
trap 'rm -rf "$INSTALL_STAGING"' EXIT

TARBALL_DIR="$INSTALL_STAGING/tarballs"
mkdir -p "$TARBALL_DIR"

for pkg_dir in packages/tui packages/ai packages/agent packages/coding-agent; do
  (cd "$pkg_dir" && npm pack --pack-destination "$TARBALL_DIR" >/dev/null 2>&1)
done

INSTALL_DIR="$INSTALL_STAGING/global"
mkdir -p "$INSTALL_DIR"

# Relative path from install dir to tarball dir (required by file: specifiers).
REL_TB=$(python3 -c "import os.path; print(os.path.relpath('$TARBALL_DIR', '$INSTALL_DIR'))")

# Build dependency map: list all tarballs as file: deps so npm deduplicates
# workspace packages correctly instead of fetching from the registry.
DEPS=""
for tb in "$TARBALL_DIR"/*.tgz; do
  PKG_NAME=$(tar -xOf "$tb" package/package.json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
  TB_FILE=$(basename "$tb")
  [ -n "$DEPS" ] && DEPS="$DEPS,"
  DEPS=$(printf '%s\n    "%s": "file:%s/%s"' "$DEPS" "$PKG_NAME" "$REL_TB" "$TB_FILE")
done

cat > "$INSTALL_DIR/package.json" <<ENDJSON
{
  "private": true,
  "dependencies": {$DEPS
  }
}
ENDJSON

(cd "$INSTALL_DIR" && npm install --omit=dev --ignore-scripts)

# Verify the pi binary exists in the staging install.
if [ ! -f "$INSTALL_DIR/node_modules/.bin/pi" ]; then
  echo "pi binary not found in staging install" >&2; exit 1
fi

# The staging install hoists workspace packages to
# $INSTALL_DIR/node_modules/@earendil-works/*. The global prefix expects a
# self-contained package at lib/node_modules/@earendil-works/pi-coding-agent
# with all deps nested underneath.  Move the hoisted workspace siblings into
# pi-coding-agent/node_modules/ so the global layout is self-contained.
CA_NM="$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent/node_modules"
mkdir -p "$CA_NM/@earendil-works"

for ws_pkg in pi-ai pi-tui pi-agent-core; do
  SRC="$INSTALL_DIR/node_modules/@earendil-works/$ws_pkg"
  if [ -d "$SRC" ]; then
    mv "$SRC" "$CA_NM/@earendil-works/$ws_pkg"
  fi
done

# Also move non-scoped hoisted deps that coding-agent needs.
for dep in "$INSTALL_DIR/node_modules/"*; do
  dep_name=$(basename "$dep")
  case "$dep_name" in
    .bin|.package-lock.json|@earendil-works) continue ;;
  esac
  [ ! -e "$CA_NM/$dep_name" ] && mv "$dep" "$CA_NM/$dep_name"
done

# Now pi-coding-agent is self-contained.  Copy it into the global prefix.
GLOBAL_PREFIX=$(npm prefix -g)
GLOBAL_NM="$GLOBAL_PREFIX/lib/node_modules"
GLOBAL_BIN="$GLOBAL_PREFIX/bin"

log "Installing into $GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo rm -rf "$GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo mkdir -p "$GLOBAL_NM/@earendil-works"
sudo cp -a "$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent" \
          "$GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo ln -sf "$GLOBAL_NM/@earendil-works/pi-coding-agent/dist/cli.js" "$GLOBAL_BIN/pi"

# --- push ------------------------------------------------------------------

git push intern
