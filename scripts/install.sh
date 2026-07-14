#!/usr/bin/env bash
# Install resident daemon. Auto-detects macOS (launchd) vs Linux (systemd --user).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
HOME_DIR="$HOME"
LABEL="com.weclaude.daemon"

[[ -x "$NODE" ]] || { echo "node not found in PATH"; exit 1; }

# jq is the PreToolUse hook's fast path for JSON. The hook now degrades to node
# (a Claude Code hard dep) when jq is absent, so this is best-effort only — try
# the common package managers, but never fail the install if none is available.
if ! command -v jq >/dev/null 2>&1; then
  echo "[install] jq not found — attempting install (hook falls back to node if this fails)"
  if   command -v apt-get >/dev/null 2>&1; then (sudo apt-get install -y jq || apt-get install -y jq) >/dev/null 2>&1 || true
  elif command -v dnf     >/dev/null 2>&1; then (sudo dnf install -y jq || dnf install -y jq) >/dev/null 2>&1 || true
  elif command -v yum     >/dev/null 2>&1; then (sudo yum install -y jq || yum install -y jq) >/dev/null 2>&1 || true
  elif command -v apk     >/dev/null 2>&1; then (sudo apk add jq || apk add jq) >/dev/null 2>&1 || true
  elif command -v brew    >/dev/null 2>&1; then brew install jq >/dev/null 2>&1 || true
  fi
  command -v jq >/dev/null 2>&1 \
    && echo "[install] jq installed" \
    || echo "[install] jq still missing — hook will use node fallback (fine)"
fi

# Build if missing
if [[ ! -f "$REPO/dist/daemon/index.js" ]]; then
  echo "[install] building..."
  (cd "$REPO" && npm install --silent && npx tsc -p tsconfig.json)
fi

mkdir -p "$HOME_DIR/.weclaude"

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
    # systemd --user needs a live user session bus. Containers (PID 1 not
    # systemd, no XDG_RUNTIME_DIR) don't have one — `systemctl --user` then dies
    # with "Failed to connect to bus". Detect that and fall back to a setsid
    # restart-loop supervisor instead of aborting the whole install.
    if systemctl --user show-environment >/dev/null 2>&1; then
      UNIT_DIR="$HOME_DIR/.config/systemd/user"
      mkdir -p "$UNIT_DIR"
      UNIT_DST="$UNIT_DIR/weclaude.service"
      sed \
        -e "s|__NODE__|$NODE|g" \
        -e "s|__REPO__|$REPO|g" \
        -e "s|__HOME__|$HOME_DIR|g" \
        "$REPO/systemd/weclaude.service.template" > "$UNIT_DST"
      systemctl --user daemon-reload
      systemctl --user enable --now weclaude.service
      echo "[install] systemd unit enabled: $UNIT_DST"
    else
      echo "[install] no systemd --user session — using restart-loop supervisor" >&2
      SUP="$HOME_DIR/.weclaude/daemonctl.sh"
      mkdir -p "$HOME_DIR/.weclaude"
      cp "$REPO/scripts/daemonctl.sh" "$SUP"
      chmod +x "$SUP"
      "$SUP" restart || true
      echo "[install] daemon supervised via $SUP (add '$SUP start' to your shell profile / container entrypoint for reboot persistence)"
    fi
    ;;
  *)
    echo "unsupported OS: $OS"; exit 1 ;;
esac

echo "[install] done. Logs at $HOME_DIR/.weclaude/daemon.{stdout,stderr,log}"
