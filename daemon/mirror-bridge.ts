// Mirror-mode bridge.
//
// Strategy: a running interactive `claude` exposes no local IPC. Its only
// shared surface is the append-only transcript at
//   ~/.claude/projects/<encoded(cwd)>/<session-id>.jsonl
// So:
//   • Inbound (WeCom → claude): spawn `claude --resume <sid> -p <text>` —
//     writes a new user/assistant turn into the SAME jsonl. Serialized per
//     session to avoid concurrent writers stomping each other.
//   • Outbound (claude → WeCom): tail that jsonl from the current EOF; every
//     new `assistant` line gets pushed to a configured WeCom chat.
//
// Caveat: the user shouldn't be hammering the same session in their local TTY
// while a `--resume` injection is in flight; Claude Code locks aren't strict.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import type { WSClient, WsFrame, WsFrameHeaders, EventMessageWith, TemplateCard, TemplateCardEventData } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import {
  activeBackends,
  backendForPath,
  type CliBackend,
  type CliBackendName,
  projectDirFor,
  projectDirsFor,
  type NormalizedTranscriptLine,
} from "../shared/cli-backends.js";
import { isModalPane, isAskqSubmitPage, parseModalOptions, pickModalAnswer, type ModalPaneVerdict } from "../shared/modal-pane.js";
import type { MirrorStore } from "./mirror-store.js";
import { hasMirrorAskq, runMirrorAskqFlow, hasMirrorPlan, mootMirrorPlan, runMirrorPlanFlow } from "./approval.js";
import { runTmux as runTmuxCmd, spawnTmuxClaude } from "./spawn-tmux.js";
import { recordTool, recordToolResult, recordTurnStart, recordTurnItem, recordTurnUsage, recordTurnClose, recordCloseOpenTurns, buildDetailUrl, buildChatUrl } from "./detail.js";
import type { CtxCut, TurnOrigin, TurnUsage } from "./detail.js";
import { labelFor, tagOfKey, baseOfKey, keyOf, withTagHeader } from "../shared/session-label.js";
import { splitMarkdown } from "../shared/md-chunk.js";
import { randomTip } from "./tips.js";
import { chatBaseOf, chatNameOf, listChatNames, normChatName, parsePeerRef, peerAddress } from "./chat-name.js";
import { stripAnsi, compactPane, paneIsBusy, paneIsStalled, transcriptStalled, summarizeTail, lastAssistantText, lastContextTokens, keepaliveStamps, tailTurns, renderDialog, type PeerInfo } from "./peers.js";

// Same PATH augmentation logic as cc-bridge: launchd / systemd start the daemon
// with a stripped PATH that often lacks nvm / homebrew, breaking spawn(claudeBin).
const NODE_BIN_DIR = dirname(process.execPath);
const augmentedPath = (orig: string | undefined): string => {
  const extras = [
    NODE_BIN_DIR,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
  ].filter(Boolean);
  const seen = new Set<string>();
  return [orig ?? "", ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(":");
};

// Backend resolution is per-transcript, not global: `backendForPath` recovers
// which CLI wrote a jsonl from its projects root, so claude / claude-internal /
// codebuddy sessions can be mirrored side by side. `projectDirFor` re-encodes a
// cwd under that same backend's dialect (Claude: leading `-`, CodeBuddy: none)
// so pane-drift comparisons stay apples-to-apples.

// Pull the bound session's actual project cwd from its transcript head. Each
// jsonl line carries a `cwd` field; the encoded directory name is lossy (both
// `/` and `.` collapse to `-`) so it can't be reversed — reading the file is
// the only faithful path. Used as the middle tier in attach()'s cwd resolution
// so /wrc-attached sessions reflect their real project in /pwd, /clear, /new,
// instead of falling back to the global cfg.wrc.cwd.
const readCwdFromJsonl = (path: string): string => {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    if (size === 0) return "";
    const fd = openSync(path, "r");
    const cap = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { cwd?: unknown };
        if (typeof j.cwd === "string" && j.cwd.trim()) return j.cwd.trim();
      } catch { /* partial / non-JSON line — skip */ }
    }
  } catch { /* unreadable — fall through */ }
  return "";
};

interface ResolvedSession {
  sessionId: string;
  jsonlPath: string;
}

// Every *.jsonl under `cwd`'s project dir, ranked newest-mtime first. A cwd can
// hold transcripts from more than one CLI (same project opened in claude and in
// codebuddy), so the default is the union across all active backends — that is
// what lets a fresh session be discovered regardless of which binary wrote it.
//
// `only` narrows to a single backend. Every path that RE-BINDS an existing
// attachment must pass it: healing a claude chat onto the codebuddy transcript
// that merely happens to be newer in the same directory would hand the chat to
// a session it can neither resume (`claude --resume` wouldn't find the sid) nor
// parse (wrong jsonl dialect). Only genuine discovery searches the union.
const rankedJsonlsForCwd = (
  cwd: string,
  only?: CliBackend,
  exclude?: Set<string>,
): Array<{ sessionId: string; jsonlPath: string; mtime: number }> =>
  projectDirsFor(expandHome(cwd))
    .filter(({ backend }) => !only || backend.name === only.name)
    .flatMap(({ dir }) => {
      let names: string[];
      try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
      return names.flatMap((n) => {
        const sid = n.replace(/\.jsonl$/, "");
        if (exclude?.has(sid)) return []; // already bound to another chat/peer — never steal it
        const p = join(dir, n);
        try { return [{ sessionId: sid, jsonlPath: p, mtime: statSync(p).mtimeMs }]; }
        catch { return []; }
      });
    })
    .sort((a, b) => b.mtime - a.mtime);

// Newest-mtime *.jsonl in the project dir(s) for `cwd`. A `/clear` (or a native
// `/new`) rotation always leaves a fresh jsonl here, so this is how the mirror
// re-finds the live session after a rotation it didn't itself record — used by
// resolveSession's auto-pick and by restoreFromStore's heal path.
const latestJsonlForCwd = (cwd: string, only?: CliBackend, exclude?: Set<string>): ResolvedSession | undefined => {
  const top = rankedJsonlsForCwd(cwd, only, exclude)[0];
  return top ? { sessionId: top.sessionId, jsonlPath: top.jsonlPath } : undefined;
};

// Locate a transcript by sessionId across every sibling project dir of every
// active backend. Claude Code's EnterWorktree/ExitWorktree relocate the SAME-sid
// jsonl between <cwd> and <cwd>/.claude/worktrees/<name> — each cwd encodes to
// its own project dir, so the path moves but the sid doesn't. It's a rename
// (byte prefix preserved), so a tail can follow it with a continuous offset.
// Newest-mtime wins if a stale sibling lingers.
const findJsonlBySid = (sid: string, only?: CliBackend): string | undefined => {
  const sidFile = `${sid}.jsonl`;
  return (only ? [only] : activeBackends())
    .flatMap((b) => {
      const root = expandHome(b.projectsDir);
      try { return readdirSync(root).map((d) => join(root, d, sidFile)); } catch { return []; }
    })
    .flatMap((p) => { try { return [{ p, m: statSync(p).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.m - a.m)[0]?.p;
};

// Backend-agnostic line adapter for the raw-jsonl predicates below. They were
// written against Claude's schema (type:"user", isMeta, string content) —
// codebuddy persists message/function_call records instead, so route every
// parsed line through the owning backend's adapter first (identity for claude).
const normalizeForPath = (path: string, raw: unknown): TranscriptLine | null =>
  backendForPath(path).normalizeTranscriptLine(raw) as TranscriptLine | null;

// Local-command noise on user lines: Claude marks the caveat / command-stdout
// records isMeta; codebuddy persists them as PLAIN user messages (no isMeta
// field at all). Predicates looking for the first REAL user line must skip
// both forms explicitly.
const isLocalCommandNoise = (content: unknown): boolean =>
  typeof content === "string" &&
  (content.includes('data-role="command-caveat"') || content.includes("<local-command-stdout>"));

// True if `path` holds at least one real (non-meta, non-sidechain) user line —
// i.e. it's a live session, not an empty just-touched jsonl. Bounded head read.
const jsonlHasUserLine = (path: string): boolean => {
  try {
    const size = statSync(path).size;
    const cap = Math.min(size, 256 * 1024);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = normalizeForPath(path, JSON.parse(line));
        if (j?.type === "user" && !j.isMeta && !j.isSidechain) return true;
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  return false;
};

// Search a jsonl's tail for a just-injected message fingerprint; return the
// byte offset of the START of the line containing it, or undefined. Used to
// rebind onto a same-dir fork that swallowed our inject (see armSilentForkRebind)
// — matching the exact text is what makes cross-session rebind safe when many
// sessions share one project dir. Bounded tail read (the inject is near EOF).
const findInjectOffset = (path: string, fp: string): number | undefined => {
  try {
    const size = statSync(path).size;
    const readLen = Math.min(size, 256 * 1024);
    const start = size - readLen;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(readLen);
    try { readSync(fd, buf, 0, readLen, start); } finally { closeSync(fd); }
    const chunk = buf.toString("utf8");
    const idx = chunk.lastIndexOf(fp);
    if (idx === -1) return undefined;
    const lineStart = chunk.lastIndexOf("\n", idx) + 1; // -1 → 0 (chunk head)
    return start + Buffer.byteLength(chunk.slice(0, lineStart), "utf8");
  } catch { return undefined; }
};

// Newest-mtime *.jsonl WITH user content in cwd's project dir(s), across all
// active backends. The content gate skips an empty just-touched file so we bind
// the real session. Reliable for worktree dirs (one session lives there);
// restore + the drift follower only consult it on cross-dir moves, where that
// assumption holds.
const liveSessionForCwd = (cwd: string, only?: CliBackend, exclude?: Set<string>): ResolvedSession | undefined => {
  for (const c of rankedJsonlsForCwd(cwd, only, exclude)) {
    if (jsonlHasUserLine(c.jsonlPath)) return { sessionId: c.sessionId, jsonlPath: c.jsonlPath };
  }
  return undefined;
};

const resolveSession = (cfg: Config, log: Logger): ResolvedSession | undefined => {
  const cwd = expandHome(cfg.wrc.cwd);
  const dirs = projectDirsFor(cwd).map(({ dir }) => dir).filter((d) => existsSync(d));
  if (dirs.length === 0) {
    log.error({ probed: projectDirsFor(cwd).map(({ dir }) => dir) }, "mirror: project dir not found (no CLI session ever ran in cwd?)");
    return undefined;
  }
  const pinned = cfg.wrc.mirror.sessionId.trim();
  if (pinned) {
    const p = dirs.map((d) => join(d, `${pinned}.jsonl`)).find((x) => existsSync(x));
    if (!p) {
      log.error({ pinned, dirs }, "mirror: pinned sessionId jsonl missing");
      return undefined;
    }
    return { sessionId: pinned, jsonlPath: p };
  }
  const top = latestJsonlForCwd(cwd);
  if (!top) {
    log.error({ dirs }, "mirror: no .jsonl in project dir");
    return undefined;
  }
  return top;
};

// ── Tail logic ────────────────────────────────────────────────────────
interface TailDeps {
  jsonlPath: string;
  log: Logger;
  includeUser: boolean;
  includeTools: boolean;
  includeToolResults: boolean;
  toolResultMaxChars: number;
  toolUseInlineMaxChars: number;
  isOwnInject: (text: string) => boolean;
  /** True when this assistant text was already pushed early from a pane capture
   *  (pre-card preamble). CC flushes a tool-terminated turn to the jsonl only
   *  after the tool resolves, so the tail re-emits text we already mirrored;
   *  suppress that one echo. One-shot — a genuine later re-say still streams. */
  isOwnAssistantSend?: (text: string) => boolean;
  onItem: (item: RenderItem) => void;
  /** Build a click-to-detail URL for a tool_use id; returns "" when disabled
   *  (cfg.daemon.detailLinksInMirror=false) so the tail can skip wrapping the
   *  bubble in a markdown link. `principal` is the originating chat key, used
   *  as ww_uniq so all detail links from one chat share one WeCom window. */
  detailUrlFor: (toolUseId: string, principal?: string) => string;
  /** Originating session/target for the detail page header. */
  sessionId: string;
  target: string;
  /** Backend-specific jsonl normalizer. Converts a parsed line from the
   *  active CLI's transcript schema into the Claude Code TranscriptLine shape
   *  that renderLine consumes. Returns null to drop the line. Claude backends
   *  are identity; codebuddy maps message/function_call/function_call_result
   *  records into the nested message.content shape. */
  normalizeLine?: (raw: unknown) => NormalizedTranscriptLine | null;
  /** Override the initial read offset. Default: current EOF (or 0 if missing).
   *  Used by /clear migration to replay the freshly-rotated jsonl from start —
   *  the user line dedupes via isOwnInject, assistant lines stream normally. */
  startOffset?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  // thinking block ({type:"thinking", thinking:"..."})
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string; tool_name?: string }>;
}

interface TranscriptLine {
  type?: string;
  /** Present on `type:"system"` lines — e.g. "local_command" for slash-command
   *  invocation records. */
  subtype?: string;
  /** Top-level content for `type:"system"` lines (distinct from message.content
   *  used on user/assistant lines). Slash-command invocation lands here as
   *  `<command-name>/foo</command-name>...`. */
  content?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    /** Anthropic Messages API stop_reason — present on assistant turns. We
     *  treat `end_turn` / `stop_sequence` / `max_tokens` as "turn truly done"
     *  signals to immediately finalize the live WeCom bubble (so it's
     *  quotable without waiting for the next inbound or the 6-min hard
     *  timeout). `tool_use` is NOT terminal — more turns will follow. */
    stop_reason?: string;
    /** Anthropic message id — used to dedupe usage accounting: one API response
     *  can be split into multiple assistant lines (e.g. thinking + tool_use),
     *  each carrying the same usage snapshot. Same id ⇒ same API call. */
    id?: string;
    /** Model name (e.g. "claude-4.7-opus") on assistant lines. Extracted into
     *  turn store so the detail page can display it as a muted chip. */
    model?: string;
    /** Per-API-call usage snapshot on assistant lines. Each assistant line has
     *  its own independent counts; a multi-tool turn spans several lines and
     *  needs field-level accumulation in the turn store. */
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
  /** 见 NormalizedTranscriptLine.softTurnEnd —— 后端只能确认"这条消息写完了"。 */
  softTurnEnd?: boolean;
}

// Target keys are `user:xxx[#tag]` / `chat:xxx[#tag]`. Strip the principal
// prefix AND the `#tag` suffix so WeCom's sendMessage receives just the bare
// chatid/userid. Tag survives only inside the daemon's byTarget/store keys.
const stripPrincipalPrefix = (s: string): string => {
  const i = s.indexOf(":");
  const rest = i >= 0 ? s.slice(i + 1) : s;
  const h = rest.indexOf("#");
  return h >= 0 ? rest.slice(0, h) : rest;
};

// Extract the `#tag` suffix from a target key, "" if untagged.
const tagOfTarget = tagOfKey;

// Drop the `#tag` suffix — collapses tagged session keys to the chat-scoped
// base principal. Shared with the peer/graph layer via session-label.
const basePrincipalOf = baseOfKey;

// Prefix outbound content with `<emoji> #tag` header (blank line separator)
// when the target carries a `#tag` suffix. Untagged targets pass through
// unchanged — default session keeps its plain-bubble UX.
const withSessionTag = withTagHeader;

// Claude Code wraps slash-command invocations into the user message as
//   <command-message>name</command-message>
//   <command-name>/name</command-name>
//   <command-args>...</command-args>
// plus assorted <local-command-stdout>, <local-command-caveat>,
// <system-reminder> blocks. Rendering those raw to WeCom is pure noise.
//
// Strategy: extract /cmd + args into a single styled line; strip the rest.
// Returns "" when the message is purely meta — caller filters.
// Opening tag tolerates attributes: codebuddy emits e.g.
// `<system-reminder data-role="command-caveat">` (verified 100+ on disk) —
// a bare `<tag>` match lets the whole caveat leak into the WeCom bubble.
const SLASH_TAG_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const SLASH_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const META_TAG_RE = /<(command-message|command-name|command-args|local-command-stdout|local-command-caveat|system-reminder|task-notification)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
const TASK_NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;

// Claude Code's `/goal` installs a session-scoped Stop hook and injects this
// marker (type:"user", plain string content) telling the model to self-drive
// toward the condition. Crucially the model then NEVER emits a terminal
// stop_reason — every assistant line stays stop_reason:"tool_use" until the goal
// auto-clears — so `turn_end` (and thus brief-mode's closeBriefTurn / any
// per-turn flush) never fires, and the entire run goes silent on WeCom. Detect
// the marker on a stable English substring so the mirror can enter a
// progress-streaming mode for the goal's duration.
const GOAL_START_RE = /session-scoped Stop hook is now active with condition:\s*"?([^"\n]*)"?/;

// Pure: goal marker → goal_start item. The marker line ships as `type:"user",
// isMeta:true, content:string` (verified against real /goal transcripts), so
// detection MUST run before renderLine's isMeta gate — behind it the signal is
// dropped and the whole goal adaptation never engages.
const goalStartOf = (c: unknown): RenderItem | undefined => {
  if (typeof c !== "string") return undefined;
  const m = c.match(GOAL_START_RE);
  return m ? { kind: "goal_start", condition: (m[1] ?? "").trim() } : undefined;
};

// Background task completion notification (Claude Code emits these into the
// user channel when a backgrounded Bash/Agent task finishes). Render the
// summary + status as a single styled line; drop the noisy tool-use-id /
// output-file fields.
const renderTaskNotification = (block: string): string => {
  const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
  const status = block.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? "";
  const icon = status === "completed" ? "✅" : status === "failed" || status === "error" ? "❌" : "🏁";
  return `${icon} ${summary || `后台任务 ${status || "完成"}`}`;
};

const cleanUserText = (raw: string): string => {
  const nameMatch = raw.match(SLASH_TAG_RE);
  const slashCmd = nameMatch?.[1]?.trim() ?? "";
  const argsMatch = raw.match(SLASH_ARGS_RE);
  const slashArgs = argsMatch?.[1]?.trim() ?? "";
  const stripped = raw.replace(META_TAG_RE, "").trim();
  if (slashCmd) {
    const head = `\`${slashCmd}${slashArgs ? ` ${slashArgs}` : ""}\``;
    return stripped ? `${head}\n${stripped}` : head;
  }
  return stripped;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;

const renderToolInput = (input: unknown): string => {
  try {
    const json = JSON.stringify(input ?? {}, null, 0);
    return truncate(json, 600);
  } catch {
    return "{}";
  }
};

const extractToolResultText = (block: ContentBlock): string => {
  const c = block.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (typeof b?.text === "string" ? b.text : b?.tool_name ? `→ ${b.tool_name}` : ""))
    .filter(Boolean)
    .join("\n");
};

// detail 页用的存储上限 — 远大于聊天气泡的 toolResultMaxChars(默认 400),
// 确保点开"详情"能看到工具调用的完整 result, 不再受气泡截断的影响。
const DETAIL_RESULT_MAX = 64 * 1024;

// Tagged render output: items append in-order into the live replyStream. Tool
// items render as plain body lines; the full input/result is carried out
// of band on the item so the caller can register them for click-to-detail.
type RenderItem =
  | { kind: "text"; body: string; final?: boolean }
  // 只驱动 brief 气泡的 CoT 进度行 —— 正文/standalone/detail 所有通道都不收它。
  | { kind: "thinking"; body: string }
  // CLI-side user line (not a WeCom inject). Marks a turn boundary that did
  // NOT originate from the still-open WeCom liveStream — onItem uses this to
  // finalize the prior bubble so the new conversation gets its own bubble.
  | { kind: "user_text"; body: string }
  // Claude Code's /goal command was activated (session-scoped Stop hook marker
  // detected in the transcript). Carries the goal condition. onItem switches the
  // attachment into goal-progress mode — see handleGoalItem. Emitted regardless
  // of includeUser, because a goal run never emits a terminal stop_reason and
  // brief-mode's turn_end-gated flush would otherwise swallow the whole run.
  | { kind: "goal_start"; condition: string }
  // Skill stdout (e.g. /model). Always emitted as a standalone bubble — bypasses
  // deferred-state filtering so the user sees /model output even when no
  // assistant turn is active. `quiet` 例外: subagent/后台任务完成通知 —— 主 agent
  // 随后自己会把结论说进本轮答复里, 单独再推一条只是重复噪声。只记进 turn/detail,
  // 不发气泡。
  | { kind: "skill_output"; body: string; quiet?: boolean }
  | {
      kind: "tool_use";
      body: string;
      // calls.length === 1 是普通工具调用; > 1 是同一 assistant 行里连续相同
      // tool name 的批量调用 (e.g. 并行 3 个 Bash) 聚合后的结果。
      calls: Array<{ toolUseId: string; name: string; input: unknown }>;
    }
  | { kind: "tool_result"; body: string; toolUseId: string; full: string }
  // Assistant turn ended. Emitted AFTER any text/tool_use items from the same
  // line so onItem can finalize the bubble once the content has been appended.
  // Pure signal — no body to render.
  //   • 硬信号 (soft 缺省): stop_reason==="end_turn" 的终态行, 或 system/turn_duration。
  //   • soft:true: 后端只能说"这条消息写完了" (codebuddy), 需静默期确认才作数。
  | { kind: "turn_end"; soft?: boolean }
  // Per-assistant-line usage snapshot (model + token counts). Consumed only in
  // brief mode where it's fed into the turn store for aggregate chip display.
  // Non-brief onItem drops it silently — no bubble, no stream side effect.
  | { kind: "turn_usage"; model?: string; messageId?: string; usage: TurnUsage };

const oneLineSummary = (s: string, max = 40): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
};

// WeCom's markdown sanitizer strips HTML-like `<...>` runs even inside inline
// code spans — so a Bash command containing `<<'EOF'` (heredoc), `<file>`,
// `<noreply@x>` etc. silently swallows the rest of the line plus the closing
// backtick, eating subsequent items. A literal backtick inside `compact` also
// closes the surrounding inline-code prematurely; `[`/`]` break the
// enclosing `[text](url)` link by re-anchoring the text span.
// Replace with full-width / similar glyphs: visually close, harmless to the
// renderer. Applied to the user-controlled part only — surrounding markdown
// structure (the wrapping ``…``, `[…](…)` and `> ↩ ` prefix) stays literal.
const safeForMarkdown = (s: string): string =>
  s
    .replace(/`/g, "ʼ")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    // \( \) is LaTeX inline-math in WeCom desktop renderer → contents render
    // italic and the link span breaks. Keep the backslash for fidelity, swap
    // to full-width parens so the math tokenizer no longer recognizes it.
    // (\[ \] is already neutralized above by the [/] replacement.)
    .replace(/\\\(/g, "\\（")
    .replace(/\\\)/g, "\\）");

const renderToolInputCompact = (input: unknown, max: number): string => {
  // Heuristic: prefer command/file_path/pattern-like keys for the inline summary.
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return oneLineSummary(pick, max);
  }
  return oneLineSummary(renderToolInput(input), max);
};

// 渲染一组同名 tool_use:
//   • 单次  → `🔧 [Name compact](url)`            (与原行为一致)
//   • 多次  → 聚合为一个 markdown 块:
//       🔧 Name × N
//       [• compact1](url1)
//       [• compact2](url2)
// 多次的每条仍是独立 link, 各自指向自己的 detail URL。
const renderToolUseGroupBody = (
  calls: Array<{ toolUseId: string; name: string; input: unknown }>,
  deps: TailDeps,
): string => {
  const renderOne = (c: { toolUseId: string; input: unknown }): { compact: string; url: string } => ({
    compact: safeForMarkdown(renderToolInputCompact(c.input, deps.toolUseInlineMaxChars)),
    url: deps.detailUrlFor(c.toolUseId, deps.target),
  });
  if (calls.length === 1) {
    const c = calls[0]!;
    const { compact, url } = renderOne(c);
    return url ? `🔧 [${c.name} ${compact}](${url})` : `🔧 ${c.name} ${compact}`;
  }
  const header = `🔧 ${calls[0]!.name} × ${calls.length}`;
  const lines = calls.map((c) => {
    const { compact, url } = renderOne(c);
    return url ? `[• ${compact}](${url})` : `• ${compact}`;
  });
  return [header, ...lines].join("\n");
};



// Render one transcript line into tagged items. Caller decides batching.
const renderLine = (raw: string, deps: TailDeps): RenderItem[] => {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw) as TranscriptLine;
  } catch {
    return [];
  }
  // Phase 3: normalize backend-specific jsonl (codebuddy splits tool_use /
  // tool_result into independent top-level records; Claude is identity). Done
  // AFTER JSON.parse so the adapter works on structured data, BEFORE the
  // isMeta/isSidechain gates so backend-mapped fields flow through.
  if (deps.normalizeLine) {
    const normalized = deps.normalizeLine(line);
    if (!normalized) return [];
    line = normalized as TranscriptLine;
  }
  if (line.isSidechain) return [];
  if (line.isMeta) {
    // isMeta 行整体丢弃, 唯一例外是 /goal 的激活 marker (isMeta:true 的 user
    // 行) — 它是 goal 模式的进入信号, 吞掉它 = 整个 goal run 在 WeCom 静默。
    const goal = line.type === "user" ? goalStartOf(line.message?.content) : undefined;
    return goal ? [goal] : [];
  }

  const out: RenderItem[] = [];

  if (line.type === "user") {
    const c = line.message?.content;
    if (typeof c === "string") {
      // Skill/system feedback (e.g. `/model`'s "Set model to …", background
      // task completions) is emitted REGARDLESS of includeUser — it's system
      // output, not the user's own chatter, so the includeUser=false default
      // (which suppresses echoing user lines) must not swallow it.
      // Match against raw content BEFORE cleanUserText strips the tag.
      const stdoutMatch = c.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (stdoutMatch && stdoutMatch[1]) {
        const skillOutput = stdoutMatch[1].replace(/\[[0-9;]*m/g, "").trim();
        if (skillOutput) {
          out.push({ kind: "skill_output", body: `⚙️ ${skillOutput}` });
        }
        return out;
      }

      // Background task completion — strip the raw tag soup and render
      // a single styled line. quiet: 这是 subagent 的回执, 不单独推给聊天。
      const taskMatch = c.match(TASK_NOTIF_RE);
      if (taskMatch && taskMatch[1]) {
        out.push({ kind: "skill_output", body: renderTaskNotification(taskMatch[1]), quiet: true });
        return out;
      }

      // /goal activation — non-isMeta 形态兜底 (marker 格式漂移防御), emit
      // REGARDLESS of includeUser; isMeta 形态已在上方 isMeta 门截获。
      const goal = goalStartOf(c);
      if (goal) return [goal];

      if (!deps.includeUser) return [];

      const text = cleanUserText(c);
      if (!text) return []; // pure slash-command meta / stdout — drop
      if (deps.isOwnInject(text)) return []; // dedupe WeCom→CLI echo
      const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
      out.push({ kind: "user_text", body: quoted });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const raw = extractToolResultText(b);
        if (!raw) continue;
        const toolUseId = b.tool_use_id ?? "";
        const full = truncate(raw, DETAIL_RESULT_MAX);
        // 始终把完整 result 落 detail 库 + 作为 tool_result item 发出 — 与
        // includeToolResults(气泡推送开关)彻底解耦: 关掉气泡时 detail 页与 brief
        // turn 页(handleBriefItem 消费本 item 写 turn store)都仍要看到 result。
        // 气泡推送的 gate 挪到非-brief 消费端 (onItem), 见下方 includeToolResults 判断。
        if (toolUseId) recordToolResult(toolUseId, full);
        const compact = safeForMarkdown(oneLineSummary(full, 40));
        const url = deps.detailUrlFor(toolUseId, deps.target);
        out.push({
          kind: "tool_result",
          toolUseId,
          full,
          body: url ? `[↩ ${compact}](${url})` : `↩ ${compact}`,
        });
      }
    }
    return out;
  }

  if (line.type === "assistant") {
    const blocks = line.message?.content;
    if (!Array.isArray(blocks)) return [];
    // Mark text items emitted from a terminal-stop_reason line as `final`.
    // Per Anthropic protocol, an `end_turn` line contains only text blocks
    // (tool_use → stop_reason="tool_use"),
    // so these texts ARE the agent's final answer for the turn. Downstream uses
    // `final` to decide bubble splits — mid-turn text appends; only final text
    // after tools peels out into its own standalone (preview = real answer).
    // 只认 end_turn。另两个终态在 CC 落盘语义里都不是"这一轮说完了":
    //   • stop_sequence —— 实测 152 次里 ~150 次是 CC 合成的错误/限额行
    //     ("API Error: …" / "You've hit your session limit" / "No response
    //     requested."), 其中可重试的那种 (stalled mid-stream / ECONNRESET) CC 会
    //     自动续跑同一轮, 在它上面收口 = turn 中途断掉。真正终止的那些后面必跟
    //     system/turn_duration, 由下方权威信号兜住, 不会漏收。
    //   • max_tokens —— 语义是"消息被截断", CC 继续同一轮; 全量 transcript 0 命中。
    const sr = line.message?.stop_reason;
    const isFinal = sr === "end_turn";
    // final 是三态: true=终句, false=已知的中途输出, undefined=后端说不清 (软收口)。
    // 软后端不能填 false —— 那会让每句叙述都被当成中途输出标记上 briefHadTool, 一句
    // 话答完的 turn 也要被当成"有工具"处理。
    const textFinal = isFinal ? true : line.softTurnEnd ? undefined : false;
    let pending: Array<{ toolUseId: string; name: string; input: unknown }> = [];
    const flushPending = (): void => {
      if (pending.length === 0) return;
      const calls = pending;
      pending = [];
      // 每个 tool_use 都要单独 recordTool, 这样点击-查看-详情可以按 id 命中。
      for (const c of calls) {
        if (c.toolUseId) {
          recordTool({
            id: c.toolUseId,
            toolName: c.name,
            toolInput: c.input,
            sessionId: deps.sessionId,
            target: deps.target,
          });
        }
      }
      out.push({
        kind: "tool_use",
        calls,
        body: renderToolUseGroupBody(calls, deps),
      });
    };
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        flushPending();
        const t = b.text.trim();
        if (t && !deps.isOwnAssistantSend?.(t)) out.push({ kind: "text", body: t, final: textFinal });
      } else if (b?.type === "tool_use" && deps.includeTools) {
        const name = b.name ?? "tool";
        const toolUseId = b.id ?? "";
        // 同名扩展当前 group; 不同名先 flush 再起新组。
        if (pending.length > 0 && pending[0]!.name !== name) flushPending();
        pending.push({ toolUseId, name, input: b.input });
      } else if (b?.type === "thinking" && typeof b.thinking === "string") {
        // codebuddy 的 reasoning 记录已被 normalizeLine 归一成这个形状。
        // 只作为 CoT 进度源发出: onItem 里它唯一的下游是 brief 进度行, 不进正文。
        const thought = b.thinking.trim();
        if (thought) out.push({ kind: "thinking", body: thought });
      }
    }
    flushPending();
    // Emit per-line usage snapshot BEFORE turn_end so brief store gets the last
    // increment before the turn closes. Non-brief onItem drops it silently.
    const u = line.message?.usage;
    if (u) {
      const model = typeof line.message?.model === "string" ? line.message.model : undefined;
      const messageId = typeof line.message?.id === "string" ? line.message.id : undefined;
      const rawIn = u.input_tokens ?? 0;
      const cr = u.cache_read_input_tokens ?? 0;
      const cw = u.cache_creation_input_tokens ?? 0;
      // 网关把 input_tokens 报成 cr+cw+fresh 的总和 (claude-4.7-opus, deepseek-v4-flash),
      // 而 Anthropic 官方 input_tokens 只含 fresh (与 cache_creation/cache_read disjoint)。
      // 判据用数据本身: input_tokens 是否已覆盖两个 cache 档 —— 覆盖即网关口径, 反推 fresh;
      // 否则按原生口径 (input 即 fresh) 原样保留。不按模型名风格猜, deepseek 无点号版本。
      const isTotalized = rawIn >= cr + cw;
      const input = isTotalized ? rawIn - cr - cw : rawIn;
      out.push({
        kind: "turn_usage",
        model,
        messageId,
        usage: {
          input,
          output: u.output_tokens ?? 0,
          cacheRead: cr,
          cacheWrite: cw,
          serviceTier: u.service_tier,
          calls: 1,
        },
      });
    }
    // Terminal stop_reason → emit turn_end so onItem closes the live bubble.
    // `tool_use` is intentionally excluded — more turns will follow once the
    // tool result lands; finalizing now would split a single logical reply.
    //
    // 但 stop_reason 是 **消息级** 字段, 而 CC 把同一个 message.id 拆成多行落盘
    // (thinking / text / tool_use 各占一行), 每行都原样带着这个 stop_reason ——
    // 终态消息的 thinking 行先落盘, 就已经是 end_turn 了。在它上面收口 = turn 提前
    // 结束: 紧随其后的真正答案(text 行)落在已关闭的 turn 之外, 只能走 standalone,
    // 且此后整轮的 tool/text 全部退化成散装气泡。终态消息里必然有 text 块 (含
    // tool_use 的消息 stop_reason 恒为 "tool_use"), 且实测终态消息从不拆出第二个
    // text 行 —— 所以"本行带 text 块"精确等价于"本消息的最后一行"。
    if (isFinal && blocks.some((b) => b?.type === "text")) out.push({ kind: "turn_end" });
    // 软收口 (codebuddy): 这条消息写完了, 但说不出后面还有没有 function_call。
    else if (line.softTurnEnd) out.push({ kind: "turn_end", soft: true });
    return out;
  }

  // CC (≥2.1.198) 在一轮真正跑完后写一行 `system/turn_duration` —— 权威收口信号。
  // 补上 stop_reason 路径覆盖不到的场景: 被 esc 打断的 turn 只剩 thinking 行, 永远
  // 没有终态 text 行, 否则 brief turn 会一直挂到 hardTimer。与 stop_reason 收口重复
  // 时无害 —— closeBriefTurn / finalizeStream 都是幂等的。goal 模式下 Stop hook 拦住
  // 了收尾, CC 不写这一行, 所以不会把自主执行提前踢出 goal 模式。
  if (line.type === "system" && line.subtype === "turn_duration") return [{ kind: "turn_end" }];

  // Slash-command records for TUI-only commands land here as `type:"system"`,
  // `subtype:"local_command"` — the invocation itself and, if present, a
  // sibling `<local-command-stdout>` line carrying the rendered panel.
  //   • /context (2.1.139+): dumps the full panel as ANSI-decorated text.
  //   • /model on Claude Code 2.1.139 still lands under `type:"user"`, so this
  //     branch is currently /context-focused; other future TUI-only commands
  //     that follow the same shape will fall through the same anchoring.
  if (line.type === "system" && line.subtype === "local_command" && typeof line.content === "string") {
    const stdout = line.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1] ?? "";
    if (!stdout.trim()) return []; // pure invocation record or empty stdout
    const cleaned = stripAnsi(stdout);
    const anchored = anchorSkillOutput(cleaned);
    if (!anchored) return [];
    // Fenced code block so WeCom renders the aligned /context panel monospaced
    // (the bar-chart columns only line up in a fixed-width bubble).
    return [{ kind: "skill_output", body: "⚙️\n```\n" + anchored + "\n```" }];
  }

  return [];
};

// Block-wise packing (shared/md-chunk): never cuts mid-line, and never cuts a
// fenced block or table in a way that breaks rendering — see splitMarkdown.
const splitChunks = splitMarkdown;

// Room reserved in every chunk for the `emoji \`#tag\` \`2/5\`` header line
// (up to ~110 bytes in its linked `[🧙 #tag](url)` form).
const TAG_HEADER_BUDGET = 64;

interface TailHandle {
  stop: () => void;
  /** Synchronously pull and emit any newly-appended jsonl lines. fs.watch
   *  usually fires fast enough but the approval card path needs a hard barrier
   *  before sending: callers can force the tail to catch up so any pending
   *  assistant text is queued onto the mirror's outbound paths first. */
  drain: () => void;
}

export const startMirrorTail = (deps: TailDeps): TailHandle => {
  const { log } = deps;

  // A single logical tail follows ONE sessionId whose transcript file may move
  // between sibling project dirs — Claude Code's EnterWorktree/ExitWorktree
  // rename <sid>.jsonl into/out of <cwd>/.claude/worktrees/<name>, each cwd
  // encoding to its own project dir. We keep a candidate path list (seeded with
  // the attach-time path, grown lazily by sid on first miss) and ONE shared
  // offset. Because the move is a rename (byte prefix preserved), the offset
  // stays continuous across enter→work→exit: no re-dump, no missed lines, and
  // switching back to the original path just resumes on the same offset.
  // The sid search is scoped to the backend owning this transcript — a sid from
  // another CLI is never ours, however recently it was written.
  const candidates: string[] = [deps.jsonlPath];

  // Newest-mtime candidate that currently exists (the move can briefly leave a
  // stale sibling behind under copy-then-delete semantics; the destination wins).
  const existing = (): string | undefined =>
    candidates
      .flatMap((p) => { try { return [{ p, m: statSync(p).mtimeMs }]; } catch { return []; } })
      .sort((a, b) => b.m - a.m)[0]?.p;

  // Live path: a known candidate if one exists; else the file relocated — find
  // it by sid and cache so subsequent round-trips are a pure stat pick (no rescan).
  const resolveLive = (): string | undefined => {
    const known = existing();
    if (known) return known;
    const found = findJsonlBySid(deps.sessionId, backendForPath(deps.jsonlPath));
    if (found && !candidates.includes(found)) candidates.push(found);
    return existing();
  };

  // Start at EOF — don't re-emit history. File may not exist yet (auto-spawn
  // path: claude doesn't create the jsonl until it processes the first input);
  // start at 0 in that case so we capture everything once it appears.
  // Caller-provided startOffset wins (used by /clear migration to replay the
  // already-written user line + any early assistant lines from offset 0).
  let offset = deps.startOffset !== undefined
    ? deps.startOffset
    : (() => { const p = resolveLive(); return p ? statSync(p).size : 0; })();
  let buffer = "";
  let stopped = false;

  // fs.watch binds one path; re-arm it on the live path whenever the file
  // relocates. The 1s poll is the correctness floor either way.
  let watcher: FSWatcher | undefined;
  let watchedPath = "";
  const armWatch = (path: string): void => {
    if (path === watchedPath) return;
    watcher?.close();
    watchedPath = path;
    try {
      watcher = watch(path, { persistent: false }, () => drain());
    } catch (e) {
      watcher = undefined;
      log.warn({ err: (e as Error).message }, "fs.watch failed; relying on poll");
    }
  };

  const drain = (): void => {
    if (stopped) return;
    const jsonlPath = resolveLive();
    if (!jsonlPath) return;
    armWatch(jsonlPath);
    let size: number;
    try {
      size = statSync(jsonlPath).size;
    } catch {
      return;
    }
    if (size < offset) {
      // file truncated/rotated — reset to new EOF
      offset = size;
      buffer = "";
      return;
    }
    if (size === offset) return;
    const fd = openSync(jsonlPath, "r");
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = size;
      buffer += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      for (const item of renderLine(line, deps)) deps.onItem(item);
    }
  };

  const live0 = resolveLive();
  if (live0) armWatch(live0);
  const poll = setInterval(drain, 1000);

  log.info({ jsonlPath: deps.jsonlPath, startOffset: offset }, "mirror tail started");

  return {
    stop: () => {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
    drain,
  };
};

// ── Inject (WeCom → claude) ───────────────────────────────────────────
// Two strategies:
//  • spawn  — `claude --resume <sid> -p <text>`. Writes a turn into the jsonl,
//             but the live interactive TTY claude (a different process) won't
//             observe it. Outbound tail still picks it up → user sees response
//             in WeCom only.
//  • tmux   — paste into the live TTY via tmux. Indistinguishable from the
//             user typing; claude processes normally → response visible in BOTH
//             the CLI and (via outbound tail) WeCom. Required for true mirror.
interface InjectArgs {
  text: string;
  /** Image absolute paths. injectViaTmux pumps each via clipboard+Ctrl+V before
   *  the text paste; injectViaSpawn prepends `@<path>` to text. */
  images?: string[];
  cfg: Config;
  log: Logger;
  sessionId: string;
  /** Bound transcript path. Identifies which CLI owns the session, so the
   *  spawn-mode inject resumes it with THAT binary — resuming a codebuddy
   *  session with `claude` (or vice versa) just errors "session not found". */
  jsonlPath: string;
  /** tmux pane (e.g. `%5`) auto-discovered from caller's $TMUX_PANE at attach time. Empty → spawn-mode inject (writes to jsonl only, not the live TTY). */
  tmuxTarget?: string;
  /** Set when this inject runs immediately after a `claude --resume` respawn:
   *  the TUI is still loading the transcript and bracketed-paste end can take
   *  several extra seconds to be processed, so the verifier uses extended
   *  timeouts. False (default) keeps warm-pane behavior untouched. */
  freshSpawn?: boolean;
}

// Run a tmux subcommand, capturing stdout/stderr. Delegates to spawn-tmux's
// runTmux so there is exactly ONE tmux exec path in the daemon — and therefore
// exactly one place where the hard timeout lives. (Two hand-rolled copies used
// to exist here; both could hang forever, which is how a wedged tmux server
// silently killed a whole chat. See TMUX_TIMEOUT_MS.)
const tmuxRun = (args: string[], opts?: { stdin?: string }): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> =>
  runTmuxCmd(args, opts);

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Stable JSON: sort object keys recursively. Used to fingerprint a tool_use's
// `input` so the hook-side and the jsonl-side compute the same signature even
// when the model emits keys in arbitrary order.
const stableStringify = (v: unknown): string => {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
};
const toolUseSig = (name: string, input: unknown): string => `${name}|${stableStringify(input)}`;
const RECENT_SIGS_MAX = 64;

// macOS clipboard image inject. Claude Code's TUI handles Ctrl+V by reading the
// system clipboard for image data and attaching it as an image content block in
// the next user turn — no Read tool call, no permission prompt. To trigger that
// path we (a) put image bytes onto the clipboard with the right AppleScript
// pasteboard class, (b) send a literal C-v keystroke to the live tmux pane.
//
// Pasteboard class per source format:
//   .png         → «class PNGf»
//   .jpg/.jpeg   → JPEG picture
//   .gif         → «class GIFf»
//   .tiff/.tif   → «class TIFF»
// Anything else (webp/heic/...) we transcode to PNG via `sips` first; sips ships
// with macOS so no extra dep. Files are cached next to the original; cleanup is
// left to the inbox dir's regular eviction.
//
// 注入策略 —— JXA 主路径 + AppleScript 兜底：
//   codebuddy v2.72.0 的 release note 明确说"macOS 图片粘贴新增 JXA NSPasteboard
//   后备方案，兼容企业微信等第三方截图工具"——说明 codebuddy 的 TUI 在主路径
//   (AppleScript «class PNGf») 读不到图时，会走 JXA `$.NSPasteboard.generalPasteboard`
//   后备。我们显式用 JXA 写一份 `NSPasteboardTypePNG` flavor，保证 codebuddy 的
//   后备路径一定能读到；同时 `NSPasteboardTypePNG` 和 `«class PNGf»` 在系统层是
//   同一个 UTI (public.png)，Claude Code 的主路径读 JXA 写入的 flavor 也没问题。
//   JXA 失败（极少见，比如 AppKit 框架加载失败）才回退到纯 AppleScript。
const PB_CLASS_BY_EXT: Record<string, string> = {
  png: "«class PNGf»",
  jpg: "JPEG picture",
  jpeg: "JPEG picture",
  gif: "«class GIFf»",
  tif: "«class TIFF»",
  tiff: "«class TIFF»",
};

// Same no-unbounded-await rule as runTmux: this sits on the inject path (image
// pump), and `osascript` in particular can block indefinitely if macOS decides
// to raise an automation-permission prompt nobody is there to answer. 30s is
// generous for a sips transcode of a large screenshot.
const PROC_TIMEOUT_MS = 30_000;

const runProc = (cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    let settled = false;
    const finish = (r: { ok: boolean; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish({ ok: false, stderr: `${cmd} timeout after ${PROC_TIMEOUT_MS}ms` });
    }, PROC_TIMEOUT_MS);
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", (e) => finish({ ok: false, stderr: e.message }));
    p.on("close", (code) => finish({ ok: code === 0, stderr: err }));
  });

const setMacClipboardImage = async (imgPath: string): Promise<{ ok: boolean; reason?: string }> => {
  const ext = (imgPath.split(".").pop() ?? "").toLowerCase();
  let pbClass = PB_CLASS_BY_EXT[ext];
  let pathToUse = imgPath;
  if (!pbClass) {
    // Transcode to PNG so AppleScript can pull it onto the pasteboard.
    const tmp = `${imgPath}.cb.png`;
    const r = await runProc("sips", ["-s", "format", "png", imgPath, "--out", tmp]);
    if (!r.ok) return { ok: false, reason: `sips ${ext}→png failed: ${r.stderr.slice(-200)}` };
    pathToUse = tmp;
    pbClass = "«class PNGf»";
  }
  // POSIX path quoting: backslash-escape `\` and `"` for both AppleScript and
  // JXA string literals (二者转义规则一致)。
  const escaped = pathToUse.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // 主路径：JXA 直接写 NSPasteboardTypePNG。clearContents 后单 flavor 写入，
  // 同时覆盖 codebuddy v2.72.0 JXA 后备读路径和 Claude Code 主路径。
  // (public.png UTI 与 «class PNGf» 同一，Claude Code 读这份不会回归。)
  const jxa = [
    "ObjC.import('AppKit');",
    "const pb = $.NSPasteboard.generalPasteboard;",
    "pb.clearContents();",
    `const data = $.NSData.dataWithContentsOfFile("${escaped}");`,
    "if (data.isNil()) $.abort('read failed');",
    "pb.setData(data, forType: $.NSPasteboardTypePNG);",
  ].join(" ");
  const rJxa = await runProc("osascript", ["-l", "JavaScript", "-e", jxa]);
  if (rJxa.ok) return { ok: true };

  // 兜底：JXA 失败才回退纯 AppleScript（用原 pbClass，可能是 JPEG/GIF/TIFF，
  // 不强转 PNG —— 这条路径本来就是 Claude Code 历史验证过的）。
  const script = `set the clipboard to (read POSIX file "${escaped}" as ${pbClass})`;
  const rApple = await runProc("osascript", ["-e", script]);
  if (!rApple.ok) {
    return {
      ok: false,
      reason: `clipboard set failed: jxa=${rJxa.stderr.slice(-120)}; applescript=${rApple.stderr.slice(-120)}`,
    };
  }
  return { ok: true };
};

// Pane fingerprint for verifying paste/submit. `rows` controls how far back
// from the bottom to capture: a wide window (12) for paste-landed (lenient,
// catches wrapped content / hint lines), a narrow window (5) for input-box-
// cleared. The narrow window matters after `/clear`: the buffer is almost
// empty, so claude's echo of the just-submitted message sits directly above
// the input box and would otherwise re-trigger the fingerprint, falsely
// flagging "Enter not honored".
const capturePaneTail = async (target: string, rows = 12): Promise<string> => {
  const r = await tmuxRun(["capture-pane", "-t", target, "-p", "-S", `-${rows}`]);
  return r.ok ? r.stdout : "";
};

// Trim slash-command stdout to the useful section. TUI panels prepend a run
// of leading whitespace / bar-chart glyph rows before the human-readable
// title; we anchor at the first title line and drop everything above. The
// anchors here are the known /context titles — extend when new commands
// route through this branch.
const SKILL_ANCHORS = ["Context Usage"];
const anchorSkillOutput = (raw: string): string => {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => SKILL_ANCHORS.some((a) => l.includes(a)));
  const sliced = idx >= 0 ? lines.slice(idx) : lines;
  return sliced.join("\n").replace(/^\s+|\s+$/g, "");
};

// How far back to capture when recovering a pre-card preamble. Preambles before
// AskUserQuestion/ExitPlanMode are short; 40 rows covers wrap + the pending
// tool/picker below it without dragging in the previous turn.
const PANE_PREAMBLE_ROWS = 40;
const BULLET = "⏺"; // ⏺ — Claude Code's assistant/tool bullet
// Indented lines that are tool-execution summaries, not prose wrap. Filtered out
// when they sandwich between prose and the pending tool.
const TOOL_SUMMARY_RE =
  /^(⎿|… ?\+?\d|Ran |Read |Wrote |Edited |Listed |Searched |Found |Fetched |Called |Committed |Pushed |Pulled |Rebased |Staged |Updated )/u;
// After `⏺ `: a tool call (`Bash(…`) or a collapsed summary → not prose.
const isToolBullet = (afterBullet: string): boolean =>
  /^[A-Za-z_][\w.-]*\(/u.test(afterBullet) || TOOL_SUMMARY_RE.test(afterBullet);

// Pull the most recent assistant PROSE block out of a Claude Code TUI capture —
// the "why" that precedes a pending approval tool. CC renders prose as
// `⏺ <text>` + 2-space-indented wrapped lines; tool calls as `⏺ Name(…)` and
// summaries as indented `Ran…/Read…/⎿…`. Walk up from the bottom past the
// pending tool region to the last prose bullet, then collect its block.
// Best-effort: returns "" when nothing confident is found (caller sends the
// card alone — status-quo, no regression).
const extractPaneAssistantTail = (pane: string): string => {
  const lines = pane.replace(/[\s﻿]+$/u, "").split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!;
    if (/^❯\s+\S/u.test(ln)) return ""; // a user-message echo above → no preamble between it and here
    // note: the empty input-box prompt (`❯ ` + NBSP, nothing after) is NOT a boundary — skip it
    if (ln.startsWith(BULLET + " ")) {
      if (!isToolBullet(ln.slice(2).trimStart())) { start = i; break; }
      // tool bullet (the gating tool) — keep scanning up for the prose above it
    }
  }
  if (start === -1) return "";
  const out: string[] = [lines[start]!.slice(2).trimStart()];
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.trim() === "") { out.push(""); continue; }
    if (ln.startsWith(BULLET)) break;        // next block starts
    if (!/^\s{2}\S/u.test(ln)) break;        // not a 2-space continuation
    if (/[│┌┐└┘├┤┬┴┼◯○●☐☑▪▸▹]/u.test(ln)) break; // picker/table chrome
    const body = ln.trimStart();
    if (TOOL_SUMMARY_RE.test(body)) continue; // sandwiched tool summary
    out.push(body);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  const text = out.join("\n").trim();
  return text.length >= 12 ? text : "";
};

// Is the pane sitting on a modal picker that would eat an injection?
//
// Deliberately NOT capturePaneTail: that one passes `-S -N`, which reaches
// into the scrollback. A confirm the user already answered lives in the
// scrollback forever, so a scrollback-inclusive capture would keep matching it
// long after the pane went back to accepting input — wedging the mirror shut
// permanently. Bare `-p` captures only what is currently on screen.
//
// Trailing blank rows are trimmed first so the 15-row window lands on the
// bottom-most *content* (a picker's footer is its last line); 15 rows spans
// "title → options → footer" on every confirm layout we've seen.
const MODAL_SCAN_ROWS = 15;
// `screen` = 实际参与判定的那一屏文本, 一并返回给调用方做选项解析 —— 再 capture
// 一次会拿到"下一瞬间"的屏幕, 与 verdict 不同源(框可能已被本地按掉), 按键就按错了。
const detectModalPicker = async (target: string): Promise<ModalPaneVerdict & { screen: string }> => {
  const r = await tmuxRun(["capture-pane", "-t", target, "-p"]);
  if (!r.ok) return { modal: false, screen: "" };
  const lines = r.stdout.replace(/\s+$/u, "").split("\n");
  const screen = lines.slice(-MODAL_SCAN_ROWS).join("\n");
  return { ...isModalPane(screen), screen };
};

// 「聊聊这个」收尾: 文本 inject 已把引导语贴进自定义文本行 (❯ N. <text>)。codebuddy
// 的 AskUserQuestion 面板把自定义行和 Submit 行做成两个独立行, 光标此刻停在自定义
// 行, 直接 Enter 只是在文本里换行, 提交不了。这里读屏确认 Submit 行已渲染
// (isAskqSubmitPage) → Down 落到 Submit 行 → Enter 收工 → 确认面板关闭 (!isModalPane)。
// 全程 bare `-p` (仅当前屏, 不碰 scrollback 里的旧面板残影)。最多重试
// ASKQ_CONFIRM_ENTERS 次, 仍在面板里则判失败, 交回上层告警兜底。
const ASKQ_CONFIRM_ENTERS = 3;
const ASKQ_CONFIRM_POLL_MS = 150;
const ASKQ_CONFIRM_STAGE_MS = 2500; // 每阶段 (到提交页 / 面板关闭) 的轮询上限
const confirmAskqSubmit = async (
  target: string,
  paneAlive: () => Promise<boolean>,
): Promise<{ ok: boolean; reason?: string }> => {
  const capture = async (): Promise<string> => {
    const r = await tmuxRun(["capture-pane", "-t", target, "-p"]);
    return r.ok ? r.stdout.replace(/\s+$/u, "") : "";
  };
  // 轮询到 pred 为真; 期间 pane 死了立即失败。
  const pollUntil = async (pred: (pane: string) => boolean, timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    for (;;) {
      if (!(await paneAlive())) return false;
      if (pred(await capture())) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      await sleepMs(ASKQ_CONFIRM_POLL_MS);
    }
  };
  const sendKey = (key: string) => tmuxRun(["send-keys", "-t", target, key]);

  for (let attempt = 0; attempt < ASKQ_CONFIRM_ENTERS; attempt++) {
    if (!(await paneAlive())) return { ok: false, reason: "pane_dead" };
    const cur = await capture();
    // 面板已经不在了 = 已成功收工。
    if (!isModalPane(cur).modal) return { ok: true };
    // 还没出现 Submit 行则等它渲染 (文本刚落下 / TUI 重绘)。
    if (!isAskqSubmitPage(cur) && !(await pollUntil(isAskqSubmitPage, ASKQ_CONFIRM_STAGE_MS))) {
      // 连 Submit 行都没有 —— 可能文本没落下, 兜底按一次 Enter 试推进。
      const e = await sendKey("Enter");
      if (!e.ok) return { ok: false, reason: `send-keys Enter: ${e.stderr.slice(-200) || e.code}` };
      continue;
    }
    // Submit 行已出现, 但光标停在自定义文本行 (❯ N. <text>) —— 面板结构是
    // 「自定义行 + 独立 Submit 行」, 直接 Enter 只会在自定义行换行。先 Down 落到
    // Submit 行, 再 Enter 收工。
    const d = await sendKey("Down");
    if (!d.ok) return { ok: false, reason: `send-keys Down: ${d.stderr.slice(-200) || d.code}` };
    await sleepMs(ASKQ_CONFIRM_POLL_MS); // 等光标移动重绘
    const e = await sendKey("Enter");
    if (!e.ok) return { ok: false, reason: `send-keys Enter: ${e.stderr.slice(-200) || e.code}` };
    if (await pollUntil((p) => !isModalPane(p).modal, ASKQ_CONFIRM_STAGE_MS)) return { ok: true };
  }
  return { ok: false, reason: "面板未在确认后关闭 (可能停在提交页/自定义行)" };
};

// Two fingerprints, derived from different ends of `text`:
//   headFp — first 8 non-ws chars; used for "did paste land" against a wide
//     window because long pastes wrap and the head sits near the top of the
//     input box, possibly outside a tight tail capture.
//   tailFp — last 8 non-ws chars; sits right above the cursor (bottom of the
//     input box). Used for "did input box clear" against a narrow window:
//     after Enter, claude echoes the user message ABOVE the input box, so a
//     wide capture stays "dirty" forever; a tight 5-row capture sees only
//     the input box itself, which DOES clear.
const fingerprints = (text: string): { headFp: string; tailFp: string } => {
  const stripped = text.replace(/\s+/gu, "").trim();
  return { headFp: stripped.slice(0, 8), tailFp: stripped.slice(-8) };
};

// Self-verifying inject. The cold-spawn race we guard against: paste lands
// but the trailing Enter is eaten while the TUI is still initializing, so
// the prompt sits typed-but-unsent. Strategy:
//   1. paste; wide-window poll for headFp → paste reached the input box.
//   2. settle; send Enter.
//   3. narrow-window poll (last 5 rows = just the input box, NOT the echo
//      above) for tailFp absence → submit was honored.
//   4. on stuck-after-Enter, retry Enter once with extra settle.
const injectViaTmux = async (target: string, text: string, images: string[], log: Logger, freshSpawn: boolean, backendName: CliBackendName): Promise<{ ok: boolean; reason?: string; uncertain?: boolean }> => {
  log.info({ target, len: text.length, images: images.length, freshSpawn, backendName }, "mirror inject (tmux)");

  // Never type into a modal picker (see detectModalPicker). Checked before the
  // image pump too — a C-v into a picker is just as destructive as a paste.
  // 必须在按后端分流之前: 每个后端都有自己的原生确认框, 往任何一个里打字都会
  // 替用户点掉框并吞掉这条消息。放到 codebuddy 早退之后就等于只保护了 claude。
  // Escape hatch: WEZARD_MODAL_GUARD=0, in case a future TUI layout trips it.
  if (process.env.WEZARD_MODAL_GUARD !== "0") {
    const modal = await detectModalPicker(target);
    if (modal.modal) {
      log.warn({ target, title: modal.title, backendName }, "mirror inject: modal picker on pane, refusing to inject");
      const what = modal.title ? `「${modal.title}」` : "原生确认框";
      return {
        ok: false,
        reason: `目标会话停在 CLI ${what} 等待确认,消息未送达。`
          + `(强行注入会替你点掉确认框并吞掉这条消息)`
          + `请到 tmux 里处理该确认框,或发 /stop 取消当前操作后重发。`,
      };
    }
  }

  // 图片注入策略按后端分流：
  //   claude / claude-internal —— 走 macOS 剪贴板 + Ctrl+V，TUI 收到 \x16 后
  //     直接读系统剪贴板的 PNGf flavor，附加为 image content block。
  //   codebuddy —— 它的 TUI 在 TMUX 环境下收到 C-v 后会先调
  //     syncTmuxToSystemClipboard()（执行 `tmux save-buffer - | pbcopy`），
  //     这会用 tmux buffer 的文本内容覆盖系统剪贴板，把 daemon 刚写入的
  //     PNGf flavor 冲掉（pbcopy 只写 public.utf8-plain-text，NSImage 读不到）。
  //     所以 codebuddy 走 C-v 必然失败 —— 改走 @<path> 文本提及，让 LLM
  //     调 Read 工具读图（Read 支持图片，见 codebuddy tools-reference.md）。
  //     v2.52.4 之后 @<path> 不自动转 image block，但 LLM 看到路径会 Read。
  if (backendName === "codebuddy") {
    const refs = images.map((p) => `@${p}`);
    const textWithRefs = refs.length ? (text ? `${refs.join("\n")}\n${text}` : refs.join("\n")) : text;
    return injectViaTmuxText(target, textWithRefs, log, freshSpawn);
  }

  // Pump images first via clipboard+C-v so each one is attached as a separate
  // image content block. Each C-v needs a brief settle for Claude Code's TUI
  // to read the clipboard before the next overwrite. Fresh spawn extends.
  const IMG_SETTLE_MS = freshSpawn ? 700 : 350;
  for (const imgPath of images) {
    const cb = await setMacClipboardImage(imgPath);
    if (!cb.ok) {
      log.warn({ imgPath, reason: cb.reason }, "mirror inject: clipboard set failed, skipping image");
      continue;
    }
    const cv = await tmuxRun(["send-keys", "-t", target, "C-v"]);
    if (!cv.ok) return { ok: false, reason: `tmux send-keys C-v failed: ${cv.stderr.slice(-200)}` };
    await sleepMs(IMG_SETTLE_MS);
  }

  // Image-only message: TUI input box now holds the attached images; press
  // Enter and we're done. No fingerprint to verify (the input itself is binary
  // image refs, not text).
  if (!text) {
    if (images.length === 0) return { ok: true };
    const e = await tmuxRun(["send-keys", "-t", target, "Enter"]);
    return e.ok ? { ok: true } : { ok: false, reason: `tmux send-keys Enter failed: ${e.stderr.slice(-200)}` };
  }

  return injectViaTmuxText(target, text, log, freshSpawn);
};

// 文本 paste + Enter 提交 + 自校验。从 injectViaTmux 抽出来，让 codebuddy
// 后端的 @<path> 回退路径也能复用同样的 paste-verify 逻辑。
const injectViaTmuxText = async (target: string, text: string, log: Logger, freshSpawn: boolean): Promise<{ ok: boolean; reason?: string; uncertain?: boolean }> => {
  // Warm pane: tight timings, low latency. Fresh spawn (claude --resume just
  // started, transcript still loading): extended timings — bracketed-paste
  // end can take 4-7s to be honored on a cold TUI. Only the fresh-spawn path
  // pays the latency cost.
  const PASTE_VERIFY_MS = freshSpawn ? 6000 : 2500;
  const POST_PASTE_SETTLE_MS = freshSpawn ? 1500 : 400;
  const POST_PASTE_SETTLE_FALLBACK_MS = freshSpawn ? 2500 : 700;
  const CLEARED_TIMEOUT_MS = freshSpawn ? 4000 : 1500;
  const RETRY_SETTLE_MS = freshSpawn ? 1500 : 800;

  const loadAndPaste = async (): Promise<{ ok: boolean; reason?: string }> => {
    // stdin variant of the shared exec path — it carries the same hard timeout,
    // which a hand-rolled spawn here did not.
    const loaded = await tmuxRun(["load-buffer", "-"], { stdin: text });
    if (!loaded.ok) return { ok: false, reason: `tmux load-buffer failed: ${loaded.stderr.slice(-200) || loaded.code}` };
    const pasted = await tmuxRun(["paste-buffer", "-p", "-d", "-t", target]);
    if (!pasted.ok) return { ok: false, reason: `tmux paste-buffer failed: ${pasted.stderr.slice(-200)}` };
    return { ok: true };
  };

  let r = await loadAndPaste();
  if (!r.ok) return r;

  const { headFp, tailFp } = fingerprints(text);
  const POLL_MS = 100;
  const stripWs = (s: string): string => s.replace(/\s+/gu, "");

  // Wide window catches a wrapped paste's head whether it's row -3 or row -10.
  const sawHead = async (timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const pane = await capturePaneTail(target, 12);
      if (headFp && stripWs(pane).includes(headFp)) return true;
      await sleepMs(POLL_MS);
    }
    return false;
  };

  // Narrow window = just the input box. tailFp is the chars next to the
  // cursor, so it's always inside this window pre-submit and gone post-submit.
  const inputBoxStillHasTail = async (): Promise<boolean> => {
    const pane = await capturePaneTail(target, 5);
    return Boolean(tailFp) && stripWs(pane).includes(tailFp);
  };

  let pasteSeen = await sawHead(PASTE_VERIFY_MS);
  if (!pasteSeen) {
    // headFp not seen — but on a cold fresh-spawn the TUI can render the paste
    // just outside our capture window / after our budget, so `sawHead` yields a
    // FALSE negative even though the text is sitting in the input box. Blindly
    // re-pasting then stacks a SECOND copy → the classic doubled prompt. Guard:
    // re-paste only if the box genuinely lacks our tail; otherwise the first
    // paste landed and we just proceed to submit.
    if (await inputBoxStillHasTail()) {
      log.warn({ target, headFp }, "mirror inject: headFp not seen but tail present in box — first paste landed, skipping re-paste");
      pasteSeen = true;
    } else {
      log.warn({ target, headFp }, "mirror inject: paste headFp not seen, re-pasting");
      await sleepMs(RETRY_SETTLE_MS);
      r = await loadAndPaste();
      if (!r.ok) return r;
      pasteSeen = await sawHead(PASTE_VERIFY_MS);
    }
  }

  // Bracketed-paste end + TUI catch-up. Warm pane: 400ms is invisible.
  // Fresh respawn: 1500ms+ — claude --resume is still loading the transcript.
  await sleepMs(pasteSeen ? POST_PASTE_SETTLE_MS : POST_PASTE_SETTLE_FALLBACK_MS);

  const sendEnter = async (): Promise<{ ok: boolean; reason?: string }> => {
    const e = await tmuxRun(["send-keys", "-t", target, "Enter"]);
    return e.ok ? { ok: true } : { ok: false, reason: `tmux send-keys failed: ${e.stderr.slice(-200)}` };
  };
  const waitForCleared = async (timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleepMs(POLL_MS);
      if (!(await inputBoxStillHasTail())) return true;
    }
    return false;
  };

  const e1 = await sendEnter();
  if (!e1.ok) return e1;
  if (!pasteSeen) log.warn({ target }, "mirror inject: submitted without paste verification (capture-pane lag)");
  if (!tailFp) return { ok: true }; // empty/whitespace text — nothing to verify

  if (await waitForCleared(CLEARED_TIMEOUT_MS)) return { ok: true };

  // Input box still holds our tail — Enter was eaten (cold TUI) or the
  // bracketed-paste end hadn't been processed yet. One retry with extra
  // settle. We keep this to ONE retry to bound damage if our cleared-check
  // is wrong (would otherwise spam Enters into a real conversation).
  log.warn({ target, tailFp }, "mirror inject: input box still has text after Enter, retrying once");
  await sleepMs(RETRY_SETTLE_MS);
  const e2 = await sendEnter();
  if (!e2.ok) return e2;
  if (await waitForCleared(CLEARED_TIMEOUT_MS)) return { ok: true };

  // freshSpawn fallback: claude --resume can take longer than our budget to
  // process bracketed-paste end. The Enter was sent twice; if it lands later,
  // claude will process the prompt and the user gets their reply. Trust it
  // rather than reporting a hard failure that the user actually got served.
  //
  // Warm-pane path also trusts: in practice tmux Enter is reliable once the
  // pane exists, and the verifier has structural false-positive risk —
  // tailFp (last 8 non-ws chars) can match the echo line directly above the
  // input box when it falls within the 5-row capture window. Surfacing
  // `[mirror] ✗` to the user when the prompt actually landed is worse than
  // accepting an extra no-op Enter on the rare true-stuck case.
  log.warn({ target, tailFp, freshSpawn }, "mirror inject: clear not observed, trusting submit");
  // Input box still held our text after two Enters. Usually the prompt landed
  // late (verifier false-positive), but it can also mean the target session is
  // busy / not consuming input (e.g. running a long task, or context full) —
  // the user's message would then silently go nowhere. Flag it uncertain so the
  // caller can hint the user, without reporting a hard failure.
  return { ok: true, uncertain: true, reason: "目标会话可能正忙或未消费输入(回车后输入框未清空)" };
};

const injectViaSpawn = (args: InjectArgs): Promise<{ ok: boolean; reason?: string }> => {
  const { text, images = [], cfg, log, sessionId, jsonlPath } = args;
  const bin = backendForPath(jsonlPath).bin;
  // Spawn-mode (no live TTY) can't do clipboard+C-v — fall back to `@<path>`,
  // which Claude parses at submit time and inlines as image content blocks
  // without a model-decided Read tool turn.
  const refs = images.map((p) => `@${p}`).join("\n");
  const finalText = refs ? (text ? `${refs}\n${text}` : refs) : text;
  const cliArgs = [
    "-p",
    finalText,
    "--resume",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    ...cfg.wrc.extraArgs,
  ];
  log.info({ sessionId, bin, len: text.length }, "mirror inject");
  return new Promise((resolve) => {
    const proc = spawn(bin, cliArgs, {
      cwd: expandHome(cfg.wrc.cwd),
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    let spawnError: Error | undefined;
    proc.on("error", (err) => {
      spawnError = err;
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1500);
    });
    proc.on("close", (code) => {
      if (spawnError) {
        log.error({ err: spawnError.message }, "mirror spawn error");
        resolve({ ok: false, reason: `spawn ${bin}: ${spawnError.message}` });
        return;
      }
      if (code !== 0) {
        log.error({ code, stderrTail: stderrTail.slice(-400) }, "mirror inject non-zero");
        resolve({ ok: false, reason: `${bin} exited ${code}: ${stderrTail.slice(-300)}` });
        return;
      }
      resolve({ ok: true });
    });
  });
};

const inject = (args: InjectArgs): Promise<{ ok: boolean; reason?: string; uncertain?: boolean }> => {
  const target = (args.tmuxTarget ?? "").trim();
  if (!target) return injectViaSpawn(args);
  const backendName = backendForPath(args.jsonlPath).name;
  return injectViaTmux(target, args.text, args.images ?? [], args.log, args.freshSpawn ?? false, backendName);
};

// ── Per-session injection queue ───────────────────────────────────────
type Job = () => Promise<void>;
const queues = new Map<string, Promise<void>>();
/** Ceiling for one whole inject job (respawn + paste + submit verification).
 *  Worst legitimate case is a cold `--resume` respawn (~8s) plus a fresh-spawn
 *  inject with both paste re-try and both cleared-polls (~30s), so 90s is ~2.5x
 *  headroom. Past that the job is wedged, and holding the queue is strictly
 *  worse than dropping the turn: every later message in that chat would queue
 *  behind it forever. Well under brief's 350s bubble ceiling so the user still
 *  gets an error bubble rather than a silent stream timeout. */
const INJECT_JOB_TIMEOUT_MS = 90_000;
/** Drop a session's queue chain. A hung job can't be cancelled (it's parked in a
 *  tmux read), but detaching the chain means the NEXT message doesn't inherit
 *  its deadlock. Pair with an injectGen bump so the zombie can't act when it
 *  eventually returns. */
const abortInjectQueue = (key: string): void => {
  queues.delete(key);
};
const enqueue = (key: string, job: Job): Promise<void> => {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => undefined);
  queues.set(
    key,
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }),
  );
  return next;
};

// ── Public bridge API ─────────────────────────────────────────────────
export interface MirrorDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  store: MirrorStore;
}

export interface MirrorDispatchArgs {
  principal: string;
  text: string;
  /** Absolute paths to image files. Tmux mode pumps each via macOS clipboard +
   *  Ctrl+V (matches Claude Code's documented image paste path → image content
   *  block, NO Read tool turn). Spawn-mode falls back to `@<path>` prepended
   *  to text so the headless `claude --resume -p` reads the file at submit. */
  images?: string[];
  frame: WsFrameHeaders;
  streamId: string;
}

export interface AttachArgs {
  sessionId: string;
  jsonlPath: string;
  target?: string; // optional override; falls back to cfg.wrc.mirror.pushChat || cfg.defaultChat
  /** tmux pane (e.g. `%5`); usually auto-discovered from caller's $TMUX_PANE. Empty → spawn-mode inject. */
  tmuxPane?: string;
  /** tmux session name (e.g. `wezard-xxx`). Persisted so a reload can re-derive a fresh paneId for the same session. */
  tmuxSession?: string;
  /** Cwd the live pane is running in. Persisted so /pwd can show truth and
   *  /clear can detect mismatch. Empty → cfg.wrc.cwd. */
  cwd?: string;
  /** User-requested next cwd (carry-over on re-attach). */
  pendingCwd?: string;
}

export interface AttachResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  jsonlPath?: string;
  target?: string;
}

/** 代按原生确认框的结果。answered 之外的一切都要求调用方走兜底(取消 + 告知)。 */
export type NativeModalAnswer =
  | { status: "answered"; title?: string; index: number; label: string }
  | { status: "no_modal" }
  | { status: "no_pane"; reason: string }
  | { status: "unparsable"; title?: string; screen: string }
  | { status: "still_modal"; title?: string; index: number; label: string };

export interface MirrorBridge {
  dispatch: (args: MirrorDispatchArgs) => Promise<void>;
  shutdown: () => void;
  attach: (args: AttachArgs) => AttachResult;
  status: () => {
    attached: boolean;
    mirrors: Array<{ sessionId: string; jsonlPath: string; target: string }>;
    /** Convenience fields mirroring the first attachment, for back-compat callers. */
    sessionId?: string;
    jsonlPath?: string;
    target?: string;
  };
  /** True if `principal` (e.g. "chat:xxx" / "user:xxx") is currently a mirror target — used by inbound gating to implicitly authorize talkback. */
  hasMirrorTarget: (principal: string) => boolean;
  /** Look up the mirror target (e.g. "chat:xxx") bound to a Claude sessionId. Used by approval to route cards to the originating WeCom chat. */
  targetForSession: (sessionId: string) => string | undefined;
  /** Look up the mirror target bound to a tmux pane id (e.g. "%20"). Pane id is
   *  stable across `/clear` (which rotates sessionId), so MCP tools whose env
   *  sessionId went stale after a clear can still resolve their own chat. */
  targetForPane: (tmuxPane: string) => string | undefined;
  /** Returns full tool detail markdown for a turnId, or undefined if expired/unknown. */
  resolveToolDetail: (turnId: string) => { target: string; markdown: string[] } | undefined;
  /** Approval-click hook: finalize any open liveStream for this Claude sessionId
   *  so subsequent tool_use / tool_result items fall through to the debounced
   *  standalone path instead of growing the same bubble. No-op when no live
   *  stream exists. */
  terminateLiveStream: (sessionId: string) => void;
  /** Pre-card hook: drain any pending assistant text/tool markdown for this
   *  session and await the per-attachment FIFO so the card race never lets the
   *  vote/approval card overtake the "thinking" bubble. Resolves once all
   *  outbound mirror sends queued so far have hit WeCom. No-op when no
   *  attachment exists for the session. When `expect` is provided, polls
   *  `tail.drain()` until the assistant message containing that tool_use is
   *  observed in the jsonl (closes the race where Claude Code's flush trails
   *  the hook fire by tens-to-hundreds of ms). */
  flushBeforeCard: (
    sessionId: string,
    expect?: { toolName: string; toolInput: unknown },
  ) => Promise<void>;
  /** Inject text into an attached mirror without an originating WeCom frame.
   *  Used by `wezard init` to fire a demo prompt right after auto-spawn so
   *  the user sees the full PreToolUse → approval card → assistant mirror
   *  loop end-to-end. Skips the live-stream/replyStream machinery — the tail
   *  pushes assistant output via the standalone path. */
  injectText: (target: string, text: string, origin?: TurnOrigin) => Promise<{ ok: boolean; reason?: string }>;
  /** Send Esc to the live tmux pane bound to `target` — interrupts whatever
   *  Claude is currently doing (active generation / open prompt). No-op for
   *  spawn-mode attachments (no live TTY to interrupt).
   *
   *  `teardown: true` (what `/stop` passes) additionally does the tmux-free part
   *  FIRST: bump injectGen, drop the inject queue, and force-close every hanging
   *  bubble/stream. That path stays useful when tmux is the thing that's wedged,
   *  and reports `torndown` (bubbles closed) plus whether the Esc landed. */
  interruptPane: (
    target: string,
    opts?: { teardown?: boolean },
  ) => Promise<{ ok: boolean; reason?: string; torndown?: number; escOk?: boolean; escReason?: string }>;
  /** Tear the session down: Esc the pane, kill it, detach, and drop the
   *  persisted binding so nothing resurrects it. The chat auto-spawns a fresh
   *  session on its next message. */
  killPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Send a bare Enter to the live tmux pane bound to `target` — confirms a
   *  prompt / press-enter-to-continue, or submits the input box as-is. No-op
   *  for spawn-mode attachments (no live TTY). */
  submitPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Switch the most-recently-active attached tmux client to this session's
   *  pane (session + window + pane all selected) — the WeCom-side "show me
   *  the terminal" escape hatch. Fails with an attach hint when no tmux
   *  client is attached anywhere. */
  revealPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Does this Claude sessionId have a live tmux pane we could answer a native
   *  confirm on? Sync (map lookup only) — the aliveness probe happens in
   *  `answerNativeModal`. Approval uses it to decide whether the `.claude/**`
   *  guard can promise "card → we press the confirm for you". */
  hasLivePane: (sessionId: string) => boolean;
  /** Answer the native (non-hookable) permission confirm Claude Code raises
   *  after the hook returned allow — see shared/modal-pane.ts for why this is
   *  scoped to a just-approved call only. Polls up to `waitMs` for the confirm
   *  to appear, then presses the parsed one-shot "Yes". */
  answerNativeModal: (
    sessionId: string,
    opts: { waitMs: number },
  ) => Promise<NativeModalAnswer>;
  /** Cwd lifecycle for the chat-bound project path. `getCwd` returns
   *  `{ runningCwd, pendingCwd, defaultCwd }` so /pwd can render all three
   *  truthfully. `setPendingCwd` writes the user-requested next cwd into the
   *  store; `clearPendingCwd` is called by the bridge after a /new spawn lands. */
  getCwd: (target: string) => { runningCwd: string; pendingCwd: string; defaultCwd: string };
  setPendingCwd: (target: string, cwd: string) => { ok: boolean; reason?: string; runningCwd: string; pendingCwd: string };
  /** Detach + respawn a target's pane in `cfg.wrc.cwd` or its pendingCwd
   *  override. Used by /new to give the user a fresh claude in the bound
   *  project. Returns the new attachment result. */
  newSession: (target: string, windowName?: string, cli?: CliBackendName, opts?: { model?: string; cwd?: string; silent?: boolean }) => Promise<{ ok: boolean; reason?: string; sessionId?: string; cwd?: string }>;
  /** Every target key of `target`'s chat (default + every `#tag`), live or
   *  merely persisted. Sync and cheap — the `peers` probe shells out to tmux,
   *  far too much for answering "is this tag taken". */
  chatTargets: (target: string) => string[];
  /** Sibling sessions of `target`'s chat (default + every `#tag`), each with
   *  liveness / busy / last-activity so an agent can see who else is working. */
  peers: (target: string) => Promise<PeerInfo[]>;
  /** Sessions in OTHER chats that `target` can actually address — a globally
   *  unique `#tag`, or any tag in a NAMED chat (reachable as `chatName#tag`).
   *  The discovery surface for cross-chat handoffs; same shape as `peers`. */
  foreignPeers: (target: string) => Promise<PeerInfo[]>;
  /** Resolve a peer address to a target key. `""` → self's chat default;
   *  `fix` → self's chat, else a GLOBALLY UNIQUE `#fix` elsewhere;
   *  `daily#fix` / `chat:wr…#fix` → that exact chat's `#fix`, no uniqueness
   *  requirement. Refuses (with the addresses that would have worked) rather
   *  than guessing between ambiguous matches. */
  resolvePeerTag: (
    self: string,
    ref: string,
  ) => { ok: true; target: string; foreign: boolean } | { ok: false; reason: string; candidates?: string[] };
  /** Every chat the daemon knows — named ones plus any with a live/persisted
   *  session — with the target keys living in each. The cross-chat directory. */
  chatRoster: (self: string) => Array<{ base: string; name: string; self: boolean; targets: string[] }>;
  /** Live tmux pane tail of `target` — what that agent's terminal shows right
   *  now, including in-flight tool calls the transcript hasn't recorded yet. */
  peekPane: (target: string, rows?: number) => Promise<{ ok: boolean; reason?: string; pane?: string; busy?: boolean }>;
  /** Last `n` turns of `target`'s conversation, read from its transcript. The
   *  default way to observe a peer; `peekPane` is the fallback for a session
   *  whose jsonl isn't bound/written yet. */
  peekTurns: (target: string, n?: number) => Promise<{ ok: boolean; reason?: string; dialog?: string; busy?: boolean }>;
  /** Mid-turn check for one target. False for cold/dead panes (nothing running). */
  isBusy: (target: string) => Promise<boolean>;
  /** Latest assistant message of `target` — the handoff payload between agents. */
  lastText: (target: string) => string;
}

interface ToolEntry {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: string;
}

/** Brief turn 的气泡 —— ack 时就把 `tag 详情链接 …` 写进去 (finish=false, 不关闭),
 *  所以从收消息那一刻起群里就有可点的详情页入口, 而不是一个纯文本占位。后续:
 *  正文到位 → 以 `链接 正文` 覆盖收口; 一直没正文 → hardTimer 兜底以纯链接收口。
 *  hardTimer 兜底 WeCom ~6min stream 窗口, 到点强制 finish=true。 */
interface BriefBubble {
  frame: WsFrameHeaders;
  streamId: string;
  hardTimer: NodeJS.Timeout;
  done: boolean;
}

/** turn 记录已建好、气泡已 ack 的 turn 载体 (turnId / 气泡 / slash 标记)。 */
interface QueuedTurn {
  turnId: string;
  bubble: BriefBubble;
  isSlash: boolean;
}

interface ActiveStream {
  turnId: string;
  frame: WsFrameHeaders;
  streamId: string;
  /** Target key of the owning attachment. Duplicated onto the stream so
   *  flush/finalize can prefix outbound content with `emoji #tag` without
   *  threading `a` through every call site. */
  target: string;
  acc: string;
  lastSent: string;
  capped: boolean;
  closed: boolean;
  dead: boolean; // server rejected; subsequent items go to standalone
  flushTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  cardSent: boolean;
  tools: ToolEntry[];
  /** 本流内已追加过 tool_use/tool_result。规则 1: tool 之后的首个 text item
   *  截断当前 stream, 让最终文本回复落到独立 standalone 气泡。 */
  sawTool: boolean;
}

interface AttachState {
  sessionId: string;
  jsonlPath: string;
  target: string;
  /** tmux pane (e.g. `%5`) of the live claude process; auto-discovered from $TMUX_PANE on attach. Empty → fall back to spawn-mode inject. */
  tmuxPane: string;
  /** tmux session name; kept so we can re-derive `tmuxPane` after a daemon reload (pane ids aren't stable across the daemon process). */
  tmuxSession: string;
  /** Cwd the live pane was actually spawned/respawned in (post-expandHome).
   *  Diverges from `pendingCwd` when the user has requested a switch but
   *  hasn't yet hit /new — /clear bridges the gap by upgrading to /new. */
  runningCwd: string;
  /** User-requested next cwd (set via `cd` MCP tool). Applied at
   *  next /new (or /clear → upgraded to /new). Cleared after the spawn. */
  pendingCwd: string;
  tail: TailHandle;
  liveStream?: ActiveStream;
  /** Per-attachment FIFO so standalone pushes from the same mirror stay ordered. */
  standalonePending: Promise<void>;
  /** Debounce buffer for the standalone fallback path. liveStream 活时为 undefined,
   *  fallback 落入时累积 item.body, debounce 窗口结束统一发出, 抑制工具调用刷屏。 */
  standaloneBuf?: { parts: string[]; timer: NodeJS.Timeout };
  /** 刚由 newSession 铸出的 pane —— TUI 只有 TUI_SETTLE_MS 那么大。首条 inject
   *  必须用冷启动时序,否则 paste 校验会在 TUI 抓到 pty 之前超时并重贴一次,
   *  两次 paste 最终都落进输入框 = 提示词重复。一次性,由第一次 dispatch 消费。 */
  justSpawned?: boolean;
  /** Inject generation. Bumped by `/stop` and by the inject watchdog. A job that
   *  hung inside tmux and wakes up minutes later compares its snapshot against
   *  this and bails — otherwise a recovering tmux server would suddenly paste a
   *  long-abandoned message into the pane. */
  injectGen?: number;
  /** 新 spawn 的 pane 在首次 inject 落地前会产出初始输出 (greeting / system),
   *  设为 true 时 onItem 全部吞掉, inject 成功后清除。 */
  muteUntilInject?: boolean;
  /** 待记账的上下文断点 (`/clear` 注入 / `/new` 铸盘 / 观测到 /clear 轮换)。由下一次
   *  recordTurnStart 消费一次 —— 断点属于"断点之后的第一轮", 那才是读不到上文的一轮。 */
  ctxCut?: CtxCut;
  /** 待记账的 graph 归因, 与 ctxCut 同一套路: injectText 盖章, 下一次 recordTurnStart
   *  消费一次。带时间戳是因为注入未必真的开出一轮 (pane 死了 / 文本被吞), 陈旧的
   *  印章若一直留着, 会把很久以后某条真人消息误标成 graph 派的。 */
  pendingOrigin?: { origin: TurnOrigin; at: number };
  /** Set when `/clear` was injected: the next user prompt will land in a fresh
   *  jsonl with a new sessionId. A watcher polls the project dir to migrate
   *  this attachment onto the new file. Cleared once migration completes or
   *  the watcher times out. */
  migrationWatcher?: { cancel: () => void };
  /** Armed alongside the `/clear` migration watcher. The dir-scan can only
   *  identify a rotation by "new transcript whose first user line is /clear",
   *  a signature EVERY chat's /clear produces — so when it can't attribute the
   *  file to this pane it stands down and leaves the rebind to the next
   *  inject's text fingerprint, which is pane-certain. `baseline` is the
   *  pre-clear file list, so the fingerprint search only considers transcripts
   *  born from that rotation. One-shot: consumed by the next inject. */
  clearRebind?: { baseline: Set<string> };
  /** Per-turn outbound state machine. undefined ≡ IDLE (no active turn)
   *  / STREAMING (a.liveStream is the source of truth in that phase).
   *  Set on dispatch when outboundDeferMs > 0; cleared on promote/exit. */
  outbound?: OutboundState;
  /** Recent tool_use signatures observed via onItem — `${name}|${stableJSON(input)}`.
   *  flushBeforeCard polls drain() until the to-be-approved tool's sig appears
   *  here, closing the race where the hook fires before Claude Code has
   *  finished flushing the assistant message (with its preceding text) to disk.
   *  Bounded ring; insertion order via Map iteration. */
  recentToolSigs: Map<string, number>;
  /** Brief 模式当前 turn 的 id (由 newTurnId 生成)。空 = 没有活跃 turn。
   *  brief 模式下所有 tool_use / tool_result / 中间 text 只写入 detail store,
   *  不发气泡; final text / turn_end 触发关闭 + finish 消息。 */
  briefTurnId?: string;
  /** Brief turn 的 loading 气泡 —— 起始以 "…" (finish=false) 挂住不关闭。turn 收口
   *  时才定最终内容: 无工具→直接把结论写进这个气泡; 有工具→写详情链接 (结论另发
   *  standalone)。hardTimer 兜底 WeCom ~6min stream 窗口, 到点强制收口。 */
  briefBubble?: BriefBubble;
  /** 本 turn 是否出现过工具调用 / 非 final 文本 —— 决定 skill_output 是当答案写进气泡
   *  还是当中间反馈独立发。详情链接本身与它无关: 气泡从 ack 起就带着链接。 */
  briefHadTool?: boolean;
  /** 本 turn 由 slash 命令 (/context…) 触发 —— 其 skill_output 即答案, 写进气泡而非 standalone。 */
  briefIsSlash?: boolean;
  /** 本 turn 的结论是否已经落地 (写进气泡或发了 standalone), 防止软收口重复推送。 */
  briefConcluded?: boolean;
  /** 本 turn 最近一条 assistant text。软收口没有"终句"标记, 收口时拿它当结论。 */
  briefLastText?: string;
  /** brief 气泡的 CoT 进度 —— 最新一条 thinking / 工具调用, 已压成单行。只在正文落地前
   *  覆盖气泡: 结论一到, 气泡被 `链接 正文` 整条替换掉, 进度不会残留在最终气泡里。 */
  cotText?: string;
  /** CoT 进度的节流计时器 —— 每次刷新都是整条内容重发, 高频 thinking 不能 1:1 打上去。 */
  cotTimer?: NodeJS.Timeout;
  /** 软收口的静默期计时器 —— 任何新 item 到达即撤销。 */
  softEnd?: NodeJS.Timeout;
  /** CLI 侧最近一条用户输入, 用作下一个"无气泡 turn"(ensureBriefTurn) 的 userQuery。
   *  WeCom 发起的 turn 直接从 dispatch 拿到原文, 用不到它。 */
  pendingBriefQuery?: string;
  /** True while a `/goal` is active (session-scoped Stop hook self-driving the
   *  model). Goal runs never emit a terminal stop_reason, so brief-mode's
   *  turn_end-gated flush would swallow the whole run into the turn store while
   *  WeCom stays silent. While set, onItem streams assistant text as progress
   *  standalone and drops per-tool bubbles (kept in the detail store). Set on the
   *  goal marker, cleared on the completing turn's turn_end. */
  goalActive?: boolean;
  /** Keepalive clocks, driven by MESSAGE-turn timestamps (see keepaliveStamps),
   *  NOT file mtime — non-message lines bump mtime and must not read as activity.
   *  `lastMs` = last user/assistant turn (real OR our ping) = cache-warmth clock;
   *  `lastRealMs` = last genuine (non-keepalive) turn = the real-idle cutoff.
   *  `seenMtime` = file mtime observed last tick, the cheap "re-read the tail?"
   *  gate. `pinging`/`pingMtime` guard the inject→settle window (pingMtime holds
   *  `lastMs` at fire; the ping settles once a newer turn — its own — appears).
   *  `round` counts pings since the last real turn — surfaced as `n/N`. */
  keepalive?: { lastMs: number; lastRealMs: number; seenMtime: number; pinging: boolean; pingMtime: number; round: number; settledAt: number };
  /** Keepalive paused by `/stop`. Stays off until a real turn resumes it — a
   *  WeCom inbound (dispatch) or the pane going busy on a genuine turn — so an
   *  explicitly-stopped session isn't poked until the human comes back. */
  keepaliveOff?: boolean;
  /** When `/stop` paused keepalive (ms). The busy-based resume is gated on a
   *  grace window after this so an in-flight ping at /stop time can't self-resume. */
  keepaliveOffAt?: number;
  /** While set, onItem swallows the keepalive ping turn from every WeCom path
   *  (no bubble, no live stream), closing on the turn's terminal signal. The
   *  timer is a fail-safe so a ping that never emits turn_end can't mute a later
   *  real turn. */
  keepaliveQuiet?: NodeJS.Timeout;
  /** Detail-store turn id for the in-flight keepalive. The ping is kept OUT of
   *  chat but recorded into chat-detail as a marked turn — its real usage
   *  (cache-read snapshot) is routed here from the swallowed turn_usage items,
   *  so the timeline shows the ping happened and proves it was a cheap read. */
  keepaliveTurnId?: string;
}

// Mirror outbound state machine. See plan: defer stream open by N ms; flush
// buffered items as one standalone if a needs-approval tool_use shows up
// (so it lands BEFORE the approval card); resume with a fresh stream after
// the user clicks. Pure-text turns that complete inside the window collapse
// to a single standalone bubble — no typewriter wasted on a finished reply.
type OutboundState =
  | {
      kind: "deferred";
      buf: RenderItem[];
      frame: WsFrameHeaders;
      streamId: string;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "awaiting_appr";
      frame: WsFrameHeaders;
      streamId: string;
    };

export const startMirror = (deps: MirrorDeps): MirrorBridge => {
  const { cfg, log, client } = deps;
  // Multi-mirror: each (sessionId, target) pair is one Attachment. Same
  // sessionId reattaches → replace. Same target with different sessionId →
  // replace too (one WeCom chat can only show one mirror at a time).
  const bySessionId = new Map<string, AttachState>();
  const byTarget = new Map<string, AttachState>();

  // Ring buffer of recently-injected user texts to suppress WeCom→CLI echo.
  const INJECT_TTL_MS = 60_000;
  const recentInjects: Array<{ text: string; ts: number }> = [];
  const rememberInject = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    recentInjects.push({ text: t, ts: Date.now() });
    // Slash commands land in the jsonl wrapped in <command-name>...</command-name>
    // tags; cleanUserText renders that as `/cmd args` (backticked). Push that
    // form too so the dedupe filter catches the tail's emission — without this,
    // /clear (and any other slash inject) echoes back as a quoted bubble.
    if (t.startsWith("/")) {
      const head = t.split(/\s+/, 1)[0] ?? t;
      const args = t.slice(head.length).trim();
      recentInjects.push({ text: `\`${head}${args ? ` ${args}` : ""}\``, ts: Date.now() });
    }
    if (recentInjects.length > 64) recentInjects.shift();
  };
  const isOwnInject = (text: string): boolean => {
    const now = Date.now();
    const t = text.trim();
    for (let i = recentInjects.length - 1; i >= 0; i--) {
      const e = recentInjects[i]!;
      if (now - e.ts > INJECT_TTL_MS) continue;
      if (e.text === t) return true;
    }
    return false;
  };

  // Assistant prose pushed EARLY from a pane capture (pre-card preamble). The
  // same text lands in the jsonl later — CC flushes a tool-terminated turn only
  // when the tool resolves, i.e. after the card is answered — so the tail would
  // re-send it. Match normalized (ws-stripped) so a wrapped/dedented pane copy
  // equals the clean jsonl text; boundary match covers a pane that only caught
  // part of a long preamble. findAssistantSend peeks (dup-guard for the per-
  // question flushBeforeCard re-calls); isOwnAssistantSend consumes one-shot.
  const recentAssistantSends: Array<{ sig: string; ts: number }> = [];
  const normAssistant = (s: string): string => s.replace(/\s+/gu, "");
  const findAssistantSend = (text: string): number => {
    const sig = normAssistant(text);
    if (sig.length < 12) return -1;
    const cutoff = Date.now() - INJECT_TTL_MS;
    for (let i = recentAssistantSends.length - 1; i >= 0; i--) {
      const e = recentAssistantSends[i]!;
      if (e.ts < cutoff) continue;
      if (sig === e.sig || sig.startsWith(e.sig) || e.sig.startsWith(sig) || sig.endsWith(e.sig) || e.sig.endsWith(sig)) return i;
    }
    return -1;
  };
  const rememberAssistantSend = (text: string): void => {
    const sig = normAssistant(text);
    if (sig.length < 12) return;
    recentAssistantSends.push({ sig, ts: Date.now() });
    if (recentAssistantSends.length > 32) recentAssistantSends.shift();
  };
  const isOwnAssistantSend = (text: string): boolean => {
    const i = findAssistantSend(text);
    if (i === -1) return false;
    recentAssistantSends.splice(i, 1); // one-shot: a genuine later re-say still streams
    return true;
  };

  // ── Typewriter stream lifecycle ────────────────────────────────────
  // WeCom spec: server polls us for stream refreshes for up to 6 min from the
  // original inbound. SDK queues replyStream calls per req_id, sends serially
  // (5s ack timeout each). After 6 min the server stops accepting refreshes.
  // We keep the stream open until either (a) the next inbound supersedes it,
  // (b) the hard cap fires (just under 6 min), (c) server rejects (s.dead),
  // or (d) we hit the byte cap. No idle-based close — claude can sit thinking
  // for >60s mid-turn and we don't want to drop the bubble while it's chewing.
  const FLUSH_MS = 250;
  const HARD_TIMEOUT_MS = 350_000;
  /** 软收口静默期。后端只能说"这条消息写完了"(codebuddy) 时, 等这么久没有新 item
   *  才认定一轮结束。取值只需盖住"叙述消息落盘 → 紧随其后的 function_call 落盘"
   *  这一段, 与模型思考/工具执行时长无关。
   *  codebuddy 默认 10s (实测 <40ms, 但留余量防 fs.watch 抖动 / 落盘延迟);
   *  claude 默认 4s (硬信号兜底, 软收口极少触发)。可由 config 覆盖。 */
  const SOFT_TURN_END_DEFAULT_CLAUDE = 4_000;
  const SOFT_TURN_END_DEFAULT_CB = 10_000;
  const softTurnEndMsFor = (a: AttachState): number =>
    cfg.wrc.mirror.softTurnEndMs ?? (backendForPath(a.jsonlPath).name === "codebuddy" ? SOFT_TURN_END_DEFAULT_CB : SOFT_TURN_END_DEFAULT_CLAUDE);
  const STREAM_SOFT_CAP = 18_000;
  const TOOL_DETAIL_TTL_MS = 24 * 60 * 60 * 1000;


  // turnId → { tools, target, expiresAt } registry for click-to-detail lookups.
  interface TurnRecord {
    tools: ToolEntry[];
    target: string;
    expiresAt: number;
  }
  const turnRegistry = new Map<string, TurnRecord>();
  const evictTurns = (): void => {
    const now = Date.now();
    for (const [k, v] of turnRegistry) if (v.expiresAt < now) turnRegistry.delete(k);
  };

  const TOOL_DETAIL_PREFIX = "TOOL_DETAIL|";
  const newTurnId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const detailCardFor = (s: ActiveStream, target: string): TemplateCard | undefined => {
    if (s.tools.length === 0) return undefined;
    const tag = tagOfTarget(target);
    const titlePrefix = tag ? `${labelFor(tag)} #${tag} · ` : "";
    return {
      card_type: "button_interaction" as const,
      main_title: { title: `${titlePrefix}本轮工具调用` },
      sub_title_text: `共 ${s.tools.length} 次调用，点击查看详情`,
      task_id: s.turnId,
      button_list: [{ text: "查看详情", style: 1, key: `${TOOL_DETAIL_PREFIX}${s.turnId}` }],
    };
  };

  const flushStream = async (s: ActiveStream): Promise<void> => {
    s.flushTimer = undefined;
    if (s.closed || s.dead || s.acc === s.lastSent) return;
    const content = s.acc;
    s.lastSent = content;
    try {
      await client.replyStream(s.frame, s.streamId, withSessionTag(s.target, content || " "), false);
      log.debug({ turnId: s.turnId, len: content.length }, "stream flush ok");
    } catch (e) {
      log.warn({ turnId: s.turnId, err: (e as Error).message }, "stream flush failed; marking dead");
      s.dead = true;
    }
  };
  const scheduleFlush = (s: ActiveStream): void => {
    if (s.flushTimer || s.closed || s.dead) return;
    s.flushTimer = setTimeout(() => void flushStream(s), FLUSH_MS);
  };
  const finalizeStream = async (a: AttachState, s: ActiveStream): Promise<void> => {
    if (s.closed) return;
    s.closed = true;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = undefined; }
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = undefined; }
    if (s.hardTimer) { clearTimeout(s.hardTimer); s.hardTimer = undefined; }
    // 没正文不写: finish=true 是整条覆盖, 空正文只会把 "…" ack 覆盖成光秃秃的
    // 链接头, 结束处理自己制造错发。气泡保持现有内容, 由 WeCom 6min 窗口自然
    // 到期。dead 流同理只做本地清理。
    if (!s.dead && s.acc.trim()) {
      const card = detailCardFor(s, a.target);
      try {
        if (card) {
          s.cardSent = true;
          await client.replyStreamWithCard(s.frame, s.streamId, withLinkedTag(a, s.acc, undefined, s.turnId), true, { templateCard: card });
        } else {
          await client.replyStream(s.frame, s.streamId, withLinkedTag(a, s.acc, undefined, s.turnId), true);
        }
        log.info({ sessionId: a.sessionId, turnId: s.turnId, accLen: s.acc.length, tools: s.tools.length, withCard: !!card }, "stream finalize");
      } catch (e) {
        log.warn({ sessionId: a.sessionId, turnId: s.turnId, err: (e as Error).message }, "stream finalize failed");
        s.dead = true;
      }
    } else {
      log.info({ sessionId: a.sessionId, turnId: s.turnId, accLen: s.acc.length, tools: s.tools.length, dead: s.dead }, "stream finalize (no body — not overwriting)");
    }
    if (s.tools.length > 0) {
      turnRegistry.set(s.turnId, {
        tools: s.tools,
        target: a.target,
        expiresAt: Date.now() + TOOL_DETAIL_TTL_MS,
      });
      evictTurns();
    }
    if (a.liveStream === s) a.liveStream = undefined;
  };

  const openStream = (a: AttachState, frame: WsFrameHeaders, streamId: string): ActiveStream => {
    const s: ActiveStream = {
      turnId: newTurnId(),
      frame, streamId,
      target: a.target,
      acc: "", lastSent: "",
      capped: false, closed: false, dead: false, cardSent: false,
      tools: [], sawTool: false,
    };
    s.hardTimer = setTimeout(() => void finalizeStream(a, s), HARD_TIMEOUT_MS);
    log.info({ sessionId: a.sessionId, turnId: s.turnId, streamId }, "stream open");
    return s;
  };

  // Standalone fallback (no live stream / stream dead). Per-attachment FIFO so
  // pushes from a single mirror stay ordered; different mirrors run in parallel.
  // Linked tag prefix: emoji+tag becomes a chat-detail link. Falls back to
  // plain withSessionTag when no turnId is available (no active turn to link).
  const linkedTagPrefix = (target: string, turnId: string | undefined): string => {
    if (!turnId) return "";
    const url = buildChatUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, turnId, stripPrincipalPrefix(target));
    const tag = tagOfKey(target);
    return tag ? `[${labelFor(tag)} #${tag}](${url})` : `[🧙](${url})`;
  };

  const withLinkedTag = (a: AttachState, content: string, seq?: string, turnId?: string): string => {
    const prefix = linkedTagPrefix(a.target, turnId ?? a.briefTurnId);
    if (prefix) {
      const seqBit = seq ? ` ${seq}` : "";
      return `${prefix}${seqBit} ${content}`;
    }
    return withSessionTag(a.target, content, seq);
  };

  const sendStandalone = (a: AttachState, content: string): void => {
    const chatId = stripPrincipalPrefix(a.target);
    const pieces = splitChunks(content, Math.max(200, cfg.wrc.mirror.chunkBytes - TAG_HEADER_BUDGET));
    const chunks = pieces.map((p, i) =>
      withLinkedTag(a, p, pieces.length > 1 ? `${i + 1}/${pieces.length}` : undefined));
    a.standalonePending = a.standalonePending
      .then(async () => {
        for (const c of chunks) {
          try {
            await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: c } });
          } catch (e) {
            log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "standalone push failed");
          }
        }
      })
      .catch(() => undefined);
  };

  // Like sendStandalone but skips withSessionTag — content already contains the tag header (e.g. as a link).
  const sendRaw = (a: AttachState, content: string): void => {
    const chatId = stripPrincipalPrefix(a.target);
    a.standalonePending = a.standalonePending
      .then(async () => {
        try {
          await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content } });
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "raw push failed");
        }
      })
      .catch(() => undefined);
  };

  // Pre-card preamble recovery. Called right before an approval card when the
  // gating tool_use is NOT yet in the jsonl (mirror mode: CC defers the whole
  // tool-terminated turn's flush until the tool resolves — after the card is
  // answered). The "why" text is therefore only in the live pane; capture it,
  // push it ahead of the card, and remember it so the later jsonl-tailed copy
  // is dropped as a dup. Enqueues on standalonePending, which flushBeforeCard
  // awaits — so the card lands after. Fail-safe: any miss → just the card.
  const sendPanePreamble = async (a: AttachState): Promise<void> => {
    if (!cfg.wrc.mirror.panePreamble || !a.tmuxPane) return;
    try {
      const pane = await capturePaneTail(a.tmuxPane, PANE_PREAMBLE_ROWS);
      const text = extractPaneAssistantTail(pane);
      if (!text || findAssistantSend(text) !== -1) return; // nothing new / already queued
      rememberAssistantSend(text);
      sendStandalone(a, text);
      log.info({ sessionId: a.sessionId, len: text.length }, "flushBeforeCard: pushed pane preamble before card");
    } catch (e) {
      log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "pane preamble capture failed");
    }
  };

  // Debounce 聚合: 仅 standalone 路径用。窗口内 onItem 多次落入 → 合并成单条 markdown。
  // 0 关闭时退化为透传。flushStandalone 也用于 detach / teardown 时的 drain。
  const flushStandalone = (a: AttachState): void => {
    const buf = a.standaloneBuf;
    if (!buf) return;
    const merged = buf.parts.join("\n\n");
    a.standaloneBuf = undefined;
    if (merged) sendStandalone(a, merged);
  };

  const enqueueStandalone = (a: AttachState, content: string): void => {
    const ms = cfg.wrc.mirror.standaloneDebounceMs;
    if (ms <= 0) {
      sendStandalone(a, content);
      return;
    }
    if (a.standaloneBuf) {
      clearTimeout(a.standaloneBuf.timer);
      a.standaloneBuf.parts.push(content);
      a.standaloneBuf.timer = setTimeout(() => flushStandalone(a), ms);
      return;
    }
    a.standaloneBuf = {
      parts: [content],
      timer: setTimeout(() => flushStandalone(a), ms),
    };
  };

  const recordToolEntry = (s: ActiveStream, item: RenderItem): void => {
    if (item.kind === "tool_use") {
      for (const c of item.calls) {
        s.tools.push({ toolUseId: c.toolUseId, name: c.name, input: c.input });
      }
    } else if (item.kind === "tool_result") {
      // Match by toolUseId; if not found, append a standalone result entry.
      const existing = item.toolUseId
        ? s.tools.find((t) => t.toolUseId === item.toolUseId && t.result === undefined)
        : undefined;
      if (existing) existing.result = item.full;
      else s.tools.push({ toolUseId: item.toolUseId, name: "(result)", input: undefined, result: item.full });
    }
  };

  // ── Outbound deferral (DEFERRED / AWAITING_APPR state machine) ────────
  // 进入 AWAITING_APPR 的唯一触发口是 daemon 真要发卡前调的 flushBeforeCard。
  // 历史上 mirror 这边还做过一次本地 needsApproval 预判直接早闪 standalone, 但那
  // 条路无法预知 hook 会不会被 auto / bypass / 自定义 self-call 放行 — 预判错时
  // 就会出现 standalone 已经发出、随即又新开 stream 的"气泡分裂"。现在去掉,
  // 让 flushBeforeCard 作为单一信号: 发卡的真实路径 → flush as standalone,
  // 不发卡的所有路径 (auto mode、cache、bypass) → deferMs 计时器原地促进到 STREAMING。

  const renderBuf = (buf: RenderItem[]): string =>
    buf.map((i) => ("body" in i ? i.body : "")).filter(Boolean).join("\n\n");

  // Drain any pending standalone debounce so the prior turn's tail content
  // doesn't sandwich into our pre-card flush. Caller already ensured `outbound`
  // points at a deferred slot.
  const flushPendingStandalone = (a: AttachState): void => {
    if (!a.standaloneBuf) return;
    clearTimeout(a.standaloneBuf.timer);
    flushStandalone(a);
  };

  // Path A: a needs-approval tool_use just landed. Aggregate the buffer as one
  // standalone, send it BEFORE the approval card race, transition to AWAITING_APPR.
  const promoteToStandalone = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    clearTimeout(out.timer);
    const md = renderBuf(out.buf);
    a.outbound = { kind: "awaiting_appr", frame: out.frame, streamId: out.streamId };
    flushPendingStandalone(a);
    if (md) sendStandalone(a, md);
    log.info(
      { sessionId: a.sessionId, items: out.buf.length, mdLen: md.length },
      "outbound: DEFERRED → AWAITING_APPR (needs-approval flush)",
    );
  };

  // Path C: turn ended inside the deferral window (fast pure-text reply, or
  // an end-to-end tool turn that happened to fit in the window). The inbound's
  // streamId is already showing a "loading" bubble in WeCom (server polls us
  // for every msg.msgid; we haven't replied to this one) — sending a separate
  // standalone leaves that loading bubble dangling until WeCom's ~6-min
  // server-side timeout. Push the buffered content into the held streamId
  // with finish=true so the bubble fills + closes in one shot.
  //
  // Split mirrors the STREAMING tool→FINAL_text rule: if buf saw a tool AND
  // ends with a run of final-text items, peel that run out into a standalone
  // so the answer gets its own bubble (preview = real answer, not tool noise).
  // Pure-text turn or no trailing final text → no split, all into streamId.
  const exitDeferredAsFinalStream = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    clearTimeout(out.timer);
    const buf = out.buf;
    const sawTool = buf.some((i) => i.kind === "tool_use" || i.kind === "tool_result");
    let bubbleEnd = buf.length;
    if (sawTool) {
      while (bubbleEnd > 0) {
        const it = buf[bubbleEnd - 1]!;
        if (it.kind === "text" && it.final === true) bubbleEnd--;
        else break;
      }
    }
    const bubbleItems = buf.slice(0, bubbleEnd);
    const trailingFinal = buf.slice(bubbleEnd);
    const bubbleMd = renderBuf(bubbleItems);
    const trailingMd = renderBuf(trailingFinal);
    a.outbound = undefined;
    flushPendingStandalone(a);
    void (async () => {
      try {
        // 有正文才写旧 streamId (收入 stream); 空缓冲一个字都不写 —— 否则
        // loading 气泡被 " " 覆盖, 结束处理自己凭空制造一条空消息。
        if (bubbleMd) await client.replyStream(out.frame, out.streamId, withLinkedTag(a, bubbleMd), true);
      } catch (e) {
        log.warn(
          { sessionId: a.sessionId, err: (e as Error).message },
          "exit-deferred finalize failed; falling back to standalone",
        );
        if (bubbleMd) sendStandalone(a, bubbleMd);
      }
      if (trailingMd) sendStandalone(a, trailingMd);
    })();
    log.info(
      { sessionId: a.sessionId, items: buf.length, bubbleLen: bubbleMd.length, trailingLen: trailingMd.length, sawTool },
      "outbound: DEFERRED → IDLE (turn_end, finalized to streamId)",
    );
  };

  // Path B: deferral timer fired without a needs-approval tool. Open a normal
  // stream and replay the buffer through onItem — it'll flow through the
  // STREAMING branch since outbound is now undefined.
  const promoteToStream = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    const { buf, frame, streamId } = out;
    a.outbound = undefined;
    const s = openStream(a, frame, streamId);
    a.liveStream = s;
    if (buf.length === 0) {
      // Empty buffer — claude still thinking. Send the "…" ack so the user
      // sees the bubble; subsequent items grow it as today.
      void (async () => {
        try {
          await client.replyStream(frame, streamId, withSessionTag(a.target, "…"), false);
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "stream initial ack failed");
        }
      })();
    }
    log.info(
      { sessionId: a.sessionId, items: buf.length, turnId: s.turnId },
      "outbound: DEFERRED → STREAMING (timer)",
    );
    for (const item of buf) onItem(a, item);
  };

  const enterDeferred = (a: AttachState, frame: WsFrameHeaders, streamId: string): void => {
    // Safety net: if nothing ever arrives (inject stuck, claude crashed, or
    // claude went silent forever), promote-to-stream after 5 min to clean up.
    // The REAL deferral window (cfg.wrc.mirror.outboundDeferMs) is armed by
    // handleDeferredItem when the first tail item lands — measuring from "claude
    // starts producing" not from "dispatch starts", which would otherwise fire
    // during inject latency (typical 1-4s for tmux paste verify) + post-inject
    // thinking gap (often 5-15s for non-trivial prompts) and falsely promote
    // an empty buffer before any tool_use can be evaluated for approval-needs.
    const SAFETY_MS = 5 * 60_000;
    const timer = setTimeout(() => promoteToStream(a), SAFETY_MS);
    a.outbound = { kind: "deferred", buf: [], frame, streamId, timer };
    log.info({ sessionId: a.sessionId, safetyMs: SAFETY_MS }, "outbound: IDLE → DEFERRED (safety net)");
  };

  // Buffer / decide while in DEFERRED. user_text is CLI-side typing (not the
  // WeCom inbound), unrelated to this turn — drop. tool_use triggers Path A
  // when ANY parallel call needs approval. First item arms the short window;
  // subsequent items don't reset (bounded promote delay).
  const handleDeferredItem = (a: AttachState, item: RenderItem): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    if (item.kind === "turn_end") {
      exitDeferredAsFinalStream(a);
      return;
    }
    if (item.kind === "user_text") return;
    // Skill outputs (e.g. /model) bypass deferred filtering — emit directly
    // as a standalone bubble so the user sees the result immediately.
    if (item.kind === "skill_output") {
      if (!item.quiet) enqueueStandalone(a, item.body);
      return;
    }
    const wasEmpty = out.buf.length === 0;
    out.buf.push(item);
    if (wasEmpty) {
      // First activity from claude — swap the safety net for the short defer
      // window. flushBeforeCard 会在真要发卡前把 buf 转 AWAITING_APPR; 没卡可发
      // 时这个计时器到点就 promoteToStream, 让 bypass/auto 场景也只走一条 stream。
      clearTimeout(out.timer);
      const deferMs = cfg.wrc.mirror.outboundDeferMs;
      out.timer = setTimeout(() => promoteToStream(a), deferMs);
      log.info({ sessionId: a.sessionId, deferMs, kind: item.kind }, "outbound: first item → short defer armed");
    }
  };

  // ── Brief mode ────────────────────────────────────────────────────────
  // 每个 turn 挂一条气泡: ack 时就写进 `tag 详情链接 …` (finish=false, 不立刻关掉),
  // 让群里从收到消息那一刻起就有详情页入口。收口时:
  //   • 正文到位 → 以 `链接 正文` 覆盖这条气泡。
  //   • 始终没正文 / 过 6min 窗口 → 以 ack 时那条纯 `链接` 收口。
  //   • 气泡已收口或无气泡 turn (CLI 侧发起) → 正文另发一条 standalone。
  // 其它所有 item 只写入 turn detail store。
  // 能证明"assistant 已经在产出"的 item —— 见到它们才补开无气泡 turn。
  const BRIEF_TURN_OPENERS = new Set<RenderItem["kind"]>(["text", "tool_use", "tool_result", "skill_output"]);

  // ── CoT 进度行 (brief 气泡) ─────────────────────────────────────────
  // 一轮里正文要等 final text 才落地, 中间几十秒到几分钟气泡只有一个 "…"。这里把最新的
  // thinking / 工具调用覆盖进这条还没收口的气泡, 让群里看得到进展。三条硬约束:
  //   • 只写"还没收口的气泡" —— 结论一到 finishBubble 就用 `链接 正文` 整条替换, 进度
  //     不会留在最终气泡里 (这是它与已下线的 thinkStyle 的分界线: 那次是把整轮 reasoning
  //     拼进正文, 单条体积翻几倍被 md-chunk 切成多页刷屏);
  //   • 单行定长 (COT_MAX_CHARS), 无论 thinking 多长恒定一行, 不存在刷屏可能;
  //   • 节流 —— 气泡刷新是整条内容重发, 高频 thinking 不能 1:1 打到 stream 上。
  const COT_MAX_CHARS = 100;
  const COT_FLUSH_MS = 1500;

  // 压成一行的进度片段。safeForMarkdown 必须先于截断: thinking 里一个裸反引号就能提前
  // 闭合代码段, 让后面的正文裸奔在链接旁边。尾随的省略号 = "还在进行中"; 截断与进行中
  // 共用同一个 …, 不叠加两个。
  const cotLine = (s: string): string => {
    const flat = safeForMarkdown(s.replace(/\s+/g, " ").trim());
    return flat ? `${flat.slice(0, COT_MAX_CHARS)}…` : "";
  };

  const cotToolLabel = (calls: Array<{ name: string; input: unknown }>): string =>
    calls.map((c) => `${c.name} ${renderToolInputCompact(c.input, 60)}`.trim()).join(" / ");

  const clearCot = (a: AttachState): void => {
    if (a.cotTimer) { clearTimeout(a.cotTimer); a.cotTimer = undefined; }
    a.cotText = undefined;
  };

  const flushCot = async (a: AttachState): Promise<void> => {
    a.cotTimer = undefined;
    const text = a.cotText;
    a.cotText = undefined;
    const b = a.briefBubble;
    const turnId = a.briefTurnId;
    // 收口后这一路全部失效: 气泡要么已 done, 要么 turn 已经换人/清空。
    if (!text || !b || b.done || !turnId || a.briefConcluded) return;
    try {
      await client.replyStream(b.frame, b.streamId, `${briefDetailLink(turnId, a.target)} \`${text}\``, false);
    } catch (e) {
      log.debug({ sessionId: a.sessionId, turnId, err: (e as Error).message }, "brief: cot refresh failed");
    }
  };

  /** 推进气泡里的 CoT 进度。节流窗口内到达的多条只留最后一条 —— 进度永远只展示"最新"。 */
  const updateBriefProgress = (a: AttachState, raw: string): void => {
    const b = a.briefBubble;
    if (!b || b.done || a.briefConcluded) return;
    const line = cotLine(raw);
    if (!line) return;
    a.cotText = line;
    if (a.cotTimer) return;
    a.cotTimer = setTimeout(() => void flushCot(a), COT_FLUSH_MS);
  };

  // 链接落到 chat 视图: 默认选中本 turn 所属的 #tag, 贴底显示整条会话。turnId 依旧
  // 是凭据 (不可枚举), 只是页面从"一个 turn"扩成"这个 chat 的全部会话"。
  // target 作为 ww_uniq 传下去, 让同 chat 的所有 turn 详情都复用一个 WeCom 窗口。
  const briefDetailLink = (turnId: string, target: string): string => {
    const url = buildChatUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, turnId, stripPrincipalPrefix(target));
    const tag = tagOfKey(target);
    return tag ? `[${labelFor(tag)} #${tag}](${url})` : `[🧙](${url})`;
  };

  // 收口一条 loading 气泡: finish=true 写入最终内容, 只生效一次。发送失败退回 standalone。
  // raw=true skips withSessionTag (used when content already contains the linked tag header).
  // WeCom 客户端收到 finish=true 后仍有打字机动画要播放, 如果紧接着就下发
  // standalone (sendMessage), 用户会看到 standalone 抢在气泡动画结束之前出现。
  // 把 finishBubble 的 replyStream promise 链入 standalonePending, 让后续
  // standalone 自然排在 finish 之后; 额外加一小段延迟留给客户端渲染。
  const BUBBLE_FINISH_SETTLE_MS = 600;
  const finishBubble = async (a: AttachState, b: BriefBubble | undefined, content: string, raw = false): Promise<void> => {
    if (!b || b.done) return;
    b.done = true;
    clearTimeout(b.hardTimer);
    if (a.briefBubble === b) a.briefBubble = undefined;
    // 气泡要定稿了 —— 排队中的 CoT 进度必须撤掉, 否则它会把 `链接 正文` 覆盖回进度行。
    clearCot(a);
    const p = (async () => {
      try {
        await client.replyStream(b.frame, b.streamId, raw ? (content || " ") : withLinkedTag(a, content || " "), true);
        // 给 WeCom 客户端留一点时间完成打字机动画, 再放行 standalone 队列。
        await new Promise<void>((r) => setTimeout(r, BUBBLE_FINISH_SETTLE_MS));
      } catch (e) {
        log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "brief: bubble finish failed; standalone fallback");
        if (content.trim()) raw ? sendRaw(a, content) : sendStandalone(a, content);
      }
    })();
    // 链入 standalonePending, 后续 sendStandalone/sendRaw 自然等 finish 完成。
    a.standalonePending = a.standalonePending.then(() => p).catch(() => undefined);
    return p;
  };

  const finishBriefBubble = (a: AttachState, content: string, raw = false): Promise<void> => finishBubble(a, a.briefBubble, content, raw);

  // 让一个已建好记录的 turn 成为活跃 turn。turn 级状态在这里统一归零 —— 唯一入口。
  const openBriefTurn = (a: AttachState, q: QueuedTurn): void => {
    a.briefTurnId = q.turnId;
    a.briefBubble = q.bubble;
    a.briefIsSlash = q.isSlash;
    a.briefHadTool = false;
    a.briefConcluded = false;
    a.briefLastText = undefined;
    clearCot(a); // turn 级状态 —— 进度行跟着气泡走, 不能跨 turn 残留
    log.info({ sessionId: a.sessionId, turnId: q.turnId, isSlash: q.isSlash }, "brief: turn started");
  };

  // WeCom 侧发起一个 turn。断点是一次性的: 只归给断点后的第一轮, 之后的轮次上下文又连续了。
  const consumeCut = (a: AttachState): CtxCut | undefined => {
    const cut = a.ctxCut;
    a.ctxCut = undefined;
    return cut;
  };

  // graph 归因同样一次性: 一次注入只解释它开出的那一轮。超过 ORIGIN_TTL_MS 还没被
  // 认领 = 那次注入没能开出 turn, 印章作废 —— 宁可少标一轮, 也不能把人打的字冒认成
  // graph 派的 (归因错了比没有更糟)。
  const ORIGIN_TTL_MS = 5 * 60_000;
  const consumeOrigin = (a: AttachState): TurnOrigin | undefined => {
    const p = a.pendingOrigin;
    a.pendingOrigin = undefined;
    return p && Date.now() - p.at <= ORIGIN_TTL_MS ? p.origin : undefined;
  };

  const startBriefTurn = async (a: AttachState, frame: WsFrameHeaders, streamId: string, isSlash = false, userQuery = ""): Promise<void> => {
    const turnId = newTurnId();
    recordTurnStart({ id: turnId, target: a.target, sessionId: a.sessionId, cwd: a.runningCwd || undefined, userQuery: userQuery.trim() || undefined, cut: consumeCut(a), origin: consumeOrigin(a) });
    // hardTimer 兜底: turn 若无终句 / turn_end 收口 (卡死/漏收), 到点仍收气泡。
    const bubble: BriefBubble = { frame, streamId, hardTimer: undefined as unknown as NodeJS.Timeout, done: false };
    const q: QueuedTurn = { turnId, bubble, isSlash };
    bubble.hardTimer = setTimeout(() => {
      // WeCom ~6min stream 窗口快到, 必须 finish=true 收口。
      void finishBubble(a, bubble, briefDetailLink(turnId, a.target), true);
    }, HARD_TIMEOUT_MS);
    // 新消息 = 对话边界: 立刻收掉上一 turn, 新 turn 直接激活、不排队。收口语义见
    // closeBriefTurn: 有正文收入旧气泡, 没正文不写一个字 (绝不因边界结束凭空新发/
    // 覆盖消息)。旧 turn 在 CLI 侧的剩余产出自然流入新气泡 —— "新回复走最新气泡"
    // 正是这个语义。代价是旧 turn 页提前标完、尾部 item 记到新 turn 名下, 但远小于
    // 排队的代价: 排队 turn 的 frame 在前一个长 turn 期间 (可达数分钟) 过期, 激活后
    // replyStream 全被 WeCom 拒收 (#stream 事故的静默根因)。
    if (a.briefTurnId) closeBriefTurn(a);
    openBriefTurn(a, q);
    // ack 即详情链接。URL 的三个入参 (turnId / target / host) 在收消息这一刻全部已知 ——
    // turnId 是本地生成的, 详情页记录也已在 recordTurnStart 建好, 所以不必等 CLI 产出,
    // 也不必猜后端: codebuddy 那种几十秒后才落盘的轮, 入口从第一秒就在。
    // 尾随 `…` 表示"正文还没到", 正文到位时整条内容被 `链接 正文` 覆盖。
    try {
      await client.replyStream(frame, streamId, `${briefDetailLink(turnId, a.target)} …`, false);
    } catch (e) {
      log.warn({ sessionId: a.sessionId, turnId, err: (e as Error).message }, "brief: turn ack failed");
    }
  };

  // 无气泡 turn。CLI 侧自己开的一轮 (WeCom 从没发过消息, 拿不到 frame/streamId), 以及
  // 收口后仍有 item 补写进来的情况, 都要有一个 turn 承接 —— 否则每条 tool/text 都掉进
  // fallback standalone, 一轮工具密集的对话能在群里刷出几十条散装气泡。这里只推一条
  // 详情链接当入口, 其余全部收进 turn 页, 与 WeCom 侧发起的 turn 表现一致。
  const ensureBriefTurn = (a: AttachState): void => {
    if (a.briefTurnId) return;
    const turnId = newTurnId();
    const query = a.pendingBriefQuery?.replace(/^> ?/gm, "").trim();
    a.pendingBriefQuery = undefined;
    recordTurnStart({ id: turnId, target: a.target, sessionId: a.sessionId, userQuery: query || undefined, cut: consumeCut(a), origin: consumeOrigin(a) });
    a.briefTurnId = turnId;
    a.briefBubble = undefined;
    a.briefIsSlash = false;
    a.briefHadTool = false;
    a.briefConcluded = false;
    a.briefLastText = undefined;
    clearCot(a);
    sendRaw(a, briefDetailLink(turnId, a.target));
    log.info({ sessionId: a.sessionId, turnId }, "brief: turn started (CLI-side, no bubble)");
  };

  // 本轮出现过工具调用 / tool_result / 非 final 文本 —— 只记状态: 详情链接从 ack 起
  // 就挂在气泡里, 无需再推一次。气泡仍然不关, 等正文到来后以 `链接 正文` 覆盖收口。
  const markBriefTool = (a: AttachState): void => {
    if (!a.briefTurnId) return;
    a.briefHadTool = true;
  };

  // 本轮结论落地, 只生效一次:
  //   • 气泡仍开 (ack 时的 `链接 …` 还在) → 以 `链接 正文` 覆盖收口;
  //   • 气泡已收 (过 6min 窗口 / 已收口) 或无气泡 turn (CLI 侧发起) → body 走 standalone,
  //     那条 standalone 自带 `链接` 头 (withLinkedTag / ensureBriefTurn 已发过详情链接)。
  const concludeBriefTurn = (a: AttachState, body: string): void => {
    const turnId = a.briefTurnId;
    if (!turnId || a.briefConcluded || !body.trim()) return;
    a.briefConcluded = true;
    if (a.briefBubble && !a.briefBubble.done) {
      void finishBriefBubble(a, `${briefDetailLink(turnId, a.target)} ${body}`, true);
    } else {
      sendStandalone(a, body);
    }
    // 只保留当前 turn: 其余仍开着的 turn 记录是漏收的 close, 一并扫掉。
    recordCloseOpenTurns({ target: a.target, sessionId: a.sessionId, exceptIds: [turnId] });
  };

  /** 收口一个 turn (软/硬/对话边界统一语义):
   *  有正文 (briefLastText) → 收入本 turn 自己的气泡 (`链接 正文`) 收口, 不另发消息;
   *  气泡已收/不在 → 正文走 standalone (有内容才有资格发)。
   *  没有正文 → 一个字都不写: finish=true 是整条覆盖, 空收口只会把 `链接 …`/CoT
   *  进度行覆盖成光秃秃的链接。气泡保持现有内容, 由 WeCom 6min 窗口自然到期。 */
  const closeBriefTurn = (a: AttachState): void => {
    if (!a.briefTurnId) return;
    concludeBriefTurn(a, a.briefLastText ?? "");
    recordTurnClose(a.briefTurnId);
    log.info({ sessionId: a.sessionId, turnId: a.briefTurnId }, "brief: turn closed");
    a.briefTurnId = undefined;
    a.briefBubble = undefined;
    a.briefHadTool = false;
    a.briefIsSlash = false;
    a.briefConcluded = false;
    a.briefLastText = undefined;
    clearCot(a);
  };

  // 强制收口一个 attachment 的全部出站通道, 并返回收掉的气泡/流条数。
  //
  // 关键约束: **一个 tmux 调用都不许有**。它的两个调用方 (`/stop` 和 inject
  // watchdog) 恰恰是在 tmux 已经卡死时才最需要生效 —— 历史故障里 tmux 无响应
  // 导致 dispatch 静默挂死, 用户在手机上看到一条永不结束的 "…" 气泡, 发 /stop
  // 也没用 (旧 /stop 第一件事就是 tmuxPaneAlive, 一起卡死)。所以这里只做纯内存
  // 状态的清算, Esc 之类要碰 pane 的动作留给调用方在这之后自己尽力去做。
  const teardownOutbound = (a: AttachState, note?: string): number => {
    let closed = 0;
    if (a.briefTurnId) {
      closed++;
      closeBriefTurn(a);
    }
    clearCot(a); // 无 turn 也要撤: 它可能正挂在一个已被 finish 掉的气泡上
    if (a.softEnd) { clearTimeout(a.softEnd); a.softEnd = undefined; }
    if (a.outbound) {
      if (a.outbound.kind === "deferred") clearTimeout(a.outbound.timer);
      a.outbound = undefined;
    }
    if (a.standaloneBuf) { clearTimeout(a.standaloneBuf.timer); flushStandalone(a); }
    if (a.liveStream && !a.liveStream.closed) {
      closed++;
      void finalizeStream(a, a.liveStream);
    }
    if (note) sendStandalone(a, note);
    return closed;
  };

  // Watchdog around one inject job. The failure this exists for: every await in
  // the job chain used to be unbounded, so a wedged tmux server parked the job
  // forever — no log line, no error bubble, and the per-session queue stayed
  // locked behind it, muting that chat until the daemon restarted. Now the queue
  // is released on a deadline and the user gets told.
  const withInjectWatchdog = async (a: AttachState, gen: number, job: () => Promise<void>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), INJECT_JOB_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      job().then(
        () => "done" as const,
        (e: unknown) => {
          log.error({ target: a.target, sessionId: a.sessionId, err: (e as Error)?.message }, "inject job threw");
          return "done" as const;
        },
      ),
      timedOut,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome !== "timeout") return;
    // Racing already released the queue for the next message. The zombie is
    // still parked in tmux, so bump the generation to disarm its paste, and
    // detach the queue chain it thinks it owns.
    if ((a.injectGen ?? 0) === gen) a.injectGen = gen + 1;
    abortInjectQueue(a.sessionId);
    log.error(
      { target: a.target, sessionId: a.sessionId, gen: a.injectGen, timeoutMs: INJECT_JOB_TIMEOUT_MS },
      "inject job watchdog fired — queue released, turn abandoned",
    );
    teardownOutbound(
      a,
      `[mirror] ✗ 注入超时 ${Math.round(INJECT_JOB_TIMEOUT_MS / 1000)}s — tmux 无响应, 本轮已放弃。再发一条消息即可重试, 或 \`/new\` 换个 pane。`,
    );
  };

  // Route one RenderItem into the turn store. final text 会额外作为 standalone 发群。
  const handleBriefItem = (a: AttachState, item: RenderItem): void => {
    const turnId = a.briefTurnId;
    if (!turnId) return;
    const now = Date.now();
    if (item.kind === "tool_use") {
      markBriefTool(a);
      updateBriefProgress(a, cotToolLabel(item.calls));
      for (const c of item.calls) {
        // 也走单卡 detail record — turn 页里 tool_use 段可点开链到独立详情 (以后有需要时)。
        if (c.toolUseId) {
          recordTool({
            id: c.toolUseId,
            toolName: c.name,
            toolInput: c.input,
            sessionId: a.sessionId,
            target: a.target,
          });
        }
        recordTurnItem(turnId, {
          t: "tool_use",
          toolUseId: c.toolUseId,
          toolName: c.name,
          toolInput: c.input,
          ts: now,
        });
      }
      return;
    }
    if (item.kind === "tool_result") {
      markBriefTool(a);
      recordTurnItem(turnId, { t: "tool_result", toolUseId: item.toolUseId, body: item.full, ts: now });
      return;
    }
    if (item.kind === "text") {
      recordTurnItem(turnId, { t: "text", body: item.body, ts: now, final: item.final === true });
      a.briefLastText = item.body;
      if (item.final === false) markBriefTool(a);
      if (item.final === true) concludeBriefTurn(a, item.body);
      // 非终句文本 (中途叙述, 软后端含最终答案本身) 也是 CoT —— 推进进度行。
      // 终句走 conclude 直接定稿气泡, clearCot 会撤掉可能挂着的进度刷新。
      else updateBriefProgress(a, item.body);
      return;
    }
    if (item.kind === "turn_end") {
      closeBriefTurn(a);
      return;
    }
    if (item.kind === "turn_usage") {
      recordTurnUsage(turnId, { model: item.model, messageId: item.messageId, usage: item.usage });
      return;
    }
    if (item.kind === "skill_output") {
      recordTurnItem(turnId, { t: "text", body: item.body, ts: now });
      // quiet (subagent 回执): 只留在 turn/detail 页, 不占一条聊天消息。
      if (item.quiet) return;
      // slash 命令 (/context…) 的 skill_output 即本轮答案 (无 final text 收口) —— 写进
      // loading 气泡。非 slash 场景的 skill_output 是用户可见的中间反馈, 走 standalone。
      if (a.briefIsSlash && !a.briefHadTool && a.briefBubble && !a.briefBubble.done) {
        void finishBriefBubble(a, item.body);
      } else {
        sendStandalone(a, item.body);
      }
      return;
    }
    // user_text (CLI 侧输入) 在 brief 下丢弃 — turn 视角不需要展示。
  };

  const goalBanner = (cond: string): string =>
    cond
      ? `🎯 目标已设置，进入自主执行：${cond}\n进度将实时推送。`
      : "🎯 进入目标自主执行模式，进度将实时推送。";

  // Enter goal-progress mode. The /goal was (usually) sent from WeCom, so a brief
  // loading bubble is open — finalize it to the goal banner and close the brief
  // turn so its turn_end-gated state doesn't dangle for the whole (never-ending)
  // run. When goal was set from the CLI there's no brief turn — just announce.
  const enterGoalMode = (a: AttachState, condition: string): void => {
    if (a.goalActive) return; // 幂等: 重放/重复 marker 不再重发 banner
    const banner = goalBanner(condition);
    if (a.briefBubble && !a.briefBubble.done) void finishBriefBubble(a, banner);
    else enqueueStandalone(a, banner);
    // 活跃 brief turn 也收掉: goal 期间所有 item 走 handleGoalItem, 它永远等不到
    // 自己的 turn_end。气泡已 done → closeBriefTurn 不会重复收口。
    if (a.briefTurnId) closeBriefTurn(a);
    a.goalActive = true;
    log.info({ sessionId: a.sessionId, target: a.target, condition }, "goal: entered progress mode");
  };

  // Route items while a goal is active. Text (the model's inter-tool narration and
  // the final answer) streams as standalone progress; tools/results stay in the
  // detail store only (renderLine already recorded them) to avoid flooding the
  // chat with hundreds of tool bubbles. turn_end = the goal auto-cleared and the
  // model finally stopped → leave goal mode; normal brief resumes next turn.
  const handleGoalItem = (a: AttachState, item: RenderItem): void => {
    if (item.kind === "text" || item.kind === "skill_output") {
      if (item.kind !== "skill_output" || !item.quiet) enqueueStandalone(a, item.body);
      return;
    }
    if (item.kind === "turn_end") {
      a.goalActive = false;
      log.info({ sessionId: a.sessionId, target: a.target }, "goal: cleared (turn ended)");
      return;
    }
    // tool_use / tool_result / user_text / turn_usage: recorded to detail store; no bubble.
  };

  // 软收口到点: 静默期内没有新 item, 确认这一轮真的结束了。
  const fireSoftTurnEnd = (a: AttachState): void => {
    a.softEnd = undefined;
    log.debug({ sessionId: a.sessionId, turnId: a.briefTurnId }, "soft turn_end confirmed");
    if (a.goalActive) { handleGoalItem(a, { kind: "turn_end" }); return; }
    if (cfg.wrc.mirror.brief && a.briefTurnId) { closeBriefTurn(a); return; }
    if (a.liveStream && !a.liveStream.closed) void finalizeStream(a, a.liveStream);
  };

  // Close the keepalive quiet window — the ping turn is over (or the fail-safe
  // fired), so subsequent real items flow through onItem normally again.
  const endKeepaliveQuiet = (a: AttachState): void => {
    if (!a.keepaliveQuiet) return;
    clearTimeout(a.keepaliveQuiet);
    a.keepaliveQuiet = undefined;
  };

  // A keepalive ping turn is swallowed wholesale — the reply content doesn't
  // matter (model may add extra commentary beyond "pong", that's fine).

  const onItem = (a: AttachState, item: RenderItem): void => {
    // 新 spawn 的 pane 在首次 inject 落地前吞掉所有初始输出 (greeting/system)。
    if (a.muteUntilInject) return;
    // Keepalive ping turns are cache-warmers: swallow every item from the WeCom
    // paths so the ping/pong never reaches chat. But record the REAL exchange
    // into its chat-detail turn — the actual assistant reply, the tool calls if
    // any, and the usage (proof it was a cheap cache-read) — so the detail page
    // shows the genuine heartbeat, not a synthetic summary.
    if (a.keepaliveQuiet) {
      const id = a.keepaliveTurnId;
      if (id) {
        const now = Date.now();
        if (item.kind === "text") {
          recordTurnItem(id, { t: "text", body: item.body, ts: now, final: item.final === true });
        } else if (item.kind === "tool_result") {
          recordTurnItem(id, { t: "tool_result", toolUseId: item.toolUseId, body: item.full, ts: now });
        } else if (item.kind === "turn_usage") {
          recordTurnUsage(id, { model: item.model, messageId: item.messageId, usage: item.usage });
        } else if (item.kind === "turn_end") {
          recordTurnClose(id);
          a.keepaliveTurnId = undefined;
        }
      }
      if (item.kind === "turn_end") { endKeepaliveQuiet(a); }
      return;
    }
    // 任何新 item 到达 = 上一条"消息写完了"并不代表这一轮结束 → 撤销待确认的软收口。
    // 硬信号 (end_turn / turn_duration) 的后端永远不会走到这里。
    if (a.softEnd) { clearTimeout(a.softEnd); a.softEnd = undefined; }
    // thinking 唯一的出口是 brief 气泡的 CoT 进度行。必须在这里就吃掉 —— 漏到下面任何
    // 一条通道 (deferred buf → renderBuf / standalone / stream append) 都会把它写进正文,
    // 那就变回已下线的 thinkStyle 了。
    if (item.kind === "thinking") {
      if (cfg.wrc.mirror.brief && a.briefTurnId) updateBriefProgress(a, item.body);
      return;
    }
    if (item.kind === "turn_end" && item.soft === true) {
      a.softEnd = setTimeout(() => fireSoftTurnEnd(a), softTurnEndMsFor(a));
      return;
    }
    // codebuddy: ExitPlanMode 若被本地先答, result 落盘即作废挂着的计划审批卡
    // (卡 pending 期间 model 阻塞在本地对话框, 不可能有其它 tool_result)。
    if (item.kind === "tool_result") mootMirrorPlan(a.sessionId);
    // Record tool_use signatures unconditionally (before any state branching),
    // so flushBeforeCard's poll-drain can detect that the to-be-approved tool
    // is now persisted in the jsonl regardless of DEFERRED/STREAMING/IDLE.
    if (item.kind === "tool_use") {
      for (const c of item.calls) {
        const sig = toolUseSig(c.name, c.input);
        a.recentToolSigs.delete(sig); // re-insert at tail to keep recency order
        a.recentToolSigs.set(sig, Date.now());
        while (a.recentToolSigs.size > RECENT_SIGS_MAX) {
          const oldest = a.recentToolSigs.keys().next().value;
          if (oldest === undefined) break;
          a.recentToolSigs.delete(oldest);
        }
        // codebuddy 的 ExitPlanMode 完全不过 PreToolUse hook (实测: 由
        // interruption-service 本地对话框裁决, HookExecutor 零调用)。mirror 从
        // jsonl 看到 function_call → 发计划审批卡; 点选后 send-keys 裁决本地
        // 对话框 (Enter=同意, 默认高亮 Yes / Escape=选项 2 标注的快捷键)。
        // claude 系 hook 即时触发, 不走此路 (否则双重发卡)。
        if (
          c.name === "ExitPlanMode"
          && backendForPath(a.jsonlPath).name === "codebuddy"
          && !hasMirrorPlan(a.sessionId)
        ) {
          void runMirrorPlanFlow({
            log: log.child({ sessionId: a.sessionId }),
            client,
            sessionId: a.sessionId,
            chatKey: a.target,
            cwd: a.runningCwd,
            jsonlPath: a.jsonlPath,
            voteTimeoutMs: cfg.approval.longPollSec * 1000,
            sendKey: async (key) => {
              if (!a.tmuxPane) return { ok: false, reason: "no_live_pane" };
              if (!(await tmuxPaneAlive(a.tmuxPane))) return { ok: false, reason: "pane_dead" };
              const r = await tmuxRun(["send-keys", "-t", a.tmuxPane, key]);
              return r.code === 0 ? { ok: true } : { ok: false, reason: `send-keys ${key} failed: ${r.stdout.slice(-200) || r.code}` };
            },
          });
        }
        // codebuddy 对 AskUserQuestion 不在提问时触发 PreToolUse hook — 先弹本地
        // 面板, hook 只在面板被提交后才到达 (实测可延迟数小时)。这里从 jsonl 提前
        // 看到 function_call, 直接驱动 vote 卡让远端可答; 点选后注入一段触发文本
        // 提交本地面板, hook 到达时以 deny+reason 覆盖答案, 与 claude 路径同产物。
        // claude 系 hook 即时触发, 不走此路 (否则双重发卡)。
        if (
          c.name === "AskUserQuestion"
          && backendForPath(a.jsonlPath).name === "codebuddy"
          && !hasMirrorAskq(a.sessionId)
        ) {
          void runMirrorAskqFlow({
            log: log.child({ sessionId: a.sessionId }),
            client,
            sessionId: a.sessionId,
            chatKey: a.target,
            toolInput: c.input,
            voteTimeoutMs: cfg.wrc.mirror.askqVoteTimeoutSec * 1000,
            drive: async (acts) => {
              // 面板只活在 TTY 里 — 无 pane 无法驱动 (spawn 注入会变成新 prompt)。
              if (!a.tmuxPane) return { ok: false, reason: "no_live_pane" };
              if (!(await tmuxPaneAlive(a.tmuxPane))) return { ok: false, reason: "pane_dead" };
              for (const act of acts) {
                if (act.kind === "text") {
                  // 贴文本到自定义输入行: 复用 inject 的 bracketed-paste + Enter。
                  const r = await inject({
                    text: act.text,
                    cfg,
                    log: log.child({ principal: a.target, sessionId: a.sessionId }),
                    sessionId: a.sessionId,
                    jsonlPath: a.jsonlPath,
                    tmuxTarget: a.tmuxPane,
                    freshSpawn: false,
                  });
                  if (!r.ok) return r;
                } else if (act.kind === "confirm_submit") {
                  // 读屏确认收尾: 到提交页 → Enter → 面板关闭, 取代盲发 Enter。
                  const r = await confirmAskqSubmit(a.tmuxPane!, () => tmuxPaneAlive(a.tmuxPane!));
                  if (!r.ok) return r;
                } else {
                  for (const key of act.keys) {
                    const r = await tmuxRun(["send-keys", "-t", a.tmuxPane!, key]);
                    if (r.code !== 0) return { ok: false, reason: `send-keys ${key}: ${r.stdout.slice(-200) || r.code}` };
                    await sleepMs(120); // 键间距 — 等 TUI 重渲染, 防吞键
                  }
                }
                await sleepMs(300); // 题间/阶段间隔 — 等面板翻页
              }
              return { ok: true };
            },
          });
        }
      }
    }
    // /goal mode overrides everything below: the session-scoped Stop hook
    // self-drives the model with no terminal stop_reason, so turn_end never fires
    // and brief-mode would swallow the entire run into the turn store (silent
    // WeCom for the whole goal). Enter progress-streaming on the marker; while
    // active, stream text + drop tool bubbles until the completing turn's
    // turn_end. Placed before the brief short-circuit so goal wins over brief.
    if (item.kind === "goal_start") { enterGoalMode(a, item.condition); return; }
    if (a.goalActive) { handleGoalItem(a, item); return; }
    // Brief 模式下没有活跃 turn 时, 任何 assistant 侧产出都补开一个无气泡 turn ——
    // 覆盖 CLI 侧直接开的新一轮 (WeCom 没参与, 拿不到 frame) 与收口后的零星补写。
    // user_text 只记下来当下一轮的 query, 不开 turn (CLI 敲字 ≠ 一定有回复)。
    if (cfg.wrc.mirror.brief && !a.briefTurnId) {
      if (item.kind === "user_text") a.pendingBriefQuery = item.body;
      else if (BRIEF_TURN_OPENERS.has(item.kind)) ensureBriefTurn(a);
    }
    // Usage snapshots never flow into WeCom bubbles — brief 分支下 handleBriefItem
    // 会把它写进 turn store, 非 brief 下直接吞掉, 保持 onItem 主流程只处理有渲染
    // 输出的 item 类型。
    if (item.kind === "turn_usage" && !(cfg.wrc.mirror.brief && a.briefTurnId)) {
      return;
    }
    // Brief mode 短路: 所有正常流/deferral/awaiting 全跳过, 只写入 turn store,
    // 唯一发到群里的是 turn 结束时的 finish text (下文 handleBriefItem 处理)。
    if (cfg.wrc.mirror.brief && a.briefTurnId) {
      handleBriefItem(a, item);
      return;
    }
    // 到这里已经过了 brief 分支; turn_usage 若还残留(brief=false 走上面早退,
    // brief && briefTurnId 走 handleBriefItem), 逻辑上不可能, 兜底再吞一次让 TS
    // 收窄类型 —— 下方 append/standalone 分支只处理带 body 的 item。
    if (item.kind === "turn_usage") return;
    // tool_result 气泡推送开关。parseLine 现在无条件发出 tool_result (供 detail/turn
    // 页消费); 非-brief 的所有气泡消费路径(deferred/awaiting/streaming/standalone)
    // 在此统一 gate: includeToolResults=false 时不把 result 推进气泡, 与旧行为一致。
    if (item.kind === "tool_result" && !cfg.wrc.mirror.includeToolResults) return;
    // Brief mode 短路: 所有正常流/deferral/awaiting 全跳过, 只写入 turn store,
    // 唯一发到群里的是 turn 结束时的 finish text (下文 handleBriefItem 处理)。
    if (cfg.wrc.mirror.brief && a.briefTurnId) {
      handleBriefItem(a, item);
      return;
    }
    if (a.outbound?.kind === "deferred") {
      handleDeferredItem(a, item);
      return;
    }
    // AWAITING_APPR 兜底: needsApproval 是 mirror 这一侧的预判, hook (pre-tool-use.sh)
    // 那边在 permission_mode=auto/bypassPermissions/dontAsk 时直接放行, daemon 根本
    // 收不到 /approve, 也就永远不会有 card 点击 → onApproved 永远不触发 → AWAITING_APPR
    // 卡住, 后续 tool/text 全走 standalone fallback。这里只要看到任何新 item 到达就
    // 说明 claude 已继续执行 (hook 必然已返回 / 根本没拦), 把状态提升回 STREAMING,
    // 复用原 frame/streamId 让本轮回到打字机气泡。
    if (a.outbound?.kind === "awaiting_appr") {
      const { frame, streamId } = a.outbound;
      a.outbound = undefined;
      const s = openStream(a, frame, streamId);
      a.liveStream = s;
      log.info(
        { sessionId: a.sessionId, kind: item.kind, turnId: s.turnId },
        "outbound: AWAITING_APPR → STREAMING (hook bypassed, item arrived)",
      );
    }
    // Skill outputs (e.g. /model) always emit as standalone — never append to
    // an active stream so the result is independently visible.
    if (item.kind === "skill_output") {
      if (!item.quiet) enqueueStandalone(a, item.body);
      return;
    }
    // Assistant turn truly ended (stop_reason terminal). Finalize the live
    // bubble synchronously so it becomes quotable in WeCom without waiting
    // for the next inbound or the 6-min hard timeout. No body to append.
    if (item.kind === "turn_end") {
      if (a.liveStream && !a.liveStream.closed) {
        log.debug({ sessionId: a.sessionId, turnId: a.liveStream.turnId }, "turn_end → finalize");
        void finalizeStream(a, a.liveStream);
      }
      return;
    }
    // CLI-side user line marks a turn boundary that did NOT come from WeCom.
    // Close any open WeCom liveStream first so the new conversation gets its
    // own bubble — otherwise the user's CLI exchange silently mutates the
    // previous WeCom bubble (still within its 6min update window) and is
    // invisible on the chat side.
    if (item.kind === "user_text" && a.liveStream && !a.liveStream.closed) {
      void finalizeStream(a, a.liveStream);
    }
    const s = a.liveStream;
    if (s && !s.closed && !s.dead && !s.capped) {
      // 规则 1: tool→FINAL_text 截断。仅当 text 是本 turn 的终态文本(line
      // stop_reason ∈ end_turn/stop_sequence/max_tokens)且本流已出现过 tool
      // 时, 把"最终答复"切到独立 standalone — WeCom 消息列表预览看到的就是答
      // 案而不是中间 tool 噪声。中间过程的 text(final=false)保持 append, 多
      // 轮 think→tool→think 不再被切碎。
      if (item.kind === "text" && s.sawTool && item.final === true) {
        void finalizeStream(a, s);
        enqueueStandalone(a, item.body);
        return;
      }
      const sep = s.acc ? "\n\n" : "";
      const next = s.acc + sep + item.body;
      if (next.length > STREAM_SOFT_CAP) {
        s.acc = `${s.acc}${sep}…(超出 stream 容量上限，详情见"查看详情")`;
        s.capped = true;
      } else {
        s.acc = next;
      }
      if (item.kind !== "text") {
        recordToolEntry(s, item);
        s.sawTool = true;
      }
      log.debug({ sessionId: a.sessionId, turnId: s.turnId, kind: item.kind, accLen: s.acc.length }, "stream append");
      scheduleFlush(s);
      return;
    }
    log.info({ sessionId: a.sessionId, kind: item.kind, hasLive: !!s, closed: s?.closed, dead: s?.dead, capped: s?.capped }, "fallback standalone");
    enqueueStandalone(a, item.body);
  };

  const resolveTarget = (override?: string): string =>
    sanitizeId(override?.trim() || cfg.wrc.mirror.pushChat.trim() || cfg.defaultChat.trim());

  // Detach an attachment: finalize any live stream, stop the tail, drop from indexes.
  const detach = (a: AttachState, reason: string): void => {
    if (a.migrationWatcher) { a.migrationWatcher.cancel(); a.migrationWatcher = undefined; }
    a.clearRebind = undefined;
    if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
    a.outbound = undefined;
    if (a.softEnd) { clearTimeout(a.softEnd); a.softEnd = undefined; }
    if (a.briefTurnId) closeBriefTurn(a); // 活跃 turn 收掉 (队列已随对话边界策略移除)
    if (a.liveStream && !a.liveStream.closed) void finalizeStream(a, a.liveStream);
    if (a.standaloneBuf) { clearTimeout(a.standaloneBuf.timer); flushStandalone(a); }
    a.tail.stop();
    bySessionId.delete(a.sessionId);
    if (byTarget.get(a.target) === a) byTarget.delete(a.target);
    log.info({ sessionId: a.sessionId, target: a.target, reason }, "mirror detached");
  };

  // Click-to-detail URL for a tool_use id. Cached on the bridge so both
  // attach() and migrateAttachment() share the same closure. Returns ""
  // when disabled in config — renderLine then drops the markdown wrapping.
  // `principal` flows through to ww_uniq so all detail links from the same
  // chat reuse one WeCom inner-browser window.
  const detailUrlFor = (id: string, principal?: string): string =>
    cfg.daemon.detailLinksInMirror && id
      ? buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id, principal ? stripPrincipalPrefix(principal) : undefined)
      : "";

  const attach = ({ sessionId, jsonlPath, target: targetOverride, tmuxPane, tmuxSession, cwd, pendingCwd }: AttachArgs): AttachResult => {
    const target = resolveTarget(targetOverride);
    if (!target) return { ok: false, reason: "no target chat (set wrc.mirror.pushChat or defaultChat, or pass target)" };
    // Note: jsonlPath may not exist yet on the auto-spawn path — claude only
    // creates its transcript after the first user input. The tail tolerates a
    // missing file (existsSync gate at start, try/catch in drain) and the 1s
    // poll picks it up the moment claude writes the first line.
    // Replace any existing attach with the same sessionId or same target. The
    // sessionId clash is the "/wrc again from same window" case; the target
    // clash is "different window steals my WeCom chat" — both end the previous.
    // Guard: if a DIFFERENT principal already owns this sessionId, refuse rather
    // than detaching it — prevents cross-wire when concurrent restoreFromStore
    // calls race or heal logic picks the same newest jsonl.
    const prevBySid = bySessionId.get(sessionId);
    if (prevBySid && prevBySid.target !== target) {
      log.warn({ sessionId, existingTarget: prevBySid.target, incomingTarget: target }, "mirror attach: sessionId already bound to another principal, refusing");
      return { ok: false, reason: `sessionId ${sessionId} already bound to ${prevBySid.target}` };
    }
    if (prevBySid) detach(prevBySid, "sessionId reattach");
    const prevByTarget = byTarget.get(target);
    // Carry over pending request only when caller didn't explicitly say
    // otherwise. `undefined` (omitted) → carry from prev (re-attach case);
    // `""` → explicit clear (newSession just consumed it); `"/foo"` → set.
    const carryPending = pendingCwd !== undefined ? pendingCwd : (prevByTarget?.pendingCwd ?? "");
    if (prevByTarget) detach(prevByTarget, "target reassigned");
    // Build the attachment first so the tail's onItem closure can capture it.
    const a: AttachState = {
      sessionId,
      jsonlPath,
      target,
      tmuxPane: (tmuxPane ?? "").trim(),
      tmuxSession: (tmuxSession ?? "").trim(),
      // Explicit cwd (spawn path) wins; otherwise derive from jsonl head so
      // /wrc attaches inherit the bound session's real project dir instead of
      // collapsing to cfg.wrc.cwd (which would mislabel /pwd, /clear, /new).
      runningCwd: expandHome(((cwd ?? "").trim()) || readCwdFromJsonl(jsonlPath) || cfg.wrc.cwd),
      pendingCwd: carryPending,
      tail: { stop: () => undefined, drain: () => undefined }, // placeholder; replaced below
      standalonePending: Promise.resolve(),
      recentToolSigs: new Map(),
    };
    a.tail = startMirrorTail({
      jsonlPath,
      log: log.child({ sub: "tail", sessionId }),
      includeUser: cfg.wrc.mirror.includeUser,
      includeTools: cfg.wrc.mirror.includeTools,
      includeToolResults: cfg.wrc.mirror.includeToolResults,
      toolResultMaxChars: cfg.wrc.mirror.toolResultMaxChars,
      toolUseInlineMaxChars: cfg.wrc.mirror.toolUseInlineMaxChars,
      isOwnInject,
      isOwnAssistantSend,
      onItem: (item) => onItem(a, item),
      detailUrlFor,
      sessionId,
      target,
      // Dialect comes from the transcript's own root, not defaultCli — that is
      // what lets a claude session and a codebuddy session be mirrored at once.
      normalizeLine: backendForPath(jsonlPath).normalizeTranscriptLine,
    });
    bySessionId.set(sessionId, a);
    byTarget.set(target, a);
    // Preserve a persisted `/stop` pause across the re-attach: restore rebuilds the
    // record here, and dropping keepaliveOff would resurrect a session the user
    // explicitly quieted. restoreFromStore re-hydrates the in-memory flags below.
    const prevRec = deps.store.get(target);
    deps.store.set(target, {
      sessionId,
      jsonlPath,
      tmuxSession: a.tmuxSession || undefined,
      tmuxPane: a.tmuxPane || undefined,
      cwd: a.runningCwd || undefined,
      pendingCwd: a.pendingCwd || undefined,
      keepaliveOff: prevRec?.keepaliveOff,
      keepaliveOffAt: prevRec?.keepaliveOffAt,
    });
    log.info({ sessionId, jsonlPath, target, tmuxSession: a.tmuxSession, runningCwd: a.runningCwd, pendingCwd: a.pendingCwd, mirrors: bySessionId.size }, "mirror attached");
    return { ok: true, sessionId, jsonlPath, target };
  };

  // ── Persistence: restore-from-store (lazy + boot) ────────────────────
  // NOTE: this used to be a second hand-rolled `spawn("tmux", …)` that shadowed
  // the module-level helper — and had no timeout, so `/stop` itself could hang
  // on a wedged server. It now resolves to the same single exec path.

  // Verify a paneId still exists. `display-message -t <paneId>` succeeds iff
  // the pane is alive — and tmux pane ids monotonically increment within a
  // server lifetime, so a freed id will not be silently reused. We don't need
  // the session name, which matters because /wrc attaches capture only $TMUX_PANE.
  const tmuxPaneAlive = async (paneId: string): Promise<boolean> => {
    if (!paneId) return false;
    const r = await tmuxRun(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
    return r.code === 0 && r.stdout.trim() === paneId;
  };

  // Re-attach a stored binding for `principal`. Returns the resulting state, or
  // undefined if the on-disk transcript is gone (in which case the entry is
  // dropped so the next inbound flows through /new auto-spawn).
  // Every sessionId already bound to a DIFFERENT principal (live attachment or
  // persisted store). The cwd-newest heal must never hand one of these to
  // another peer: a chat's siblings all share one cwd, so "newest jsonl in cwd"
  // is a different peer's live transcript, not this one's rotation. Healing onto
  // it collapses N distinct peers onto one sessionId (attach() then dedupes by
  // sid and silently detaches all-but-one). Excluding claimed sids keeps each
  // peer on its own session.
  const sidsClaimedByOthers = (principal: string): Set<string> => {
    const s = new Set<string>();
    for (const [k, v] of Object.entries(deps.store.all())) if (k !== principal && v.sessionId) s.add(v.sessionId);
    for (const [k, a] of byTarget) if (k !== principal && a.sessionId) s.add(a.sessionId);
    return s;
  };

  const restoreFromStore = async (principal: string): Promise<AttachState | undefined> => {
    const rec = deps.store.get(principal);
    if (!rec) return undefined;
    let jsonlAbs = expandHome(rec.jsonlPath);
    // Prefer the stored pane id and validate via display-message. Pane ids
    // (`%N`) are monotonic per tmux server lifetime, so they're stable across
    // daemon reloads as long as the tmux server didn't restart. With the
    // shared `wezard` session hosting many chats, listing panes by session
    // name would mis-route to whichever window happens to be first — never
    // do that. If the stored pane is dead, leave tmuxPane empty and let
    // dispatch's respawn check reincarnate via `claude --resume <sid>`.
    // Resolved BEFORE the heal below: a live pane authoritatively owns
    // `rec.sessionId` (spawned as `--session-id <uuid>`), so a not-yet-written
    // jsonl means "no input yet", NOT "rotated away" — healing it onto some
    // unrelated newest-in-cwd file is exactly the cross-wire we must avoid.
    const storedPane = (rec.tmuxPane ?? "").trim();
    const livePane = storedPane && (await tmuxPaneAlive(storedPane)) ? storedPane : "";
    if (!existsSync(jsonlAbs)) {
      // First: the SAME-sid transcript may have merely relocated to a sibling
      // project dir (Claude Code EnterWorktree/ExitWorktree moved it while the
      // daemon was down). Re-home onto it WITHOUT changing the sessionId — the
      // tail then follows it natively. Must precede the latestJsonlForCwd heal,
      // which would otherwise grab whatever session is newest in the original
      // cwd's dir (usually a *different* chat) and cross-wire the mirror.
      const owner = backendForPath(expandHome(rec.jsonlPath));
      const relocated = findJsonlBySid(rec.sessionId, owner);
      if (relocated) {
        log.info({ principal, sessionId: rec.sessionId, from: rec.jsonlPath, to: relocated }, "mirror restore: sid relocated (worktree), re-homed");
        rec.jsonlPath = relocated;
        jsonlAbs = relocated;
        deps.store.set(principal, rec);
      } else if (livePane) {
        // Live pane, no transcript yet: a freshly-spawned peer that hasn't
        // received its first turn. The pane owns `rec.sessionId` and will write
        // `<sid>.jsonl` on first input; keep spawn-mode (the tail tolerates a
        // missing file). Do NOT heal — that is what made every idle sibling in a
        // shared cwd collapse onto the same newest jsonl.
        log.info({ principal, sessionId: rec.sessionId, pane: livePane }, "mirror restore: live pane, transcript not written yet — keeping spawn-mode binding");
      } else {
        // Pane dead AND transcript gone. Either the session rotated (`/clear` /
        // native `/new` the daemon missed, leaving a newer jsonl) or the peer was
        // spawned-then-killed before writing anything. Heal onto the newest jsonl
        // in the project dir — but skip any sid already bound to another peer, so
        // a dead node can't steal a live sibling's transcript. Fail-closed drop
        // when nothing unclaimed remains.
        const healed = latestJsonlForCwd(rec.cwd || cfg.wrc.cwd, owner, sidsClaimedByOthers(principal));
        if (!healed) {
          log.warn({ principal, jsonlPath: rec.jsonlPath }, "mirror restore: jsonl missing and no unclaimed sibling, dropping entry");
          deps.store.drop(principal);
          return undefined;
        }
        log.warn({ principal, from: rec.sessionId, to: healed.sessionId }, "mirror restore: recorded jsonl gone, healed to latest unclaimed in project dir");
        rec.sessionId = healed.sessionId;
        rec.jsonlPath = healed.jsonlPath;
        jsonlAbs = healed.jsonlPath;
        deps.store.set(principal, rec);
      }
    }

    // Pane-cwd worktree re-home: the stored jsonl can EXIST yet be stale because
    // the live pane entered/selected a git worktree, switching it to a DIFFERENT
    // sessionId in a sibling project dir. Trust the pane's real cwd — if its
    // project dir differs and holds a live session under another sid, bind that.
    // Without this, two chats whose panes diverged into worktrees but still
    // carry the old shared sid collide in bySessionId (attach → replace) and one
    // is silently detached; that detached chat then never mirrors again. Runs at
    // boot; the 3s drift follower maintains it thereafter.
    if (livePane) {
      const cwdRes = await tmuxRun(["display-message", "-p", "-t", livePane, "#{pane_current_path}"]);
      const paneCwd = cwdRes.stdout.trim();
      if (paneCwd) {
        // Encode under the backend that owns the bound transcript — comparing
        // with the primary dialect would report a phantom drift for every
        // session belonging to a non-primary CLI.
        const paneDir = projectDirFor(jsonlAbs, expandHome(paneCwd));
        if (paneDir !== dirname(jsonlAbs)) {
          const live = liveSessionForCwd(paneCwd, backendForPath(jsonlAbs), sidsClaimedByOthers(principal));
          if (live && live.sessionId !== rec.sessionId) {
            log.info({ principal, from: rec.sessionId, to: live.sessionId, paneCwd }, "mirror restore: pane in worktree, re-homed to live session");
            rec.sessionId = live.sessionId;
            rec.jsonlPath = live.jsonlPath;
            jsonlAbs = live.jsonlPath;
            rec.cwd = expandHome(paneCwd);
            deps.store.set(principal, rec);
          }
        }
      }
    }

    const r = attach({
      sessionId: rec.sessionId,
      jsonlPath: jsonlAbs,
      target: principal,
      tmuxPane: livePane,
      tmuxSession: rec.tmuxSession ?? "",
      cwd: rec.cwd,
      pendingCwd: rec.pendingCwd,
    });
    if (!r.ok) {
      log.warn({ principal, reason: r.reason }, "mirror restore: re-attach failed");
      return undefined;
    }
    // Re-hydrate the `/stop` pause so a reload doesn't resume pinging a quieted
    // session (attach preserved it on disk; this puts it back in memory).
    const restored = byTarget.get(principal);
    if (restored && rec.keepaliveOff) { restored.keepaliveOff = true; restored.keepaliveOffAt = rec.keepaliveOffAt; }
    log.info({ principal, sessionId: rec.sessionId, livePane: livePane || "(spawn-mode)" }, "mirror restored from store");
    return restored;
  };

  // Write the live `/stop` pause state through to the store (merging, not
  // clobbering, the rest of the record) so it survives a daemon reload.
  const persistPause = (a: AttachState): void => {
    const rec = deps.store.get(a.target);
    if (rec) deps.store.set(a.target, { ...rec, keepaliveOff: a.keepaliveOff, keepaliveOffAt: a.keepaliveOffAt });
  };


  // We re-attach lazily on demand too (see restoreFromStore in dispatch /
  // hasMirrorTarget), but eager boot-restore makes outbound (tail → push) work
  // even before any inbound arrives — e.g. claude finishes a long-running
  // background task and writes assistant content to the jsonl while idle.
  const persisted = deps.store.all();
  const persistedKeys = Object.keys(persisted);
  if (persistedKeys.length > 0) {
    for (const principal of persistedKeys) {
      void restoreFromStore(principal);
    }
  } else if (cfg.wrc.mirror.sessionId.trim()) {
    // Pinned-sessionId fallback: only honor when the store is empty (otherwise
    // the persisted bindings already cover the right sessions).
    const resolved = resolveSession(cfg, log);
    if (resolved) {
      const r = attach({ sessionId: resolved.sessionId, jsonlPath: resolved.jsonlPath });
      if (!r.ok) log.warn({ reason: r.reason }, "mirror: pinned auto-attach skipped");
    }
  } else {
    log.info("mirror: no persisted attachments and no pinned sessionId — waiting for /new or /mirror/attach");
  }

  // Render full tool details for a finalized turn into one-or-more markdown
  // chunks (split at chunkBytes boundaries).
  const renderToolDetails = (tools: ToolEntry[]): string[] => {
    const parts: string[] = [];
    let i = 0;
    for (const t of tools) {
      i += 1;
      const inputJson = t.input === undefined
        ? "(no input)"
        : (() => {
            try { return JSON.stringify(t.input, null, 2); } catch { return "(unrenderable)"; }
          })();
      const result = t.result ?? "(no result captured)";
      parts.push(
        `### ${i}. 🔧 ${t.name}\n\n**input**\n\`\`\`json\n${truncate(inputJson, 4000)}\n\`\`\`\n\n**result**\n\`\`\`\n${truncate(result, 4000)}\n\`\`\``,
      );
    }
    const merged = parts.join("\n\n---\n\n");
    return splitChunks(merged, Math.max(200, cfg.wrc.mirror.chunkBytes - TAG_HEADER_BUDGET));
  };

  const resolveToolDetail = (turnId: string): { target: string; markdown: string[] } | undefined => {
    evictTurns();
    const r = turnRegistry.get(turnId);
    if (!r) return undefined;
    return { target: r.target, markdown: renderToolDetails(r.tools) };
  };

  // ── /clear → session migration ──────────────────────────────────────
  // After `/clear` claude rotates to a fresh sessionId on the very next user
  // input. Detect the rotation by watching the project dir for a new .jsonl
  // that didn't exist at /clear time and contains a non-empty user line, then
  // re-target this attachment onto it.
  const isClearCommand = (text: string): boolean => {
    const t = text.trim();
    return t === "/clear" || t.startsWith("/clear ") || t.startsWith("/clear\n");
  };

  const listJsonls = (dir: string): Set<string> => {
    try {
      return new Set(readdirSync(dir).filter((n) => n.endsWith(".jsonl")));
    } catch {
      return new Set();
    }
  };

  // Every `/clear` the daemon injects, keyed by the project dir it rotates in.
  // Two chats mirroring panes in the SAME dir (the norm — one repo, many chats)
  // both produce an indistinguishable post-clear transcript; whichever watcher
  // ticks first would otherwise claim whichever file landed first and the two
  // chats stay cross-wired forever (persisted to the store). Recorded BEFORE
  // the inject so a sibling armed earlier still sees the overlap.
  const CLEAR_WINDOW_MS = 5 * 60_000; // == migration watcher TIMEOUT_MS
  const clearInjects: Array<{ dir: string; target: string; at: number }> = [];
  const noteClearInject = (a: AttachState): void => {
    const cut = Date.now() - CLEAR_WINDOW_MS;
    for (let i = clearInjects.length - 1; i >= 0; i--) if (clearInjects[i]!.at < cut) clearInjects.splice(i, 1);
    clearInjects.push({ dir: dirname(a.jsonlPath), target: a.target, at: Date.now() });
  };
  const siblingClearedSameDir = (a: AttachState): boolean => {
    const cut = Date.now() - CLEAR_WINDOW_MS;
    const dir = dirname(a.jsonlPath);
    return clearInjects.some((r) => r.at >= cut && r.dir === dir && r.target !== a.target);
  };

  // Post-/clear identification: claude rotates the session IMMEDIATELY on
  // /clear (not on next user input as the original design assumed) and writes
  // the `/clear` command itself as the first non-meta user line of the brand-
  // new jsonl. Match that signature to (a) confirm the file is a /clear-rotated
  // child, (b) avoid mis-migrating onto an unrelated jsonl that some other
  // claude process happened to create on the same cwd in our window.
  const SLASH_CLEAR_USER_RE = /<command-name>\s*\/clear\s*<\/command-name>/;
  const jsonlIsPostClearChild = (path: string): boolean => {
    try {
      const fd = openSync(path, "r");
      const size = statSync(path).size;
      const cap = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(cap);
      readSync(fd, buf, 0, cap, 0);
      closeSync(fd);
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = normalizeForPath(path, JSON.parse(line));
          if (!j || j.type !== "user" || j.isMeta || j.isSidechain) continue;
          const c = j.message?.content;
          // codebuddy writes the caveat + /clear + stdout as sibling plain user
          // messages — skip the noise so the DECIDING line is the first real
          // one, same as Claude's isMeta-filtered stream.
          if (isLocalCommandNoise(c)) continue;
          // First non-meta user line decides: /clear → match; anything else → reject.
          return typeof c === "string" && SLASH_CLEAR_USER_RE.test(c);
        } catch { /* partial line */ }
      }
    } catch { /* unreadable */ }
    return false;
  };

  // First non-meta user-line uuid of a transcript. A freshly resume-forked
  // child (`claude --resume <sid>` interactive) is seeded with a copy of the
  // parent transcript, so it carries a real user line the instant it appears —
  // this distinguishes it from an empty just-touched jsonl. (We can't reuse the
  // /clear signature: a resume fork's first user line is the actual prompt, not
  // `/clear`.) Returns undefined for empty/garbled files.
  const firstUserUuid = (path: string): string | undefined => {
    try {
      const fd = openSync(path, "r");
      const size = statSync(path).size;
      const cap = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(cap);
      readSync(fd, buf, 0, cap, 0);
      closeSync(fd);
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = normalizeForPath(path, JSON.parse(line));
          if (j?.type === "user" && !j.isMeta && !j.isSidechain && !isLocalCommandNoise(j.message?.content) && typeof j.uuid === "string") return j.uuid;
        } catch { /* partial line */ }
      }
    } catch { /* unreadable */ }
    return undefined;
  };

  // startOffset semantics differ by caller: /clear passes 0 to replay the
  // freshly-rotated jsonl (only holds the /clear line + new content); resume
  // migration omits it (→ tail from EOF) because the fork file is seeded with
  // the FULL prior transcript and replaying from 0 would re-dump it to WeCom.
  const migrateAttachment = (a: AttachState, newSessionId: string, newJsonlPath: string, startOffset?: number): void => {
    // Guard: if newSessionId is already bound to a DIFFERENT principal, abort —
    // prevents silent cross-wire (path B: /clear rotation or drift landing on
    // a sibling's live session).
    const incumbent = bySessionId.get(newSessionId);
    if (incumbent && incumbent.target !== a.target) {
      log.warn({ target: a.target, newSessionId, incumbentTarget: incumbent.target }, "migrateAttachment: target sid owned by another principal, aborting migration");
      return;
    }
    const oldSessionId = a.sessionId;
    const oldJsonlPath = a.jsonlPath;
    // 迁移是所有会话轮换的唯一漏斗 (注入的 /clear、TUI 里手打的 /clear、resume fork、
    // worktree drift)。只有目标 jsonl 首条用户行是 /clear 的那种才是真清空 —— fork /
    // drift 上下文是延续的, 让 store 去推它那条中性的 "switch"。
    if (jsonlIsPostClearChild(newJsonlPath)) {
      a.ctxCut = "clear";
      // 真清空 = 缓存里已无任何值得保温的内容。像 /stop 一样暂停保活 —— 与
      // dispatch 里 WeCom 注入 /clear 的暂停对齐;TUI 手打 /clear 只走这个漏斗,
      // 不在这里停下的话旧时钟会继续 ping 一个空上下文。busy-resume(过 grace)
      // 或真实 inbound 解除。下方 store.set 一并落盘。
      a.keepaliveOff = true;
      a.keepaliveOffAt = Date.now();
      a.keepalive = undefined;
    }
    a.tail.stop();
    bySessionId.delete(oldSessionId);
    a.sessionId = newSessionId;
    a.jsonlPath = newJsonlPath;
    bySessionId.set(newSessionId, a);
    a.tail = startMirrorTail({
      jsonlPath: newJsonlPath,
      log: log.child({ sub: "tail", sessionId: newSessionId }),
      includeUser: cfg.wrc.mirror.includeUser,
      includeTools: cfg.wrc.mirror.includeTools,
      includeToolResults: cfg.wrc.mirror.includeToolResults,
      toolResultMaxChars: cfg.wrc.mirror.toolResultMaxChars,
      toolUseInlineMaxChars: cfg.wrc.mirror.toolUseInlineMaxChars,
      isOwnInject,
      isOwnAssistantSend,
      onItem: (item) => onItem(a, item),
      detailUrlFor,
      sessionId: newSessionId,
      target: a.target,
      startOffset,
      // A migration can cross backends (rare, but the new jsonl is resolved by
      // path, not by CLI) — re-derive the dialect from the destination.
      normalizeLine: backendForPath(newJsonlPath).normalizeTranscriptLine,
    });
    deps.store.set(a.target, {
      sessionId: newSessionId,
      jsonlPath: newJsonlPath,
      tmuxSession: a.tmuxSession || undefined,
      tmuxPane: a.tmuxPane || undefined,
      cwd: a.runningCwd || undefined,
      pendingCwd: a.pendingCwd || undefined,
      // store.set 是整记录替换 —— 必须带上暂停态,否则迁移会把 dispatch 刚落盘
      // 的 /clear 暂停(或之前的 /stop 暂停)从盘上抹掉,reload 后保活复活。
      keepaliveOff: a.keepaliveOff || undefined,
      keepaliveOffAt: a.keepaliveOffAt || undefined,
    });
    log.info({ target: a.target, oldSessionId, newSessionId, oldJsonlPath, newJsonlPath, startOffset }, "mirror migrated session");
  };

  // Watch the project dir for a new jsonl (not in `baseline`) that satisfies
  // `isChild`, then re-bind the attachment onto it. Used by both /clear
  // (predicate = first user line is /clear; replay from 0) and dead-pane resume
  // (predicate = file has real user content; tail from EOF — the fork is seeded
  // with full history). `startOffset` flows through to migrateAttachment.
  // `exclusive` (the /clear flavor) refuses to claim on ambiguous evidence —
  // see claimIsAttributable.
  const startMigrationWatcher = (
    a: AttachState,
    baseline: Set<string>,
    isChild: (path: string) => boolean,
    startOffset?: number,
    exclusive?: boolean,
  ): void => {
    if (a.migrationWatcher) a.migrationWatcher.cancel(); // re-armed (e.g. /clear twice, or respawn during a pending watch)
    const projectDir = dirname(a.jsonlPath);
    // baseline is captured by the caller BEFORE inject/respawn runs — claude
    // creates the rotated/forked jsonl while processing it, so a baseline taken
    // here (post-inject) would already include it and migration would never fire.
    const POLL_MS = 500;
    const TIMEOUT_MS = 5 * 60_000; // generous: user may take a while to type
    const t0 = Date.now();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
      if (stopped) return;
      if (Date.now() - t0 > TIMEOUT_MS) {
        log.warn({ target: a.target, sessionId: a.sessionId }, "mirror migration: timeout, giving up");
        a.migrationWatcher = undefined;
        return;
      }
      const current = listJsonls(projectDir);
      // Exclude sids already bound to OTHER targets: when several panes in one
      // cwd fork/spawn concurrently (a graph's #t3/#sp/base all resuming), each
      // watcher sees ALL the new jsonls, not just its own pane's. Without this a
      // resume-fork watcher grabs a sibling's freshly-written transcript (newest
      // + has content) and two tags collapse onto one sessionId. The claimed set
      // pins each watcher off its siblings' sessions.
      const claimed = sidsClaimedByOthers(a.target);
      const candidates: string[] = [];
      for (const name of current) if (!baseline.has(name) && !claimed.has(name.replace(/\.jsonl$/, ""))) candidates.push(name);
      // Pick newest-mtime candidate that has user content. Older candidates
      // without content stay in the running until they accrue — never aborts.
      const ranked = candidates
        .map((n) => ({ n, mtime: (() => { try { return statSync(join(projectDir, n)).mtimeMs; } catch { return 0; } })() }))
        .sort((x, y) => y.mtime - x.mtime);
      const matches = ranked.filter((c) => isChild(join(projectDir, c.n)));
      // A `/clear` rotation is identified only by "first user line is /clear",
      // which every chat's /clear produces — the file carries nothing tying it
      // to a pane. So claim only on unambiguous evidence: exactly one match,
      // and no sibling attachment in this dir cleared inside the same window.
      // Otherwise stand down and let the next inject's text fingerprint decide
      // (see armSilentForkRebind + a.clearRebind) — a wrong pick here would
      // permanently wire this chat onto another chat's pane.
      if (exclusive && matches.length > 0 && (matches.length > 1 || siblingClearedSameDir(a))) {
        log.warn({ target: a.target, candidates: matches.map((c) => c.n) }, "mirror migration: ambiguous /clear rotation, deferring to inject fingerprint");
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const hit = matches[0];
      if (hit) {
        stopped = true;
        a.migrationWatcher = undefined;
        a.clearRebind = undefined;
        const newSid = hit.n.replace(/\.jsonl$/, "");
        if (newSid !== a.sessionId) migrateAttachment(a, newSid, join(projectDir, hit.n), startOffset);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    a.migrationWatcher = {
      cancel: () => { stopped = true; if (timer) clearTimeout(timer); },
    };
    log.info({ target: a.target, sessionId: a.sessionId, projectDir, baselineCount: baseline.size }, "mirror migration: watcher armed");
    timer = setTimeout(tick, POLL_MS);
  };

  // A user who runs /clear (or restarts claude) directly in the live TUI forks
  // the pane onto a NEW sid in the SAME project dir — invisible to both watchers
  // above (startMigrationWatcher wants a daemon-injected new file; followPaneDrift
  // wants a cross-dir move). The tail then sits on the dead old jsonl and the "…"
  // bubble never updates. After every inject, if the bound jsonl stays silent
  // while a same-dir sibling swallowed our exact injected text, rebind onto it —
  // replaying from our message so the response is mirrored.
  //
  // The rebind is only safe because the fork lives under THIS chat's own pane.
  // Three guards keep it from mis-migrating across the many sessions that
  // legitimately share one project dir (the classic "串session"):
  //   1. pane liveness — a dead pane means the fork premise is void (the
  //      dead-pane respawn path owns that); never cross-rebind then.
  //   2. pane cwd — the pane must still sit in the bound project dir; if it
  //      drifted elsewhere, followPaneDrift is the right handler.
  //   3. ownership — never adopt a sid another live mirror is already tailing;
  //      a fingerprint hit on a concurrently-busy sibling is a false positive,
  //      not our fork. A genuine TUI fork is a brand-new, unowned session.
  // The fingerprint itself is lengthened (and its min-length raised) so short /
  // common messages can't collide onto a stranger's transcript in the first place.
  //
  // It doubles as the resolver for a `/clear` rotation the dir-scan watcher
  // refused to attribute (a.clearRebind): same mechanism, but the candidate set
  // narrows to transcripts born after the clear, which makes a short
  // fingerprint safe enough to accept.
  const armSilentForkRebind = (a: AttachState, text: string): void => {
    const pendingClear = a.clearRebind;
    if (pendingClear) {
      // Hand over: the fingerprint is pane-certain, the dir-scan is not.
      a.migrationWatcher?.cancel();
      a.migrationWatcher = undefined;
      a.clearRebind = undefined;                    // one-shot — this inject is the evidence
    } else if (a.migrationWatcher) {
      return;                                       // don't race an in-flight watcher
    }
    if (!a.tmuxPane) return;                         // spawn-mode: no pane to fork under
    const stripped = text.replace(/\s+/gu, "");
    if (stripped.length < (pendingClear ? 4 : 16)) return; // too short to fingerprint safely
    const fp = stripped.slice(0, 120);              // long contiguous run → collision-resistant
    const dir = dirname(a.jsonlPath);
    const boundPath = a.jsonlPath;
    let baseSize = 0; try { baseSize = statSync(boundPath).size; } catch { /* fresh */ }
    const POLL_MS = 700;
    const TIMEOUT_MS = 25_000;
    const t0 = Date.now();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const reschedule = (): void => { timer = setTimeout(() => void tick(), POLL_MS); };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (Date.now() - t0 > TIMEOUT_MS) { a.migrationWatcher = undefined; return; }
      // Bound jsonl grew → our message landed in the right session; nothing to do.
      try { if (statSync(boundPath).size > baseSize) { a.migrationWatcher = undefined; return; } } catch { /* */ }
      // Guard 1+2: pane must be alive AND still in the bound project dir. One
      // display-message gives both — it fails on a dead pane, and its cwd tells
      // us whether the pane still belongs here.
      const r = await tmuxRun(["display-message", "-p", "-t", a.tmuxPane, "#{pane_current_path}"]);
      if (stopped) return;
      const paneCwd = r.code === 0 ? r.stdout.trim() : "";
      if (!paneCwd) { a.migrationWatcher = undefined; return; } // pane gone → dead-pane path owns it
      const paneDir = projectDirFor(boundPath, expandHome(paneCwd));
      if (paneDir !== dir) { reschedule(); return; }            // pane drifted → followPaneDrift owns it
      let names: string[] = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* */ }
      const boundName = boundPath.slice(dir.length + 1);
      const ranked = names
        .filter((n) => n !== boundName)
        // Post-/clear: only transcripts that didn't exist before the rotation
        // can be ours, which is what licenses the shorter fingerprint above.
        .filter((n) => !pendingClear || !pendingClear.baseline.has(n))
        .map((n) => ({ n, m: (() => { try { return statSync(join(dir, n)).mtimeMs; } catch { return 0; } })() }))
        .sort((x, y) => y.m - x.m);
      for (const c of ranked) {
        const off = findInjectOffset(join(dir, c.n), fp);
        if (off === undefined) continue;
        const newSid = c.n.replace(/\.jsonl$/, "");
        // Guard 3: a sid another live mirror already tails is that chat's
        // session, not our fork — a fingerprint false positive. Skip it and
        // keep scanning; a real fork is unowned.
        const owner = bySessionId.get(newSid);
        if (owner && owner !== a) {
          log.warn({ target: a.target, newSid, ownerTarget: owner.target }, "mirror: skip fork rebind — session owned by another mirror (fingerprint false positive)");
          continue;
        }
        stopped = true;
        a.migrationWatcher = undefined;
        if (newSid !== a.sessionId) {
          log.info({ target: a.target, oldSid: a.sessionId, newSid, off }, "mirror: silent same-dir fork, rebinding onto forked session");
          migrateAttachment(a, newSid, join(dir, c.n), off);
        }
        return;
      }
      reschedule();
    };
    a.migrationWatcher = { cancel: () => { stopped = true; if (timer) clearTimeout(timer); } };
    reschedule();
  };

  // ── Worktree / session drift follow ─────────────────────────────────
  // An inject isn't the only way the live session under a pane changes:
  // entering OR selecting a git worktree makes Claude Code switch the pane to a
  // DIFFERENT sessionId in a sibling project dir (the worktree cwd encodes to
  // its own dir). That's neither a same-sid rename (findJsonlBySid follows those
  // with a continuous offset) nor an inject-triggered rotation (startMigration-
  // Watcher catches those) — the old jsonl just goes quiet and the mirror tails
  // a dead file. Poll each attached pane's real cwd; when it points at a
  // different project dir whose live session has a different sid, migrate onto
  // it. Tail from EOF (undefined startOffset): the worktree session already
  // carries full history we don't want to re-dump to WeCom.
  let paneDriftTicking = false;
  const followPaneDrift = async (): Promise<void> => {
    if (paneDriftTicking) return; // skip overlapping ticks (tmux call is async)
    paneDriftTicking = true;
    try {
      const attachments = Array.from(byTarget.values()).filter((a) => a.tmuxPane);
      if (attachments.length === 0) return;
      const r = await tmuxRun(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_path}"]);
      if (r.code !== 0) return;
      const paneCwd = new Map<string, string>();
      for (const line of r.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab !== -1) paneCwd.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
      }
      for (const a of attachments) {
        if (a.migrationWatcher) continue;                    // inject-driven migration in flight
        if (a.liveStream && !a.liveStream.closed) continue;  // mid typewriter — don't yank the tail
        const cwd = paneCwd.get(a.tmuxPane);
        if (!cwd) continue;                                   // pane gone
        const paneDir = projectDirFor(a.jsonlPath, expandHome(cwd));
        if (paneDir === dirname(a.jsonlPath)) continue;       // same project dir — no drift
        const live = liveSessionForCwd(cwd, backendForPath(a.jsonlPath), sidsClaimedByOthers(a.target));
        if (!live || live.sessionId === a.sessionId) continue; // empty dir, or same-sid rename (tail follows it)
        a.runningCwd = expandHome(cwd);                        // migrateAttachment persists this to store
        log.info({ target: a.target, pane: a.tmuxPane, fromDir: dirname(a.jsonlPath), toDir: paneDir, oldSid: a.sessionId, newSid: live.sessionId }, "mirror: pane drifted (worktree), following live session");
        migrateAttachment(a, live.sessionId, live.jsonlPath);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "pane-drift follow tick failed");
    } finally {
      paneDriftTicking = false;
    }
  };
  const paneDriftTimer = setInterval(() => void followPaneDrift(), 3000);

  // ── Cwd lifecycle ───────────────────────────────────────────────────
  // Per-chat project path. Stored on the attachment (live) and persisted to
  // mirror-attachments.json so /pwd survives reload. `pendingCwd` is the
  // user-requested next cwd — applied only on /new (or /clear when it differs
  // from the running cwd). Decoupling means /pwd can show truth even after
  // the AI sets a new path but the user hasn't /new'd yet.
  const expandedDefaultCwd = expandHome(cfg.wrc.cwd);

  // Long absolute paths wrap in the WeCom bubble — show only the trailing
  // three segments, which is enough to identify the project.
  const shortCwd = (p: string): string => p.split("/").filter(Boolean).slice(-3).join("/");

  const renderProjectInfo = (target: string): string => {
    const a = byTarget.get(target);
    const rec = a ? undefined : deps.store.get(target);
    const running = (a?.runningCwd?.trim()) || rec?.cwd?.trim() || expandedDefaultCwd;
    // pendingCwd is chat-scoped — the queued switch applies to every session
    // in this chat, so read it from the shared base slot rather than the
    // caller's own (now-empty) attachment record.
    const pending = chatCwdFallback(target).pending;
    const lines = [`📂 cwd: \`${shortCwd(running)}\``];
    if (pending && pending !== running) {
      lines.push(`下次切换: \`${shortCwd(pending)}\` (使用 /new 或 /clear 生效)`);
    }
    // Session-boundary footer — `/new` and `/clear` are the only two callers,
    // so the tip lands exactly once per fresh context, never mid-conversation.
    lines.push(randomTip());
    return lines.join("\n");
  };

  // `header` folds the caller's ack ("created") into this same bubble — /new
  // must land as exactly ONE WeCom message, not card + separate reply.
  const pushProjectInfo = (target: string, header?: string): void => {
    const info = renderProjectInfo(target);
    const md = header ? `${header}\n\n${info}` : info;
    const a = byTarget.get(target);
    if (a) {
      sendStandalone(a, md);
      return;
    }
    // No attachment (rare — newSession always re-attaches before pushing).
    // Send via plain sendMessage so the user still gets the info.
    const chatId = stripPrincipalPrefix(target);
    void client
      .sendMessage(chatId, { msgtype: "markdown", markdown: { content: withSessionTag(target, md) } })
      .catch((e: unknown) => log.warn({ err: (e as Error).message, target }, "pushProjectInfo (no attach) failed"));
  };

  // Cwd is CHAT-SCOPED, not session-scoped: all sessions in the same chat
  // (default + any `#tag` siblings) share one cwd/pendingCwd, tracked on the
  // BASE principal's byTarget/store record. Tagged sessions still have their
  // own `runningCwd` (the tmux pane's actual working dir at spawn time), but
  // cwd fallbacks and `cd` pendingCwd writes always resolve against the base.
  const chatCwdFallback = (target: string): { pending: string; running: string } => {
    const base = basePrincipalOf(target);
    const baseA = byTarget.get(base);
    const baseRec = deps.store.get(base);
    return {
      pending: (baseA?.pendingCwd?.trim()) || (baseRec?.pendingCwd?.trim()) || "",
      running: (baseA?.runningCwd?.trim()) || (baseRec?.cwd?.trim()) || "",
    };
  };

  // /new path: kill the old pane (so we don't leak orphan tmux windows) and
  // spawn a fresh claude in pendingCwd ?? runningCwd ?? default. Returns the
  // new sessionId/cwd so callers can render the user-facing reply.
  const newSession = async (
    target: string,
    windowName?: string,
    cli?: CliBackendName,
    opts?: { model?: string; cwd?: string; silent?: boolean },
  ): Promise<{ ok: boolean; reason?: string; sessionId?: string; cwd?: string; info?: string }> => {
    const prev = byTarget.get(target);
    // Resolution precedence (all chat-scoped except the running-cwd fallback):
    //   base.pending > caller.pending > target.running > base.running > default
    // A fresh tagged session inherits the chat's current cwd; re-`/new`ing a
    // live tagged session keeps its pane cwd unless the base session queued a
    // `cd`. This keeps siblings aligned by default without forcibly clobbering
    // an already-spawned tagged pane on every base-cwd change.
    const chat = chatCwdFallback(target);
    const rec = !prev ? deps.store.get(target) : undefined;
    // An explicit per-node cwd (graph spec) outranks every chat-scoped fallback:
    // the point of declaring it is that this node lives in a different repo.
    // When no base session exists (tagged-only chats), setPendingCwd writes to
    // the caller's own record — include it here so the switch isn't lost.
    const eff =
      (opts?.cwd?.trim() ? expandHome(opts.cwd.trim()) : "") ||
      chat.pending ||
      (prev?.pendingCwd?.trim()) ||
      (prev?.runningCwd?.trim()) ||
      (rec?.cwd?.trim()) ||
      chat.running ||
      expandedDefaultCwd;
    // Inherit the outgoing session's CLI when the caller didn't name one: a
    // `/new` (or a /clear upgraded to /new) on a codebuddy-bound chat must stay
    // on codebuddy rather than silently reverting to `defaultCli`. Inheritance
    // is chat-scoped like cwd — a FIRST `/new #tag` has no record of its own,
    // so it falls back to the base session's binding instead of `defaultCli`
    // (otherwise a tagged sibling silently forks onto a different CLI).
    const base = basePrincipalOf(target);
    const baseBound = base === target ? undefined : byTarget.get(base)?.jsonlPath ?? deps.store.get(base)?.jsonlPath;
    const boundPath = prev?.jsonlPath ?? rec?.jsonlPath ?? baseBound;
    const effCli = cli ?? (boundPath ? backendForPath(expandHome(boundPath)).name : undefined);
    if (prev?.tmuxPane) {
      // Best-effort kill; ignore errors (pane may already be dead).
      void tmuxRun(["kill-pane", "-t", prev.tmuxPane]);
    }
    if (prev) detach(prev, "/new respawn");
    const r = await spawnTmuxClaude({
      cfg,
      log: log.child({ sub: "new-session", target }),
      windowName: windowName ?? target,
      cwdOverride: eff,
      cli: effCli,
      model: opts?.model,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const att = attach({
      sessionId: r.sessionId!,
      jsonlPath: r.jsonlPath!,
      target,
      tmuxPane: r.tmuxPane,
      tmuxSession: r.tmuxSession,
      cwd: r.cwd,
      // Explicit "" clears any carried-over pending — it has just been applied.
      pendingCwd: "",
    });
    if (!att.ok) return { ok: false, reason: att.reason };
    // 首条注入吃冷时序(injectText 走 /mirror/spawn 时已经硬编码 freshSpawn:true,
    // dispatch 这条隐式建会话的路径此前漏了)。
    const spawned = byTarget.get(target);
    if (spawned) {
      spawned.justSpawned = true;
      spawned.muteUntilInject = true;
      // 只有换过 pane 才是断点 —— 首次 /wrc 建会话时 prev 为空, 那不是"不连续", 是开局。
      if (prev) spawned.ctxCut = "new";
      // A freshly spawned session is empty — nothing in the cache to keep warm.
      // Pause keepalive like /stop; the first real turn (WeCom inbound, or the
      // pane going busy after the resume grace) re-earns the budget. Mirrors
      // interruptPane so /new can't strand a ping loop on an idle blank session.
      spawned.keepaliveOff = true;
      spawned.keepaliveOffAt = Date.now();
      spawned.keepalive = undefined; // re-anchors cleanly on resume
      persistPause(spawned);
    }
    // Clear the chat's pendingCwd on the BASE record too — the queued switch
    // has just been consumed by this respawn. Without this, a subsequent /new
    // #other would re-apply the same cd and diverge from user intent.
    if (base !== target) {
      const baseA = byTarget.get(base);
      if (baseA?.pendingCwd) {
        baseA.pendingCwd = "";
        deps.store.set(base, {
          sessionId: baseA.sessionId,
          jsonlPath: baseA.jsonlPath,
          tmuxSession: baseA.tmuxSession || undefined,
          tmuxPane: baseA.tmuxPane || undefined,
          cwd: baseA.runningCwd || undefined,
          pendingCwd: undefined,
        });
      } else {
        const baseRec = deps.store.get(base);
        if (baseRec?.pendingCwd) deps.store.set(base, { ...baseRec, pendingCwd: undefined });
      }
    }
    if (!opts?.silent) pushProjectInfo(target, "created");
    return { ok: true, sessionId: r.sessionId, cwd: r.cwd };
  };

  const getCwd = (target: string): { runningCwd: string; pendingCwd: string; defaultCwd: string } => {
    // pendingCwd is chat-scoped — a `cd` from any sibling session queues the
    // switch for the whole chat. runningCwd stays per-session (each pane has
    // its own spawn dir).
    const chat = chatCwdFallback(target);
    const pending = chat.pending;
    const a = byTarget.get(target);
    if (a) return { runningCwd: a.runningCwd || expandedDefaultCwd, pendingCwd: pending, defaultCwd: expandedDefaultCwd };
    const rec = deps.store.get(target);
    if (rec) return { runningCwd: rec.cwd?.trim() || expandedDefaultCwd, pendingCwd: pending, defaultCwd: expandedDefaultCwd };
    return { runningCwd: chat.running || expandedDefaultCwd, pendingCwd: pending, defaultCwd: expandedDefaultCwd };
  };

  // Write `pendingCwd` to the BASE principal so the switch applies chat-wide —
  // the next /new in any tagged/untagged session picks it up. `cd` from a
  // tagged session still writes to the shared slot, not the tagged session's
  // own record, matching "sessions share the chat's cwd".
  const setPendingCwd = (
    target: string,
    cwd: string,
  ): { ok: boolean; reason?: string; runningCwd: string; pendingCwd: string } => {
    const trimmed = (cwd ?? "").trim();
    if (!trimmed) return { ok: false, reason: "empty cwd", runningCwd: "", pendingCwd: "" };
    const expanded = expandHome(trimmed);
    if (!expanded.startsWith("/")) return { ok: false, reason: "cwd must be absolute (or start with ~)", runningCwd: "", pendingCwd: "" };
    const base = basePrincipalOf(target);
    const callerA = byTarget.get(target);
    const callerRunning = callerA?.runningCwd?.trim() || deps.store.get(target)?.cwd?.trim() || expandedDefaultCwd;
    const baseA = byTarget.get(base);
    if (baseA) {
      baseA.pendingCwd = expanded;
      deps.store.set(base, {
        sessionId: baseA.sessionId,
        jsonlPath: baseA.jsonlPath,
        tmuxSession: baseA.tmuxSession || undefined,
        tmuxPane: baseA.tmuxPane || undefined,
        cwd: baseA.runningCwd || undefined,
        pendingCwd: baseA.pendingCwd || undefined,
      });
      log.info({ target, base, runningCwd: callerRunning, pendingCwd: expanded }, "setPendingCwd (chat-scoped, live base)");
      return { ok: true, runningCwd: callerRunning, pendingCwd: expanded };
    }
    const baseRec = deps.store.get(base);
    if (baseRec) {
      deps.store.set(base, { ...baseRec, pendingCwd: expanded });
      log.info({ target, base, runningCwd: callerRunning, pendingCwd: expanded }, "setPendingCwd (chat-scoped, persisted base)");
      return { ok: true, runningCwd: callerRunning, pendingCwd: expanded };
    }
    // No base binding yet (caller is a tagged session created before any
    // default session existed). Fall back to writing on the caller's own
    // record so the pending switch isn't lost — the next default /new will
    // then inherit via chatCwdFallback and normalize onto the base.
    if (callerA) {
      callerA.pendingCwd = expanded;
      deps.store.set(target, {
        sessionId: callerA.sessionId,
        jsonlPath: callerA.jsonlPath,
        tmuxSession: callerA.tmuxSession || undefined,
        tmuxPane: callerA.tmuxPane || undefined,
        cwd: callerA.runningCwd || undefined,
        pendingCwd: callerA.pendingCwd || undefined,
      });
      log.info({ target, runningCwd: callerA.runningCwd, pendingCwd: callerA.pendingCwd }, "setPendingCwd (fallback: no base, wrote to caller)");
      return { ok: true, runningCwd: callerA.runningCwd, pendingCwd: callerA.pendingCwd };
    }
    const callerRec = deps.store.get(target);
    if (callerRec) {
      deps.store.set(target, { ...callerRec, pendingCwd: expanded });
      log.info({ target, runningCwd: callerRec.cwd, pendingCwd: expanded }, "setPendingCwd (fallback: no base, wrote to caller persist)");
      return { ok: true, runningCwd: callerRec.cwd?.trim() || expandedDefaultCwd, pendingCwd: expanded };
    }
    return { ok: false, reason: "no mirror binding for target — send a message in the WeCom chat first", runningCwd: "", pendingCwd: "" };
  };

  // ── Peer graph (sibling sessions of one chat) ────────────────────────
  // A chat's sessions are exactly the keys sharing its base principal: the
  // untagged default plus every `#tag`. Live attachments are the truth; the
  // persisted store fills in cold bindings so a peer nobody has talked to since
  // the last reload is still discoverable (and revivable) rather than invisible.
  const allTargets = (): string[] => {
    const keys = new Set([...byTarget.keys(), ...Object.keys(deps.store.all())]);
    return Array.from(keys).sort();
  };
  const chatTargets = (target: string): string[] => {
    const base = basePrincipalOf(target);
    return allTargets().filter((k) => basePrincipalOf(k) === base);
  };

  // 名字解析:`daily` / `chat:wrxxx` → base principal。认不出就把已知名字一并回给
  // 调用方 —— 跨 chat 出错时"我该写什么"比"你写错了"有用得多。
  const resolveChatRef = (ref: string): { ok: true; base: string } | { ok: false; reason: string; candidates?: string[] } => {
    const base = chatBaseOf(cfg, ref);
    if (base) return { ok: true, base };
    const known = listChatNames(cfg).map((c) => c.name);
    return {
      ok: false,
      reason: `unknown chat '${ref}' — give that chat a name first (\`/name ${normChatName(ref) || "<name>"}\` inside it)`,
      candidates: known,
    };
  };

  // peer 寻址。地址是两级的(见 chat-name.ts):
  //   ""            本 chat 的 default —— 自身语义不变;
  //   `fix`         本 chat 优先,本 chat 没有再全局兜底(全 host 唯一才认)——
  //                 命名之前唯一的跨 chat 路子,老调用方不能因为引入命名而断掉;
  //   `daily#fix`   daily 这个 chat 里的 `#fix`,精确到点,不问 tag 全不全局唯一;
  //   `daily#`      daily 的 default 会话;
  //   `chat:wr…#fix` 全量 key 同理(list_peers 吐的就是它)。
  // 裸 tag 的 0 命中 / ≥2 命中依旧拒绝,但出路从"回去改 tag 名"变成"用带 chat 名
  // 的全称地址"——后者不需要动别人的会话。
  const resolvePeerTag = (
    self: string,
    ref: string,
  ): { ok: true; target: string; foreign: boolean } | { ok: false; reason: string; candidates?: string[] } => {
    const { chat, tag } = parsePeerRef(ref ?? "");
    const t = tag.trim();
    if (chat) {
      const c = resolveChatRef(chat);
      if (!c.ok) return c;
      const target = keyOf(c.base, t);
      if (allTargets().includes(target)) {
        return { ok: true, target, foreign: c.base !== basePrincipalOf(self) };
      }
      return {
        ok: false,
        reason: `chat '${chat}' has no ${t ? `'#${t}'` : "default"} session — create it with new_claude_session({ chat: '${chat}'${t ? `, tag: '${t}'` : ""}, cwd })`,
        candidates: allTargets().filter((k) => basePrincipalOf(k) === c.base),
      };
    }
    const local = keyOf(basePrincipalOf(self), t);
    if (!t) return { ok: true, target: local, foreign: false };
    const all = allTargets();
    if (all.includes(local)) return { ok: true, target: local, foreign: false };
    const foreignMatches = all.filter((k) => tagOfKey(k) === t && basePrincipalOf(k) !== basePrincipalOf(self));
    if (foreignMatches.length === 1) return { ok: true, target: foreignMatches[0]!, foreign: true };
    if (foreignMatches.length === 0) {
      // 裸 token 正好是个 chat 名字 —— 用户/agent 想说的是"那个群",不是"那个 tag"。
      // 直接给出它的会话地址,比让人再查一次 list_chats 快。
      const asChat = chatBaseOf(cfg, t);
      if (asChat) {
        return {
          ok: false,
          reason: `'${t}' is a CHAT, not a tag — address one of its sessions, e.g. '${t}#' for its default`,
          candidates: allTargets().filter((k) => basePrincipalOf(k) === asChat).map((k) => peerAddress(cfg, self, k)),
        };
      }
      return { ok: false, reason: `no peer with tag '#${t}' — create one with new_claude_session, or address it in full as 'chatName#${t}' (list_chats shows the names)` };
    }
    return {
      ok: false,
      reason: `tag '#${t}' exists in ${foreignMatches.length} chats — address it in full as 'chatName#${t}' (list_chats shows the names)`,
      candidates: foreignMatches.map((k) => peerAddress(cfg, self, k)),
    };
  };

  /** 已知的每个 chat:命名的 + 有会话在跑的。`name` 为空即"还没起名",那就是
   *  它暂时只能靠全局唯一 tag 被找到的原因。 */
  const chatRoster = (self: string): Array<{ base: string; name: string; self: boolean; targets: string[] }> => {
    const bases = new Set([
      ...listChatNames(cfg).map((c) => c.base),
      ...allTargets().map(basePrincipalOf),
      basePrincipalOf(self),
    ]);
    return [...bases].filter(Boolean).sort().map((base) => ({
      base,
      name: chatNameOf(cfg, base),
      self: base === basePrincipalOf(self),
      targets: allTargets().filter((k) => basePrincipalOf(k) === base),
    }));
  };

  const paneOf = (target: string): string =>
    byTarget.get(target)?.tmuxPane || deps.store.get(target)?.tmuxPane || "";
  const jsonlOf = (target: string): string =>
    expandHome(byTarget.get(target)?.jsonlPath || deps.store.get(target)?.jsonlPath || "");

  // Busy ≡ the pane is showing an interrupt hint. A dead or unbound pane is
  // reported idle, not busy: "nothing is running there" is the truthful answer
  // and it keeps a graph step from blocking forever on a session that vanished.
  const paneBusy = async (pane: string): Promise<boolean> =>
    !!pane && (await tmuxPaneAlive(pane)) && paneIsBusy(await capturePaneTail(pane, 12));

  const isBusy = (target: string): Promise<boolean> => paneBusy(paneOf(target));

  const lastText = (target: string): string => {
    const p = jsonlOf(target);
    return p ? lastAssistantText(p) : "";
  };

  // 一个 target 的完整画像。本 chat 的兄弟和外 chat 的 peer 走同一条,只有
  // `self` / `address` 因观察者而异 —— 地址本来就是相对调用方说的话。
  const peerInfoOf = async (t: string, self: string): Promise<PeerInfo> => {
    const a = byTarget.get(t);
    const rec = deps.store.get(t);
    const jsonlPath = jsonlOf(t);
    const pane = paneOf(t);
    const paneAlive = pane ? await tmuxPaneAlive(pane) : false;
    const tag = tagOfTarget(t);
    let lastActivity = 0;
    try { if (jsonlPath) lastActivity = statSync(jsonlPath).mtimeMs; } catch { /* not written yet */ }
    return {
      target: t,
      tag,
      chat: chatNameOf(cfg, t),
      address: peerAddress(cfg, self, t),
      label: tag ? labelFor(tag) : "🧙",
      sessionId: a?.sessionId || rec?.sessionId || "",
      jsonlPath,
      cwd: a?.runningCwd || rec?.cwd || expandedDefaultCwd,
      cli: jsonlPath ? backendForPath(jsonlPath).name : (activeBackends()[0]?.name ?? "claude"),
      tmuxPane: pane,
      attached: !!a,
      paneAlive,
      busy: paneAlive ? paneIsBusy(await capturePaneTail(pane, 12)) : false,
      lastActivity,
      summary: jsonlPath ? summarizeTail(jsonlPath) : "(未绑定会话)",
      self: t === self,
    };
  };

  const byRecent = (x: PeerInfo, y: PeerInfo): number => y.lastActivity - x.lastActivity;

  const peers = async (target: string): Promise<PeerInfo[]> =>
    (await Promise.all(chatTargets(target).map((t) => peerInfoOf(t, target)))).sort(byRecent);

  // list_peers 的跨 chat 补充:其他 chat 里**当前调用方叫得动**的 session。两条
  // 入选路径 —— tag 全局唯一(裸 tag 就能命中),或者它所在的 chat 有名字(全称
  // `daily#fix` 命中)。后者是命名带来的新增量:同名 tag 不再互相遮蔽,想被找到
  // 只要给群起个名,不必回去改别人的 tag。
  const foreignPeers = async (self: string): Promise<PeerInfo[]> => {
    const selfBase = basePrincipalOf(self);
    const foreign = allTargets().filter((k) => tagOfKey(k) && basePrincipalOf(k) !== selfBase);
    const tagCount = foreign.reduce(
      (acc, k) => acc.set(tagOfKey(k), (acc.get(tagOfKey(k)) ?? 0) + 1),
      new Map<string, number>(),
    );
    const reachable = foreign.filter((k) => tagCount.get(tagOfKey(k)) === 1 || chatNameOf(cfg, k));
    return (await Promise.all(reachable.map((t) => peerInfoOf(t, self)))).sort(byRecent);
  };

  // Capture a few extra rows then compact away the TUI's blank padding, so
  // `rows` counts lines the user actually cares about.
  const peekPane = async (
    target: string,
    rows = 24,
  ): Promise<{ ok: boolean; reason?: string; pane?: string; busy?: boolean }> => {
    const pane = paneOf(target);
    if (!pane) return { ok: false, reason: "no tmux pane bound for target" };
    if (!(await tmuxPaneAlive(pane))) return { ok: false, reason: "tmux pane no longer alive — the session needs /new or a respawn" };
    const raw = await capturePaneTail(pane, Math.max(8, rows) + 12);
    return { ok: true, pane: compactPane(raw, rows), busy: paneIsBusy(raw) };
  };

  // Reading a peer's conversation is a transcript job, not a terminal job: the
  // jsonl holds whole role-tagged messages, while a pane capture is ANSI-laden
  // and clipped at the viewport edge. Only `busy` still comes from the pane.
  const peekTurns = async (
    target: string,
    n = 6,
  ): Promise<{ ok: boolean; reason?: string; dialog?: string; busy?: boolean }> => {
    const jsonl = jsonlOf(target);
    const busy = await isBusy(target);
    if (!jsonl || !existsSync(jsonl)) return { ok: false, reason: "no transcript bound for target", busy };
    const dialog = renderDialog(tailTurns(jsonl, n));
    return dialog ? { ok: true, dialog, busy } : { ok: false, reason: "transcript has no turns yet", busy };
  };

  // ── Prompt-cache keepalive ──────────────────────────────────────────
  // Anthropic's prompt cache expires ~5min after the last request. A pane that
  // goes idle (agent parked on a peer, background task running) lets the whole
  // context fall out of cache — the next real turn then re-writes it at 1.25x.
  // We inject a tiny ping just before expiry so the model makes one cheap
  // request (cache-read 0.1x) that slides the TTL forward. The whole schedule is
  // anchored to the last REAL (non-ping) activity, NOT to our own pings — so a
  // dead session is never kept warm forever, and once real work is older than
  // `maxIdleSec` we stop and let the cache die.
  // After `/stop`, ignore pane-busy as a resume signal for this long — long
  // enough for an in-flight ping (interrupted by the same /stop's Esc) to settle,
  // so it can't self-resume the pause. A genuine new turn after this window does.
  const RESUME_GRACE_MS = 30_000;

  // Seed the keepalive clocks from message-turn timestamps (keepaliveStamps), never
  // from file mtime — non-message lines (file-history-snapshot / ai-title / mode)
  // bump mtime without being a model turn, which would fake a long-dead session
  // back to "just active" and pin it in an endless ping loop. lastRealMs stays
  // anchored on genuine work, so the tick's realIdle guard can finally let it die.
  const initKeepalive = (jsonlPath: string, mtime: number, pingSigs: string[]): AttachState["keepalive"] => {
    let lastMs = 0;
    let lastRealMs = 0;
    try { const s = keepaliveStamps(jsonlPath, pingSigs); lastMs = s.lastMs; lastRealMs = s.lastRealMs; } catch { /* unreadable tail */ }
    return { lastMs, lastRealMs, seenMtime: mtime, pinging: false, pingMtime: 0, round: 0, settledAt: 0 };
  };

  const fireKeepalive = async (a: AttachState, stalled: boolean): Promise<void> => {
    const kc = cfg.wrc.mirror.keepalive;
    // Stalled (error/limit banner + idle pane): send the full resume instruction
    // — inviting the model to finish genuinely-unfinished work, or to reply
    // "pong" if it was legitimately parked. Otherwise the plain warmer, the SAME
    // full instruction every round: a bare "ping" used to be sent from round 2 on
    // (the instruction was already in context), but the model reads a bare "ping"
    // as an open turn and answers it however it likes — anything other than
    // "pong" un-swallows the heartbeat into chat and re-anchors the clocks as
    // real activity. Restating the instruction is a few tokens of cache-write and
    // buys a deterministic reply. keepaliveStamps matches every form, so none
    // reads as real activity. (round is incremented below, after the inject lands.)
    const text = stalled ? kc.resumePing : kc.ping;
    // Suppress the pane→WeCom echo of the ping user line, then swallow the whole
    // ping turn (reply included). The 60s fail-safe clears the quiet window if
    // the turn somehow never emits turn_end, so a later real turn is never muted;
    // it also closes the detail turn so it can't hang open in the chat timeline.
    rememberInject(text);
    a.keepaliveQuiet = setTimeout(() => {
      a.keepaliveQuiet = undefined;
      if (a.keepaliveTurnId) { recordTurnClose(a.keepaliveTurnId); a.keepaliveTurnId = undefined; }
    }, 60_000);
    const r = await inject({
      text, images: [], cfg,
      log: log.child({ target: a.target, sessionId: a.sessionId, sub: "keepalive" }),
      sessionId: a.sessionId, jsonlPath: a.jsonlPath, tmuxTarget: a.tmuxPane,
    });
    if (!r.ok) {
      endKeepaliveQuiet(a);
      if (a.keepalive) a.keepalive.pinging = false; // roll back so the next tick can retry
      log.warn({ target: a.target, reason: r.reason }, "keepalive: inject failed");
      return;
    }
    const tokens = lastContextTokens(a.jsonlPath);
    const round = a.keepalive ? (a.keepalive.round += 1) : 1;
    log.info({ target: a.target, tokens, round, totalRounds: Math.max(1, kc.rounds) }, "keepalive: ping injected");
    // Open a chat-detail turn for the real heartbeat exchange: userQuery is the
    // actual ping we injected; the assistant reply (expected: just "pong"), any
    // tool calls, and usage are grafted on from the swallowed items in onItem;
    // closed on the ping's turn_end (or the fail-safe). Kept out of chat.
    const turnId = newTurnId();
    a.keepaliveTurnId = turnId;
    recordTurnStart({ id: turnId, target: a.target, sessionId: a.sessionId, userQuery: text });
  };

  let keepaliveTicking = false;
  const keepaliveTick = async (): Promise<void> => {
    const kc = cfg.wrc.mirror.keepalive;
    if (!kc.enabled || keepaliveTicking) return;
    keepaliveTicking = true;
    try {
      const idleTriggerMs = Math.max(30, kc.ttlSec - kc.marginSec) * 1000;
      const ttlMs = kc.ttlSec * 1000;
      const pingSigs = [normAssistant(kc.ping).slice(0, 40), normAssistant(kc.resumePing).slice(0, 40)].filter((s) => s.length > 0);
      const now = Date.now();
      for (const a of byTarget.values()) {
        if (!a.tmuxPane) continue;                            // spawn-mode: no live pane to warm
        if (a.migrationWatcher) continue;                     // session rotating — skip
        if (a.liveStream && !a.liveStream.closed) continue;   // mid typewriter — don't inject
        if (!(await tmuxPaneAlive(a.tmuxPane))) continue;     // dead pane — nothing to keep alive
        let mtime = 0;
        try { mtime = statSync(a.jsonlPath).mtimeMs; } catch { continue; }
        if (!mtime) continue;
        const k = (a.keepalive ??= initKeepalive(a.jsonlPath, mtime, pingSigs))!;
        // File mtime is only a cheap "did anything change → re-read the tail" gate.
        // The clocks themselves come from message turns, so metadata churn (which
        // bumps mtime but is not a turn) can never move them. `grewSinceLast` now
        // means a NEW message turn appeared — not that the file grew.
        const prevRealMs = k.lastRealMs;
        if (mtime > k.seenMtime + 1000) {
          const s = keepaliveStamps(a.jsonlPath, pingSigs);
          if (s.stamped) { k.lastMs = s.lastMs; k.lastRealMs = s.lastRealMs; }
          else { k.lastMs = mtime; k.lastRealMs = mtime; } // backend without timestamps → fall back to mtime
        }
        k.seenMtime = mtime;
        // Round reset / real-activity re-anchor keys off REAL turns only — a
        // keepalive ping+pong advances lastMs but NOT lastRealMs, so the heartbeat
        // no longer reads as activity to itself (which was pinning round at 1/N).
        const grewSinceLast = k.lastRealMs > prevRealMs + 1000;
        const paneTail = await capturePaneTail(a.tmuxPane, 16);
        const busy = paneIsBusy(paneTail);

        if (k.pinging) {
          // Waiting for our own ping to land and settle: until a NEWER message turn
          // (the ping's own user line) appears and the pane goes idle, keep waiting.
          if (busy || k.lastMs <= k.pingMtime) continue;
          k.pinging = false;
          k.settledAt = now;
          continue;
        }
        // A new real message turn (or a busy pane) re-anchors: reset the round
        // counter, and past the /stop grace lift a busy-resume. grewSinceLast is
        // message-based now, so `/stop`'s Esc settling writes (metadata, no new
        // turn) can no longer self-resume the pause — only a busy pane past grace,
        // or a WeCom inbound in dispatch, does.
        // Suppress the grewSinceLast reset for 30s after pinging settles — the
        // pong's tail flush can lag a tick and would otherwise fake real activity.
        const justSettled = k.settledAt > 0 && now - k.settledAt < 30_000;
        if (busy || (grewSinceLast && !justSettled)) {
          k.round = 0; k.settledAt = 0;
          if (a.keepaliveOff && busy && now - (a.keepaliveOffAt ?? 0) > RESUME_GRACE_MS) { a.keepaliveOff = false; persistPause(a); }
          if (busy) continue;
        }
        if (a.keepaliveOff) continue;                          // paused by /stop until real activity returns
        const idleSinceTouch = k.lastMs ? now - k.lastMs : now - mtime;   // last model turn = cache touch
        if (idleSinceTouch < idleTriggerMs) continue;          // cache still comfortably warm
        if (idleSinceTouch >= ttlMs) continue;                 // cache already cold — a ping would cold-rewrite for nothing
        if (k.round >= kc.rounds) continue;                    // budget spent — let it go cold
        // Stall recovery, decided by RULE only (no model self-judgment): the last
        // transcript turn is a synthetic API-error/limit line, or the idle pane
        // still shows an error banner ⇒ a turn died mid-work. Send the resume
        // instruction instead of the plain warmer.
        const stalled = kc.resumeOnStall && (transcriptStalled(a.jsonlPath) || paneIsStalled(paneTail));
        k.pinging = true;
        k.pingMtime = k.lastMs;                                // settles when a newer turn (the ping's own) appears
        await fireKeepalive(a, stalled);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "keepalive tick failed");
    } finally {
      keepaliveTicking = false;
    }
  };
  const keepaliveTimer = setInterval(() => void keepaliveTick(), 15_000);

  return {
    attach,
    chatTargets,
    peers,
    foreignPeers,
    resolvePeerTag,
    chatRoster,
    peekPane,
    peekTurns,
    isBusy,
    lastText,
    status: () => {
      const list = Array.from(bySessionId.values()).map((a) => ({
        sessionId: a.sessionId,
        jsonlPath: a.jsonlPath,
        target: a.target,
      }));
      // Keep a single-attach view for back-compat; first entry wins when there's
      // exactly one mirror, callers iterating `mirrors` get the full picture.
      const first = list[0];
      return first
        ? { attached: true, mirrors: list, sessionId: first.sessionId, jsonlPath: first.jsonlPath, target: first.target }
        : { attached: false, mirrors: [] };
    },
    resolveToolDetail,
    hasMirrorTarget: (principal) => {
      if (byTarget.has(principal)) return true;
      // Lazy: a persisted binding counts as "attached" if its transcript is
      // still on disk. The actual re-attach happens on dispatch (async).
      const rec = deps.store.get(principal);
      if (!rec) return false;
      return existsSync(expandHome(rec.jsonlPath));
    },
    targetForSession: (sessionId) => {
      // Live attach is the fast path. Fall back to scanning persisted store:
      // an MCP tool (e.g. `cd`) called from a claude that isn't mirror-attached
      // would otherwise miss here and silently retarget to defaultChat — that
      // bug stranded pendingCwd on the wrong principal. Store keeps each
      // target's sessionId in sync via migrate/attach/setPendingCwd writes.
      const live = bySessionId.get(sessionId)?.target;
      if (live) return live;
      const all = deps.store.all();
      for (const [target, rec] of Object.entries(all)) {
        if (rec.sessionId === sessionId) return target;
      }
      return undefined;
    },
    targetForPane: (tmuxPane) => {
      const pane = (tmuxPane ?? "").trim();
      if (!pane) return undefined;
      for (const a of bySessionId.values()) {
        if (a.tmuxPane === pane) return a.target;
      }
      for (const [target, rec] of Object.entries(deps.store.all())) {
        if ((rec.tmuxPane ?? "") === pane) return target;
      }
      return undefined;
    },
    terminateLiveStream: (sessionId) => {
      const a = bySessionId.get(sessionId);
      if (!a) return;
      if (a.liveStream && !a.liveStream.closed) {
        log.info({ sessionId, turnId: a.liveStream.turnId }, "approval click — terminating liveStream");
        void finalizeStream(a, a.liveStream);
      }
      // Promote AWAITING_APPR → STREAMING on any approval click (allow / deny /
      // allow_window — claude resumes after each, producing tool_result + text
      // that need a stream destination). If frame is stale (>~6min from inbound),
      // the first flushStream will reject, mark s.dead=true, and subsequent items
      // route to standalone via the existing :1206 fall-through. Self-healing.
      if (a.outbound?.kind === "awaiting_appr") {
        const { frame, streamId } = a.outbound;
        a.outbound = undefined;
        const s = openStream(a, frame, streamId);
        a.liveStream = s;
        log.info({ sessionId, turnId: s.turnId }, "outbound: AWAITING_APPR → STREAMING (approved)");
      }
    },
    // 解决"卡片先于思考过程到达 WeCom"的赛跑: hook 触发的 /approve 直接走
    // client.sendMessage 发卡, 而 mirror 这条管道里同一 turn 的 text/tool_use 还
    // 可能卡在三处 — DEFERRED 的 buf、standaloneBuf 的 3s 防抖、liveStream 的
    // 250ms flush。逐一强制 drain, 再 await standalonePending FIFO, 让发卡前 mirror
    // 已经把"为什么发这张卡"推完。
    flushBeforeCard: async (sessionId, expect) => {
      const a = bySessionId.get(sessionId);
      if (!a) return;
      // 1) fs.watch 通常即时, 但本调用是发卡前最后一道屏障 — 主动拽一次 tail,
      //    把刚落盘的 assistant 行(可能含 text + tool_use)立刻喂给 onItem。
      //    若 caller 给了 expect, 进一步轮询 drain 直到对应 tool_use 落盘 —
      //    Claude Code 的 jsonl 写入相对 hook fire 有 tens-to-hundreds ms 的
      //    异步抖动, 单次 drain 经常抓空, 最终用户先看到卡再看到为什么。
      const expectSig = expect ? toolUseSig(expect.toolName, expect.toolInput) : "";
      if (expectSig) {
        const deadline = Date.now() + cfg.wrc.mirror.flushBeforeCardWaitMs;
        let polls = 0;
        while (Date.now() < deadline) {
          try { a.tail.drain(); } catch (e) { log.warn({ sessionId, err: (e as Error).message }, "flushBeforeCard tail drain failed"); }
          if (a.recentToolSigs.has(expectSig)) break;
          polls++;
          await sleepMs(50);
        }
        if (!a.recentToolSigs.has(expectSig)) {
          log.warn({ sessionId, polls, toolName: expect?.toolName }, "flushBeforeCard wait timed out — sending card without sig confirm");
        } else if (polls > 0) {
          log.info({ sessionId, polls, toolName: expect?.toolName }, "flushBeforeCard waited for tool_use to materialize");
        }
      } else {
        try { a.tail.drain(); } catch (e) { log.warn({ sessionId, err: (e as Error).message }, "flushBeforeCard tail drain failed"); }
      }
      // 1.5) 门控 tool_use 始终没在 jsonl 落盘 → CC 把整条 tool-terminated turn 攒着
      //     等工具 resolve 才 flush(而工具正卡在这张卡上), 前言此刻既不在 jsonl 也
      //     不在 hook 的 transcript_tail 里, 只剩活着的 pane 有。抠出来先推, 稍后
      //     jsonl 落盘 tail 出来的同一条由 isOwnAssistantSend 抑制。
      const sigConfirmed = expectSig !== "" && a.recentToolSigs.has(expectSig);
      if (expect && !sigConfirmed) {
        await sendPanePreamble(a);
      }
      // 2) DEFERRED 状态如果还在 buffering(needsApproval 因任何原因没触发就走到这),
      //    这里手动提升 → 立刻把 buf 当 standalone 推出, 进入 AWAITING_APPR。
      if (a.outbound?.kind === "deferred" && a.outbound.buf.length > 0) {
        promoteToStandalone(a);
      }
      // 3) standalone 防抖里 (3s 默认) 还压着的合并文案 — 强制立刻发。
      if (a.standaloneBuf) {
        clearTimeout(a.standaloneBuf.timer);
        flushStandalone(a);
      }
      // 4) liveStream 半成品: 当前 acc 里有内容但还没 flush 出去 — 同步刷一刀,
      //    保留 stream 不 finalize (后续 tool_result 还要继续 append 同一气泡)。
      const ls = a.liveStream;
      if (ls && !ls.closed && !ls.dead && ls.acc && ls.acc !== ls.lastSent) {
        if (ls.flushTimer) {
          clearTimeout(ls.flushTimer);
          ls.flushTimer = undefined;
        }
        await flushStream(ls);
      }
      // 5) 上面的 sendStandalone 都串在 standalonePending FIFO 上, 等它把 WeCom
      //    投递落地, 才算前奏到位 — 这步是关键, 确保返回时卡片可以安心发。
      try {
        await a.standalonePending;
      } catch {
        // 队列内单条失败已在 sendStandalone 里 warn 过, 这里吞掉, 不阻塞发卡。
      }
    },
    injectText: async (target, text, origin) => {
      // Lazy restore, same as dispatch: a peer session that hasn't been talked
      // to in this process lifetime (or any session after a reload) has an empty
      // in-memory slot but a perfectly good persisted binding. Without this, an
      // agent driving a cold sibling gets "not attached" for a live pane.
      const a = byTarget.get(target) ?? (await restoreFromStore(target));
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      if (!text.trim()) return { ok: false, reason: "empty text" };
      // Pre-record so the tail's user-line emission is suppressed by the
      // recentInjects dedupe (otherwise the user sees their own demo prompt
      // echoed back as a quoted bubble).
      rememberInject(text);
      // 印章要早于 inject 落地 —— tail 是独立轮询的, 它可能在 inject 的 promise
      // resolve 之前就看到 user 行并开出 turn, 那时归因必须已经在位。
      if (origin) a.pendingOrigin = { origin, at: Date.now() };
      const sid = a.sessionId;
      const paneAlive = a.tmuxPane ? await tmuxPaneAlive(a.tmuxPane) : false;
      if (!paneAlive) {
        log.warn({ target, sessionId: sid, oldPane: a.tmuxPane }, "injectText: pane not alive, respawning");
        // Same resume-fork hazard as dispatch: snapshot before spawn, re-bind
        // onto the forked jsonl once it appears (EOF offset — fork is seeded).
        const resumeBaseline = listJsonls(dirname(a.jsonlPath));
        const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "respawn-init", sessionId: sid }), resumeSessionId: sid, windowName: tagOfTarget(target) || target, cwdOverride: a.runningCwd, cli: backendForPath(a.jsonlPath).name });
        if (!r.ok || !r.tmuxPane) return { ok: false, reason: `respawn failed: ${r.reason ?? "unknown"}` };
        a.tmuxPane = r.tmuxPane;
        a.tmuxSession = r.tmuxSession ?? a.tmuxSession;
        if (r.cwd) a.runningCwd = r.cwd;
        deps.store.set(target, { sessionId: sid, jsonlPath: a.jsonlPath, tmuxSession: a.tmuxSession, tmuxPane: a.tmuxPane, cwd: a.runningCwd || undefined, pendingCwd: a.pendingCwd || undefined });
        startMigrationWatcher(a, resumeBaseline, (p) => firstUserUuid(p) !== undefined);
      }
      // freshSpawn: true — the pane was just minted by /mirror/spawn, the TUI
      // is still warming up so the verifier in injectViaTmux needs the slack.
      // 同 dispatch: 在 inject 之前解除静默, 防止验证循环中 LLM 回复被永久吞掉。
      a.muteUntilInject = false;
      a.justSpawned = false;
      const r = await inject({
        text, images: [], cfg, log: log.child({ principal: target, sessionId: sid, sub: "init-demo" }),
        sessionId: sid, jsonlPath: a.jsonlPath, tmuxTarget: a.tmuxPane, freshSpawn: true,
      });
      return r;
    },
    interruptPane: async (target, opts) => {
      const a = byTarget.get(target);
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      // `/stop` (teardown: true) must work when tmux itself is the problem, so
      // the order is: local state first, pane second. The old implementation
      // probed the pane FIRST and returned early on failure — meaning a wedged
      // tmux server left the user with a "…" bubble that /stop could not close
      // and an inject queue no message could get past. Callers that only want
      // an Esc (the `.claude/**` guard's cancel) pass no opts and keep the old
      // pane-only behavior, bubbles untouched.
      let torndown = 0;
      if (opts?.teardown) {
        a.injectGen = (a.injectGen ?? 0) + 1; // disarm a zombie inject's paste
        abortInjectQueue(a.sessionId);        // unblock the next message
        torndown = teardownOutbound(a);       // close every hanging bubble/stream
      } else if (!a.tmuxPane) {
        return { ok: false, reason: "no live tmux pane (spawn-mode attachment)" };
      }
      // /stop also pauses keepalive: the user is deliberately quieting this
      // session, so stop poking it too. A real turn (WeCom inbound, or the pane
      // going busy AFTER the resume grace) lifts the pause and re-earns the
      // budget. Stamping keepaliveOffAt gates the busy-resume so the ping that
      // may be mid-flight right now can't immediately self-resume.
      a.keepaliveOff = true;
      a.keepaliveOffAt = Date.now();
      a.keepalive = undefined; // re-anchors cleanly on resume
      persistPause(a);          // survive a reload — don't resurrect a quieted session
      // Best-effort Esc. Every failure mode here is reported, never fatal: the
      // teardown above already gave the user their chat back.
      let escOk = false;
      let escReason = "";
      if (!a.tmuxPane) {
        escReason = "spawn-mode attachment (no live tmux pane)";
      } else if (!(await tmuxPaneAlive(a.tmuxPane))) {
        escReason = "tmux pane no longer alive";
      } else {
        const r = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Escape"]);
        escOk = r.ok;
        if (!r.ok) escReason = `send-keys Escape failed: ${(r.stderr || r.stdout).slice(-200) || r.code}`;
      }
      // Any in-flight ping's quiet window + detail turn are left to close on their
      // own turn_end (or the 60s fail-safe), so the interrupted pong stays out of chat.
      log.info({ target, sessionId: a.sessionId, pane: a.tmuxPane, torndown, escOk, escReason, gen: a.injectGen }, "mirror /stop — teardown + Esc");
      // Esc failure is not an overall failure when we tore down: the user asked
      // for quiet and got it. Without teardown there's nothing else to report,
      // so keep the old strict contract.
      if (!opts?.teardown && !escOk) return { ok: false, reason: escReason };
      return { ok: true, torndown, escOk, escReason: escReason || undefined };
    },
    killPane: async (target) => {
      // paneOf (not byTarget.get) so a binding surviving only in the persisted
      // store — e.g. after a reload that couldn't re-attach — is still killable.
      const a = byTarget.get(target);
      const pane = a?.tmuxPane || paneOf(target);
      if (!a && !pane) return { ok: false, reason: "no session bound to target" };
      if (pane && (await tmuxPaneAlive(pane))) {
        // Esc first, like /stop: a mid-generation CLI gets a beat to unwind and
        // flush its transcript before the TTY is yanked out from under it.
        await tmuxRun(["send-keys", "-t", pane, "Escape"]);
        await sleepMs(250);
        const r = await tmuxRun(["kill-pane", "-t", pane]);
        if (r.code !== 0) return { ok: false, reason: `kill-pane failed: ${r.stdout.slice(-200) || r.code}` };
      }
      if (a) detach(a, "/kill");
      // Drop the persisted record too — keeping it would let the next inbound
      // resurrect this very session via the dead-pane `--resume` self-heal,
      // which is the opposite of what /kill means. The chat then auto-spawns a
      // fresh session on its next message.
      deps.store.drop(target);
      log.info({ target, sessionId: a?.sessionId, pane }, "mirror /kill — pane killed, binding dropped");
      return { ok: true };
    },
    submitPane: async (target) => {
      const a = byTarget.get(target);
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      if (!a.tmuxPane) return { ok: false, reason: "no live tmux pane (spawn-mode attachment)" };
      const alive = await tmuxPaneAlive(a.tmuxPane);
      if (!alive) return { ok: false, reason: "tmux pane no longer alive" };
      const r = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Enter"]);
      if (r.code !== 0) return { ok: false, reason: `send-keys Enter failed: ${r.stdout.slice(-200) || r.code}` };
      log.info({ target, sessionId: a.sessionId, pane: a.tmuxPane }, "mirror /n — Enter sent to pane");
      return { ok: true };
    },
    revealPane: async (target) => {
      // paneOf (not byTarget.get) so a cold binding surviving only in the
      // persisted store can still be revealed after a daemon reload.
      const pane = paneOf(target);
      if (!pane) return { ok: false, reason: "no tmux pane bound for target" };
      if (!(await tmuxPaneAlive(pane))) return { ok: false, reason: "tmux pane no longer alive — the session needs /new or a respawn" };
      // Only clients already attached to the pane's OWN session are candidates:
      // switching a client that sits on an unrelated session would yank the
      // user's other terminal window into wezard. Most-recently-active wins —
      // switch-client with no -c is ambiguous under multiple clients.
      const s = await tmuxRun(["display-message", "-p", "-t", pane, "#{session_name}"]);
      const sess = s.stdout.trim() || cfg.wrc.tmuxPrefix;
      const clients = await tmuxRun(["list-clients", "-t", sess, "-F", "#{client_activity} #{client_name}"]);
      const best = clients.stdout.split("\n").filter(Boolean)
        .map((l) => { const i = l.indexOf(" "); return { act: Number(l.slice(0, i)), name: l.slice(i + 1) }; })
        .sort((x, y) => y.act - x.act)[0]?.name;
      if (!best) {
        // Nothing to switch; tell the user how to get a client onto the session.
        return { ok: false, reason: `没有 attach 到 \`${sess}\` 的 tmux 客户端。先在终端执行: \`tmux attach -t ${sess}\`` };
      }
      // A pane target pulls session + window selection along with it.
      const r = await tmuxRun(["switch-client", "-c", best, "-t", pane]);
      if (r.code !== 0) return { ok: false, reason: `switch-client failed: ${r.stdout.slice(-200) || r.code}` };
      log.info({ target, pane, client: best }, "mirror /reveal — tmux client switched");
      return { ok: true };
    },
    hasLivePane: (sessionId) => Boolean(bySessionId.get(sessionId)?.tmuxPane),
    answerNativeModal: async (sessionId, opts) => {
      const a = bySessionId.get(sessionId);
      if (!a?.tmuxPane) return { status: "no_pane", reason: "no live tmux pane for session" };
      if (!(await tmuxPaneAlive(a.tmuxPane))) return { status: "no_pane", reason: "tmux pane no longer alive" };
      const pane = a.tmuxPane;
      const lg = log.child({ sessionId, pane, sub: "native-modal" });

      // CC 在 hook 返回**之后**才渲染这个框, 所以进来时它通常还没出现 —— 轮询等它。
      const POLL_MS = 200;
      const deadline = Date.now() + Math.max(0, opts.waitMs);
      let v = await detectModalPicker(pane);
      while (!v.modal && Date.now() < deadline) {
        await sleepMs(POLL_MS);
        v = await detectModalPicker(pane);
      }
      // 没等到: 这次 CC 没弹框(会话内已授权过 / 命中盲点判断失误)。无事可做。
      if (!v.modal) return { status: "no_modal" };

      const pick = pickModalAnswer(parseModalOptions(v.screen), v.title);
      if (!pick) {
        lg.warn({ title: v.title }, "native modal: no trustworthy one-shot option, not pressing");
        return { status: "unparsable", title: v.title, screen: v.screen };
      }

      // 数字键在 CC 的 picker 里即选即确认。按完等一拍回读: 框还在且**标题没变**才
      // 补一个 Enter(个别布局要显式确认); 标题变了说明弹的已是另一个框 —— 绝不盲按,
      // 交给兜底路径, 免得替用户确认了他没看过的东西。
      const SETTLE_MS = 400;
      await tmuxRun(["send-keys", "-t", pane, String(pick.index)]);
      await sleepMs(SETTLE_MS);
      let after = await detectModalPicker(pane);
      if (after.modal && after.title === v.title) {
        await tmuxRun(["send-keys", "-t", pane, "Enter"]);
        await sleepMs(SETTLE_MS);
        after = await detectModalPicker(pane);
      }
      if (after.modal) {
        lg.warn({ title: after.title, pressed: pick.index }, "native modal: still on pane after answer");
        return { status: "still_modal", title: after.title, index: pick.index, label: pick.label };
      }
      lg.info({ title: v.title, pressed: `${pick.index}. ${pick.label}` }, "native modal answered");
      return { status: "answered", title: v.title, index: pick.index, label: pick.label };
    },
    getCwd,
    setPendingCwd,
    newSession,
    shutdown: () => {
      clearInterval(paneDriftTimer);
      clearInterval(keepaliveTimer);
      for (const a of bySessionId.values()) {
        if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
        a.outbound = undefined;
        if (a.liveStream && !a.liveStream.closed) void finalizeStream(a, a.liveStream);
        a.tail.stop();
      }
      bySessionId.clear();
      byTarget.clear();
    },
    dispatch: async ({ principal, text, images, frame, streamId }) => {
      // Route by inbound principal — the WeCom chat the user just messaged us
      // from is the same string we registered as `target` on attach. After a
      // daemon reload the in-memory map is empty; restore from the persisted
      // store before giving up so the conversation continues in the prior
      // claude session instead of getting "not attached".
      let a = byTarget.get(principal);
      if (!a) a = await restoreFromStore(principal);
      if (!a) {
        try {
          await client.replyStream(
            frame,
            streamId,
            withSessionTag(principal, "[wezard] wecom remote control not attached — run `/wrc` inside the target Claude session"),
            true,
          );
        } catch {
          /* ignore */
        }
        return;
      }
      // `/clear` resets to an empty session — nothing in the cache to keep warm,
      // so pause keepalive like `/stop` instead of lifting it. Every other inbound
      // is real work: lift any prior pause and re-anchor both clocks to now.
      // Pane-side new turns re-anchor via the tick's stamps; this covers the
      // WeCom-driven path.
      if (isClearCommand(text)) {
        a.keepaliveOff = true;
        a.keepaliveOffAt = Date.now();
        a.keepalive = undefined; // re-anchors cleanly on resume
      } else {
        a.keepaliveOff = false;
        if (a.keepalive) { a.keepalive.lastMs = Date.now(); a.keepalive.lastRealMs = Date.now(); }
      }
      persistPause(a); // persist the pause/resume too, else a reload would revert it
      // Finalize prior live stream (if any) so this new turn renders into its
      // own message bubble. Then open a fresh stream tied to the new frame and
      // ack immediately so WeCom doesn't time out while inject queues.
      const armMigration = isClearCommand(text);
      // `/model <arg>` opens the TUI picker preselected on the match — the
      // switch only lands after a confirm Enter. Bare `/model` is excluded:
      // auto-confirming it would just re-pick the current model.
      const isModelSwitch = /^\/model\s+\S/.test(text.trim());
      // 任意 slash 命令 (/context, /cost, /status…): 产物走 skill_output standalone,
      // 详情链接是纯噪声 —— brief 起 turn 时不推链接。
      const isSlash = /^\/[a-z]/i.test(text.trim());
      // Auto-upgrade /clear → /new when the user has queued a project switch:
      // a plain /clear would only rotate sessionId in the same pane, which sits
      // in the OLD cwd. Killing+respawning is the only way to honor the switch.
      // pendingCwd is chat-scoped on the base principal; fall back to the
      // caller's own record when no base exists (tagged-only chats).
      const pending = chatCwdFallback(a.target).pending || a.pendingCwd;
      if (armMigration && pending && pending !== a.runningCwd) {
        if (a.liveStream && !a.liveStream.closed) await finalizeStream(a, a.liveStream);
        log.info({ target: a.target, runningCwd: a.runningCwd, pendingCwd: pending }, "/clear upgraded to /new (cwd switch)");
        // Prefer the tag suffix as tmux window name when present (matches
        // /new #tag behavior), fall back to the full target for untagged.
        const tag = tagOfTarget(a.target);
        const r = await newSession(a.target, tag || a.target);
        if (!r.ok) {
          try { await client.replyStream(frame, streamId, withSessionTag(a.target, `[mirror] 切换失败: ${r.reason ?? "unknown"}`), true); } catch { /* ignore */ }
        }
        return;
      }
      // Snapshot the project dir BEFORE inject runs. Claude rotates the session
      // synchronously while processing /clear and writes the rotated jsonl
      // immediately — capturing baseline post-inject would already include it,
      // and the watcher would never see a "new" candidate (the bug this fixes).
      const preClearBaseline = armMigration ? listJsonls(dirname(a.jsonlPath)) : undefined;
      // Registered here, not after the inject: the inject's paste verification
      // can take ~10s, and a sibling chat's watcher armed earlier must already
      // see this clear as an overlap by the time it evaluates a candidate.
      if (armMigration) noteClearInject(a);
      // 记下断点, 由下一轮 (第一轮读不到上文的轮次) 领走。/clear 自己不建 turn,
      // 否则这次清空在 chat 详情里毫无痕迹, 前后两轮看着还是连续的。
      if (armMigration) a.ctxCut = "clear";
      // 新消息 = 对话边界: 上一 turn 的出站状态在此清算。softEnd 是旧 turn 的
      // 静默期收口判决, 残留到新 turn 会在中途开火、提前收掉新气泡/新流;
      // deferred 缓冲里是已从 tail 消费但还没下发的 item, 收入旧 streamId 收口
      // (exitDeferredAsFinalStream): 正文进流关掉 loading 气泡, 只有 trailing 终句
      // 才走 standalone, 空缓冲一个字都不写 —— 不再整体另发 standalone。旧 frame
      // 就此作废; 用户之后点旧审批卡, terminateLiveStream 找不到 outbound 槽位会
      // 优雅 no-op。
      if (a.softEnd) { clearTimeout(a.softEnd); a.softEnd = undefined; }
      if (a.outbound) {
        if (a.outbound.kind === "deferred") {
          exitDeferredAsFinalStream(a);
        } else {
          a.outbound = undefined;
        }
      }
      // Drain any pending standalone debounce so a prior turn's tail tail
      // doesn't get sandwiched into this turn's pre-card flush (Path A) or
      // race against the new stream's first content (Path B).
      if (a.standaloneBuf) { clearTimeout(a.standaloneBuf.timer); flushStandalone(a); }
      // /clear produces no assistant output; opening a stream would leave a
      // stale "…" + quoted-user bubble in WeCom. Skip the stream entirely on
      // success path; only surface a terse "clean" if inject fails.
      if (a.liveStream && !a.liveStream.closed) {
        await finalizeStream(a, a.liveStream);
      }
      // Three paths from here:
      //  • armMigration → s undefined, no defer (existing /clear behavior)
      //  • outboundDeferMs > 0 → DEFERRED slot; stream opens later via promote
      //  • outboundDeferMs === 0 → eager openStream + "…" ack (legacy behavior)
      const brief = cfg.wrc.mirror.brief && !armMigration;
      const eagerOpen = !armMigration && !brief && cfg.wrc.mirror.outboundDeferMs <= 0;
      const s = eagerOpen ? openStream(a, frame, streamId) : undefined;
      if (s) {
        a.liveStream = s;
        try {
          await client.replyStream(frame, streamId, withSessionTag(a.target, "…"), false);
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "stream initial ack failed");
        }
      }
      if (brief) {
        // 挂 loading 气泡并起新 turn —— 上一 turn 若还在跑, startBriefTurn 内部
        // 会立刻把它收掉 (对话边界策略), 本轮直接成为活跃 turn。
        // 后续 onItem 走 handleBriefItem, 不再走 stream / defer 路径。
        await startBriefTurn(a, frame, streamId, isSlash, text);
      } else if (!armMigration && !eagerOpen) {
        enterDeferred(a, frame, streamId);
      }
      const sid = a.sessionId;
      const myGen = a.injectGen ?? 0;
      await enqueue(sid, () => withInjectWatchdog(a, myGen, async () => {
        if (s && s.closed) return; // (eager path) superseded by a newer dispatch
        // Always reincarnate when no live pane: covers (a) pane closed between
        // turns, (b) daemon reload restored a binding without a live pane, AND
        // (c) /wrc'd from a non-tmux context (no tmuxSession ever stored) —
        // that last case used to permanently lock the chat into spawn-mode.
        // If respawn fails, fall through to spawn-mode inject for THIS turn
        // but DON'T erase tmuxSession from store — next inbound will retry,
        // making the system self-healing instead of one-failure-permanent.
        // First step of the job and the historical hang point — log BEFORE the
        // probe so a stall is attributable to it next time, not invisible.
        log.info({ target: a.target, sessionId: sid, pane: a.tmuxPane, gen: myGen }, "inject job start");
        const paneAlive = a.tmuxPane ? await tmuxPaneAlive(a.tmuxPane) : false;
        let freshSpawn = a.justSpawned === true;
        a.justSpawned = false;
        if (!paneAlive) {
          log.warn({ target: a.target, sessionId: sid, oldPane: a.tmuxPane, oldSession: a.tmuxSession }, "mirror: no live tmux pane, respawning");
          // Interactive `claude --resume <sid>` does NOT keep appending to the
          // same <sid>.jsonl — it FORKS to a fresh <newSid>.jsonl seeded with a
          // copy of the transcript. Our tail stays bound to the OLD, now-frozen
          // jsonl, so the chat would go silent after respawn. Snapshot the
          // project dir BEFORE spawn so the fork surfaces as a new file the
          // watcher can re-bind onto. Skip when /clear already owns a watcher
          // for this turn (its migration supersedes the fork).
          const resumeBaseline = !armMigration ? listJsonls(dirname(a.jsonlPath)) : undefined;
          // Respawn in the binding's runningCwd (pendingCwd doesn't apply to a
          // mid-turn reincarnation — only /new and /clear-with-pending swap cwd).
          const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "respawn", sessionId: sid }), resumeSessionId: sid, windowName: tagOfTarget(a.target) || a.target, cwdOverride: a.runningCwd, cli: backendForPath(a.jsonlPath).name });
          if (r.ok && r.tmuxPane && r.tmuxSession) {
            a.tmuxPane = r.tmuxPane;
            a.tmuxSession = r.tmuxSession;
            if (r.cwd) a.runningCwd = r.cwd;
            freshSpawn = true;
            deps.store.set(a.target, {
              sessionId: sid,
              jsonlPath: a.jsonlPath,
              tmuxSession: a.tmuxSession,
              tmuxPane: a.tmuxPane,
              cwd: a.runningCwd || undefined,
              pendingCwd: a.pendingCwd || undefined,
            });
            log.info({ target: a.target, sessionId: sid, newPane: a.tmuxPane, newSession: a.tmuxSession }, "mirror: tmux respawned");
            // Re-bind onto the resume fork once it appears (EOF offset: the fork
            // already holds the full prior transcript — replaying from 0 would
            // re-dump it). If --resume happens to keep the same jsonl, no new
            // file appears, the watcher times out harmlessly, and the existing
            // tail keeps working — safe under either behavior.
            if (resumeBaseline) startMigrationWatcher(a, resumeBaseline, (p) => firstUserUuid(p) !== undefined);
          } else {
            // Drop only the stale pane id; keep tmuxSession (if any) so the
            // store still reflects "user wanted tmux" — next turn retries.
            log.error({ reason: r.reason }, "mirror: tmux respawn failed, this turn falls back to spawn-mode");
            a.tmuxPane = "";
          }
        }
        // Remember BEFORE inject (not after success): a fresh-spawn paste can
        // submit late, after our verifier reports failure. The tail still
        // surfaces the user's text, and without a pre-recorded entry the
        // dedupe filter wouldn't suppress it — user's chat msg gets echoed
        // back as a quoted bubble. Recording up front fixes that.
        // Last checkpoint before we touch the pane: a `/stop` (or a watchdog
        // fire) during the respawn above means this text is no longer wanted.
        // Without this, a tmux server that unwedges after the user gave up would
        // paste a minutes-old message into a session that has moved on.
        if ((a.injectGen ?? 0) !== myGen) {
          // Lift the spawn mute here too: this inject will never land, so the
          // pane's output (including whatever /stop interrupted) would otherwise
          // stay swallowed by onItem until some later message injects cleanly.
          a.muteUntilInject = false;
          log.warn({ target: a.target, sessionId: sid, myGen, gen: a.injectGen }, "inject aborted — superseded by /stop or watchdog");
          return;
        }
        rememberInject(text);
        // 解除静默必须在 inject 之前: inject 内部的 freshSpawn 验证循环可达 10+s
        // (paste-verify + settle + waitForCleared + retry), 而 LLM 的回复可能在 Enter
        // 发出后 2-3s 就落盘 —— tail 在 mute 期间读到的 item 会被 onItem 永久丢弃,
        // 导致 turn_end 丢失, brief turn 无法收口, 后续消息全部错位 (off-by-one)。
        // 安全性: newSession 的 fresh pane 在 inject 前只写过 system/init (→ 无 item),
        // 用户行有 isOwnInject 过滤 —— 提前解除不会泄漏脏数据。
        a.muteUntilInject = false;
        const r = await inject({
          text, images, cfg, log: log.child({ principal, sessionId: sid }),
          sessionId: sid, jsonlPath: a.jsonlPath, tmuxTarget: a.tmuxPane, freshSpawn,
        });
        if (!r.ok) {
          if (s) {
            s.acc = s.acc ? `${s.acc}\n\n[mirror] ✗ ${r.reason ?? "failed"}` : `[mirror] ✗ ${r.reason ?? "failed"}`;
            await finalizeStream(a, s);
          } else if (armMigration) {
            // /clear path has no live stream — surface failure as a one-shot
            // terse reply ("clean" per project convention).
            try { await client.replyStream(frame, streamId, withSessionTag(a.target, "clean"), true); } catch { /* ignore */ }
          } else {
            // Deferred path: tear down outbound, surface error as standalone.
            // promote* may have already cleared the slot if a tail item raced
            // ahead of inject completion — in that case just send the error.
            if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
            a.outbound = undefined;
            sendStandalone(a, `[mirror] ✗ ${r.reason ?? "failed"}`);
          }
          return;
        }
        // Inject "succeeded" but the input box never cleared — the target
        // session may be busy / not consuming input (long task, full context).
        // Hint the user once so a silently-dropped message isn't mistaken for a
        // wezard bug. Skip on the /clear path (armMigration), which has its
        // own "cleared" feedback below.
        //
        // OFF by default: the clear-check has a structural false-positive (the
        // tailFp can match the message's own echo line just above the input box
        // when it falls in the 5-row capture window), so in the common mirror
        // case this fires on essentially every message even though it landed
        // fine — pure noise. A genuinely dropped message still surfaces as the
        // `[mirror] ✗` hard failure above. Opt back in with
        // WEZARD_WARN_UNCERTAIN_INJECT=1 if you want the (noisy) heads-up.
        if (r.uncertain && !armMigration && process.env.WEZARD_WARN_UNCERTAIN_INJECT === "1") {
          sendStandalone(a, `[mirror] ⚠️ 消息已发送,但目标会话似乎正忙或未响应(输入框未清空),可能未被处理。可稍后重试,或用 \`/sessions\` 切到其它会话。`);
        }
        // Follow a user-initiated same-dir fork (/clear or manual restart in the
        // live TUI) that would otherwise leave the tail — and the "…" bubble —
        // stuck on the dead old jsonl. /clear via WeCom (armMigration) has its
        // own watcher; skip spawn-mode (no shared pane to fork under us).
        if (!armMigration && a.tmuxPane) armSilentForkRebind(a, text);
        // Confirm the /model picker. Early Enter (before the picker renders)
        // would leave it unconfirmed, so settle first; a late Enter is a
        // harmless no-op in the empty input box. On confirm, claude writes
        // "Set model to …" as <local-command-stdout> — the tail mirrors that
        // back to the chat as a ⚙️ bubble, which IS the readback.
        if (isModelSwitch && a.tmuxPane) {
          await sleepMs(1000);
          const e = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Enter"]);
          if (e.code !== 0) log.warn({ pane: a.tmuxPane, reason: e.stdout.slice(-200) || e.code }, "/model confirm Enter failed — user can send /n manually");
        }
        // /clear was just injected — claude rotates sessionId on the next user
        // input. Arm a watcher to migrate the attachment onto the new jsonl,
        // and surface a standalone "cleared" so the user gets explicit
        // feedback (the skip-stream path otherwise leaves WeCom silent).
        if (armMigration) {
          sendStandalone(a, `cleared\n\n${renderProjectInfo(a.target)}`);
          a.clearRebind = { baseline: preClearBaseline! };
          startMigrationWatcher(a, preClearBaseline!, jsonlIsPostClearChild, 0, true);
        }
        // Don't await the stream's lifetime — it stays open until next inbound
        // or hard timeout. Releasing the inject queue here lets the next
        // dispatch start its inject promptly while tail content keeps flowing
        // into the (still-open) stream until superseded.
      }));
    },
  };
};

const TOOL_DETAIL_PREFIX_EXT = "TOOL_DETAIL|";

// Install a click-handler for the "查看详情" button. On click, look up the
// turn's tool entries and push them as standalone markdown messages to the
// originating chat.
export const installMirrorEventListener = (
  client: WSClient,
  bridge: MirrorBridge,
  log: Logger,
): void => {
  client.on("event.template_card_event", (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
    const ev = frame.body?.event;
    const key = ev?.event_key ?? "";
    if (!key.startsWith(TOOL_DETAIL_PREFIX_EXT)) return;
    const turnId = key.slice(TOOL_DETAIL_PREFIX_EXT.length);
    const detail = bridge.resolveToolDetail(turnId);
    if (!detail) {
      log.warn({ turnId }, "tool detail expired or unknown");
      return;
    }
    const chatId = stripPrincipalPrefix(detail.target);
    void (async () => {
      const n = detail.markdown.length;
      for (const [i, md] of detail.markdown.entries()) {
        try {
          const content = withSessionTag(detail.target, md, n > 1 ? `${i + 1}/${n}` : undefined);
          await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content } });
        } catch (e) {
          log.warn({ err: (e as Error).message, turnId }, "tool detail push failed");
        }
      }
    })();
  });
};
