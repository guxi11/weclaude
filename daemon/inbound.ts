// Inbound text router. Hands the message off to either the headless CC bridge
// (mode=headless) or the mirror bridge (mode=mirror).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, BaseMessage, QuoteContent } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import type { Bridge } from "./cc-bridge.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import { tryConsumeClaim, persistClaim, ackClaim, shouldAutoClaim, ackAutoClaim } from "./claim.js";
import { getLastResponse } from "./last-response.js";
import { scanClaudeSessions, type SessionInfo } from "./session-scan.js";

// Chat-binding key: stable id for "this conversation thread". Used as
// session-map key, mirror target, defaultChat. NOT used for auth.
const chatPrincipal = (msg: BaseMessage): string =>
  msg.chattype === "group" && msg.chatid ? `chat:${msg.chatid}` : `user:${msg.from.userid}`;

// Auth principals: any-of test against allowFrom. Tiered — allowing a user
// grants them access in any chat; allowing a group grants every member of
// that group access. DMs collapse to just the sender.
const authPrincipals = (msg: BaseMessage): string[] => {
  const user = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) return [`chat:${msg.chatid}`, user];
  return [user];
};

// "会话id" = chat-binding (session/mirror key); "权限id" = either the group
// OR the sender — allowFrom passes if any one of them is whitelisted.
// Also surfaces per-id 授权状态 + 对应 `weclaude mirror` CLI 参数 (vid:/chatid:),
// so users can copy-paste straight into a terminal to bind a Claude session.
const renderIds = (msg: BaseMessage, cfg: Config): string => {
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  const mark = (id: string): string => (allowed.has(id) ? "✅ 已授权" : "❌ 未授权");
  const sender = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) {
    const chat = `chat:${msg.chatid}`;
    return [
      `群: \`${chat}\` ${mark(chat)}`,
      `发送者: \`${sender}\` ${mark(sender)}`,
      `(allowFrom 任一通过即可)`,
      `在已有claude会话中绑定本群聊: \`/weclaude:wrc chat:${msg.chatid}\``,
    ].join("\n");
  }
  return [
    `会话id: \`${sender}\` ${mark(sender)}`,
    `在已有claude会话中绑定本单聊: \`/weclaude:wrc user:${msg.from.userid}\``,
  ].join("\n");
};

// IMEs (esp. mobile WeCom) sprinkle invisible format chars around emoji and at
// message ends — a word-joiner U+2060 after 🐼, a zero-width space, a BOM. They
// survive .trim() (not whitespace), so "/auto⁠" !== "/auto" and "🐼⁠" !== "🐼",
// silently breaking every exact-match command. Strip the whole Unicode format
// category (\p{Cf}: ZWSP/ZWNJ/ZWJ/WJ/BOM/…) before comparing. Animal labels are
// plain single-codepoint emoji, so this can't eat them.
const stripInvisibles = (s: string): string => s.replace(/\p{Cf}/gu, "");
// Canonicalize a slash-command line for exact matching: drop invisibles, trim.
const cmd = (text: string): string => stripInvisibles(text).trim();

const isIdCommand = (text: string): boolean => cmd(text) === "/id";
const isPwdCommand = (text: string): boolean => cmd(text) === "/pwd";
const isNewCommand = (text: string): boolean => cmd(text) === "/new";
const isStopCommand = (text: string): boolean => cmd(text) === "/stop";

// /session(s) [arg] — list live Claude sessions, or switch the mirror to one.
// Bare "/sessions" (or "/session") lists; an arg (animal emoji, sessionId, or
// sessionId prefix) switches. Tolerates an optional trailing "s" and any spacing.
// stripInvisibles drops IME-injected \p{Cf} chars (see cmd() above) so an arg
// like "🐼⁠" / "92b3534b⁠" still matches.
const parseSessionsCommand = (text: string): { arg: string } | undefined => {
  const m = /^\/sessions?(?:\s+(.+))?$/u.exec(stripInvisibles(text).trim());
  if (!m) return undefined;
  return { arg: stripInvisibles(m[1] ?? "").trim() };
};

// Render the scanned session list into a WeCom-friendly markdown block. The
// session currently mirrored to this chat's target (if any) is flagged.
const renderSessionsList = (sessions: SessionInfo[], currentSid: string): string => {
  if (sessions.length === 0) return "[weclaude] 未发现正在运行的 Claude 会话";
  const lines = sessions.map((s) => {
    const here = s.sessionId === currentSid ? " ⬅️ 当前" : "";
    const dir = s.cwd.replace(/^.*\//, "") || s.cwd || "?";
    return `${s.label || "▫️"} \`${s.sessionId.slice(0, 8)}\` ${dir}${here}`;
  });
  return [
    "[weclaude] 正在运行的会话：",
    ...lines,
    "> 切换：`/sessions <emoji 或 id>`，如 `/sessions 🐼`",
  ].join("\n");
};

// Match a switch arg against a scanned session: animal emoji label, full
// sessionId, or a ≥6 char sessionId prefix. Returns the session or undefined.
const matchSession = (sessions: SessionInfo[], arg: string): SessionInfo | undefined =>
  sessions.find((s) => s.label === arg) ??
  sessions.find((s) => s.sessionId === arg) ??
  (arg.length >= 6 ? sessions.find((s) => s.sessionId.startsWith(arg)) : undefined);

// /escape — one-shot "get me out of a stuck session". Like /sessions but picks
// the destination automatically: switch to the most-recently-active OTHER live
// session, or spawn a fresh one if none exists. Handled entirely in the daemon
// (never injected into the mirrored session), so it works even when the current
// session is wedged — this is the whole point.
const isEscapeCommand = (text: string): boolean => cmd(text) === "/escape";

// /auto — switch THIS chat's currently-mirrored (live) session into auto
// permission mode via the bridge's Shift+Tab cycler. Daemon-handled; only works
// on a session that's consuming keys (a wedged one won't react — use /escape).
const isAutoCommand = (text: string): boolean => cmd(text) === "/auto";

// Strip any "@<botname>" mention (leading, mid-text, or trailing) so it doesn't
// leak into claude's prompt. WeCom may place the mention anywhere depending on
// where the user typed it.
// Safety: if the text contains more than one "@", it's ambiguous (user likely
// also @'d a file path like "@src/foo.ts"), so leave it untouched rather than
// risk eating the path.
const stripMentions = (text: string): string => {
  const atCount = (text.match(/@/gu) ?? []).length;
  if (atCount !== 1) return text;
  return text.replace(/\s*@\S+\s*/u, " ").replace(/\s+/gu, " ").trim();
};

// DMs can't @ a bot — any "@" the user types is content (e.g. "@src/foo.ts"),
// so we only strip mentions in group chats.
const isGroup = (msg: BaseMessage): boolean => msg.chattype === "group" && !!msg.chatid;
const maybeStripMentions = (msg: BaseMessage, text: string): string =>
  isGroup(msg) ? stripMentions(text) : text;

// Render the user's "引用" (quoted message) into a markdown blockquote so the
// claude prompt carries the upstream context. WeCom delivers `quote` as a
// sibling field on the message body — currently we surface text/voice (already
// transcribed) inline; image/mixed-image/file are rendered as a placeholder
// (download would mean an extra round-trip + clipboard paste, which is too
// heavy for a quote — user can always send the file directly if needed).
const quoteToText = (q: QuoteContent): string => {
  if (q.msgtype === "text") return q.text?.content ?? "";
  if (q.msgtype === "voice") return q.voice?.content ?? "";
  if (q.msgtype === "mixed") {
    return (q.mixed?.msg_item ?? [])
      .map((it) => (it.msgtype === "text" ? it.text?.content ?? "" : "[图片]"))
      .filter(Boolean)
      .join(" ");
  }
  if (q.msgtype === "image") return "[图片]";
  if (q.msgtype === "file") return "[文件]";
  return "";
};
const renderQuotePrefix = (q: QuoteContent | undefined): string => {
  if (!q) return "";
  const body = quoteToText(q).trim();
  if (!body) return "";
  // Quote each line so multi-line引用渲染整洁; trailing blank line separates
  // from the user's actual message.
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `> [引用]\n${quoted}\n\n`;
};
// Normalize for self-reply quote dedup: WeCom mangles formatting on its quote
// bubble in unpredictable ways — strips backticks, swaps `-` bullets for `·`,
// re-wraps whitespace, sometimes loses inline markdown. Reduce both sides to
// just letters + digits (Unicode + CJK) and compare on that — robust against
// any punctuation/whitespace/markup churn while keeping content fidelity.
const canonForCompare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");

const isLastResponseQuote = (target: string, quoted: string): boolean => {
  const last = getLastResponse(target);
  if (!last || !quoted) return false;
  const a = canonForCompare(last);
  const b = canonForCompare(quoted);
  if (a.length < 4 || b.length < 6) return false; // too short — false-positive risk
  // Substring match (prefix subsumes; suffix covers tool-heavy turns where the
  // tracked `s.acc` interleaves tool entries before the final text). Both
  // sides are canon'd to letters+digits only, so formatting/punctuation drift
  // can't break the match.
  return a.includes(b);
};

const withQuote = (msg: BaseMessage, text: string): string => {
  if (!msg.quote) return text;
  // Drop the quote when the user is replying to weclaude's most recent message
  // in this chat — claude already has that turn in its context, surfacing it
  // again is redundant noise. Older self-quotes still flow through (the user
  // is genuinely pointing back to something earlier).
  const quoted = quoteToText(msg.quote).trim();
  if (isLastResponseQuote(chatPrincipal(msg), quoted)) return text;
  const prefix = renderQuotePrefix(msg.quote);
  return prefix ? `${prefix}${text}` : text;
};

const isAllowed = (cfg: Config, principals: string[]): boolean => {
  if (cfg.wrc.allowFrom.length === 0) return false;
  // Tolerate invisible chars sneaking into hand-edited config (paste artifacts).
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  return principals.some((p) => allowed.has(p));
};

// Mirror mode grants implicit talkback: any chat that's currently a mirror
// target can post back without being in `allowFrom`. The act of /wrc'ing into
// that chat is the authorization signal.
const isMirrorTarget = (bridge: Bridge | MirrorBridge, who: string): boolean =>
  "hasMirrorTarget" in bridge && bridge.hasMirrorTarget(who);

// Sniff extension from magic bytes; falls back to .bin. WeCom doesn't always
// give us a filename for images, and we want claude's Read tool to recognize
// the file (it dispatches on extension).
const sniffExt = (buf: Buffer): string => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf.length >= 12 && buf.subarray(4, 12).toString("ascii") === "ftypheic") return ".heic";
  return ".bin";
};

interface DownloadDeps {
  client: WSClient;
  log: Logger;
  inboxDir: string;
}

const downloadToInbox = async (
  deps: DownloadDeps,
  url: string,
  aesKey: string | undefined,
  msgid: string,
  index: number,
): Promise<string | undefined> => {
  try {
    const { buffer, filename } = await deps.client.downloadFile(url, aesKey);
    const ext = filename ? `.${filename.split(".").pop()!}` : sniffExt(buffer);
    const safeName = `${msgid.replace(/[^A-Za-z0-9_-]/g, "_")}_${index}${ext}`;
    mkdirSync(deps.inboxDir, { recursive: true });
    const abs = join(deps.inboxDir, safeName);
    writeFileSync(abs, buffer);
    deps.log.info({ url: url.slice(0, 80), bytes: buffer.length, abs }, "media saved");
    return abs;
  } catch (e) {
    deps.log.error({ err: (e as Error).message }, "media download failed");
    return undefined;
  }
};

export const installInboundRouter = (
  client: WSClient,
  cfg: Config,
  log: Logger,
  bridge: Bridge | MirrorBridge,
  sourcePath: string,
): void => {
  const inboxDir = expandHome(cfg.wrc.mirror.inboxDir);

  // Render /pwd output. Mirror mode reads the live attachment + persisted
  // store via bridge.getCwd; headless mode has no per-chat cwd, so it just
  // shows cfg.wrc.cwd as the global default.
  const renderPwd = (who: string): string => {
    if ("getCwd" in bridge) {
      const { runningCwd, pendingCwd, defaultCwd } = bridge.getCwd(who);
      const lines = [`[weclaude] 📂 当前项目: \`${runningCwd}\``];
      if (pendingCwd && pendingCwd !== runningCwd) {
        lines.push(`下次切换: \`${pendingCwd}\` (使用 /new 或 /clear 生效)`);
      }
      if (runningCwd !== defaultCwd) lines.push(`(默认: \`${defaultCwd}\`)`);
      lines.push("> 切换其他项目: 让 AI 调用 `cd` MCP 工具");
      return lines.join("\n");
    }
    return `[weclaude] 📂 当前项目: \`${expandHome(cfg.wrc.cwd)}\` (headless mode, 全局默认)`;
  };

  // Mirror-only auto-spawn / /new helper. Routes through bridge.newSession
  // which kills the old pane, spawns fresh in pendingCwd ?? runningCwd ??
  // default, attaches, and pushes "📂 当前项目" info to the chat. Returns
  // the user-facing one-line ack.
  const autoSpawnAndAttach = async (who: string): Promise<string> => {
    if (!("newSession" in bridge)) return "[weclaude] /new only available in mirror mode";
    const r = await bridge.newSession(who, who);
    if (!r.ok) return `[weclaude] /new failed: ${r.reason ?? "unknown"}`;
    return `✅ 新会话已建立 \`${r.sessionId}\``;
  };

  // Common gating: claim bootstrap + allowFrom check. Returns true if the
  // caller should stop (claim consumed or message rejected).
  const gate = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, text: string): Promise<{ stop: boolean; who: string }> => {
    const who = chatPrincipal(msg);
    const auths = authPrincipals(msg);
    // /id — bypass allowFrom so users can discover their ids before configuring.
    if (isIdCommand(text)) {
      try { await client.replyStream(frame, msg.msgid, renderIds(msg, cfg), true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // /pwd — bypass allowFrom too. Read-only project-path lookup.
    if (isPwdCommand(text)) {
      try { await client.replyStream(frame, msg.msgid, renderPwd(who), true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    if (tryConsumeClaim(text, who)) {
      log.info({ who }, "claim consumed — bootstrapping defaultChat + allowFrom");
      try { persistClaim(cfg, sourcePath, who); } catch (e) {
        log.error({ err: (e as Error).message }, "persistClaim failed");
      }
      await ackClaim(client, who, log);
      try { await client.replyStream(frame, msg.msgid, "✅ done", true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Auto-claim: empty allowFrom + DM ⇒ first sender becomes super admin.
    // Falls through so the same message is also dispatched as a real prompt —
    // user types "hi" and gets both the promotion ack and the assistant reply.
    const isDm = !(msg.chattype === "group" && msg.chatid);
    if (shouldAutoClaim(cfg, isDm)) {
      log.info({ who }, "auto-claim — empty allowFrom, first DM sender promoted");
      try { persistClaim(cfg, sourcePath, who); } catch (e) {
        log.error({ err: (e as Error).message }, "auto-claim persistClaim failed");
      }
      await ackAutoClaim(client, who, log);
      // fall through to dispatch
    }
    if (!isAllowed(cfg, auths) && !isMirrorTarget(bridge, who)) {
      log.warn({ from: who, auths }, "drop: not in allowFrom");
      try {
        await client.replyStream(
          frame,
          msg.msgid,
          `未授权\n${renderIds(msg, cfg)}\n请将上述任一权限id加入 config 的 wrc.allowFrom 数组`,
          true,
        );
      } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Authorized `/new` — spawn a tmux+claude pair and attach it to this chat.
    // Runs BEFORE the mirror-not-attached short-circuit so it works as the
    // very first message from a fresh user.
    if (isNewCommand(text)) {
      const reply = await autoSpawnAndAttach(who);
      try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Authorized `/stop` — Esc the live pane to interrupt whatever Claude is
    // currently doing. Mirror-mode only; bails cleanly when no attachment.
    if (isStopCommand(text)) {
      if (!("interruptPane" in bridge)) {
        try { await client.replyStream(frame, msg.msgid, "[weclaude] /stop only available in mirror mode", true); } catch { /* ignore */ }
      } else {
        const r = await bridge.interruptPane(who);
        const reply = r.ok ? "✅ Esc sent" : `[weclaude] /stop failed: ${r.reason ?? "unknown"}`;
        try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      }
      return { stop: true, who };
    }
    // /sessions [arg] — list live Claude sessions, or switch the mirror to one.
    // Bare lists; with an arg (emoji / sessionId / ≥6-char prefix) it re-points
    // THIS chat's mirror at the matched session. Reuses the same scan+attach
    // path as the /sessions/switch route so IM and MCP behave identically.
    const sc = parseSessionsCommand(text);
    if (sc) {
      if (!("attach" in bridge)) {
        try { await client.replyStream(frame, msg.msgid, "[weclaude] /sessions only available in mirror mode", true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      let sessions: SessionInfo[] = [];
      try {
        sessions = await scanClaudeSessions();
      } catch (e) {
        log.error({ err: (e as Error).message }, "/sessions scan failed");
      }
      // Resolve which session is currently mirrored to THIS chat.
      const currentSid = bridge.status().mirrors.find((mm) => mm.target === who)?.sessionId ?? "";
      if (!sc.arg) {
        try { await client.replyStream(frame, msg.msgid, renderSessionsList(sessions, currentSid), true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      const hit = matchSession(sessions, sc.arg);
      if (!hit) {
        const avail = sessions.map((s) => `${s.label || "▫️"} ${s.sessionId.slice(0, 8)}`).join("、") || "无";
        try { await client.replyStream(frame, msg.msgid, `[weclaude] 未找到会话 \`${sc.arg}\`。可用：${avail}`, true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      if (hit.sessionId === currentSid) {
        try { await client.replyStream(frame, msg.msgid, `[weclaude] 已经在该会话 ${hit.label} \`${hit.sessionId.slice(0, 8)}\``, true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      const att = bridge.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target: who, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      const reply = att.ok
        ? `✅ 已切到 ${hit.label} \`${hit.sessionId.slice(0, 8)}\` (${hit.cwd})`
        : `[weclaude] 切换失败: ${att.reason ?? "unknown"}`;
      try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // /escape — one-shot逃生. Daemon-handled (never injected into the mirrored
    // session), so it works even when the current session is wedged. Switch to
    // the most-recently-active OTHER live session; if none, spawn a fresh one.
    if (isEscapeCommand(text)) {
      if (!("attach" in bridge)) {
        try { await client.replyStream(frame, msg.msgid, "[weclaude] /escape only available in mirror mode", true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      let sessions: SessionInfo[] = [];
      try { sessions = await scanClaudeSessions(); } catch (e) { log.error({ err: (e as Error).message }, "/escape scan failed"); }
      const currentSid = bridge.status().mirrors.find((mm) => mm.target === who)?.sessionId ?? "";
      // Candidates: every live session except the one we're stuck on, newest first.
      const candidate = sessions
        .filter((s) => s.sessionId !== currentSid)
        .sort((x, y) => y.lastActivity - x.lastActivity)[0];
      if (candidate) {
        const att = bridge.attach({ sessionId: candidate.sessionId, jsonlPath: candidate.jsonlPath, target: who, tmuxPane: candidate.tmuxPane, tmuxSession: candidate.tmuxSession, cwd: candidate.cwd });
        const reply = att.ok
          ? `✅ 已逃生切到 ${candidate.label || "▫️"} \`${candidate.sessionId.slice(0, 8)}\` (${candidate.cwd})`
          : `[weclaude] 逃生切换失败: ${att.reason ?? "unknown"}`;
        try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      // No other live session — spawn a fresh one (born auto via extraArgs).
      if (!("newSession" in bridge)) {
        try { await client.replyStream(frame, msg.msgid, "[weclaude] 无其它可用会话,且当前 bridge 不支持新建", true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      const r = await bridge.newSession(who, who);
      const reply = r.ok
        ? `✅ 无其它可用会话,已新建 \`${(r.sessionId ?? "").slice(0, 8)}\` 并切过去`
        : `[weclaude] 逃生新建失败: ${r.reason ?? "unknown"}`;
      try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // /auto — switch the currently-mirrored live session into auto permission
    // mode via Shift+Tab cycling (bridge reads the TUI footer to land exactly).
    if (isAutoCommand(text)) {
      if (!("setAutoMode" in bridge)) {
        try { await client.replyStream(frame, msg.msgid, "[weclaude] /auto only available in mirror mode", true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      const r = await bridge.setAutoMode(who);
      const reply = r.ok
        ? (r.already ? "[weclaude] 当前已是 auto mode" : "✅ 已切到 auto mode")
        : `[weclaude] /auto 失败: ${r.reason ?? "unknown"}。若会话卡死,试试 /escape`;
      try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Mirror mode but no Claude session attached for this chat yet. Since the
    // sender is already in allowFrom, we treat that authorization as license
    // to auto-spawn: this inbound becomes both the binding signal and the
    // first prompt — attach, then fall through to dispatch.
    if ("hasMirrorTarget" in bridge && !bridge.hasMirrorTarget(who)) {
      const reply = await autoSpawnAndAttach(who);
      if (!reply.startsWith("✅")) {
        try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      // attached — fall through to dispatch
    }
    return { stop: false, who };
  };

  const send = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string, images: string[] = []): Promise<void> => {
    try {
      await bridge.dispatch({ principal: who, text, images, frame, streamId: msg.msgid });
    } catch (e) {
      log.error({ err: (e as Error).message }, "bridge dispatch failed");
      try { await client.replyStream(frame, msg.msgid, `[weclaude] error: ${(e as Error).message}`, true); } catch { /* ignore */ }
    }
  };

  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const raw = msg.text?.content ?? "";
    const text = withQuote(msg, maybeStripMentions(msg, raw));
    log.info({ msgid: msg.msgid, len: text.length, hasQuote: !!msg.quote }, "rx text");
    const { stop, who } = await gate(frame, msg, text);
    if (stop) return;
    await send(frame, msg, who, text);
  });

  client.on("message.image", async (frame: WsFrame<ImageMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, hasQuote: !!msg.quote }, "rx image");
    const { stop, who } = await gate(frame, msg, "");
    if (stop) return;
    const path = await downloadToInbox({ client, log, inboxDir }, msg.image.url, msg.image.aeskey, msg.msgid, 0);
    if (!path) {
      try { await client.replyStream(frame, msg.msgid, "[weclaude] 图片下载失败", true); } catch { /* ignore */ }
      return;
    }
    // Pass the path through the bridge's `images` channel — mirror mode pumps
    // each via macOS clipboard + Ctrl+V into the live TTY (matches Claude
    // Code's documented image paste flow → image content block, no Read tool
    // turn). Spawn-mode falls back to `@<path>` automatically.
    await send(frame, msg, who, withQuote(msg, ""), [path]);
  });

  client.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, items: msg.mixed?.msg_item?.length, hasQuote: !!msg.quote }, "rx mixed");
    const { stop, who } = await gate(frame, msg, "");
    if (stop) return;
    const texts: string[] = [];
    const images: string[] = [];
    let imgIdx = 0;
    for (const item of msg.mixed?.msg_item ?? []) {
      if (item.msgtype === "text" && item.text?.content) {
        const t = maybeStripMentions(msg, item.text.content);
        if (t) texts.push(t);
      } else if (item.msgtype === "image" && item.image?.url) {
        const path = await downloadToInbox(
          { client, log, inboxDir },
          item.image.url,
          item.image.aeskey,
          msg.msgid,
          imgIdx++,
        );
        if (path) images.push(path);
      }
    }
    if (texts.length === 0 && images.length === 0 && !msg.quote) return;
    await send(frame, msg, who, withQuote(msg, texts.join("\n")), images);
  });

  // template_card_event is handled in approval module; no listener here.
};
