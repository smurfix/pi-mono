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

if git merge-base --is-ancestor "$LATEST_TAG" HEAD; then
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

log "Installing coding-agent globally (sudo npm install -g ./packages/coding-agent)"
sudo npm install -g ./packages/coding-agent

# --- report ----------------------------------------------------------------

log "Done"
if command -v pi >/dev/null; then
  echo "pi --version: $(pi --version 2>&1)"
  echo "pi path:      $(command -v pi)"
fi
