#!/usr/bin/env bash
# Install a resident wezard service. Auto-detects macOS (launchd) vs Linux (systemd --user).
#   install.sh [daemon|svr]   (default: daemon)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
HOME_DIR="$HOME"

COMPONENT="${1:-daemon}"
case "$COMPONENT" in
  daemon) LABEL="com.wezard.daemon"; UNIT="wezard.service";     ENTRY="dist/daemon/index.js" ;;
  svr)    LABEL="com.wezard.svr";    UNIT="wezard-svr.service"; ENTRY="dist/svr/index.js" ;;
  *) echo "usage: install.sh [daemon|svr]"; exit 2 ;;
esac

[[ -x "$NODE" ]] || { echo "node not found in PATH"; exit 1; }

# Pre-flight: the PreToolUse hook (hooks/pre-tool-use.sh) requires jq to parse
# the tool-call payload. Without it the hook silently degrades to a local `ask`
# and approval cards never reach WeCom. Install it here on fresh boxes.
if ! command -v jq >/dev/null 2>&1; then
  echo "[install] jq not found — attempting to install..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null 2>&1; sudo apt-get install -y jq
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y jq
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y jq
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add jq
  elif command -v brew >/dev/null 2>&1; then
    brew install jq
  fi
  if command -v jq >/dev/null 2>&1; then
    echo "[install] jq installed: $(command -v jq)"
  else
    echo "[install] ERROR: could not install jq automatically." >&2
    echo "  Install it manually, then re-run install:" >&2
    echo "    Debian/Ubuntu: sudo apt-get install -y jq" >&2
    echo "    RHEL/CentOS:   sudo yum install -y jq" >&2
    echo "    Alpine:        sudo apk add jq" >&2
    echo "    macOS:         brew install jq" >&2
    exit 1
  fi
fi

# Build if missing
if [[ ! -f "$REPO/$ENTRY" ]]; then
  echo "[install] building..."
  (cd "$REPO" && npm install --silent && npx tsc -p tsconfig.json)
fi

mkdir -p "$HOME_DIR/.wezard"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    LA_DIR="$HOME_DIR/Library/LaunchAgents"
    PLIST_DST="$LA_DIR/${LABEL}.plist"
    mkdir -p "$LA_DIR"
    sed \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__HOME__|$HOME_DIR|g" \
      "$REPO/launchd/${LABEL}.plist.template" > "$PLIST_DST"

    DOMAIN="gui/$(id -u)"
    # Modern bootstrap/bootout API. Falls back to legacy load -w. load -w stderr
    # is unreliable on recent macOS (sporadic "Failed to connect to bus: No
    # medium found" / "Load failed: 5: I/O error" while the plist is in fact
    # registered). Trust `launchctl list` for verification, not $?.
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns synchronously but unload is async — bootstrapping too soon
    # races into "Bootstrap failed: 5: I/O error". Poll until it's truly gone.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl list "$LABEL" >/dev/null 2>&1 || break
      sleep 0.2
    done
    launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>/dev/null \
      || launchctl load -w "$PLIST_DST" 2>/dev/null \
      || true
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

    if launchctl list "$LABEL" >/dev/null 2>&1; then
      echo "[install] launchd loaded: $PLIST_DST"
    else
      echo "[install] launchctl load failed — plist at $PLIST_DST not registered" >&2
      exit 1
    fi
    ;;
  Linux)
    UNIT_DIR="$HOME_DIR/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT_DST="$UNIT_DIR/$UNIT"
    sed \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__HOME__|$HOME_DIR|g" \
      "$REPO/systemd/${UNIT}.template" > "$UNIT_DST"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    echo "[install] systemd unit enabled: $UNIT_DST"
    ;;
  *)
    echo "unsupported OS: $OS"; exit 1 ;;
esac

echo "[install] $COMPONENT done. Logs at $HOME_DIR/.wezard/"
