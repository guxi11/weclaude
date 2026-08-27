// Auto-spawn helper for mirror mode.
//
// Goal: from a WeCom inbound, materialize a fresh `claude` process inside a
// shared tmux session and attach the resulting jsonl to the WeCom chat —
// no human-in-the-loop `/wrc` needed.
//
// Layout: ONE shared tmux session named `cfg.wrc.tmuxPrefix` (default
// `wezard`); each chat gets its own window inside it. The pane id (`%N`)
// uniquely identifies a chat's claude process — pane ids are monotonic per
// tmux server lifetime, so they're safe to persist and re-validate via
// `display-message -t %N`. Window names are cosmetic (sanitized principal id;
// WeCom doesn't expose a display name).
//
// Pipeline:
//   uuid = randomUUID                                       (deterministic session)
//   tmux has-session -t wezard  → create or reuse
//   tmux new-window/new-session -P -F '#{pane_id}' …        (→ paneId)
//   tmux send-keys -t %paneId "claudeBin --session-id <uuid> …" Enter
//
// We do NOT wait for claude to write anything to the jsonl. The jsonl is the
// transcript file, populated as claude runs; the empty file is enough for
// MirrorBridge.attach() (existsSync) and startMirrorTail (statSync.size=0 →
// tail from offset 0). The brief post-launch settle exists only to give the
// pane's shell time to finish sourcing rc + claude TUI time to grab the pty
// before the first paste-buffer inject hits.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { activateBackend, CLI_BACKEND_DEFAULTS, primaryBackend, type CliBackend, type CliBackendName } from "../shared/cli-backends.js";

const NODE_BIN_DIR = dirname(process.execPath);
const augmentedPath = (orig: string | undefined): string => {
  const extras = [NODE_BIN_DIR, "/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME ?? ""}/.local/bin`].filter(Boolean);
  const seen = new Set<string>();
  return [orig ?? "", ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(":");
};

// A spawn has no transcript to derive a backend from, so the caller picks one
// (`cli`) and we fall back to the primary (`wrc.defaultCli`). Everything the
// pane needs — binary, transcript root, project-dir encoding, trust-marker file
// — comes from that single descriptor, which is what lets one daemon host
// claude and codebuddy panes at the same time.
const backendFor = (cfg: Config, cli?: CliBackendName): CliBackend => {
  const primary = primaryBackend();
  if (!cli || cli === primary.name) return primary;
  const base = CLI_BACKEND_DEFAULTS[cli];
  const override = cfg.wrc.cliBackends?.[cli]?.bin;
  // Activate before spawning: this CLI's transcript root may not exist yet, in
  // which case the boot-time probe skipped it and backendForPath would misread
  // the jsonl we are about to create as the primary's dialect.
  return activateBackend(override ? { ...base, bin: override } : base);
};

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Hard ceiling for ANY tmux subcommand. A wedged tmux server used to hang the
 *  caller forever with zero log output: one inbound spawned a pane, then
 *  dispatch's `tmuxPaneAlive` never returned, so the per-session inject queue
 *  stayed locked behind a zombie job and that chat went permanently silent.
 *  Normal tmux commands finish in <100ms — 10s is a generous ceiling, not a
 *  latency budget. Override via WEZARD_TMUX_TIMEOUT_MS (0 disables, for debugging). */
export const TMUX_TIMEOUT_MS = ((): number => {
  const raw = Number(process.env.WEZARD_TMUX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/** Timeouts are the only signal that the tmux server wedged, so they must leave
 *  a trace. runTmux has no logger of its own (it predates the daemon's pino
 *  child loggers and is called from two modules) — the daemon installs a
 *  reporter at boot. */
let timeoutReporter: ((info: { args: string[]; timeoutMs: number }) => void) | undefined;
export const setTmuxTimeoutReporter = (fn: (info: { args: string[]; timeoutMs: number }) => void): void => {
  timeoutReporter = fn;
};

export interface RunTmuxOpts {
  /** Written to the child's stdin, which is then closed. For `tmux load-buffer -`. */
  stdin?: string;
  /** Per-call override of TMUX_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const runTmux = (args: string[], opts: RunTmuxOpts = {}): Promise<ExecResult> =>  new Promise((resolve) => {
    const proc = spawn("tmux", args, {
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = opts.timeoutMs ?? TMUX_TIMEOUT_MS;
    const finish = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // SIGKILL, not SIGTERM: a tmux client blocked on a wedged server ignores
    // TERM. Resolving as a normal failure lets every existing `if (!r.ok)`
    // branch handle it — no call site needs to know about timeouts.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        timeoutReporter?.({ args, timeoutMs });
        finish({ ok: false, stdout: out, stderr: `tmux timeout after ${timeoutMs}ms: ${args.slice(0, 3).join(" ")}`, code: null });
      }, timeoutMs);
    }
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    proc.on("error", (e) => finish({ ok: false, stdout: "", stderr: e.message, code: null }));
    proc.on("close", (code) => finish({ ok: code === 0, stdout: out, stderr: err, code }));
    if (opts.stdin !== undefined) proc.stdin?.end(opts.stdin);
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// `tmux -V` → "tmux 3.4" / "tmux 3.2a" / "tmux next-3.4" / "tmux 1.8". Extract
// the first major.minor as a float for coarse feature gating. Unparseable →
// Infinity (assume modern; the flags we gate on are ancient anyway).
const parseTmuxVersion = (out: string): number => {
  const m = out.match(/(\d+)\.(\d+)/);
  return m ? Number(`${m[1]}.${m[2]}`) : Number.POSITIVE_INFINITY;
};
export { parseTmuxVersion };


// Single-quote shell-escape: wrap in '…' and escape embedded ' as '\''.
const shQuote = (a: string): string => (/[\s"'`$\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);

// tmux window names are free-form but a status-bar friendly slug avoids
// surprises (no whitespace / colons / quoting hazards). Principals are
// shortened: `user:foo` → `u-foo`, `chat:foo` → `c-foo`, and get truncated to
// 8 chars total (status bar real estate is scarce; collisions don't matter —
// we always address windows by pane id, never by name). Explicit tag names
// (not `user:`/`chat:` prefixed) are treated as user-authored labels and kept
// up to 24 chars so `/new #my-tag` shows readably in the tmux status bar.
const safeWindowName = (s: string): string => {
  const isPrincipal = s.startsWith("user:") || s.startsWith("chat:");
  const compact = s.startsWith("user:") ? `u-${s.slice(5)}`
    : s.startsWith("chat:") ? `c-${s.slice(5)}`
    : s;
  const slug = compact.replace(/[^A-Za-z0-9_.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (slug || "claude").slice(0, isPrincipal ? 8 : 24);
};

// Minimum settle before first poll: shell rc needs time to source before
// capture-pane contains anything meaningful. Too short → wasted polls against
// a blank screen; too long → added latency on happy path.
const MIN_SETTLE_MS = 1500;
// Max time to wait for TUI readiness. Covers slow machines / heavy .zshrc.
const TUI_READY_TIMEOUT_MS = 15_000;
// Poll interval for capture-pane checks.
const POLL_MS = 400;

// Patterns indicating the TUI reached interactive state (input box visible).
// Covers Claude Code, Claude Internal, and CodeBuddy TUIs across versions.
const TUI_READY_RE = /for shortcuts|auto mode|Try "|>\s*$/m;

// Patterns indicating an interactive prompt that consumed our Enter — the
// command is sitting unsent in the shell line.
const BLOCKER_RE = /Would you like to update|oh-my-zsh|Do you want to update/i;

const capturePaneBottom = async (pane: string, rows: number): Promise<string> => {
  const r = await runTmux(["capture-pane", "-t", pane, "-p", "-S", `-${rows}`]);
  return r.ok ? r.stdout : "";
};

// Active verification that the TUI launched and is ready for input. Replaces
// the old blind sleep(3000). On success returns true; on timeout returns false
// (caller decides whether to treat as fatal). Retries Enter once if it detects
// the command was typed but not submitted.
const waitForTuiReady = async (pane: string, cmd: string, log: Logger): Promise<boolean> => {
  await sleep(MIN_SETTLE_MS);
  const deadline = Date.now() + TUI_READY_TIMEOUT_MS;
  let retriedEnter = false;
  let resent = false;
  while (Date.now() < deadline) {
    const cap = await capturePaneBottom(pane, 20);
    if (TUI_READY_RE.test(cap)) return true;
    // Shell prompt eating our Enter: an interactive blocker (omz update, etc.)
    // swallowed it. Dismiss with "N" + Enter, then re-send the full command.
    if (!resent && BLOCKER_RE.test(cap)) {
      log.warn({ pane }, "spawn-tmux: interactive blocker detected, dismissing");
      await runTmux(["send-keys", "-t", pane, "N", "Enter"]);
      await sleep(800);
      await runTmux(["send-keys", "-t", pane, cmd, "Enter"]);
      resent = true;
    }
    // If after half the budget we still see nothing, maybe Enter was lost in
    // shell rc sourcing. Retry Enter once (safe: if claude already started, an
    // extra Enter on an empty input box is a no-op).
    if (!retriedEnter && !resent && (Date.now() - (deadline - TUI_READY_TIMEOUT_MS)) > TUI_READY_TIMEOUT_MS / 2) {
      log.warn({ pane }, "spawn-tmux: TUI not seen at half-budget, retrying Enter");
      await runTmux(["send-keys", "-t", pane, "Enter"]);
      retriedEnter = true;
    }
    await sleep(POLL_MS);
  }
  log.warn({ pane }, "spawn-tmux: TUI ready timeout, proceeding anyway");
  return false;
};

export interface SpawnArgs {
  cfg: Config;
  log: Logger;
  /** Resume an existing claude session (its jsonl already exists) instead of
   *  minting a new uuid. Used when the user closed the original tmux pane and
   *  we need to reincarnate the same conversation in a fresh pane. */
  resumeSessionId?: string;
  /** Cosmetic tmux window name (status-bar label). Falls back to sessionId.
   *  Pass the principal (e.g. "user:xxx") to make windows easy to skim. */
  windowName?: string;
  /** Per-chat cwd override. Empty/undefined → fall back to cfg.wrc.cwd.
   *  Mirror mode persists this in mirror-attachments.json so /new respawns
   *  in the user-bound project, not the global default. */
  cwdOverride?: string;
  /** Which CLI to launch. Undefined → `wrc.defaultCli`. A respawn should pass
   *  the backend that owns `resumeSessionId`, else the resume finds no session. */
  cli?: CliBackendName;
  /** Model slug for `--model`. Lets sibling `#tag` sessions in one chat run on
   *  different models (a graph node can pick opus for design, haiku for lint).
   *  Undefined → the CLI's own default. */
  model?: string;
}

export interface SpawnResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  jsonlPath?: string;
  tmuxPane?: string;
  tmuxSession?: string;
  /** Effective cwd the pane was launched in. Mirrors `cwdOverride ?? cfg.wrc.cwd`
   *  after expandHome, so callers can persist it without re-resolving. */
  cwd?: string;
  /** Backend actually launched. */
  cli?: CliBackendName;
}

// Pre-write the "trust this folder" + onboarding markers for `cwd` into
// claude's user-config json so the TUI doesn't park on the workspace-trust /
// onboarding prompts — those would silently swallow paste-buffer injects.
//
//   claude          → ~/.claude.json
//   claude-internal → ~/.claude-internal/.claude.json
//   <other>         → first existing of {~/.<bin>/.claude.json, ~/.<bin>.json};
//                     when neither exists we pick the dir-style path so the
//                     write also creates the conventional layout.
//
// Idempotent: deep-merges into the existing file, preserves unrelated keys.
type ClaudeProjectMeta = {
  hasTrustDialogAccepted?: boolean;
  projectOnboardingSeenCount?: number;
  hasClaudeMdExternalIncludesApproved?: boolean;
  hasClaudeMdExternalIncludesWarningShown?: boolean;
  [k: string]: unknown;
};
const claudeConfigCandidates = (claudeBin: string): string[] => {
  const home = homedir();
  const name = basename(claudeBin);
  if (name === "claude") return [join(home, ".claude.json")];
  return [join(home, `.${name}`, ".claude.json"), join(home, `.${name}.json`)];
};
export const trustWorkspace = (claudeBin: string, cwd: string, log: Logger): void => {
  const candidates = claudeConfigCandidates(claudeBin);
  const target: string = candidates.find(existsSync) ?? candidates[0]!;
  let cfg: { projects?: Record<string, ClaudeProjectMeta>; [k: string]: unknown } = {};
  try {
    if (existsSync(target)) cfg = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    log.warn({ target, err: (e as Error).message }, "trustWorkspace: parse failed; rewriting");
  }
  const projects = (cfg.projects ??= {});
  const proj: ClaudeProjectMeta = projects[cwd] ?? {};
  if (proj.hasTrustDialogAccepted && (proj.projectOnboardingSeenCount ?? 0) >= 1 && proj.hasClaudeMdExternalIncludesApproved) {
    return; // already trusted — no write needed
  }
  projects[cwd] = {
    ...proj,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: Math.max(proj.projectOnboardingSeenCount ?? 0, 1),
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(cfg, null, 2));
    log.info({ target, cwd }, "trustWorkspace: marker written");
  } catch (e) {
    log.warn({ target, err: (e as Error).message }, "trustWorkspace: write failed");
  }
};

export const spawnTmuxClaude = async ({ cfg, log, resumeSessionId, windowName, cwdOverride, cli, model }: SpawnArgs): Promise<SpawnResult> => {
  const backend = backendFor(cfg, cli);
  const cwd = expandHome((cwdOverride ?? "").trim() || cfg.wrc.cwd);
  const projectDir = join(expandHome(backend.projectsDir), backend.encodeProjectDir(cwd));
  const sessionId = resumeSessionId ?? randomUUID();
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  const tmuxName = cfg.wrc.tmuxPrefix; // shared session for all chats
  const winName = safeWindowName(windowName ?? sessionId);

  // Probe tmux availability up front — clearer error than a generic spawn fail.
  // Also gate two flags on version: `-c <start-dir>` on new-session/new-window
  // landed in tmux 1.9; `-e KEY=VAL` in 3.0. Old tmux (e.g. CentOS 7 ships 1.8)
  // errors `unknown option -- c` and aborts the whole spawn — so when either is
  // unsupported we fold the equivalent into the launch command instead (`cd` +
  // inline env exports), which every tmux understands.
  const probe = await runTmux(["-V"]);
  if (!probe.ok) return { ok: false, reason: `tmux not available: ${probe.stderr.trim() || probe.code}` };
  const ver = parseTmuxVersion(probe.stdout);
  const supportsC = ver >= 1.9;
  const supportsE = ver >= 3.0;

  // Ensure cwd / projectDir exist (tmux `new-session -c` fails if cwd missing;
  // default `~/.wezard/workspace` often hasn't been touched yet). Do NOT
  // pre-create the jsonl: `claude --session-id <uuid>` refuses to start when
  // the transcript file already exists ("session id is already in use"). We
  // poll for it after spawn instead.
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `prepare cwd failed: ${(e as Error).message}` };
  }

  // Pre-trust the workspace so claude TUI doesn't park on the "Do you trust
  // this folder?" / onboarding prompts — those prompts swallow paste-buffer
  // injects and the approval card never fires. Best-effort: log + continue
  // on failure (worst case the user clicks through the prompts manually).
  trustWorkspace(backend.bin, cwd, log);

  // Reuse the shared session if alive; otherwise create it. Either way, end
  // up with a fresh window whose pane id we capture via `-P -F '#{pane_id}'`.
  //
  // Seed the new pane's environment (`-e`, tmux ≥3.0) BEFORE its shell sources
  // rc: oh-my-zsh runs its update check while sourcing .zshrc and, when due,
  // blocks on `[oh-my-zsh] Would you like to update? [Y/n]`. That prompt eats
  // the `claude …` command line + the trailing Enter, so claude never launches
  // and the injected message falls through to a bare shell (`command not
  // found: hi`). These two legacy vars (still honored for back-compat) disable
  // the prompt regardless of the user's zstyle config.
  const paneEnv = supportsE ? ["-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true"] : [];
  const cwdArg = supportsC ? ["-c", cwd] : [];
  const has = await runTmux(["has-session", "-t", tmuxName]);
  const created = has.code === 0
    // `${tmuxName}:` (trailing colon) forces session-only resolution → next free
    // window index. Bare `-t wezard` is ambiguous: if a *window* is also named
    // `wezard`, tmux matches it and tries to reuse its index → "index N in use".
    ? await runTmux(["new-window", "-d", "-t", `${tmuxName}:`, "-n", winName, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"])
    : await runTmux(["new-session", "-d", "-s", tmuxName, "-n", winName, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"]);
  if (!created.ok) {
    const verb = has.code === 0 ? "new-window" : "new-session";
    return { ok: false, reason: `tmux ${verb} failed: ${created.stderr.trim() || created.code}` };
  }
  const tmuxPane = created.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  if (!tmuxPane) {
    return { ok: false, reason: "tmux returned no pane id" };
  }
  log.info({ tmuxName, winName, tmuxPane, cwd, sessionId, cli: backend.name, reused: has.code === 0 }, "spawn-tmux: pane created");

  // DISABLE_AUTOUPDATER=1 防止新 pane 启动时弹出 "An update is available" 询问 ——
  // 该交互会吞掉首条 paste-buffer 注入，导致仅落字符不进入 claude 输入框。
  // On old tmux the pane never got the two anti-update-prompt vars via `-e`, so
  // fold them into the command line as inline exports (`KEY=VAL cmd`).
  const envPrefix = [
    ...(supportsE ? [] : ["DISABLE_AUTO_UPDATE=true", "DISABLE_UPDATE_PROMPT=true"]),
    "DISABLE_AUTOUPDATER=1",
  ];
  const argv = [
    ...(resumeSessionId ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(model?.trim() ? ["--model", model.trim()] : []),
    ...cfg.wrc.extraArgs,
  ].map(shQuote);
  const cmd = [...envPrefix, backend.bin, ...argv].join(" ");
  // Old tmux couldn't set the pane's start-dir via `-c`; cd into it first.
  const launch = supportsC ? cmd : `cd ${shQuote(cwd)} && ${cmd}`;
  const sent = await runTmux(["send-keys", "-t", tmuxPane, launch, "Enter"]);
  if (!sent.ok) {
    // Kill only this window/pane, never the shared session.
    await runTmux(["kill-pane", "-t", tmuxPane]);
    return { ok: false, reason: `tmux send-keys failed: ${sent.stderr.trim() || sent.code}` };
  }

  // Actively verify the TUI reached interactive state before returning.
  // claude does NOT create the transcript jsonl until it processes the first
  // user input, so we don't wait for the file — mirror tail tolerates a
  // missing jsonl and starts emitting once claude writes the first line.
  await waitForTuiReady(tmuxPane, cmd, log);

  log.info({ tmuxName, tmuxPane, sessionId, jsonlPath, cwd, cli: backend.name }, "spawn-tmux: ready");
  return { ok: true, sessionId, jsonlPath, tmuxPane, tmuxSession: tmuxName, cwd, cli: backend.name };
};
