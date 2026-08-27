#!/usr/bin/env bash
# wezard CLI — talks to local wezard daemon over HTTP and toggles launchd/systemd.
set -uo pipefail

DAEMON_BASE="${WEZARD_DAEMON_BASE:-http://127.0.0.1:17890}"
LABEL="com.wezard.daemon"
HOME_DIR="$HOME"
OS="$(uname -s)"

# Resolve symlinks so REPO_ROOT points at the real package dir even when this
# script is invoked via the npm-installed bin symlink (e.g. ~/.npm-global/bin/wezard).
# macOS ships BSD readlink without -f, so chase the chain by hand.
self="${BASH_SOURCE[0]}"
while [[ -L "$self" ]]; do
  d="$(cd -P "$(dirname "$self")" && pwd)"
  t="$(readlink "$self")"
  [[ "$t" != /* ]] && t="$d/$t"
  self="$t"
done
REPO_ROOT="$(cd -P "$(dirname "$self")/.." && pwd)"

cmd="${1:-status}"
shift || true

usage() {
  cat <<'EOF'
wezard <subcommand>
  init                 interactive onboarding (write config, install daemon, claim default chat, run demo)
  migrate              upgrade an existing weclaude install (state + daemon + plugin + settings.json)
                       flags: --dry-run --force --purge -y
  status               daemon health + connection state
  start                load resident daemon (launchd/systemd)
  stop                 unload resident daemon
  restart              stop + start
  reload               quick: shutdown via HTTP + kickstart
  mirror [chat]        attach current Claude session for mirror push (target overrides config)
  mirror-status        show current mirror attachment
  send <chat> <text>   proactive markdown message
  pending              list outstanding approval req_ids
  svr [args...]        run standalone detail relay (deploy on a host chat + cli both reach)
  logs [-f]            tail daemon log
  config-path            show resolved config path
  sync                   write hooks/MCP/env into sync.targets settings.json
  unsync                 remove our entries from sync.targets settings.json
  audit [tag]            token/cost breakdown for current Claude session (main + subagents)
  uninstall              full teardown: stop daemon + unsync + plugin uninstall + remove daemon (run before `npm uninstall -g`)
                         add `--purge` to also delete ~/.wezard state
  version                print wezard version
  help
EOF
}

# --noproxy '*' is mandatory: the daemon is on 127.0.0.1, but an http_proxy /
# all_proxy in the environment makes curl tunnel even localhost through the
# proxy, which answers refused upstreams with an empty 200 — a false "up" that
# poisons every readiness probe. Never let a proxy sit between CLI and daemon.
http_get() { curl -sS --noproxy '*' --max-time 5 "$DAEMON_BASE$1"; }
http_post() { curl -sS --noproxy '*' --max-time 5 -X POST -H 'content-type: application/json' -d "${2:-{\}}" "$DAEMON_BASE$1"; }

# Run a dist/ entry script, building first when we're sitting in a dev checkout.
# npm installs ship dist/ in the tarball, so a missing script there means a
# broken install — fail loudly instead of invoking tsc against no tsconfig.
exec_node() {
  local rel="$1"; shift
  local script="$REPO_ROOT/$rel"
  if [[ ! -f "$script" ]]; then
    if [[ -f "$REPO_ROOT/tsconfig.json" ]]; then
      echo "[wezard] building..."
      (cd "$REPO_ROOT" && npm install --silent && npx tsc -p tsconfig.json) || { echo "build failed"; exit 1; }
    else
      echo "[wezard] missing $script — try 'npm install -g wezard' to reinstall" >&2
      exit 1
    fi
  fi
  exec "$(command -v node)" "$script" "$@"
}

# One launchctl vocabulary, one readiness judge. Every lifecycle command
# (start/restart/reload) funnels through ensure_up so none can leave the job in
# a state another can't recover from. Success is judged by the invariant that
# matters — /status responds on :17890 — never by a launchctl exit code, which
# lies (un-bootstrapped domains, throttle, load/bootstrap semantics clash).
PLIST="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"

# Fast readiness probe — short per-call timeout so a bound-but-wedged /status
# (e.g. daemon blocked on WS init) fails the poll in ~1s, not the 5s http_get
# budget. 30 tries × ~1s ceiling ≈ bounded ~30s worst case, not minutes.
probe()     { curl -sS --noproxy '*' --connect-timeout 1 --max-time 1 "$DAEMON_BASE/status" >/dev/null 2>&1; }
wait_up()   { for _ in $(seq 1 30); do probe && return 0; sleep 0.3; done; return 1; }
wait_down() { for _ in $(seq 1 30); do probe || return 0; sleep 0.3; done; return 1; }

# Nohup fallback for Linux boxes with no systemd user session (containers, CI,
# minimal images where D-Bus is unreachable). Detached background node process,
# pidfile-tracked so svc_unregister can find it again. augmentedPath isn't
# needed here — the CLI itself already runs with the user's interactive PATH.
PIDFILE="$HOME_DIR/.wezard/daemon.pid"
DAEMON_ENTRY="$REPO_ROOT/dist/daemon/index.js"
nohup_start() {
  [[ -f "$DAEMON_ENTRY" ]] || { echo "[wezard] missing $DAEMON_ENTRY — run 'npm run build'" >&2; return 1; }
  mkdir -p "$HOME_DIR/.wezard"
  nohup "$(command -v node)" "$DAEMON_ENTRY" \
    >> "$HOME_DIR/.wezard/daemon.stdout.log" \
    2>> "$HOME_DIR/.wezard/daemon.stderr.log" &
  echo $! > "$PIDFILE"
}
nohup_stop() {
  [[ -f "$PIDFILE" ]] || return 0
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
}
# True when a usable systemd --user session is reachable. `systemctl --user`
# returns "Failed to get D-Bus connection" (exit≠0) in containers; probing it
# once lets every lifecycle command pick systemd-vs-nohup consistently.
have_systemd_user() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

# idempotent converge-to-running: kick if already bootstrapped, else bootstrap,
# else legacy load — then assert it actually bound.
ensure_up() {
  case "$OS" in
    Darwin)
      launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null \
        || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
        || launchctl load -w "$PLIST" 2>/dev/null || true ;;
    Linux)
      # Prefer systemd when it's actually there; otherwise fall back to a
      # detached node process. reload/restart already ran graceful_stop, but a
      # stale nohup pid may still be around — clear it before relaunching.
      if have_systemd_user; then
        systemctl --user restart wezard.service 2>/dev/null || { echo "[wezard] systemctl --user restart failed" >&2; return 1; }
      else
        echo "[wezard] no systemd user session (container?) — starting daemon via nohup" >&2
        nohup_stop
        nohup_start || return 1
      fi ;;
  esac
  wait_up
}
# Guaranteed teardown: drive shutdown through the HTTP /shutdown path, which
# hard-exits (setTimeout process.exit) regardless of in-flight connections.
# NEVER SIGTERM a live daemon via bootout — its SIGTERM handler awaits
# http.close(), which blocks forever on a hung long-poll, wedging launchctl.
graceful_stop() { http_post /shutdown >/dev/null 2>&1 || true; wait_down; }
# Remove the job from the domain (so RunAtLoad won't respawn it). Process is
# already dead from graceful_stop, so bootout is instant — nothing to kill.
svc_unregister() {
  case "$OS" in
    Darwin) launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null \
              || launchctl unload "$PLIST" 2>/dev/null || true ;;
    Linux)
      if have_systemd_user; then systemctl --user stop wezard.service 2>/dev/null || true
      else nohup_stop; fi ;;
  esac
}

case "$cmd" in
  init)    exec_node dist/cli/init.js "$@" ;;
  migrate) exec_node dist/cli/migrate.js "$@" ;;
  status)
    if out=$(http_get /status 2>/dev/null); then
      echo "$out" | jq . 2>/dev/null || echo "$out"
      exit 0
    fi
    # /status unreachable — distinguish "not loaded" from the silent-death case:
    # launchd shows the job loaded but it never bound the port (crash-loop /
    # bad config). Surface that instead of a flat "down".
    echo "daemon: down ($DAEMON_BASE)"
    if [[ "$OS" == "Darwin" ]] && ex=$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | sed -n 's/.*last exit code = \([0-9-]*\).*/\1/p'); then
      [[ -n "$ex" && "$ex" != "0" ]] \
        && echo "  ↳ launchd job loaded but last exit code = $ex — crash-looping. 'wezard logs' to see why." >&2
    fi
    exit 1
    ;;
  start)   ensure_up && echo "daemon: started"   || { echo "daemon: start failed — 'wezard logs'" >&2; exit 1; } ;;
  stop)    graceful_stop >/dev/null 2>&1 || true; svc_unregister; echo "daemon: stopped" ;;
  restart) graceful_stop >/dev/null 2>&1 || true; svc_unregister; ensure_up && echo "daemon: restarted" || { echo "daemon: restart failed — 'wezard logs'" >&2; exit 1; } ;;
  reload)
    # KeepAlive.SuccessfulExit=false, so /shutdown alone won't respawn. Graceful
    # stop WAITS for :17890 to free (else the respawn loses the bind and
    # crash-loops on ThrottleInterval), then converge via the shared primitive.
    graceful_stop >/dev/null 2>&1 || true
    ensure_up && echo "daemon: reloaded" || { echo "daemon: reload issued but /status not responding — 'wezard logs'" >&2; exit 1; }
    ;;
  send)
    chat="${1:-}"; shift || true
    text="${*:-}"
    if [[ -z "$chat" || -z "$text" ]]; then
      echo "usage: wezard send <chat> <text>"; exit 1
    fi
    body=$(jq -nc --arg c "$chat" --arg t "$text" '{chat:$c,text:$t}')
    http_post /message "$body"
    ;;
  pending) http_get /pending | jq . 2>/dev/null || http_get /pending ;;
  svr)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/svr/index.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  logs)
    log_path=$(http_get /status 2>/dev/null | jq -r '.logFile // empty' 2>/dev/null || true)
    log_path="${log_path:-$HOME_DIR/.wezard/daemon.log}"
    # On the nohup fallback path there's no daemon.log — stdout/stderr go to
    # separate files. Prefer whichever actually exists so `logs` isn't empty.
    if [[ ! -f "$log_path" && -f "$HOME_DIR/.wezard/daemon.stderr.log" ]]; then
      log_path="$HOME_DIR/.wezard/daemon.stderr.log"
    fi
    if [[ ! -f "$log_path" ]]; then
      echo "[wezard] daemon has never started — no log file at $log_path" >&2
      echo "[wezard] start it with 'wezard start' (or 'wezard reload')" >&2
      exit 1
    fi
    if [[ "${1:-}" == "-f" ]]; then tail -f "$log_path"; else tail -n 100 "$log_path"; fi
    ;;
  config-path) http_get /status | jq -r '.sourcePath // empty' ;;
  uninstall)
    # Order matters: stop the daemon FIRST so it can't rewrite settings/lock
    # files mid-teardown; then strip MCP/env from agent settings; then remove
    # the plist/unit + Claude plugin registration. State at ~/.wezard is
    # preserved unless `--purge` is given.
    purge=0
    [[ "${1:-}" == "--purge" ]] && purge=1
    http_post /shutdown >/dev/null 2>&1 || true
    NODE_BIN="$(command -v node)"
    SYNC_SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SYNC_SCRIPT" ]] && "$NODE_BIN" "$SYNC_SCRIPT" --remove || true
    bash "$REPO_ROOT/scripts/uninstall.sh"
    rm -f "$HOME_DIR/.wezard/sync.lock.json"
    if (( purge )); then
      rm -rf "$HOME_DIR/.wezard"
      echo "[wezard] state purged (~/.wezard removed)"
    else
      echo "[wezard] cleaned. state kept at ~/.wezard — remove with 'wezard uninstall --purge' or 'rm -rf ~/.wezard'"
    fi
    echo "[wezard] safe to 'npm uninstall -g wezard' now"
    ;;
  mirror)
    cwd="${CLAUDE_PROJECT_DIR:-${CODEBUDDY_PROJECT_DIR:-$(pwd)}}"
    # claude-internal stores under ~/.claude-internal/projects/, official claude
    # under ~/.claude/projects/, codebuddy under ~/.codebuddy/projects/. Walk up
    # parent dirs — caller may be in a subdirectory of the cwd the CLI was
    # launched in (e.g. monorepo subpackage). Encoding differs: claude keeps a
    # leading `-` ([/.]→-), codebuddy trims it first (no leading `-`).
    # Prioritize the base matching the active CLI (detected via env vars) so a
    # codebuddy session doesn't fall through to a stale claude project dir.
    if [[ -n "${CODEBUDDY_SESSION_ID:-}" ]]; then
      bases=("$HOME/.codebuddy/projects" "$HOME/.claude-internal/projects" "$HOME/.claude/projects")
    else
      bases=("$HOME/.claude-internal/projects" "$HOME/.claude/projects" "$HOME/.codebuddy/projects")
    fi
    proj=""
    probe="$cwd"
    while [[ -z "$proj" && -n "$probe" ]]; do
      for base in "${bases[@]}"; do
        if [[ "$base" == *codebuddy* ]]; then
          enc="$(printf %s "$probe" | sed 's|^[/]*||; s|[/.]|-|g')"
        else
          enc="$(printf %s "$probe" | sed 's|[/.]|-|g')"
        fi
        if [[ -d "$base/$enc" ]]; then proj="$base/$enc"; break; fi
      done
      [[ "$probe" == "/" ]] && break
      probe="$(dirname "$probe")"
    done
    if [[ -z "$proj" ]]; then
      echo "no claude/codebuddy project dir for cwd: $cwd (or any ancestor)"
      echo "tried encodings up to $HOME/.claude{,-internal}/projects/ + $HOME/.codebuddy/projects/<encoded-ancestor>"
      exit 1
    fi
    # Resolve the *calling* session via env var the CLI injects into every
    # child process. Both Claude Code and CodeBuddy export CLAUDE_SESSION_ID
    # (back-compat); CODEBUDDY_SESSION_ID is the codebuddy-native name.
    sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEBUDDY_SESSION_ID:-}}}"
    latest=""
    if [[ -n "$sid" && -f "$proj/$sid.jsonl" ]]; then
      latest="$proj/$sid.jsonl"
    fi
    # Fallback for setups that don't propagate the env var: most-recent mtime.
    [[ -z "$latest" ]] && latest=$(ls -t "$proj"/*.jsonl 2>/dev/null | head -1)
    if [[ -z "$latest" ]]; then
      echo "no .jsonl under $proj"; exit 1
    fi
    sid="$(basename "$latest" .jsonl)"
    # Accept user-friendly prefixes: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
    # Pass anything else through (already in user:/chat:/group: form, or empty).
    raw="${1:-}"
    case "$raw" in
      vid:*)    target="user:${raw#vid:}" ;;
      chatid:*) target="chat:${raw#chatid:}" ;;
      *)        target="$raw" ;;
    esac
    body=$(jq -nc --arg s "$sid" --arg p "$latest" --arg t "$target" --arg tp "${TMUX_PANE:-}" \
      '{sessionId:$s, jsonlPath:$p}
        + (if $t == "" then {} else {target:$t} end)
        + (if $tp == "" then {} else {tmuxPane:$tp} end)')
    http_post /mirror/attach "$body" | jq . 2>/dev/null || true
    ;;
  mirror-status)
    http_get /mirror/status | jq . 2>/dev/null || http_get /mirror/status
    ;;
  sync)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  unsync)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" --remove "$@"
    ;;
  audit)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/audit.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  help|-h|--help) usage ;;
  version|-v|--version)
    # Read version straight from the package manifest — no jq dep, regex is enough.
    pkg="$REPO_ROOT/package.json"
    [[ -f "$pkg" ]] || { echo "package.json not found at $pkg" >&2; exit 1; }
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1
    ;;
  *) echo "unknown subcommand: $cmd"; usage; exit 2 ;;
esac
