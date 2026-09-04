# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`wezard` (CLI `wezard`) bridges agent CLIs (Claude Code / claude-internal / CodeBuddy) and WeCom (企业微信) smart bots:
- **PreToolUse approval forwarding**: every tool call is gated by a button card pushed to WeCom; clicking ✅/❌/⏱ resolves the long-poll the hook is parked on.
- **Remote `/wrc`**: messages sent to the bot drive a local agent CLI (headless `claude -p` or mirroring an interactive session).
- **MCP server** (`wecom`): exposes `send_markdown` / `send_card` / `ask_user` / `daemon_status` tools that talk to the resident daemon over loopback HTTP.

## Build / run

```bash
npm run build        # tsc → dist/, then chmod +x on the three bin entry scripts
npm run typecheck    # tsc --noEmit
npm run dev:daemon   # tsx daemon/index.ts  (no install / hot iteration)
npm run dev:cli      # tsx cli/wezard.ts
```

There are **no tests**. Don't fabricate test commands.

Local dev loop:
```bash
npm run build && ./cli/wezard.sh reload    # rebuild, then bounce the resident daemon
./cli/wezard.sh logs -f                    # tail ~/.wezard/daemon.log
./cli/wezard.sh status                     # HTTP /status — wsConnected, pending count, sourcePath
```

When the user says **"reload"** in this repo, it means exactly: `npm run build && ./cli/wezard.sh reload`. The global `wezard` binary may not be on `$PATH` in dev shells — always invoke `./cli/wezard.sh` from the repo root.

## Release / changelog

Every version bump **must** update `CHANGELOG.md` — no release without a changelog entry. Follow [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/):
- Newest version on top; collect in-flight work under `## [Unreleased]` and rename it to `## [x.y.z] - YYYY-MM-DD` at tag time.
- Group changes under `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`; label breaking changes **BREAKING**.
- Keep the compare-link footer in sync (add the new `[x.y.z]` link, repoint `[Unreleased]`).

## High-level architecture

Three processes, all coordinating via 127.0.0.1:17890 and `~/.wezard/`:

```
 WeCom  ── WS ──►  daemon (resident, launchd/systemd --user)
                     │
                     ├── HTTP :17890 ───────► hook (pre-tool-use.sh, blocking long-poll)
                     ├── HTTP :17890 ───────► MCP server (stdio child of claude)
                     └── spawn `claude -p` ── headless bridge  (or tail jsonl + tmux paste = mirror)
```

**daemon** (`daemon/`) is the only process that holds the WeCom WSClient. Everything else is a thin HTTP client of it.
- `index.ts` wires modules; route handlers are registered onto the http server returned by `startHttp`.
- `ws.ts` owns the `@wecom/aibot-node-sdk` `WSClient`. Fatal auth/reconnect → `process.exit(1)` (launchd respawns).
- `approval.ts` builds the button card, parks an HTTP request via `pending.ts`, and resolves it on `event.template_card_event`. Three click outcomes: `allow` / `allow_window` (auto-allow N min for that session) / `deny`. `session-cache.ts` short-circuits repeats.
- `inbound.ts` routes `message.text` / `message.image` / `message.mixed` → either headless `cc-bridge.ts` or `mirror-bridge.ts`. Gates on `allowFrom`; one-shot exception is the bootstrap claim (see below).
- `cc-bridge.ts` (mode=headless) spawns `claude -p --output-format stream-json --verbose`, parses `assistant`/`stream_event` lines, and pumps text via `client.replyStream`. Per-principal queue serializes turns; session id is captured from the `system/init` line and persisted to `~/.wezard/sessions.json` for `--resume`.
- `mirror-bridge.ts` (mode=mirror) tails `<projectsDir>/<encoded(cwd)>/<sid>.jsonl` and pushes new `assistant` content to a chat. Inbound injection is either `claude --resume <sid> -p` (writes a turn into the same jsonl) or `tmux paste-buffer` against a live TTY (only path that makes WeCom messages visible in the user's CLI window). `recentInjects` ring buffer suppresses the WeCom→CLI echo when tailing.
- `claim.ts` is a single-shot bootstrap: an exact-match magic phrase from any sender bypasses `allowFrom`, writes that principal as `defaultChat`, and appends to `allowFrom`. This is the **only** legitimate ingress for first-time setup.
- `peers.ts` is the read side of multi-agent awareness: sibling sessions of one chat are exactly the target keys sharing a base principal (`baseOfKey`), i.e. the untagged default plus every `#tag`. Pure parsing only — bounded transcript-tail reads (`tailTurns` / `lastAssistantText` / `summarizeTail`, shared with `session-scan.ts`) and pane classification (`paneIsBusy`). **Busy detection matches the TUI spinner footer** (`… (12m 31s · …)` on current versions, `esc to interrupt` on older ones) in the last 8 non-blank rows — transcript mtime is useless here, it goes quiet during long tool calls.
- `graph.ts` is the loop-graph runner: `nodes` = tagged sessions (own cli/model/cwd), `steps` = an ordered pipeline walked `rounds` times, each step injecting a prompt, waiting for that agent to go idle, then feeding its reply forward as `{{last}}` / `{{<tag>}}`. Stops early on the `until` sentinel. All effects go through injected deps backed by `mirror-bridge`, so a step is exactly what a human typing `#tag …` would do. Runs are **in-memory only** — a reload cancels them (panes survive).

**Configuration** (`shared/config.ts`):
- Loaded by every binary via `loadConfig()`. Resolution order: explicit arg → `$WEZARD_CONFIG` → `~/.wezard/config.jsonc` → `~/.wezard/config.json`.
- Secrets (`bot.botId`, `bot.secret`) live in `~/.wezard/secrets.json` and are deep-merged on top of the main config — keeps secrets out of dotfile repos.
- Schema is zod (`ConfigSchema`); shape mismatches throw with a path-pointed error.
- `shared/config-writer.ts` is the only sanctioned way to mutate the on-disk jsonc — it preserves comments via `jsonc-parser` edits. `cli/init.ts` and `daemon/claim.ts` use it.

**Hook + sync**:
- `hooks/hooks.json` is registered automatically by Claude Code when the plugin is installed (uses `${CLAUDE_PLUGIN_ROOT:-${CODEBUDDY_PLUGIN_ROOT}}` so the same file works under CodeBuddy's plugin loader if ever published there).
- For non-plugin installs (`claude-internal` wrapper), `cli/sync.ts` writes the MCP server entry + `WEZARD_DAEMON_BASE` env into target `settings.json`s listed in `config.sync.targets`. **It deliberately strips legacy hook entries** for `kind:"claude"` targets — registering both the plugin's `hooks.json` AND a settings.json hook fires the hook twice per tool call (= duplicate cards). For `kind:"codebuddy"` targets, since the wezard plugin is not published to CodeBuddy's marketplace, sync **writes the hook directly into `~/.codebuddy/settings.json`** with an absolute path to `hooks/pre-tool-use.sh` — this is the only registration path for CodeBuddy. `~/.wezard/sync.lock.json` tracks what was written so `--remove` is reversible.

**MCP server** (`mcp/server.ts`): stdio transport, completely stateless w.r.t. WeCom. Every tool just `POST`s to the daemon. Add a tool here AND a route handler in `daemon/`. The peer tools (`list_peers` / `peek_peer` / `send_peer` / `wait_peer` / `run_agent_graph` / `graph_status` / `stop_graph`) all send `selfRef()` = `{sessionId, tmuxPane}` so the daemon can resolve *which* session is asking — env sessionId goes stale after a `/clear`, pane id doesn't. Their descriptions are the whole discovery mechanism for agent↔agent collaboration: an agent only realizes it can drive `#fix` because `send_peer` says so.

## Important patterns / pitfalls

- **PATH for spawn**: `cc-bridge.ts` and `mirror-bridge.ts` both `augmentedPath()` because launchd/systemd start the daemon with a stripped PATH that often lacks nvm/homebrew. If you spawn anything new from the daemon, do the same or it will ENOENT in production but work fine under `npm run dev:daemon`.
- **launchd respawn**: `KeepAlive.SuccessfulExit=false`. `wezard reload` does `POST /shutdown` AND `launchctl kickstart`; just hitting `/shutdown` won't bounce the binary.
- **Uninstall order**: `wezard uninstall` *before* `npm uninstall -g wezard`. Otherwise launchd repeatedly tries to relaunch a deleted binary. State at `~/.wezard/` is intentionally preserved.
- **Card update has a 5s window**: `client.updateTemplateCard` only works within 5s of the click event — `installApprovalEventListener` does the rewrite synchronously inside the event handler.
- **Mirror mode** runs against either `~/.claude-internal/projects/` or `~/.claude/projects/` — `cli/wezard.sh mirror` probes both bases for the encoded cwd.
- **Long-poll timeouts**: hook curl `--max-time` (`approval.hookTimeoutSec`, default 43210) must be **strictly larger** than `approval.longPollSec` (default 43200 = 12h), or the hook returns `ask` while the daemon is still waiting on a click.
- **Sensitive arg redaction** (`daemon/redact.ts`) runs before card render when `approval.sensitiveArgRedact=true`. Only the redacted form is shown in WeCom and stored in pending meta.

## Project conventions

`rules/chat.md` and `rules/code.md` (loaded from `~/develop/Guxi11/aiconfig/rules/`) take precedence over generic style. Highlights enforced in this codebase:
- Functional first: `map`/`filter`/`reduce`, deep-merge by recursion, immutable transforms; side effects pushed to module boundaries (file IO in `shared/`, child_process in bridges, network in `ws.ts` / `http.ts`).
- One function = one sentence. Helpers like `extractText`, `renderInput`, `decodeKey` are pure and testable in isolation; the IO-bearing functions wire them together.
- Comments in source files lean toward "why" (subtle invariants like the dual `event_key` path in `approval.ts`, the 5s update window, the dedup ring buffer). Preserve them on edits.
- Errors should never break the workflow: `approval.fallbackOnError` defaults to `ask`, every hook failure path emits `ask`, every WeCom send is wrapped in try/catch that logs and continues.
