#!/bin/bash
#
# local_install.sh
#
# Install locally. Set GLOBAL_PREFIX.
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

log() { printf '\n=== %s ===\n' "$*"; }

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
test -v GLOBAL_PREFIX || GLOBAL_PREFIX=$(npm prefix -g)
test -v REAL_PREFIX || REAL_PREFIX=$GLOBAL_PREFIX
GLOBAL_NM="$GLOBAL_PREFIX/lib/node_modules"
REAL_NM="$REAL_PREFIX/lib/node_modules"
GLOBAL_BIN="$GLOBAL_PREFIX/bin"

log "Installing into $GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo rm -rf "$GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo mkdir -p "$GLOBAL_NM/@earendil-works"
sudo cp -a "$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent" \
          "$GLOBAL_NM/@earendil-works/pi-coding-agent"
sudo ln -sf "$REAL_NM/@earendil-works/pi-coding-agent/dist/cli.js" "$GLOBAL_BIN/pi"

# --- push ------------------------------------------------------------------

git push intern
