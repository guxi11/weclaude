// CLI backend descriptors. Claude Code / claude-internal forks / CodeBuddy
// all share the headless stream-json + hook protocol shape, but differ in:
//   - binary name + config home (~/.claude vs ~/.claude-internal vs ~/.codebuddy)
//   - on-disk project-dir encoding (Claude: leading `-`; CodeBuddy: none)
//   - jsonl transcript schema (CodeBuddy splits tool_use / tool_result into
//     independent top-level records; Claude Code nests them in message.content)
//   - slash-command injection tag dialect: verified identical (<command-name> /
//     <system-reminder>), so no tag-regex dispatch needed.
//
// normalizeTranscriptLine maps a backend's raw jsonl line into the Claude Code
// TranscriptLine shape that mirror-bridge's renderLine consumes. Claude backends
// are identity; codebuddy does the schema adapter work.

import { join } from "node:path";
import { expandHome } from "./paths.js";

export type CliBackendName = "claude" | "claude-internal" | "codebuddy";

// Normalized transcript line — structurally compatible with mirror-bridge's
// TranscriptLine. Defined here (not imported from mirror-bridge) to keep the
// shared layer free of daemon dependencies. mirror-bridge casts the return
// value to its own TranscriptLine; the shapes match field-for-field.
export interface NormalizedContentBlock {
  type?: string;
  text?: string;
  // thinking block (Claude Code shape). CodeBuddy's reasoning_text is normalized into this.
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string; tool_name?: string }>;
}

export interface NormalizedTranscriptLine {
  type?: string;
  /** Present on `type:"system"` lines — e.g. "local_command" for slash-command
   *  invocation records (Claude Code only; codebuddy has no system lines). */
  subtype?: string;
  /** Top-level content for `type:"system"` lines. */
  content?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: string | NormalizedContentBlock[];
    stop_reason?: string;
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
    };
  };
  isMeta?: boolean;
  isSidechain?: boolean;
  /** 后端只能说"这条 assistant 消息写完了", 说不出"这一轮结束了" (codebuddy: 每条
   *  记录都是独立的 completed message, 中途叙述与最终答复完全同形)。置位表示**软**
   *  收口 —— mirror-bridge 挂一小段静默期确认, 期间来了新 item 就撤销。原生 Claude
   *  有 end_turn / turn_duration 两个硬信号, 永远不置位。 */
  softTurnEnd?: boolean;
}

export interface CliBackend {
  /** Stable identifier used in config + logs. */
  name: CliBackendName;
  /** Executable name (resolved via $PATH) or absolute path. */
  bin: string;
  /** Config home, e.g. `~/.claude`. Locates settings.json + projects/. */
  homeDir: string;
  /** Transcript root: `<projectsDir>/<encoded(cwd)>/<sid>.jsonl`. */
  projectsDir: string;
  /** settings.json path inside the home dir. */
  settingsPath: string;
  /** Hook env var exporting the project cwd to child processes. */
  projectDirEnv: "CLAUDE_PROJECT_DIR" | "CODEBUDDY_PROJECT_DIR";
  /** Plugin root env var (for hooks.json `${VAR}` resolution). */
  pluginRootEnv: "CLAUDE_PLUGIN_ROOT" | "CODEBUDDY_PLUGIN_ROOT";
  /** Args required to emit `stream_event` content_block_delta lines in
   *  headless `-p --output-format stream-json` mode. Claude Code enables
   *  streaming via `--verbose`; CodeBuddy needs `--include-partial-messages`.
   *  Without these, cc-bridge falls back to the whole-assistant-message path
   *  (no typewriter effect, but still functional). */
  headlessStreamingArgs: readonly string[];
  /** Encode an absolute cwd path into the on-disk project dir segment. */
  encodeProjectDir: (absCwd: string) => string;
  /** Map a raw parsed jsonl line into the Claude Code TranscriptLine shape
   *  that mirror-bridge's renderLine consumes. Returns null to drop the line
   *  (e.g. codebuddy's reasoning / file-history-snapshot / ai-title records).
   *  Claude backends are identity — their jsonl is already in the target shape. */
  normalizeTranscriptLine: (raw: unknown) => NormalizedTranscriptLine | null;
}

// Claude + claude-internal: `/` and `.` → `-`, yields a leading `-`
// (e.g. /Users/zyy/foo → -Users-zyy-foo). Verified against ~/.claude/projects.
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");

// CodeBuddy: same char mapping but trims the leading separator first, so no
// leading `-` (e.g. /Users/zyy/foo → Users-zyy-foo).
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

// Module-level encoder, bound at daemon boot via bindCliBackends(). Defaults to
// Claude's dialect so the daemon works out-of-the-box. This is the PRIMARY
// backend's encoder — correct for *write* paths (where a new session's jsonl
// will land). Read paths must go through projectDirsFor/backendForPath instead,
// which consider every active backend.
let _encodeProjectDir: (absCwd: string) => string = encodeClaude;
export const encodeProjectDir = (absCwd: string): string => _encodeProjectDir(absCwd);

const makeClaude = (name: CliBackendName, bin: string): CliBackend => {
  const homeDir = name === "claude-internal" ? "~/.claude-internal" : "~/.claude";
  return {
    name,
    bin,
    homeDir,
    projectsDir: `${homeDir}/projects`,
    settingsPath: `${homeDir}/settings.json`,
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    pluginRootEnv: "CLAUDE_PLUGIN_ROOT",
    headlessStreamingArgs: ["--verbose"],
    encodeProjectDir: encodeClaude,
    // Claude Code jsonl is already in the TranscriptLine shape — identity pass.
    normalizeTranscriptLine: (raw) => raw as NormalizedTranscriptLine,
  };
};

// CodeBuddy jsonl adapter. Verified schema (2026-07-24, GLM-5.2 session):
//   message              → { type:"message", role:"user"|"assistant",
//                            content:[{type:"input_text"|"output_text", text}],
//                            id, parentId, status?, providerData:{agent,model,usage,...} }
//   function_call        → { type:"function_call", callId, name, arguments(JSON string),
//                            id(==host assistant msg id), parentId }
//   function_call_result → { type:"function_call_result", callId, name, status,
//                            output:{type:"text", text}, id, parentId }
//   reasoning            → { type:"reasoning", rawContent:[{type:"reasoning_text", text}] }
//                          → mapped to assistant message w/ a `thinking` block (think-style)
//   file-history-snapshot | ai-title | summary → drop
//
// Key structural differences from Claude Code:
//   1. content block types are input_text/output_text, not "text".
//   2. tool_use / tool_result are independent top-level records, not nested in
//      a message.content array. Adapter synthesizes assistant/user messages
//      around them so renderLine sees the Claude shape.
//   3. id/parentId → uuid/parentUuid.
//   4. Subagents live in <sid>/subagents/agent-<id>.jsonl — NOT inlined into
//      the main transcript — so no isSidechain filtering needed here.
//   5. Slash-command tags (<command-name> / <system-reminder>) are identical
//      to Claude Code — no tag-regex dialect dispatch needed.
//   6. /goal marker shape on disk: UNVERIFIED (blocker). The non-isMeta
//      fallback path in renderLine (goalStartOf on string content) should
//      catch it if codebuddy uses the same marker text, but this needs
//      confirmation from a real /goal session.
// CodeBuddy usage → snake_case shape that lastContextTokens / extractTokens expect.
const normalizeCbUsage = (pd: Record<string, unknown>) => {
  const u = pd.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const details = (u.inputTokensDetails ?? []) as Array<{ cached_tokens?: number }>;
  return {
    input_tokens: Number(u.inputTokens ?? 0),
    output_tokens: Number(u.outputTokens ?? 0),
    cache_read_input_tokens: details[0]?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
};

const normalizeCodebuddy = (raw: unknown): NormalizedTranscriptLine | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type as string | undefined;
  const id = r.id as string | undefined;
  const parentId = r.parentId as string | null | undefined;
  const providerData = (r.providerData ?? {}) as Record<string, unknown>;

  const uuids = { uuid: id, parentUuid: parentId ?? undefined };

  if (type === "message") {
    const role = r.role as string;
    const content = r.content as Array<{ type: string; text?: string }> | undefined;
    if (role === "user") {
      // Join input_text blocks into a single string. renderLine's string path
      // handles slash-command stripping, /goal marker detection, task-notification
      // rendering, and the isOwnInject dedup — all driven by string content.
      const text = (content ?? []).map((b) => b.text ?? "").join("");
      return { type: "user", ...uuids, message: { role: "user", content: text } };
    }
    if (role === "assistant") {
      const blocks: NormalizedContentBlock[] = (content ?? []).map((b) => ({
        type: "text",
        text: b.text ?? "",
      }));
      const msg = {
        role: "assistant",
        content: blocks,
        id: providerData.messageId as string | undefined,
        model: providerData.model as string | undefined,
        usage: normalizeCbUsage(providerData),
      };
      // status:"completed" 只说明这条记录写完了 —— codebuddy 把中途叙述和最终答复
      // 写成同形的独立 message, 映射成 stop_reason:"end_turn" 会让"中间说一句"就把
      // 整个 turn 收掉 (后半轮全部退化成散装气泡)。改为软收口, 交给 mirror-bridge
      // 用静默期确认。
      const status = r.status as string | undefined;
      return { type: "assistant", ...uuids, message: msg, softTurnEnd: status === "completed" };
    }
    return null;
  }

  if (type === "function_call") {
    const callId = r.callId as string;
    const name = r.name as string;
    const argsRaw = r.arguments as string;
    let input: unknown;
    try {
      input = argsRaw ? JSON.parse(argsRaw) : {};
    } catch {
      input = {};
    }
    return {
      type: "assistant",
      ...uuids,
      message: { role: "assistant", content: [{ type: "tool_use", id: callId, name, input }], usage: normalizeCbUsage(providerData) },
    };
  }

  if (type === "function_call_result") {
    const callId = r.callId as string;
    const output = r.output as { type?: string; text?: string } | undefined;
    const text = output?.text ?? "";
    return {
      type: "user",
      ...uuids,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text }] },
    };
  }

  // reasoning: thinking lives in rawContent:[{type:"reasoning_text", text}] (not
  // in content, which is empty). Map into a Claude-shape assistant message with
  // a `thinking` block so mirror-bridge's think-style path can pick it up.
  // No softTurnEnd — a reasoning record is never a turn boundary.
  if (type === "reasoning") {
    const rawContent = (r.rawContent ?? []) as Array<{ type?: string; text?: string }>;
    const thinking = rawContent
      .filter((b) => b?.type === "reasoning_text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n\n")
      .trim();
    if (!thinking) return null;
    return {
      type: "assistant",
      ...uuids,
      message: { role: "assistant", content: [{ type: "thinking", thinking }] },
    };
  }

  // file-history-snapshot / ai-title / summary → drop.
  return null;
};

const makeCodebuddy = (bin: string): CliBackend => ({
  name: "codebuddy",
  bin,
  homeDir: "~/.codebuddy",
  projectsDir: "~/.codebuddy/projects",
  settingsPath: "~/.codebuddy/settings.json",
  projectDirEnv: "CODEBUDDY_PROJECT_DIR",
  pluginRootEnv: "CODEBUDDY_PLUGIN_ROOT",
  // CodeBuddy: --verbose is a no-op for streaming; --include-partial-messages
  // is what emits stream_event content_block_delta lines. Keep --verbose too
  // for log parity — it's harmless and may surface diagnostics in debug mode.
  headlessStreamingArgs: ["--verbose", "--include-partial-messages"],
  encodeProjectDir: encodeCodebuddy,
  normalizeTranscriptLine: normalizeCodebuddy,
});

// Built-in defaults. `bin` is the default executable name; users override via
// `wrc.cliBackends.<name>.bin` in config.jsonc (or the legacy `wrc.claudeBin`
// for the claude / claude-internal backends — see resolveCliBackend).
export const CLI_BACKEND_DEFAULTS: Record<CliBackendName, CliBackend> = {
  claude: makeClaude("claude", "claude"),
  "claude-internal": makeClaude("claude-internal", "claude-internal"),
  codebuddy: makeCodebuddy("codebuddy"),
};

/** Minimal slice of Wrc that resolveCliBackend needs. */
export interface CliBackendsConfig {
  /** Active backend. Defaults to "claude". */
  defaultCli?: CliBackendName;
  /** Per-backend bin overrides. */
  cliBackends?: Partial<Record<CliBackendName, { bin?: string }>>;
  /** Legacy pre-v0.3 single-binary config — still honored for back-compat. */
  claudeBin?: string;
}

// Infer the default backend name from a legacy `claudeBin` basename. Only
// recognizes the two known forks; unknown bins fall back to "claude" (with
// the custom bin still preserved via the override path below).
const inferDefaultFromClaudeBin = (bin: string): CliBackendName => {
  const base = bin.split("/").pop() ?? bin;
  if (base === "claude-internal") return "claude-internal";
  if (base === "codebuddy") return "codebuddy";
  return "claude";
};

/**
 * Resolve the active backend, applying user overrides + legacy back-compat.
 *
 * Back-compat ladder (in priority order):
 *   1. Explicit `cliBackends.<name>.bin` override wins.
 *   2. `defaultCli` missing → infer from `claudeBin` basename (claude / claude-
 *      internal / codebuddy), else "claude".
 *   3. Legacy `claudeBin` set to a non-default value AND defaultCli points at
 *      the matching backend → carry `claudeBin` as the bin override. Preserves
 *      both `claudeBin: "/absolute/claude"` and `claudeBin: "claude-internal"`.
 */
export const resolveCliBackend = (cfg: CliBackendsConfig): CliBackend => {
  const name: CliBackendName = cfg.defaultCli ?? inferDefaultFromClaudeBin(cfg.claudeBin ?? "claude");
  const base = CLI_BACKEND_DEFAULTS[name];
  if (!base) throw new Error(`unknown CLI backend: ${name}`);
  const explicit = cfg.cliBackends?.[name]?.bin;
  if (explicit) return { ...base, bin: explicit };

  // Legacy `claudeBin` carries a non-default value → treat as bin override for
  // the backend it points at (matched by name, not by basename equality —
  // `/usr/local/bin/claude-internal` should still map to claude-internal).
  if (cfg.claudeBin && cfg.claudeBin !== "claude") {
    const inferred = inferDefaultFromClaudeBin(cfg.claudeBin);
    if (inferred === name) return { ...base, bin: cfg.claudeBin };
  }
  return base;
};

/**
 * Bind the active backend's dialect (encodeProjectDir) into module-level state.
 * Call once at daemon boot after loadConfig — flips mirror-bridge + spawn-tmux
 * to the resolved backend's project-dir encoding. Idempotent; re-binding on
 * daemon reload picks up a changed defaultCli without restart.
 */
export const bindCliBackend = (cfg: CliBackendsConfig): CliBackend => {
  const backend = resolveCliBackend(cfg);
  _encodeProjectDir = backend.encodeProjectDir;
  return backend;
};

// ── Multi-backend registry ──────────────────────────────────────────────
//
// The daemon mirrors sessions from EVERY installed CLI at once, not just the
// primary one: a user can have `claude` in one tmux pane and `codebuddy` in
// another, each bound to a different WeCom chat. Since a session's identity on
// disk *is* its transcript path, the path is the discriminant — `backendForPath`
// recovers which CLI wrote a jsonl, and every downstream decision (which binary
// to `--resume` with, which jsonl schema to normalize, which project-dir
// encoding to compare panes against) derives from that instead of a global.
//
// `primaryBackend()` remains the tie-breaker for *write* paths — spawning a new
// session has no path to derive from, so it uses `defaultCli`.

const backendWithBin = (name: CliBackendName, cfg: CliBackendsConfig): CliBackend => {
  const base = CLI_BACKEND_DEFAULTS[name];
  const explicit = cfg.cliBackends?.[name]?.bin;
  return explicit ? { ...base, bin: explicit } : base;
};

let _backends: readonly CliBackend[] = [CLI_BACKEND_DEFAULTS.claude];
let _primary: CliBackend = CLI_BACKEND_DEFAULTS.claude;

/** Active backends, primary first. Read-only snapshot of the last bind. */
export const activeBackends = (): readonly CliBackend[] => _backends;
/** Backend used when there is no path to derive one from (new-session spawns). */
export const primaryBackend = (): CliBackend => _primary;

/**
 * Resolve the primary backend and register every other known backend alongside
 * it. Zero-config: install codebuddy and its sessions become mirrorable without
 * touching config.jsonc.
 *
 * Deliberately does NOT probe for each root's existence. That probe ran once at
 * boot, so a CLI first used *after* the daemon started stayed invisible until a
 * reload — and it bought nothing: a nonexistent root never prefix-matches in
 * backendForPath, and every read path (rankedJsonlsForCwd, findJsonlBySid,
 * session-scan's roots) already tolerates a missing directory.
 */
export const bindCliBackends = (
  cfg: CliBackendsConfig & { projectsDirOverride?: string },
): { primary: CliBackend; backends: readonly CliBackend[] } => {
  const resolved = resolveCliBackend(cfg);
  // An explicit `mirror.projectsDir` retargets the PRIMARY backend only — it is
  // the pre-multi-CLI escape hatch for a nonstandard transcript root, and has no
  // meaning for the other backends.
  const override = (cfg.projectsDirOverride ?? "").trim();
  const primary: CliBackend =
    override && override !== resolved.projectsDir ? { ...resolved, projectsDir: override } : resolved;

  const secondaries = (Object.keys(CLI_BACKEND_DEFAULTS) as CliBackendName[])
    .filter((n) => n !== primary.name)
    .map((n) => backendWithBin(n, cfg));

  _primary = primary;
  _backends = [primary, ...secondaries];
  _encodeProjectDir = primary.encodeProjectDir;
  return { primary, backends: _backends };
};

/**
 * Register a backend as active at runtime, returning the already-known
 * descriptor if there is one. `bindCliBackends` only admits secondaries whose
 * transcript root already exists — a CLI that is installed but has never run
 * has none, so the FIRST session spawned with it would be invisible to
 * `backendForPath` (mirrored with the primary's jsonl dialect, resumed with the
 * primary's binary). Spawning with an explicit `cli` calls this so the registry
 * learns the backend before its transcript appears on disk.
 */
export const activateBackend = (backend: CliBackend): CliBackend => {
  const known = _backends.find((b) => b.name === backend.name);
  if (known) return known;
  _backends = [..._backends, backend];
  return backend;
};

/**
 * Recover the backend that owns an absolute transcript path, by longest
 * projectsDir prefix match. Falls back to primary for paths outside every known
 * root (custom `mirror.projectsDir`, or a jsonl handed in by `/wrc` from a
 * location we don't manage) — treating an unknown transcript as the primary
 * dialect is what the single-backend code already did.
 */
export const backendForPath = (absPath: string): CliBackend =>
  _backends
    .map((b) => ({ b, root: expandHome(b.projectsDir) }))
    .filter(({ root }) => absPath === root || absPath.startsWith(`${root}/`))
    .sort((x, y) => y.root.length - x.root.length)[0]?.b ?? _primary;

/**
 * Every candidate `<projectsDir>/<encoded(cwd)>` across active backends, primary
 * first. Callers filter by existence and rank by mtime — a cwd can legitimately
 * have transcripts under two backends at once (same project, both CLIs used).
 */
export const projectDirsFor = (absCwd: string): Array<{ backend: CliBackend; dir: string }> =>
  _backends.map((b) => ({ backend: b, dir: join(expandHome(b.projectsDir), b.encodeProjectDir(absCwd)) }));

/**
 * The project dir `cwd` would encode to *under the same backend that owns
 * `refPath`*. Used for "is this pane still in the project dir its transcript
 * lives in?" checks — comparing against the primary encoding would report a
 * spurious drift for every non-primary session.
 */
export const projectDirFor = (refPath: string, absCwd: string): string => {
  const b = backendForPath(refPath);
  return join(expandHome(b.projectsDir), b.encodeProjectDir(absCwd));
};
