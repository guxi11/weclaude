// Inbound text router. Hands the message off to either the headless CC bridge
// (mode=headless) or the mirror bridge (mode=mirror).
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, BaseMessage, QuoteContent } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import type { Bridge } from "./cc-bridge.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import { tailTurnsWithTools, renderPeerMentionHint, type PeerInfo, type PeerMention } from "./peers.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { tryConsumeClaim, persistClaim, ackClaim, shouldAutoClaim, ackAutoClaim } from "./claim.js";
import { getLastResponse } from "./last-response.js";
import { scanClaudeSessions, type SessionInfo } from "./session-scan.js";
import { computeUsage, renderUsageReport } from "./usage.js";
import { computeAuditReport } from "./audit.js";
import { syncProjectConfig, renderSyncReport } from "./cfg-sync.js";
import { captureQuota, renderQuotaReport } from "./quota.js";
import { tagOfKey, baseOfKey, withTagHeader, parseTagHeader, tagTokenRe, allTags, allCompoundAddresses, labelFor } from "../shared/session-label.js";
import { chatNameOf, chatBaseOf, clearChatName, listChatNames, peerAddress, setChatName } from "./chat-name.js";

/** 判定"引用内容是否已在目标会话上下文里"时回看的轮数 —— 引用的通常是最近几轮
 *  里的某条气泡,再往前用户多半是真想把老内容重新拎出来说事。 */
const QUOTE_TAIL_TURNS = 12;

// Chat-binding key: stable id for "this conversation thread". Used as
// session-map key, mirror target, defaultChat. NOT used for auth.
const chatPrincipal = (msg: BaseMessage): string =>
  msg.chattype === "group" && msg.chatid ? `chat:${msg.chatid}` : `user:${msg.from.userid}`;

// A single chat can host multiple concurrent Claude sessions via `#tag`. The
// session key = base principal + optional `#tag` suffix. Untagged = default
// session (backward-compatible). Tags: [\p{L}\p{N}_-]{1,32}, must be
// space-delimited or edge-of-string so genuine URLs / paths like
// "#L45-foo/bar" survive. Only the FIRST tag in a message is honored — that
// tag is stripped from the forwarded text; any additional #foo tokens flow
// through verbatim (may be actual references in the user's prompt).
// 剩下那些 #foo 里,真正指向兄弟会话的会在出站前被标注(见 peerMentions)。
// Token 规则收在 session-label(tagTokenRe / allTags),路由与标注共用同一把尺子。
const TAG_RE = tagTokenRe();
const parseTag = (text: string): { tag: string; cleaned: string } => {
  const m = TAG_RE.exec(text);
  if (!m) return { tag: "", cleaned: text };
  const tag = m[2] ?? "";
  const before = text.slice(0, m.index);
  const sep = m[1] ?? "";
  const after = text.slice(m.index + m[0].length);
  const cleaned = (before + sep + after).replace(/[ \t]+/g, " ").trim();
  return { tag, cleaned };
};

const sessionKey = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);
const tagOf = tagOfKey;

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
// Also surfaces per-id 授权状态 + 对应 `wezard mirror` CLI 参数 (vid:/chatid:),
// so users can copy-paste straight into a terminal to bind a Claude session.
const renderIds = (msg: BaseMessage, cfg: Config): string => {
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  const mark = (id: string): string =>
    allowed.has("all") || allowed.has(id) ? "✅ 已授权" : "❌ 未授权";
  const sender = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) {
    const chat = `chat:${msg.chatid}`;
    return [
      `群: \`${chat}\` ${mark(chat)}`,
      `发送者: \`${sender}\` ${mark(sender)}`,
      `(allowFrom 任一通过即可)`,
      `在已有 Agent 会话中绑定本群聊: \`/wezard:wrc chat:${msg.chatid}\``,
    ].join("\n");
  }
  return [
    `会话id: \`${sender}\` ${mark(sender)}`,
    `在已有 Agent 会话中绑定本单聊: \`/wezard:wrc user:${msg.from.userid}\``,
  ].join("\n");
};

const isIdCommand = (text: string): boolean => text.trim() === "/id";
const isPwdCommand = (text: string): boolean => text.trim() === "/pwd";
const isCostCommand = (text: string): boolean => text.trim() === "/cost";
// `/audit` or `/audit some-tag`. With a tag, `/audit` re-routes to the
// newest-by-mtime mirror whose target carries `#<tag>` (see resolveAuditMirror);
// without a tag, falls back to the caller's own mirror binding.
const parseAuditCommand = (text: string): { tag: string } | undefined => {
  const m = /^\/audit(?:\s+(.+))?$/u.exec(text.trim());
  return m ? { tag: (m[1] ?? "").trim().replace(/^#/, "") } : undefined;
};

// Resolve /audit target: with an explicit tag → newest-by-mtime mirror whose
// target carries `#<tag>` (regardless of caller). Without a tag → caller's own
// binding. Returns undefined when nothing matches.
interface MirrorRef { sessionId: string; jsonlPath: string; target: string; }
const resolveAuditMirror = (
  mirrors: MirrorRef[],
  tag: string,
  who: string,
  chatWho: string,
): MirrorRef | undefined => {
  if (tag) {
    const wanted = tag.replace(/^#/, "");
    const matches = mirrors.filter((m) => (m.target.split("#")[1] ?? "") === wanted);
    if (matches.length <= 1) return matches[0];
    return matches
      .map((m) => {
        let mt = 0;
        try { mt = statSync(expandHome(m.jsonlPath)).mtimeMs; } catch { /* ignore */ }
        return { m, mt };
      })
      .sort((a, b) => b.mt - a.mt)[0]?.m;
  }
  return mirrors.find((m) => m.target === who || m.target === chatWho);
};
// `/new` optionally names which CLI to launch (`/new codebuddy`). Bare `/new`
// keeps whatever CLI the chat's current session runs — see newSession's inherit
// rule — so naming one is only needed to *switch* backends.
const NEW_RE = /^\/new(?:\s+(claude-internal|claude|codebuddy))?$/i;
const isNewCommand = (text: string): boolean => NEW_RE.test(text.trim());
const cliOfNewCommand = (text: string): CliBackendName | undefined =>
  NEW_RE.exec(text.trim())?.[1]?.toLowerCase() as CliBackendName | undefined;
// `/cfgsync` (alias `/sync`) — reconcile the project's per-CLI config trees.
// Bare form is a dry run; `apply` is the only form that writes.
const CFGSYNC_RE = /^\/(?:cfgsync|sync)(?:\s+(apply))?$/i;
const parseCfgSyncCommand = (text: string): { apply: boolean } | undefined => {
  const m = CFGSYNC_RE.exec(text.trim());
  return m ? { apply: Boolean(m[1]) } : undefined;
};
// `/name` 读, `/name x` 写, `/name -` 摘掉。名字是 chat 级的 —— 带不带 `#tag`
// 路由过来都命名同一个聊天, 所以这里不看 tag。
const NAME_RE_CMD = /^\/name(?:\s+(\S+))?$/i;
const parseNameCommand = (text: string): { arg: string } | undefined => {
  const m = NAME_RE_CMD.exec(text.trim());
  return m ? { arg: m[1] ?? "" } : undefined;
};
// `/chats` — 跨聊天目录: 谁有名字、谁没有、各自跑着哪些会话。
const isChatsCommand = (text: string): boolean => /^\/chats?$/i.test(text.trim());
const isUsageCommand = (text: string): boolean => text.trim() === "/usage";
const isStopCommand = (text: string): boolean => text.trim() === "/stop";
const isKillCommand = (text: string): boolean => text.trim() === "/kill";
const isEnterCommand = (text: string): boolean => text.trim() === "/n";
const isRevealCommand = (text: string): boolean => text.trim() === "/reveal";
const isHelpCommand = (text: string): boolean => /^\/(?:help|\?|h)$/i.test(text.trim());

// Static command reference. Grouped: session control, usage/info, topic
// broadcast (natural-language, zh+en). Anything not matching a command is a
// prompt forwarded to the bound Claude session.
const renderHelp = (): string =>
  [
    "*wezard 命令*",
    "",
    "▎会话",
    "`/new` 新开会话并绑定本聊天 (沿用当前会话的 CLI)",
    "`/clear` 清空当前会话上下文 (有待切项目时自动升级为 /new)",
    "`/sessions` 列出 live 会话 · `/sessions <emoji|id>` 切换",
    "`/stop` 打断当前生成 (Esc)",
    "`/kill` 结束本会话并移除 tmux pane (下条消息自动新开)",
    "`/n` 向 CLI 输入回车 (Enter)",
    "`/reveal` 把终端的 tmux 窗口切到本会话",
    "",
    "▎切换 CLI 后端",
    "`/new codebuddy` 用指定 CLI 新开 (claude / claude-internal / codebuddy)",
    "不写则沿用本会话当前的 CLI;新开 `#tag` 会话则继承本聊天的 CLI。",
    "切换后 `/clear`、`/stop`、`--resume` 自愈都仍绑在该 CLI 上。",
    "",
    "▎多会话路由",
    "同一聊天可同时运行多个 Agent 会话:消息中任意位置带 `#tag`(如 `#docs 帮我改 README`)",
    "即路由到该标签会话;不带 tag = 默认会话。tagged 会话的回复以 `emoji #tag` 前缀标注。",
    "`/clear #tag`、`/pwd #tag`、`/stop #tag` 等命令同理按 tag 路由。",
    "`#tag` 与 CLI 名可同时写:`/new codebuddy #docs` = 用 codebuddy 开 docs 会话。",
    "",
    "▎跨聊天",
    "`/name <名字>` 给本聊天起名 · `/name` 查看 · `/name -` 取消",
    "`/chats` 列出所有已知聊天及其会话",
    "名字 1-32 位字母/数字/`_`/`-`,全机唯一。起了名字,别的聊天才叫得到这里:",
    "`daily#fix` = daily 聊天的 `#fix` · `daily#` = 它的默认会话 · `fix` = 本聊天优先。",
    "对 AI 说「让 daily#fix 看一眼」「在 daily 里开个 #ingest 跑这个目录」即可,",
    "它会调 `send_peer` / `new_claude_session` 跨群寻址、跨群建会话。",
    "未命名的聊天不可寻址、也不可被建入 —— 想被叫到,就在那个群里发一次 `/name`。",
    "",
    "▎多会话协作",
    "`/peers` 列出本聊天的所有会话及忙闲状态",
    "同一聊天内的会话互为 peer,可以互相观察和驱动。直接说人话即可:",
    "「看下 `#fix` 的进展,推动它直到结束」— AI 会读它的终端、注入指令、等它跑完。",
    "「让 `#fix` 和 `#review` 互相迭代到 review 说 LGTM」— AI 会建一个 loop graph,",
    "把多个带 tag 的会话(可各用不同 CLI / 模型)串成流水线并循环驱动。",
    "",
    "▎信息 (免授权)",
    "`/id` 查看会话/权限 id",
    "`/pwd` 当前项目路径",
    "`/usage` 真实订阅额度 %",
    "`/cost` token/成本估算",
    "`/audit` 本会话 token/成本明细 (含 subagent) · `/audit <tag>` 指定标签会话",
    "`/cfgsync` 预演跨 CLI 项目配置同步 · `/cfgsync apply` 执行 (需授权)",
    "`/help` 本帮助",
    "",
    "▎事件订阅 / 广播",
    "已迁到 MCP:直接对 AI 说「订阅 xxx」「广播 xxx: …」「每天8点广播 xxx: …」,",
    "它会调 `subscribe_topic` / `broadcast_topic` / `schedule_broadcast` 等工具处理。",
    "",
    "▎引用 (quote)",
    "引用消息 + 新文字：被引用内容作为上下文前缀附在你的话前。",
    "纯引用不加字：把被引用内容当正文重发 —— 微信会去重相同文本，",
    "这是重新触发同一条命令 (如 `/usage`) 的唯一方式。",
    "",
    "其余文本直接转发给已绑定的 Agent 会话。",
  ].join("\n");

// /session(s) [arg] — list live Claude sessions, or switch the mirror to one.
// Bare "/sessions" (or "/session") lists; an arg (animal emoji, sessionId, or
// sessionId prefix) switches. Tolerates an optional trailing "s" and any spacing.
const parseSessionsCommand = (text: string): { arg: string } | undefined => {
  const m = /^\/sessions?(?:\s+(.+))?$/u.exec(text.trim());
  if (!m) return undefined;
  return { arg: (m[1] ?? "").trim() };
};

// Render the scanned session list into a WeCom-friendly markdown block. The
// session currently mirrored to this chat's target (if any) is flagged.
const renderSessionsList = (sessions: SessionInfo[], currentSid: string): string => {
  if (sessions.length === 0) return "[wezard] 未发现正在运行的 Agent 会话";
  // Only annotate the CLI when the list actually spans more than one — with a
  // single backend the tag is pure noise on every row.
  const mixed = new Set(sessions.map((s) => s.cli)).size > 1;
  const lines = sessions.map((s) => {
    const here = s.sessionId === currentSid ? " ⬅️ 当前" : "";
    const dir = s.cwd.replace(/^.*\//, "") || s.cwd || "?";
    const cli = mixed ? ` _(${s.cli})_` : "";
    return `${s.label || "🧙"} \`${s.sessionId.slice(0, 8)}\` ${dir}${cli}${here}`;
  });
  return [
    "[wezard] 正在运行的会话：",
    ...lines,
    "> 切换：`/sessions <emoji 或 id>`，如 `/sessions 🐼`",
  ].join("\n");
};

// /peers — roster of the sessions living in THIS chat (default + every `#tag`).
// Distinct from /sessions, which sweeps the whole host: peers are the ones an
// agent here can actually collaborate with (shared chat = shared address space).
const isPeersCommand = (text: string): boolean => /^\/(?:peers?|agents?)$/iu.test(text.trim());

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const dirOf = (p: PeerInfo): string => p.cwd.replace(/^.*\//, "") || p.cwd;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// A field with the same value on every row (project dir, CLI backend) is noise
// repeated N times — hoist those into the header and annotate rows only where
// they actually differ. Rows are blank-line separated so a wrapped summary can't
// visually merge into the next peer.
const renderPeers = (peers: PeerInfo[]): string => {
  if (peers.length === 0) return "[wezard] 本聊天还没有会话。发消息或 `/new` 建一个。";
  const dirs = uniq(peers.map(dirOf));
  const clis = uniq(peers.map((p) => p.cli));
  const shared = [dirs.length === 1 ? dirs[0] : "", clis.length === 1 ? clis[0] : ""].filter(Boolean);
  const rows = peers.flatMap((p) => {
    const name = p.tag ? `#${p.tag}` : "默认";
    const state = !p.paneAlive ? "⚫️ 已关闭" : p.busy ? "🔴 忙" : "🟢 空闲";
    const varies = [dirs.length > 1 ? dirOf(p) : "", clis.length > 1 ? p.cli : ""].filter(Boolean);
    const me = p.self ? " ⬅️ 本会话" : "";
    return [
      `**${p.label} ${name}** ${state}${varies.length ? ` · ${varies.join(" · ")}` : ""}${me}`,
      `　${clip(p.summary, 64)}`,
      "",
    ];
  });
  const named = peers.find((p) => p.chat)?.chat ?? "";
  return [
    `[wezard] 本聊天${named ? ` \`${named}\`` : ""}的会话 · ${peers.length} 个${shared.length ? ` · ${shared.join(" · ")}` : ""}`,
    "",
    ...rows,
    "> 协作：直接说「看下 #fix 的进展并推动它」，AI 会读它的终端并注入指令",
    named ? "" : "> 起名：`/name <名字>` — 起了名字，别的聊天才能用 `名字#tag` 叫到这里的会话",
  ].filter((l) => l !== "").join("\n");
};

// /chats — 跨聊天目录。命名的聊天可以被 `名字#tag` 精确寻址;没命名的只能靠
// 「全局唯一 tag」碰运气,所以这里把「未命名」显式标出来当作行动号召。
const renderChats = (
  roster: Array<{ base: string; name: string; self: boolean; targets: string[] }>,
): string => {
  if (roster.length === 0) return "[wezard] 还没有任何聊天在跑会话。";
  const rows = roster.flatMap((c) => {
    const sessions = c.targets.map((t) => (tagOfKey(t) ? `#${tagOfKey(t)}` : "默认")).join(" · ") || "(无)";
    const head = c.name ? `\`${c.name}\`` : `_(未命名)_ \`${c.base}\``;
    return [`**${head}**${c.self ? " ⬅️ 本聊天" : ""} · ${c.targets.length} 个会话`, `　${sessions}`, ""];
  });
  return [
    `[wezard] 已知的聊天 · ${roster.length} 个`,
    "",
    ...rows,
    "> 跨聊天寻址：`名字#tag`（如 `daily#fix`）。未命名的聊天先在里面发 `/name <名字>`",
  ].join("\n");
};

// Match a switch arg against a scanned session: animal emoji label, full
// sessionId, or a ≥6 char sessionId prefix. Returns the session or undefined.
const matchSession = (sessions: SessionInfo[], arg: string): SessionInfo | undefined =>
  sessions.find((s) => s.label === arg) ??
  sessions.find((s) => s.sessionId === arg) ??
  (arg.length >= 6 ? sessions.find((s) => s.sessionId.startsWith(arg)) : undefined);

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
// Always kill "@wezard" (bot's own name) regardless of chat type / @-count:
// a DM user typing "@wezard start …" would otherwise leak the mention into
// Claude's prompt and get semantically parsed (e.g. spawning wrc). Word-tail
// guard `(?![A-Za-z0-9_])` keeps identifiers like "@wezard-foo" intact
// while allowing CJK / punctuation right after.
// `weclaude` stays in the alternation: the bot's WeCom display name is chosen
// by the user, not by us, so pre-rename bots are still literally "@weclaude".
const stripBotName = (text: string): string =>
  text.replace(/[ \t]*@(?:wezard|weclaude)(?![A-Za-z0-9_])[ \t]*/giu, " ").replace(/[ \t]{2,}/g, " ").trim();
const maybeStripMentions = (msg: BaseMessage, text: string): string => {
  const cleaned = stripBotName(text);
  return isGroup(msg) ? stripMentions(cleaned) : cleaned;
};

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
const renderQuotePrefix = (body: string): string => {
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

/** `haystack` 里是否已包含 `needle` 的实质内容。
 *  两边归一化后,从 needle 里等间距抽 N 段 chunk,超过阈值命中即判"已在上下文"。
 *  比整串 substring 更健壮: WeCom 引用气泡可能截断、折叠、加 [查看更多]、重排段落,
 *  全文子串匹配在任何一处断裂就 miss。分段采样只要大部分 chunk 命中就够。 */
const CHUNK_LEN = 32;  // 每段采样长度(canon'd 字符)
const CHUNK_COUNT = 5; // 采样段数
const CHUNK_THRESHOLD = 0.6; // 命中比例阈值

const canonContains = (haystack: string, needle: string): boolean => {
  const a = canonForCompare(haystack);
  const b = canonForCompare(needle);
  if (a.length < 4 || b.length < 6) return false;
  // Fast path: short needle — full substring is cheap and precise
  if (b.length <= CHUNK_LEN * 2) return a.includes(b);
  // Sampled-chunk match: pick evenly-spaced chunks from needle, check presence
  const step = Math.max(1, Math.floor((b.length - CHUNK_LEN) / (CHUNK_COUNT - 1)));
  let hits = 0;
  let total = 0;
  for (let i = 0; i <= b.length - CHUNK_LEN && total < CHUNK_COUNT; i += step, total++) {
    if (a.includes(b.slice(i, i + CHUNK_LEN))) hits++;
  }
  return total > 0 && hits / total >= CHUNK_THRESHOLD;
};

const isLastResponseQuote = (target: string, quoted: string): boolean =>
  canonContains(getLastResponse(target) ?? "", quoted);

// ── 引用即路由 ─────────────────────────────────────────────────────────
// 群里要跟 `#fix` 说话,手打 tag 太慢 —— 直接引用它的气泡即可。每条出站气泡都
// 带 `emoji #tag` 头 (withTagHeader),所以引用文本自带路由信息;用户自己发的
// 行首 `#fix 干活` 同样算数(限行首,否则正文里随手写的 #123 会误判)。
// `body` 是剥掉头/tag 后的净引用内容,用于跟目标 context 比对。
// `tag`   = 路由目标(引用继承的投递 tag)。
// `srcTag` = 引用气泡真正出自哪个会话 —— 仅 bot 气泡可知(反解 `emoji #tag` 头)。
//            去重要比对的是「内容在不在源会话」,而非路由目标: 带着引用新建 /
//            改投到别的 tag 时,目标会话是空的,只有源会话里才有那段原文。
//            `srcTag===undefined` 表示源未知(用户自己打的引用),回退到按目标查。
const parseQuote = (q: QuoteContent | undefined): { tag: string; srcTag?: string; body: string } | null => {
  const raw = q ? quoteToText(q).trim() : "";
  if (!raw) return null;
  const head = parseTagHeader(raw);
  if (head.fromBot) return { tag: head.tag, srcTag: head.tag, body: head.body };
  const m = TAG_RE.exec(raw);
  return m && m.index === 0 ? { tag: m[2] ?? "", body: parseTag(raw).cleaned } : { tag: "", body: raw };
};

// 一条入站消息的最终「投递目标 tag + 给 claude 的正文」。text / image / mixed
// 三条路径共用,两条规则:
//   1. 引用自带的 tag 决定投递目标;引用之外自己打的 `#tag` 优先级更高。
//   2. 引用内容若已经在目标会话的 context 尾部,就只保留上面那层路由绑定、正文
//      丢弃(重复贴回去纯属污染);不在则说明它是真载荷(跨会话转发 / 引同事的
//      消息 / 目标已 `/clear`),照旧渲染成 markdown 引用块。
// 纯引用不打字时,沿用旧的"把引用内容提成正文"重触发路径 —— 但同样只在内容不
// 在目标上下文里时才有意义,否则那只是一次对该会话的空 nudge。
const composeInbound = (
  msg: BaseMessage,
  rawBody: string,
  inContext: (target: string, quoted: string) => boolean,
): { text: string; tag: string; promoted: boolean } => {
  const { tag: typed, cleaned } = parseTag(rawBody);
  const q = parseQuote(msg.quote);
  const tag = typed || q?.tag || "";
  // 去重比对的会话: 若引用来自某个 bot 会话(srcTag 已知),查那个源会话 ——
  // 内容天然存在于源的 transcript, 与你把它投到哪个 tag 无关。源未知时(用户自打
  // 的引用 / 改投)回退到路由目标。这修掉了「带引用新建/改投会话时原文被重复注入」。
  const dedupTag = q?.srcTag ?? tag;
  // 剥完头什么都不剩(折叠气泡这类纯 chrome 的引用)⇒ 没有可搬运的内容,只留路由。
  const consumed = !q || !q.body.trim() || inContext(sessionKey(chatPrincipal(msg), dedupTag), q.body);
  if (cleaned.trim()) {
    return { text: consumed ? cleaned : `${renderQuotePrefix(q.body)}${cleaned}`, tag, promoted: false };
  }
  if (q && !consumed) {
    // 提成正文时也剥一次 @mention,让 "@wezard /usage" → "/usage" 命中命令路径。
    const p = parseTag(maybeStripMentions(msg, q.body).trim());
    return { text: p.cleaned, tag: p.tag || tag, promoted: true };
  }
  return { text: cleaned, tag, promoted: false };
};

const isAllowed = (cfg: Config, principals: string[]): boolean => {
  if (cfg.wrc.allowFrom.length === 0) return false;
  // Tolerate invisible chars sneaking into hand-edited config (paste artifacts).
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  // "all" is an explicit opt-in wildcard — anyone can talk to the bot.
  if (allowed.has("all")) return true;
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
      const lines = [`[wezard] 📂 当前项目: \`${runningCwd}\``];
      if (pendingCwd && pendingCwd !== runningCwd) {
        lines.push(`下次切换: \`${pendingCwd}\` (使用 /new 或 /clear 生效)`);
      }
      if (runningCwd !== defaultCwd) lines.push(`(默认: \`${defaultCwd}\`)`);
      lines.push("> 切换其他项目: 对 AI 说「切到 /path/to/proj」(`set_workspace` 工具直接换目录重开)");
      return lines.join("\n");
    }
    return `[wezard] 📂 当前项目: \`${expandHome(cfg.wrc.cwd)}\` (headless mode, 全局默认)`;
  };

  // Mirror-only auto-spawn / /new helper. Routes through bridge.newSession
  // which kills the old pane, spawns fresh in pendingCwd ?? runningCwd ??
  // default, attaches, and pushes "📂 当前项目" info to the chat. Returns
  // the user-facing one-line ack. When `who` carries a `#tag` suffix, use
  // the raw tag as the tmux window name so the pane shows readably in the
  // status bar (e.g. `#docs` → window `docs`, not the principal slug).
  // On success there is NO reply: newSession already pushed the single
  // "created + cwd" bubble. Only failures produce user-facing text.
  const spawnSession = async (who: string, cli?: CliBackendName, silent?: boolean): Promise<{ err?: string }> => {
    if (!("newSession" in bridge)) return { err: "[wezard] /new only available in mirror mode" };
    const tag = tagOf(who);
    const r = await bridge.newSession(who, tag || who, cli, { silent });
    return r.ok ? {} : { err: `[wezard] /new failed: ${r.reason ?? "unknown"}` };
  };

  // 同一 `#tag` 的两条消息会并发落进 gate,双双判定「未附着」→ 双 spawn,后者
  // newSession 会 kill 掉前者的 pane,前者的 dispatch 再 `--resume` 重生出孤儿
  // pane,消息乱序。spawn 窗口有 3s+(TUI_SETTLE_MS),所以必须按会话串行。
  const spawnQ = new Map<string, Promise<unknown>>();
  const serializeSpawn = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const next = (spawnQ.get(key) ?? Promise.resolve()).then(job, job);
    spawnQ.set(key, next.catch(() => undefined).finally(() => {
      if (spawnQ.get(key) === next) spawnQ.delete(key);
    }));
    return next;
  };

  // 显式 /new:排队但仍强制重开(用户就是要换一个)。
  const autoSpawnAndAttach = (who: string, cli?: CliBackendName): Promise<{ err?: string }> =>
    serializeSpawn(who, () => spawnSession(who, cli));

  // 隐式建会话(裸 `#tag` 第一条消息):轮到自己时若前一条已经把会话建好,直接
  // 复用,不再 respawn —— 否则先到的消息会被注入进一个刚被杀掉的 pane。
  const ensureSession = (who: string): Promise<{ err?: string }> =>
    serializeSpawn(who, async () =>
      "hasMirrorTarget" in bridge && bridge.hasMirrorTarget(who) ? {} : await spawnSession(who, undefined, true));

  // Prefix user-visible daemon replies with `<emoji> #tag` when the routed
  // session is tagged, so a chat hosting multiple concurrent tagged sessions
  // stays visually disambiguated. Untagged (default) session passes through
  // unchanged. Emoji is derived from the tag string (not sessionId) so it
  // stays stable across /clear cycles.
  const withTagPrefix = withTagHeader;
  const replyText = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string): Promise<void> => {
    try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, text), true); } catch { /* ignore */ }
  };

  // Common gating: claim bootstrap + allowFrom check. Returns true if the
  // caller should stop (claim consumed or message rejected).
  const gate = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, text: string, who: string): Promise<{ stop: boolean }> => {
    const auths = authPrincipals(msg);
    // Bootstrap / allowFrom operations are chat-scoped, not session-scoped;
    // strip any `#tag` suffix so a first-time user typing `hello #foo`
    // still promotes them as `user:xxx` (not `user:xxx#foo`).
    const basePrincipal = chatPrincipal(msg);
    // /id — bypass allowFrom so users can discover their ids before configuring.
    if (isIdCommand(text)) {
      await replyText(frame, msg, who, renderIds(msg, cfg));
      return { stop: true };
    }
    // /help — static command reference. Bypasses allowFrom like /id so a new
    // user can discover the command surface before being authorized.
    if (isHelpCommand(text)) {
      await replyText(frame, msg, who, renderHelp());
      return { stop: true };
    }
    // /pwd — bypass allowFrom too. Read-only project-path lookup.
    if (isPwdCommand(text)) {
      await replyText(frame, msg, who, renderPwd(who));
      return { stop: true };
    }
    // /cost — token / cost ESTIMATE pulled from ~/.claude(-internal)?/projects
    // jsonl transcripts (ccusage-style). Read-only, no session state, so it
    // bypasses allowFrom like /id and /pwd. Real subscription %: use /usage.
    if (isCostCommand(text)) {
      let body: string;
      try {
        body = renderUsageReport(computeUsage());
      } catch (e) {
        body = `[wezard] /cost failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /audit [tag] — per-session cost/token breakdown (main + subagents). We
    // handle it here instead of paste-forwarding to the Claude REPL because
    // (a) tmux paste + Enter is racy for slash commands and often fails to
    // submit, and (b) even when it does, the LLM turn adds 30-40s over what
    // is really just a jsonl read. Read-only, no state — bypasses allowFrom.
    //
    // Tag routing: `/audit <tag>` resolves to the SINGLE most-recently-active
    // mirror whose target carries `#<tag>` (by jsonl mtime), NOT the caller's
    // current session and NOT a sum over all sessions sharing the tag.
    // Untagged form falls back to the caller's own mirror binding.
    const audit = parseAuditCommand(text);
    if (audit) {
      const mirror = "status" in bridge
        ? resolveAuditMirror(bridge.status().mirrors, audit.tag, who, chatPrincipal(msg))
        : undefined;
      let body: string;
      if (!mirror) {
        body = audit.tag
          ? `[wezard] /audit: 未找到 tag \`${audit.tag}\` 对应的 Agent 会话。`
          : `[wezard] /audit: 未找到 ${who} 绑定的 Agent 会话。先 \`/new\` 或用 \`wezard mirror\` 绑定后再试。`;
      } else {
        try {
          body = computeAuditReport({
            sessionId: mirror.sessionId,
            jsonlPath: mirror.jsonlPath,
            tag: audit.tag || undefined,
          });
        } catch (e) {
          body = `[wezard] /audit failed: ${(e as Error).message}`;
        }
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    if (tryConsumeClaim(text, basePrincipal)) {
      log.info({ who: basePrincipal }, "claim consumed — bootstrapping defaultChat + allowFrom");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "persistClaim failed");
      }
      await ackClaim(client, basePrincipal, log);
      await replyText(frame, msg, who, "✅ done");
      return { stop: true };
    }
    // Auto-claim: empty allowFrom + DM ⇒ first sender becomes super admin.
    // Falls through so the same message is also dispatched as a real prompt —
    // user types "hi" and gets both the promotion ack and the assistant reply.
    const isDm = !(msg.chattype === "group" && msg.chatid);
    if (shouldAutoClaim(cfg, isDm)) {
      log.info({ who: basePrincipal }, "auto-claim — empty allowFrom, first DM sender promoted");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "auto-claim persistClaim failed");
      }
      await ackAutoClaim(client, basePrincipal, log);
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
      return { stop: true };
    }
    // Authorized `/usage` — real subscription rate-limit %, scraped from Claude
    // Code's own `/usage` TUI (/cost can only estimate cost/tokens; the true
    // limit % is server-side). Drives a throwaway isolated pane (~10s) → interim
    // ack, then replace with the result.
    if (isUsageCommand(text)) {
      log.info({ who }, "/usage panel: start");
      try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, "⏳ 正在拉起 /usage 面板查询真实额度…"), false); } catch (e) { log.warn({ err: (e as Error).message }, "/usage: interim ack failed"); }
      let body: string;
      try {
        const report = await captureQuota(cfg, log);
        // Wrap in a fenced code block so WeCom renders the aligned panel in a
        // monospace bubble (columns stay lined up).
        body = "```\n" + renderQuotaReport(report) + "\n```";
        log.info({ who, limits: report.limits.length }, "/usage panel: done");
      } catch (e) {
        body = `[wezard] /usage failed: ${(e as Error).message}`;
        log.error({ who, err: (e as Error).message }, "/usage panel: failed");
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // Authorized `/new` — spawn a tmux+claude pair and attach it to this chat.
    // Runs BEFORE the mirror-not-attached short-circuit so it works as the
    // very first message from a fresh user. When routed with a `#tag`, the
    // tag becomes both the mirror-store key and the tmux window name.
    if (isNewCommand(text)) {
      const { err } = await autoSpawnAndAttach(who, cliOfNewCommand(text));
      if (err) await replyText(frame, msg, who, err);
      return { stop: true };
    }
    // 事件订阅 / 广播 / 定时已全部迁移到 MCP 工具(subscribe_topic /
    // broadcast_topic / schedule_broadcast …),不再有 IM 文本命令。
    // Authorized `/stop` — Esc the live pane to interrupt whatever Claude is
    // currently doing. Mirror-mode only; bails cleanly when no attachment.
    if (isStopCommand(text)) {
      if ("interruptPane" in bridge) {
        // teardown: /stop is the user's "shut this up" button, so it must also
        // close hanging bubbles and free the inject queue — not just press Esc.
        // Stay silent on a clean stop (the pane going quiet IS the receipt);
        // only speak up when a half actually failed — a live pane that refuses
        // Esc is a very different situation from a chat merely stuck on a bubble.
        const r = await bridge.interruptPane(who, { teardown: true });
        if (!r.ok) {
          await replyText(frame, msg, who, `[wezard] /stop failed: ${r.reason ?? "unknown"}`);
        } else if (!r.escOk) {
          const torndown = r.torndown ? ` · 已收口 ${r.torndown} 个挂起气泡` : "";
          await replyText(frame, msg, who, `⚠️ Esc 未送达（${r.escReason ?? "unknown"}）${torndown} · 保活已暂停`);
        }
      }
      return { stop: true };
    }
    // Authorized `/kill` — end this session for good: Esc the pane, kill it,
    // and drop the binding (no `--resume` resurrection). Routed by `#tag` like
    // /stop, so `/kill #docs` only takes down that sibling.
    if (isKillCommand(text)) {
      if (!("killPane" in bridge)) {
        await replyText(frame, msg, who, "[wezard] /kill only available in mirror mode");
      } else {
        const r = await bridge.killPane(who);
        await replyText(frame, msg, who, r.ok ? "🗑️ 会话已结束，pane 已移除" : `[wezard] /kill failed: ${r.reason ?? "unknown"}`);
      }
      return { stop: true };
    }
    // Authorized `/n` — send a bare Enter to the live pane. Confirms a prompt /
    // dismisses a "press enter to continue", or submits whatever's already in
    // the input box. Mirror-mode only; bails cleanly when no attachment.
    if (isEnterCommand(text)) {
      if (!("submitPane" in bridge)) {
        await replyText(frame, msg, who, "[wezard] /n only available in mirror mode");
      } else {
        const r = await bridge.submitPane(who);
        await replyText(frame, msg, who, r.ok ? "Enter sent" : `[wezard] /n failed: ${r.reason ?? "unknown"}`);
      }
      return { stop: true };
    }
    // Authorized `/reveal` — switch the attached tmux client to this session's
    // pane so the user lands in the terminal showing the live TUI. Mirror-mode
    // only; routed by `#tag` like any other session command.
    if (isRevealCommand(text)) {
      if (!("revealPane" in bridge)) {
        await replyText(frame, msg, who, "[wezard] /reveal only available in mirror mode");
      } else {
        const r = await bridge.revealPane(who);
        await replyText(frame, msg, who, r.ok ? "✅ 已切到本会话的 tmux 窗口" : `[wezard] /reveal failed: ${r.reason ?? "unknown"}`);
      }
      return { stop: true };
    }
    // /cfgsync [apply] — 3-way merge of the bound project's per-CLI config
    // trees (CLAUDE.md ⇄ CODEBUDDY.md, .claude/{skills,commands,agents} ⇄
    // .codebuddy/...). Writes files, so it sits AFTER the allowFrom gate.
    const cs = parseCfgSyncCommand(text);
    if (cs) {
      const cwd = "getCwd" in bridge ? bridge.getCwd(who).runningCwd : expandHome(cfg.wrc.cwd);
      let body: string;
      try {
        body = renderSyncReport(await syncProjectConfig(cwd, cs.apply));
      } catch (e) {
        body = `[wezard] /cfgsync failed: ${(e as Error).message}`;
      }
      log.info({ who, cwd, apply: cs.apply }, "/cfgsync");
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /name [x|-] — 给本聊天起名。名字是跨聊天寻址的唯一稳定 key(`daily#fix`),
    // 所以它写进 config.jsonc 而不是运行时 state。改名即覆盖:一个聊天只留一个
    // 名字,一个名字只归一个聊天 —— 两边都唯一,`daily#fix` 才是个确定的地址。
    const nc = parseNameCommand(text);
    if (nc) {
      const cur = chatNameOf(cfg, who);
      if (!nc.arg) {
        await replyText(frame, msg, who, cur
          ? `[wezard] 本聊天名为 \`${cur}\` — 别处可用 \`${cur}#tag\` 寻址本聊天的会话`
          : "[wezard] 本聊天还没起名。`/name <名字>` 起一个，别的聊天才能用 `名字#tag` 叫到这里的会话。");
        return { stop: true };
      }
      if (nc.arg === "-") {
        const gone = clearChatName(cfg, sourcePath, who);
        await replyText(frame, msg, who, gone ? `[wezard] 已取消命名 \`${gone}\`` : "[wezard] 本聊天本来就没起名。");
        return { stop: true };
      }
      const r = setChatName(cfg, sourcePath, who, nc.arg);
      await replyText(frame, msg, who, r.ok
        ? `[wezard] ✅ 本聊天更名为 \`${r.name}\`${cur && cur !== r.name ? `（原 \`${cur}\`）` : ""} — 别处用 \`${r.name}#tag\` 即可寻址`
        : `[wezard] /name failed: ${r.reason}`);
      return { stop: true };
    }
    // /chats — 跨聊天目录:谁有名字、各自跑着哪些会话。Read-only。
    if (isChatsCommand(text)) {
      if (!("chatRoster" in bridge)) {
        await replyText(frame, msg, who, `[wezard] headless 模式无会话目录。已命名的聊天：${listChatNames(cfg).map((c) => c.name).join(", ") || "(无)"}`);
        return { stop: true };
      }
      await replyText(frame, msg, who, renderChats(bridge.chatRoster(who)));
      return { stop: true };
    }
    // /peers — this chat's own session roster (default + `#tag` siblings), with
    // live busy state. Read-only, mirror-mode only.
    if (isPeersCommand(text)) {
      if (!("peers" in bridge)) {
        await replyText(frame, msg, who, "[wezard] /peers only available in mirror mode");
        return { stop: true };
      }
      let body: string;
      try {
        body = renderPeers(await bridge.peers(who));
      } catch (e) {
        body = `[wezard] /peers failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /sessions [arg] — list live Claude sessions, or switch the mirror to one.
    // Bare lists; with an arg (emoji / sessionId / ≥6-char prefix) it re-points
    // THIS chat's mirror at the matched session. Reuses the same scan+attach
    // path as the /sessions/switch route so IM and MCP behave identically.
    const sc = parseSessionsCommand(text);
    if (sc) {
      if (!("attach" in bridge)) {
        await replyText(frame, msg, who, "[wezard] /sessions only available in mirror mode");
        return { stop: true };
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
        await replyText(frame, msg, who, renderSessionsList(sessions, currentSid));
        return { stop: true };
      }
      const hit = matchSession(sessions, sc.arg);
      if (!hit) {
        const avail = sessions.map((s) => `${s.label || "🧙"} ${s.sessionId.slice(0, 8)}`).join("、") || "无";
        await replyText(frame, msg, who, `[wezard] 未找到会话 \`${sc.arg}\`。可用：${avail}`);
        return { stop: true };
      }
      if (hit.sessionId === currentSid) {
        await replyText(frame, msg, who, `[wezard] 已经在该会话 ${hit.label} \`${hit.sessionId.slice(0, 8)}\``);
        return { stop: true };
      }
      const att = bridge.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target: who, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      await replyText(
        frame, msg, who,
        att.ok
          ? `✅ 已切到 ${hit.label} \`${hit.sessionId.slice(0, 8)}\` (${hit.cwd})`
          : `[wezard] 切换失败: ${att.reason ?? "unknown"}`,
      );
      return { stop: true };
    }
    // Mirror mode but no Claude session attached for this chat yet. Since the
    // sender is already in allowFrom, we treat that authorization as license
    // to auto-spawn: this inbound becomes both the binding signal and the
    // first prompt — attach, then fall through to dispatch.
    if ("hasMirrorTarget" in bridge && !bridge.hasMirrorTarget(who)) {
      const { err } = await ensureSession(who);
      if (err) {
        await replyText(frame, msg, who, err);
        return { stop: true };
      }
      // attached — fall through to dispatch
    }
    return { stop: false };
  };

  // 「引用内容是否已经在目标会话的 context 里」。两级:先查刚发出去的最后一条
  // 气泡(内存,headless 模式也有);miss 再读目标会话 transcript 的尾部若干轮
  // —— 引用的往往是几轮之前的气泡,只比对最后一条会漏。目标未挂载(尚未 attach /
  // headless)时读不到 transcript,退化成"保留引用",宁可多给上下文。
  const quoteInContext = (target: string, quoted: string): boolean => {
    if (isLastResponseQuote(baseOfKey(target), quoted)) {
      log.info({ target, reason: "lastResponse" }, "quoteInContext: hit");
      return true;
    }
    // 源会话的 last stream 还没收口 ⇒ 引用的是实时中间态 (URL + 最新 CoT/工具行),
    // 只保留路由 tag, 不把瞬态内容贴回 prompt。
    if ("isOpenBubbleQuote" in bridge && (bridge as MirrorBridge).isOpenBubbleQuote(target, quoted)) {
      log.info({ target, reason: "openBubble" }, "quoteInContext: hit");
      return true;
    }
    const mirrors = (bridge as { status?: () => { mirrors?: Array<{ target: string; jsonlPath: string }> } })
      .status?.().mirrors ?? [];
    const jsonl = mirrors.find((m) => m.target === target)?.jsonlPath;
    if (!jsonl) {
      log.info({ target, mirrorCount: mirrors.length, mirrorTargets: mirrors.map((m) => m.target) }, "quoteInContext: no jsonl for target");
      return false;
    }
    const tail = tailTurnsWithTools(jsonl, QUOTE_TAIL_TURNS);
    const hit = canonContains(tail, quoted);
    log.info({ target, jsonl, tailLen: tail.length, quotedLen: quoted.length, hit }, "quoteInContext: tail check");
    return hit;
  };

  // 路由用掉的那个 `#tag` 已被 parseTag 摘走,正文里剩下的每个 `#x` 都可能是
  // 用户在指另一个会话。解析走 bridge 自己的 resolvePeerTag —— peer 工具用的
  // 同一套(本 chat 优先、否则全局唯一 tag、再否则带 chat 名的全称),所以标注
  // 出来的地址一定是 peek_peer/send_peer 打得中的;解析不到的 `#123`/`#L45` 与
  // 自指静默略过。给的是 `address` 而不是裸 tag —— 跨 chat 时裸 tag 未必唯一。
  const peerMentions = (who: string, text: string): PeerMention[] => {
    if (!("resolvePeerTag" in bridge)) return [];
    const mb = bridge as MirrorBridge;
    const seen = new Set<string>();

    // Pass 1: standalone `#tag` tokens (existing behavior)
    const fromTags = allTags(text).flatMap((tag): PeerMention[] => {
      const r = mb.resolvePeerTag(who, tag);
      if (!r.ok || r.target === who) return [];
      seen.add(r.target);
      const { runningCwd, defaultCwd } = mb.getCwd(r.target);
      return [{
        tag,
        target: r.target,
        address: peerAddress(cfg, who, r.target),
        chat: chatNameOf(cfg, r.target),
        foreign: r.foreign,
        label: labelFor(tag),
        cwd: runningCwd || defaultCwd,
      }];
    });

    // Pass 2: compound `chatName#tag` patterns (invisible to TAG_TOKEN because
    // `#` isn't preceded by whitespace). Feed the raw compound to resolvePeerTag
    // which internally splits via parsePeerRef.
    const fromCompound = allCompoundAddresses(text).flatMap((addr): PeerMention[] => {
      const r = mb.resolvePeerTag(who, addr.raw);
      if (r.ok) {
        if (r.target === who || seen.has(r.target)) return [];
        seen.add(r.target);
        const { runningCwd, defaultCwd } = mb.getCwd(r.target);
        return [{
          tag: addr.tag,
          target: r.target,
          address: peerAddress(cfg, who, r.target),
          chat: chatNameOf(cfg, r.target),
          foreign: r.foreign,
          label: labelFor(addr.tag),
          cwd: runningCwd || defaultCwd,
        }];
      }
      // Session doesn't exist but chat name is valid → unborn peer hint
      if (chatBaseOf(cfg, addr.chat)) {
        return [{
          tag: addr.tag,
          target: "",
          address: `${addr.chat}#${addr.tag}`,
          chat: addr.chat,
          foreign: true,
          label: labelFor(addr.tag),
          cwd: "",
          unborn: true,
        }];
      }
      return [];
    });

    return [...fromTags, ...fromCompound];
  };

  const send = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string, images: string[] = []): Promise<void> => {
    // 斜杠命令按行解析,尾巴上多挂一段会让它不再被识别成命令 —— 只标注普通消息。
    const hint = text.trimStart().startsWith("/") ? "" : renderPeerMentionHint(peerMentions(who, text));
    try {
      await bridge.dispatch({ principal: who, text: text + hint, images, frame, streamId: msg.msgid });
    } catch (e) {
      log.error({ err: (e as Error).message }, "bridge dispatch failed");
      try { await client.replyStream(frame, msg.msgid, withTagHeader(who, `[wezard] error: ${(e as Error).message}`), true); } catch { /* ignore */ }
    }
  };

  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const { text, tag, promoted } = composeInbound(msg, maybeStripMentions(msg, msg.text?.content ?? ""), quoteInContext);
    const who = sessionKey(chatPrincipal(msg), tag);
    log.info({ msgid: msg.msgid, len: text.length, tag, hasQuote: !!msg.quote, promoted }, "rx text");
    const { stop } = await gate(frame, msg, text, who);
    if (stop) return;
    await send(frame, msg, who, text);
  });

  client.on("message.image", async (frame: WsFrame<ImageMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, hasQuote: !!msg.quote }, "rx image");
    // Images carry no text of their own — the quote (if any) is the only
    // routing signal; without it they land on the chat's default session.
    const { text, tag } = composeInbound(msg, "", quoteInContext);
    const who = sessionKey(chatPrincipal(msg), tag);
    const { stop } = await gate(frame, msg, "", who);
    if (stop) return;
    const path = await downloadToInbox({ client, log, inboxDir }, msg.image.url, msg.image.aeskey, msg.msgid, 0);
    if (!path) {
      try { await client.replyStream(frame, msg.msgid, "[wezard] 图片下载失败", true); } catch { /* ignore */ }
      return;
    }
    // Pass the path through the bridge's `images` channel — mirror mode pumps
    // each via macOS clipboard + Ctrl+V into the live TTY (matches Claude
    // Code's documented image paste flow → image content block, no Read tool
    // turn). Spawn-mode falls back to `@<path>` automatically.
    await send(frame, msg, who, text, [path]);
  });

  client.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, items: msg.mixed?.msg_item?.length, hasQuote: !!msg.quote }, "rx mixed");
    // Concatenate all text items to sniff a leading `#tag`, then strip it from
    // the effective body before forwarding to Claude.
    const rawText = (msg.mixed?.msg_item ?? [])
      .filter((it) => it.msgtype === "text")
      .map((it) => (it as { text?: { content?: string } }).text?.content ?? "")
      .join("\n");
    const { tag } = composeInbound(msg, maybeStripMentions(msg, rawText), quoteInContext);
    const who = sessionKey(chatPrincipal(msg), tag);
    const { stop } = await gate(frame, msg, "", who);
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
    // Re-compose on the per-item stripped text: drops the routing `#tag` (it was
    // consumed above; leaving it in would leak into Claude) and attaches the
    // quote only when it isn't already in the target's context.
    await send(frame, msg, who, composeInbound(msg, texts.join("\n"), quoteInContext).text, images);
  });

  // template_card_event is handled in approval module; no listener here.
};
