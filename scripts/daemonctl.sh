#!/usr/bin/env bash
# weclaude daemon supervisor for hosts without a systemd --user session
# (containers: PID 1 not systemd, no XDG_RUNTIME_DIR / user D-Bus).
# setsid-detached restart loop; idempotent.
set -uo pipefail
REPO="$(npm root -g)/weclaude"
NODE="$(command -v node)"
WC="$HOME/.weclaude"; PIDFILE="$WC/supervisor.pid"; LOG="$WC/daemon.log"
mkdir -p "$WC"
# Egress proxy: only propagate if already set in the environment. Do NOT inject a
# placeholder — a bogus proxy silently breaks the WeCom WebSocket. If this host
# needs one, `export HTTPS_PROXY=...` before calling, or set bot.proxy in config.
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"; export no_proxy="$NO_PROXY"
is_running(){ [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-start}" in
  start)   is_running && { echo "already running (pid $(cat "$PIDFILE"))"; exit 0; }
           setsid bash "$0" __loop </dev/null >>"$LOG" 2>&1 & echo $! >"$PIDFILE"
           sleep 2; echo "[daemonctl] started (pid $(cat "$PIDFILE"))" ;;
  __loop)  while [[ -f "$PIDFILE" ]]; do "$NODE" "$REPO/dist/daemon/index.js" >>"$LOG" 2>&1
             [[ -f "$PIDFILE" ]] || break; sleep 5; done ;;
  stop)    [[ -f "$PIDFILE" ]] && { pid=$(cat "$PIDFILE"); rm -f "$PIDFILE"
             pkill -P "$pid" 2>/dev/null||true; kill "$pid" 2>/dev/null||true; }
           pkill -f "$REPO/dist/daemon/index.js" 2>/dev/null||true; echo "[daemonctl] stopped" ;;
  restart) bash "$0" stop; sleep 1; bash "$0" start ;;
  status)  is_running && echo "running (pid $(cat "$PIDFILE"))" || echo "stopped"
           curl -sS -m2 http://127.0.0.1:17890/status 2>/dev/null && echo || echo "(HTTP :17890 无响应)" ;;
esac
