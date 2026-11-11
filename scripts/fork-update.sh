#!/usr/bin/env bash
# Keeps a personal fork current: rebases it onto the newest upstream stable release, rebuilds the
# desktop app and swaps it into /Applications. The sidebar pill calls this, and it also runs by hand.
#
#   scripts/fork-update.sh check     print the newest upstream release the fork is not based on
#   scripts/fork-update.sh run       rebase, rebuild and install (--force rebuilds when current, --no-install stops after the build)
#   scripts/fork-update.sh install   install the DMG already built in release/
#
# Progress goes to $STATE_DIR/status.json (read by the app) and the log to $STATE_DIR/update.log.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${T3_FORK_UPDATE_DIR:-$HOME/.t3/fork-update}"
STATUS_FILE="$STATE_DIR/status.json"
LOG_FILE="$STATE_DIR/update.log"
UPSTREAM_REMOTE="${T3_FORK_UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${T3_FORK_REMOTE:-fork}"
APP_NAME="T3 Code (Beta)"
APP_PATH="/Applications/$APP_NAME.app"
QUIT_TIMEOUT_SECONDS=120

mkdir -p "$STATE_DIR"
cd "$REPO"

current_step="Starting"

write_status() {
  local phase="$1" step="$2"
  printf '{"phase":"%s","step":"%s","pid":%s}\n' "$phase" "$step" "$$" >"$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

begin_step() {
  current_step="$1"
  echo "==> $current_step"
  write_status running "$current_step"
}

# Stable releases only: nightly, preview and PR builds are tagged too.
latest_release_tag() {
  git tag --list 'v[0-9]*' | grep -v -E -- '-(nightly|preview|pr)' | sort -V | tail -1
}

fetch_releases() {
  git fetch --quiet "$UPSTREAM_REMOTE" 'refs/tags/v*:refs/tags/v*'
}

# Empty when HEAD already contains the newest release.
pending_release_tag() {
  local tag
  tag="$(latest_release_tag)"
  if [[ -n "$tag" ]] && ! git merge-base --is-ancestor "$tag" HEAD; then
    echo "$tag"
  fi
}

fail() {
  echo "!! Failed during: $current_step"
  if [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]; then
    git rebase --abort || true
  fi
  write_status failed "$current_step"
  exit 1
}

install_built_app() {
  local dmg stage mount
  dmg="$(ls -t "$REPO"/release/*.dmg 2>/dev/null | head -1 || true)"
  if [[ -z "$dmg" ]]; then
    echo "No DMG found in $REPO/release"
    return 1
  fi

  stage="$(mktemp -d)"
  mount="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$dmg"
  ditto "$mount/$APP_NAME.app" "$stage/$APP_NAME.app"
  hdiutil detach -quiet "$mount"

  osascript -e "tell application \"$APP_NAME\" to quit" || true
  local waited=0
  while pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null; do
    if ((waited >= QUIT_TIMEOUT_SECONDS)); then
      echo "$APP_NAME did not quit in ${QUIT_TIMEOUT_SECONDS}s. The new build is staged in $stage"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # The previous app stays in the state dir so a bad build can be rolled back by hand.
  mv "$APP_PATH" "$STATE_DIR/previous.app.$$" 2>/dev/null || true
  ditto "$stage/$APP_NAME.app" "$APP_PATH"
  open "$APP_PATH"
}

command="${1:-}"
case "$command" in
check)
  fetch_releases
  pending_release_tag
  ;;
install)
  exec >>"$LOG_FILE" 2>&1
  trap fail ERR
  begin_step "Restarting into the new version"
  install_built_app
  write_status idle ""
  ;;
run)
  exec >>"$LOG_FILE" 2>&1
  trap fail ERR
  echo
  echo "=== Fork update started $(date) ==="

  begin_step "Checking upstream releases"
  fetch_releases
  tag="$(pending_release_tag)"
  if [[ -z "$tag" && " $* " != *" --force "* ]]; then
    echo "Already based on the newest release"
    write_status idle ""
    exit 0
  fi

  if [[ -n "$tag" ]]; then
    begin_step "Rebasing onto $tag"
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "The working tree has uncommitted changes"
      false
    fi
    git rebase "$tag"
  fi

  begin_step "Installing dependencies"
  pnpm install --frozen-lockfile

  begin_step "Building the app"
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env" 2>/dev/null || true
  ./node_modules/.bin/vp run dist:desktop:dmg

  begin_step "Saving the rebased branch"
  git push --force-with-lease "$FORK_REMOTE" HEAD || echo "Push failed, the build is still installed locally"

  if [[ " $* " == *" --no-install "* ]]; then
    echo "Built $(ls -t "$REPO"/release/*.dmg | head -1). Run '$0 install' to swap it in."
    write_status idle ""
    exit 0
  fi

  begin_step "Restarting into the new version"
  install_built_app
  write_status idle ""
  echo "=== Fork update finished $(date) ==="
  ;;
*)
  echo "Usage: $0 check | run [--force] [--no-install] | install" >&2
  exit 2
  ;;
esac
