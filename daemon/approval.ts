// Approval card build + click event handling. Plugs the PreToolUse hook flow.
import type {
  WSClient,
  WsFrame,
  TemplateCard,
  EventMessage,
  EventMessageWith,
  TemplateCardEventData,
} from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { Config } from "../shared/config.js";
import { createPending, getPending, getResolvedSnapshot, resolvePending, resolvePendingsByChat, failPending, stashResolved, markCardSent, isReloadError, type Decision } from "./pending.js";
import {
  cacheGet,
  cachePut,
  cacheKey,
  isAutoWindowActive,
  autoWindowRemainingMs,
  setAutoWindow,
  clearAutoWindow,
  getWindowMeta,
} from "./session-cache.js";
import { evaluateAllow, ruleMatchesAny, alwaysAllowRulesFor, splitSegments, NEVER_RULE_ALLOW, type DenyReason } from "../shared/allow-rules.js";
import { redact } from "./redact.js";
import { dangerOf, dangerEarlyExit, type DangerHit } from "./danger.js";
import { appendUnique } from "../shared/config-writer.js";
import { claudeConfigWrite, type ClaudeConfigHit } from "../shared/claude-config-path.js";
import type { NativeModalAnswer } from "./mirror-bridge.js";
import { recordApproval, recordApprovalDecision, buildDetailUrl, getDetail } from "./detail.js";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";
import { tagBadge, tagOfKey, withTagHeader } from "../shared/session-label.js";
import { sessionNameFor } from "./session-name.js";

// ── Routing helpers ────────────────────────────────────────────────────
const targetChatId = (principal: string): string => {
  // "user:abc" → "abc" (DM chatid == userid for aibot)
  // "chat:wc..." → "wc..."
  // "user:abc#tag" → "abc" (drop the routing tag; WeCom SDK only knows chatids)
  // raw fallthrough
  const i = principal.indexOf(":");
  const rest = i >= 0 ? principal.slice(i + 1) : principal;
  const h = rest.indexOf("#");
  return h >= 0 ? rest.slice(0, h) : rest;
};

const pickApprover = (cfg: Config): string | undefined => {
  if (cfg.approval.approvers.length > 0) return cfg.approval.approvers[0];
  if (cfg.defaultChat) return cfg.defaultChat;
  return undefined;
};

// ── Card construction ──────────────────────────────────────────────────
interface CardArgs {
  reqId: string;
  toolName: string;
  toolInput: unknown;
  toolInputStr: string;
  cwd: string;
  sessionShort: string;
  /** Full sessionId — used for the stable animal-emoji tag (matches /sessions list). */
  sessionId?: string;
  /** WeCom principal for this card; used to encode the "点击取消" cancel key
   *  on allow_window resolved cards. Auto-window is chat-scoped so the cancel
   *  key must carry chatKey, not sessionId. */
  chatKey?: string;
  transcriptTail: string;
  windowMinutes: number;
  detailUrl?: string;  // 空则不渲染 jump_list
  /** 命中危险名单的规则名。非空 → 卡片去掉「全过」按钮, 必须单次确认。 */
  danger?: string;
  /** 必发卡 (approval.ts 的 mustCard: 危险名单 / askRules / `.claude/**` 守卫)。
   *  按钮面必须与判决面一致 —— handler 侧 `!mustCard` 会把「⏱全过 / ✅总是」
   *  的效果全部丢掉, 卡上还画着它们就是给了两颗按不动的按钮。 */
  forceSingle?: boolean;
  /** 会话名 (#tag / CC 会话名 / 首条用户消息 / 短 id) — 发卡时算好, resolved 卡复用。 */
  sessionName?: string;
  /** 未命中 allowRules 的具体原因 — 渲染到「审核」行。 */
  denyReason?: DenyReason;
}

const TRUNC = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const HOME_RE = /^\/Users\/[^/]+/;
const fmtPath = (p: string): string => p.replace(HOME_RE, "~");
const relToCwd = (p: string, cwd: string): string => {
  if (!p) return "";
  if (cwd && p === cwd) return ".";
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return fmtPath(p);
};

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ⏎ ");
const takeFirstLines = (s: string, lines: number, maxChars: number): string =>
  TRUNC(s.split("\n").slice(0, lines).join("\n"), maxChars);

const EDIT_SNIPPET_LEN = 160;
const WRITE_PREVIEW_LINES = 4;
const WRITE_PREVIEW_CHARS = 200;

const SOURCE_ICON = "https://wwcdn.weixin.qq.com/node/wework/images/3d-claude-ai-logo.bce0ddae70.jpg";

// Source 行 = 会话身份位: 放会话名 (谁在请求), 让 main_title 整块 13×2 字腾给
// "想干什么"。危险卡只把这行文字变红 (desc_color: 2), 不换文案不加图标 ——
// 红色本身就是信号。会话名缺失时回落品牌名, 不留空行。
const buildSource = (danger?: string, sessionName?: string): TemplateCard["source"] =>
  ({
    icon_url: SOURCE_ICON,
    desc: TRUNC(sessionName || "Claude Code", 13),
    desc_color: danger ? 2 : 0,
  }) as TemplateCard["source"];

interface Rendered {
  body: string;  // wrapped in quote_area as the parameters block
  desc?: string; // 渲染到 sub_title_text — 跟 quote_area 里的命令/参数体分离
}

const prefixLines = (s: string, prefix: string): string =>
  s.split("\n").map((l) => `${prefix} ${l}`).join("\n");

// Flat key:val summary for unknown tools — never dump raw JSON.
const UNKNOWN_VAL_LEN = 140;
const UNKNOWN_TOTAL_LEN = 480;
// Path values (Glob target_directory, open_result_view target_file, …) get
// cwd/home-collapsed first, then LEFT-truncated — the filename is the
// informative tail; right-truncation cuts it off mid-path.
const TRUNC_LEFT = (s: string, n: number): string =>
  s.length > n ? `…${s.slice(s.length - (n - 1))}` : s;
const summarizeUnknown = (i: Record<string, unknown>, cwd: string): string => {
  const lines: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(i)) {
    if (total >= UNKNOWN_TOTAL_LEN) { lines.push("…"); break; }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const isPath = typeof v === "string" && v.startsWith("/");
    const shown = isPath ? TRUNC_LEFT(relToCwd(v, cwd), UNKNOWN_VAL_LEN) : TRUNC(oneLine(s), UNKNOWN_VAL_LEN);
    const line = `${k}: ${shown}`;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
};

// 卡片 quote 体上限 — 由 approval.cardQuoteMaxChars 注入 (渲染函数调用点太多,
// 模块级注入一次比层层穿参干净)。发送失败时缩到 SAFE_QUOTE_MAX 重试, 见 flushBatch。
let QUOTE_MAX = 600;
export const setCardQuoteMax = (n: number): void => { QUOTE_MAX = n; };
const SAFE_QUOTE_MAX = 600;
// 发送失败缩容重试: 正文主体如今在 sub_title_text (v2 布局), quote_area 仅存于
// 历史路径 —— 两处都缩, 保住审批流比保住展示量重要。
const shrinkQuote = (c: TemplateCard): TemplateCard => {
  let out = c;
  const q = (c as { quote_area?: { type: number; quote_text?: string } }).quote_area;
  if (q?.quote_text && q.quote_text.length > SAFE_QUOTE_MAX) {
    out = { ...out, quote_area: { ...q, quote_text: TRUNC(q.quote_text, SAFE_QUOTE_MAX) } } as TemplateCard;
  }
  const st = out.sub_title_text;
  if (st && st.length > SAFE_QUOTE_MAX) {
    out = { ...out, sub_title_text: TRUNC(st, SAFE_QUOTE_MAX) };
  }
  return out;
};
const join = (...parts: string[]): string => parts.filter(Boolean).join("\n");

// Render tool input as a multi-line "code-block / quote" body.
const renderInput = (
  toolName: string,
  toolInput: unknown,
  _toolInputStr: string,
  cwd: string,
): Rendered => {
  const i = toolInput as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return { body: "" };

  if (toolName === "Bash") {
    const cmd = typeof i.command === "string" ? i.command : "";
    const desc = typeof i.description === "string" ? i.description : "";
    return { body: TRUNC(cmd, QUOTE_MAX), desc: desc || undefined };
  }
  if (toolName === "Read") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    return { body: TRUNC(fp, QUOTE_MAX) };
  }
  if (toolName === "Write") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const content = typeof i.content === "string" ? i.content : "";
    const lc = content ? content.split("\n").length : 0;
    const preview = takeFirstLines(content, WRITE_PREVIEW_LINES, WRITE_PREVIEW_CHARS);
    return {
      body: TRUNC(join(fp, `✏️ 写入 ${lc} 行`, preview ? prefixLines(preview, "+") : ""), QUOTE_MAX),
    };
  }
  if (toolName === "Edit") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const oldS = TRUNC(typeof i.old_string === "string" ? i.old_string : "", EDIT_SNIPPET_LEN);
    const newS = TRUNC(typeof i.new_string === "string" ? i.new_string : "", EDIT_SNIPPET_LEN);
    return {
      body: TRUNC(join(fp, prefixLines(oldS, "−"), prefixLines(newS, "+")), QUOTE_MAX),
    };
  }
  if (toolName === "MultiEdit") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
    const first = edits[0] ?? {};
    const oldS = TRUNC(typeof first.old_string === "string" ? first.old_string : "", EDIT_SNIPPET_LEN);
    const newS = TRUNC(typeof first.new_string === "string" ? first.new_string : "", EDIT_SNIPPET_LEN);
    return {
      body: TRUNC(
        join(`${fp}  (✏️ ${edits.length} 处)`, prefixLines(oldS, "−"), prefixLines(newS, "+")),
        QUOTE_MAX,
      ),
    };
  }
  if (toolName === "Agent" || toolName === "Task") {
    const desc = typeof i.description === "string" ? i.description : "";
    const sa = typeof i.subagent_type === "string" ? i.subagent_type : "";
    const prompt = typeof i.prompt === "string" ? i.prompt : "";
    const head = [sa, desc].filter(Boolean).join(": ");
    return { body: TRUNC(prompt, QUOTE_MAX), desc: head || undefined };
  }
  return { body: summarizeUnknown(i, cwd) };
};

// Bash/Shell 的原始命令 — 判断卡片正文是否被截断、以及「展开完整命令」取哪一段。
const commandOf = (toolName: string, toolInput: unknown): string => {
  if (toolName !== "Bash" && toolName !== "Shell") return "";
  const i = toolInput as Record<string, unknown> | null;
  return i && typeof i.command === "string" ? i.command : "";
};

const MAIN_DESC_MAX = 30;
const mainTitle = (title: string, desc?: string): TemplateCard["main_title"] =>
  desc ? { title, desc: TRUNC(desc, MAIN_DESC_MAX) } : { title };

const dirName = (cwd: string): string => cwd.replace(/^.*\//, "") || cwd;

// quote_area 弃用后, jump_list 是卡上唯一的 PC 跳转位 (13 字上限)。
const detailJumpList = (url?: string): TemplateCard["jump_list"] | undefined =>
  url ? [{ type: 1, title: "🔍 完整命令 · 详情", url }] : undefined;

// Stable per-session animal emoji, matching list_claude_sessions, so the user
// can tell which session a card belongs to when several un-mirrored sessions
// fall back to the same WeCom chat. Needs the FULL sessionId; returns "" when
// only a short id / none is available.
// Show the session emoji ONLY on cards bound to a tagged session — the tag
// (`user:xxx#foo`) is the visual disambiguator for chats hosting parallel
// sessions. Untagged (default-session) cards drop the emoji so single-session
// users don't see a chunk of extra glyphs in every approval title. Emoji is
// keyed on the tag STRING (not sessionId) so it matches the `emoji #tag`
// prefix that outbound mirror bubbles carry — one visual per tag, regardless
// of how many times `/clear` rotates the underlying sessionId.
const emojiFor = tagBadge;

// ── v3 布局 (2026-07-31 两轮真机反馈后定稿) ──────────────────────────
// 信息优先级: 谁在问(会话名) > 想干什么(desc) > 具体命令 > 上下文。
//   source        品牌位; 危险卡文字变红 (仅变色, 不换文案)
//   main_title    <会话名> · <工具> — 无锁/无 emoji, 纯文字
//   quote_area    命令主体 — 无标题, 整块可点跳详情页 (PC); 3 行截断由
//                 右上⋯展开与详情页兜底
//   horizontal    上文 (最近用户消息); 危险卡多一行规则名
//   jump_list     「🔍 完整命令·详情」
// 会话名: #tag (企微发起) > CC 会话名 (本地发起, sessions 注册表) > 首条消息。
const HMETA_VAL_MAX = 26;

// 一级标题 = Claude 自己写的意图 (tool_input.description), 回答"想干什么" ——
// 13×2 字里最值钱的内容。没有 description 的工具 (Read/Write/Edit…) 回落
// 「工具 · 目录/」, 因为具体路径在下面的引用区里已经有了。
const cardTitle = (a: CardArgs, r: Rendered): string =>
  r.desc || `${shortTool(a.toolName)} · ${dirName(a.cwd)}/`;

// 「审核」行: 说清这条命令为什么没被白名单放行 —— 与「危险」行同一种表达方式。
// 能算出「总是」将生成的规则时直接给规则 (点总是会发生什么), 否则给段落定位。
const denyReasonText = (d: DenyReason): string | undefined => {
  switch (d.kind) {
    case "segment_unmatched":
      return d.rule
        ? `${d.index}/${d.total}段 → ${d.rule}`
        : `${d.index}/${d.total}段 ${d.segment}`;
    case "substitution": return "含 $() 动态构造，无法白名单";
    case "unparsable": return "引号未闭合或含后台符 &";
    case "tool_not_listed": return `${shortTool(d.tool)} 未在白名单`;
    case "never_allow": return "交互工具，永不免审";
    // 没配白名单规则 = 用户没在用这套机制, 每张卡都挂这行纯噪声。
    case "no_rules": return undefined;
  }
};

// mcp__server__tool → server:tool — 标题里的长工具名压短。
const shortTool = (toolName: string): string =>
  TRUNC(toolName.replace(/^mcp__/, "").replace(/__/g, ":"), 16);

const metaRows = (a: CardArgs): TemplateCard["horizontal_content_list"] => {
  const rows: Array<{ keyname: string; value: string }> = [];
  const tail = oneLine(a.transcriptTail).trim();
  if (tail) rows.push({ keyname: "上文", value: TRUNC(tail, HMETA_VAL_MAX) });
  // 为什么要人来点这一下 —— 优先级 危险 > 未白名单。danger 命中时命令很可能
  // 本来就在白名单里, 再报"未放行"是误导。
  if (a.danger) {
    rows.push({ keyname: "危险", value: TRUNC(`命中「${a.danger}」`, HMETA_VAL_MAX) });
  } else if (a.denyReason) {
    const why = denyReasonText(a.denyReason);
    if (why) rows.push({ keyname: "审核", value: TRUNC(why, HMETA_VAL_MAX) });
  }
  return rows.length > 0 ? (rows as TemplateCard["horizontal_content_list"]) : undefined;
};

// 命令主体 (引用区, 可点) + 元信息行, 各卡共用的中段。
const bodyBlocks = (a: CardArgs, r: Rendered): Partial<TemplateCard> => {
  const rows = metaRows(a);
  return {
    ...(r.body ? { quote_area: quoteArea(r.body, a.detailUrl) } : {}),
    ...(rows ? { horizontal_content_list: rows } : {}),
  };
};

// 引用区: 无标题 (省一行), 挂 type:1 + url 整块可点 → 详情页看全文 (PC 好用;
// 回环链接手机打不开是已知取舍, 手机走右上⋯展开)。
const quoteArea = (text: string, url?: string): TemplateCard["quote_area"] =>
  (url
    ? { type: 1, url, quote_text: text }
    : { type: 0, quote_text: text }) as TemplateCard["quote_area"];

// 必发卡 (危险名单 / askRules / `.claude/**` 守卫): 只有 ❌ / ✅ — 不给「N 分钟
// 全过」「✅总是」的入口, 否则一次点击就把后续所有这类操作也放行了, 名单等于失效。
// 判据是 forceSingle 而非 danger: 另两个来源的卡同样吃 handler 侧的 `!mustCard`
// 短路, 只按 danger 收按钮的话它们会画出点了没反应、也不 sweep 同批的死按钮。
const approveButtons = (a: CardArgs): TemplateCard["button_list"] =>
  a.danger || a.forceSingle
    ? [
        { text: "❌", style: 4, key: encodeKey(a.reqId, "deny") },
        { text: "✅ 确认执行", style: 4, key: encodeKey(a.reqId, "allow") },
      ]
    : [
        { text: "❌", style: 4, key: encodeKey(a.reqId, "deny") },
        { text: windowLabel(a.windowMinutes), style: 4, key: encodeKey(a.reqId, "allow_window") },
        // 「总是」= 由本次调用生成一条 allowRules 并落盘, 对齐 Claude Code 原生
        // 弹窗的 Always allow。危险卡上没有这个入口 (与「⏱全过」同理)。
        { text: "✅总是", style: 4, key: encodeKey(a.reqId, "allow_always") },
        { text: "✅", style: 4, key: encodeKey(a.reqId, "allow") },
      ];

// 正文放不下时的两条出路, 都挂在卡片自己身上 (不再额外发一条完整命令的文本消息):
//   • 引用区可点 → 详情页 (HTML, 有高亮, 但要跳浏览器)
//   • 右上角「⋯」菜单「📄 展开完整命令」→ 按需在群里发全文 (不跳出企微)
// action_menu 只在正文确实被截断时才挂, 免得短命令的卡也多一个没用的入口。
const FULLCMD_PREFIX = "FULLCMD|";
const encodeFullCmdKey = (reqId: string): string => `${FULLCMD_PREFIX}${reqId}`;
// WeCom markdown 单条上限约 2048 字节, 留出标题与 tag 头的余量。
const FULLCMD_CHUNK_CHARS = 1800;
const chunkText = (s: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length > 0 ? out : [""];
};

/** 带命令的卡一律给「看全文」入口, 待决卡与已决卡共用 (已决卡也要能回看批了
 *  什么), 不按长度区分 —— 短命令多一个菜单项无害。
 *  右上「⋯」→ 群里发全文 (哪端都能用); jump_list「🔍 完整命令·详情」→ 详情页
 *  (PC 端好用, 回环链接手机打不开是已知取舍)。 */
const fullCmdMenu = (a: CardArgs): TemplateCard["action_menu"] | undefined =>
  commandOf(a.toolName, a.toolInput)
    ? { desc: "更多", action_list: [{ text: "📄 展开完整命令", key: encodeFullCmdKey(a.reqId) }] }
    : undefined;

const buildCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const jl = detailJumpList(a.detailUrl);
  const menu = fullCmdMenu(a);
  return {
    card_type: "button_interaction",
    source: buildSource(a.danger, a.sessionName),
    main_title: { title: TRUNC(cardTitle(a, r), 26) },
    ...bodyBlocks(a, r),
    ...(menu ? { action_menu: menu } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: approveButtons(a),
  };
};

const fmtWindow = (min: number): string =>
  min % 60 === 0 ? `${min / 60}h` : `${min}min`;

// 按钮上的时间窗文案: 裸「10h」看不出是放行, 补 ⏱ + 「自动过」点明语义。
// (style 跟 ❌/✅总是/✅ 一律 4 —— 3 渲染成红色, 1 渲染成蓝色, 都让这颗按钮
//  在一排里显得像另一类操作; 它和其余三颗是同级选项, 不该被强调。)
const windowLabel = (min: number): string => `⏱${fmtWindow(min)}自动过`;

const verbOf = (d: Decision, windowMinutes: number): string => {
  switch (d) {
    case "deny": return "已拒绝";
    case "allow_window": return `${fmtWindow(windowMinutes)}会话内全过`;
    case "allow_session": return "本会话通过";
    case "allow_always": return "已通过·规则已保存";
    default: return "已通过";
  }
};

const emojiOf = (d: Decision): string => (d === "deny" ? "❌" : "✅");

// allow_window 仍可点击以取消自动窗口；其余决策为最终态 noop。
const resolvedButton = (
  d: Decision,
  windowMinutes: number,
  reqId: string,
  chatKey: string,
): { text: string; style: number; key: string } => {
  if (d === "allow_window") {
    return {
      text: `${verbOf(d, windowMinutes)} · 点击取消`,
      style: 4,
      key: encodeCancelKey(chatKey),
    };
  }
  return {
    text: `${emojiOf(d)} ${verbOf(d, windowMinutes)}`,
    style: 4,
    key: `noop:${reqId}`,
  };
};

const buildResolvedCard = (
  a: CardArgs & { decision: Decision; by: string },
): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const jl = detailJumpList(a.detailUrl);
  // 已决卡同样保留「看全文」入口 —— 回头想确认"我刚才批的到底是什么"是常态,
  // 而 detail 记录留存 24h, 点了照样能展开。
  const menu = fullCmdMenu(a);
  return {
    card_type: "button_interaction",
    source: buildSource(a.danger, a.sessionName),
    main_title: { title: TRUNC(cardTitle(a, r), 26) },
    ...bodyBlocks(a, r),
    ...(menu ? { action_menu: menu } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [resolvedButton(a.decision, a.windowMinutes, a.reqId, a.chatKey ?? "")],
  };
};

const buildCancelledCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(a.danger, a.sessionName),
    main_title: { title: TRUNC(cardTitle(a, r), 26) },
    ...bodyBlocks(a, r),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [
      { text: "已取消自动通过", style: 4, key: `noop:cancelled:${a.reqId}` },
    ],
  };
};

// 已 resolved 的卡再次被点击 — 仅作视觉反馈, 不改变任何状态。
const buildAlreadyResolvedCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(a.danger, a.sessionName),
    main_title: { title: TRUNC(cardTitle(a, r), 26) },
    ...bodyBlocks(a, r),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [{ text: "已经放行", style: 4, key: `noop:${a.reqId}` }],
  };
};

// ── Batch coalescing ───────────────────────────────────────────────────
// 同 session 同 tool 的并发 PreToolUse 在 batchCoalesceMs 窗口内合流为
// 一张卡 — 否则用户被 N 张并发卡轰炸 (典型场景: 模型并发 3 个 Bash)。
// 单成员的批次回落到普通 buildCard, 行为与未启用聚合一致 (仅多 ms 级延迟)。
interface BatchMember {
  reqId: string;
  toolInput: unknown;
  /** Original (unredacted) tool_input from the hook body. Kept alongside
   *  `toolInput` (which may be the redacted display copy) so flushBeforeCard
   *  can sig-match against the jsonl, where the model wrote the unredacted
   *  form. Card rendering still uses `toolInput`. */
  originalToolInput: unknown;
  toolInputStr: string;
  cwd: string;
  transcriptTail: string;
}
interface ActiveBatch {
  batchId: string;
  sessionId: string;
  toolName: string;
  approver: string;
  windowMinutes: number;
  /** 危险名单规则名。危险请求永远是单成员批次 (不注册进 activeBatches,
   *  没人能 join), 只为复用 flushBatch 的发卡/失败路径。 */
  danger?: string;
  /** 必发卡批次 (同 CardArgs.forceSingle)。这种批次永远只有一位成员 —— 不注册进
   *  activeBatches, 没人能 join —— 但发的是单卡, 按钮面要跟着收。 */
  forceSingle?: boolean;
  /** 会话名 (同 CardArgs.sessionName) — 批次内成员同 session, 开批时算一次。 */
  sessionName?: string;
  /** 未命中 allowRules 的原因 (同 CardArgs.denyReason)。 */
  denyReason?: DenyReason;
  members: BatchMember[];
  flushTimer: NodeJS.Timeout;
  flushed: boolean;
}
const activeBatches = new Map<string, ActiveBatch>(); // 仅 collecting 期; flush 后摘除
const batchById = new Map<string, ActiveBatch>();      // 长留, 供 click event 解析
const BATCH_BY_ID_TTL_MS = 30 * 60_000;
const BATCH_BY_ID_MAX = 200;
const evictBatches = (): void => {
  if (batchById.size <= BATCH_BY_ID_MAX) return;
  const cutoff = Date.now() - BATCH_BY_ID_TTL_MS;
  for (const [k, v] of batchById) {
    // members[0].reqId 总在 createPending 之后立刻入批, 用首个 reqId 的
    // pending meta.createdAt 也行; 这里近似用 batchId 后 8 位的时间戳。
    const ts = parseInt(v.batchId.slice(1, 1 + 8), 36);
    if (Number.isFinite(ts) && ts < cutoff) batchById.delete(k);
  }
};
const newBatchId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const batchKeyOf = (sessionId: string, toolName: string): string => `${sessionId}|${toolName}`;

// 单条成员渲染: 展开第 N 项的输入摘要, 单行化以适配批量列表的紧凑布局。
const PER_MEMBER_MAX = 120;
const BATCH_MAX_VISIBLE = 8;
const renderBatchBody = (batch: ActiveBatch): string => {
  const visible = batch.members.slice(0, BATCH_MAX_VISIBLE);
  const lines = visible.map((m, idx) => {
    const r = renderInput(batch.toolName, m.toolInput, m.toolInputStr, m.cwd);
    const flat = r.body ? oneLine(r.body) : "(no input)";
    return `${idx + 1}. ${TRUNC(flat, PER_MEMBER_MAX)}`;
  });
  const overflow = batch.members.length - visible.length;
  if (overflow > 0) lines.push(`…还有 ${overflow} 项`);
  return TRUNC(lines.join("\n"), QUOTE_MAX);
};

// 批量卡的标题/中段与单卡同构 (会话名 + 工具×N / 成员列表进引用区)。
const batchTitle = (batch: ActiveBatch): string =>
  `${batch.sessionName || batch.sessionId.slice(-8)} · ${shortTool(batch.toolName)} ×${batch.members.length}`;
const batchBlocks = (batch: ActiveBatch, transcriptTail: string): Partial<TemplateCard> => {
  const rows: Array<{ keyname: string; value: string }> = [];
  const tail = oneLine(transcriptTail).trim();
  if (tail) rows.push({ keyname: "上文", value: TRUNC(tail, HMETA_VAL_MAX) });
  if (batch.danger) rows.push({ keyname: "危险", value: TRUNC(`命中「${batch.danger}」`, HMETA_VAL_MAX) });
  return {
    quote_area: quoteArea(renderBatchBody(batch)),
    ...(rows.length > 0 ? { horizontal_content_list: rows as TemplateCard["horizontal_content_list"] } : {}),
  };
};

const buildBatchCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => ({
  card_type: "button_interaction",
  source: buildSource(batch.danger, batch.sessionName),
  main_title: { title: batchTitle(batch) },
  ...batchBlocks(batch, transcriptTail),
  task_id: batch.batchId,
  button_list: [
    { text: "❌", style: 4, key: encodeBatchKey(batch.batchId, "deny") },
    { text: windowLabel(batch.windowMinutes), style: 4, key: encodeBatchKey(batch.batchId, "allow_window") },
    // 批量卡同样给「总是」: 合流的成员是同一个工具的 N 次调用, 逐个点「总是」与
    // 点一次的结果相同(每位成员各自走一遍规则生成, 已被现有规则覆盖的不重复加)。
    { text: "✅总是", style: 4, key: encodeBatchKey(batch.batchId, "allow_always") },
    { text: `✅ ×${batch.members.length}`, style: 4, key: encodeBatchKey(batch.batchId, "allow") },
  ],
});

const buildBatchResolvedCard = (
  batch: ActiveBatch,
  decision: Decision,
  transcriptTail: string,
): TemplateCard => {
  const button = decision === "allow_window"
    ? {
        text: `${verbOf(decision, batch.windowMinutes)} · 点击取消`,
        style: 4,
        key: encodeCancelKey(batch.approver),
      }
    : {
        text: `${emojiOf(decision)} ${verbOf(decision, batch.windowMinutes)} ×${batch.members.length}`,
        style: 4,
        key: encodeBatchNoopKey(batch.batchId),
      };
  return {
    card_type: "button_interaction",
    source: buildSource(batch.danger, batch.sessionName),
    main_title: { title: batchTitle(batch) },
    ...batchBlocks(batch, transcriptTail),
    task_id: batch.batchId,
    button_list: [button],
  };
};

const buildBatchAlreadyResolvedCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => ({
  card_type: "button_interaction",
  source: buildSource(batch.danger, batch.sessionName),
  main_title: { title: batchTitle(batch) },
  ...batchBlocks(batch, transcriptTail),
  task_id: batch.batchId,
  button_list: [{ text: "已经放行", style: 4, key: encodeBatchNoopKey(batch.batchId) }],
});

const encodeKey = (reqId: string, decision: Decision): string => `${reqId}|${decision}`;
const NOOP_PREFIX = "noop:";
const CANCEL_PREFIX = "cancel_window:";
const BATCH_PREFIX = "B|";
const BATCH_NOOP_PREFIX = "B-noop:";
const encodeCancelKey = (chatKey: string): string => `${CANCEL_PREFIX}${chatKey}`;
const encodeBatchKey = (batchId: string, decision: Decision): string =>
  `${BATCH_PREFIX}${batchId}|${decision}`;
const encodeBatchNoopKey = (batchId: string): string => `${BATCH_NOOP_PREFIX}${batchId}`;
const decodeBatchKey = (key: string): { batchId: string; decision: Decision } | undefined => {
  if (!key.startsWith(BATCH_PREFIX)) return undefined;
  const [batchId, d] = key.slice(BATCH_PREFIX.length).split("|");
  if (!batchId || !d) return undefined;
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "allow_always" && d !== "deny") return undefined;
  return { batchId, decision: d };
};
const decodeBatchNoopKey = (key: string): string | undefined =>
  key.startsWith(BATCH_NOOP_PREFIX) ? key.slice(BATCH_NOOP_PREFIX.length) : undefined;
const decodeKey = (
  key: string,
): { reqId?: string; decision?: Decision; cancelChatKey?: string; noopReqId?: string } => {
  if (key.startsWith(NOOP_PREFIX)) {
    // noop:cancelled:<id> 也走这里，noopReqId 取剩余部分作为 task_id 兜底。
    return { noopReqId: key.slice(NOOP_PREFIX.length) };
  }
  if (key.startsWith(CANCEL_PREFIX)) {
    return { cancelChatKey: key.slice(CANCEL_PREFIX.length) };
  }
  const [reqId, d] = key.split("|");
  if (!reqId || !d) return {};
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "allow_always" && d !== "deny") return {};
  return { reqId, decision: d };
};

// ── AskUserQuestion 投票卡分支 ─────────────────────────────────────────
// PreToolUse 协议端只能输出 allow/deny/ask, 没有「合成 tool_result」通道。
// 取舍: 用户在 WeCom 选了选项 → 走 deny + 把答案塞进 reason, model 把 reason
// 当作上下文继续推理(CLI 不会弹原生 picker, 流程不被打断);
// 选「🖥️ CLI 处理」哨兵选项 → 返回 ask, CLI 弹原生 picker 由用户本地作答。两路互斥。
// vote_interaction 不支持 button_list (SDK 类型注释明写「button_interaction 类型卡片使用」),
// 微信侧静默吞掉, 所以 cli 入口只能塞进 checkbox option_list 作为哨兵 id。
const ASKQ_PREFIX = "ASKQ|";
const ASKQ_PICKED_PREFIX = "picked:";
const ASKQ_CLI_OPTION_ID = "__cli__";
const ASKQ_CHAT_OPTION_ID = "__chat__";
const ASKQ_NOOP_PREFIX = "askq_noop:";
type AskqAction = "submit";
const encodeAskqKey = (reqId: string): string => `${ASKQ_PREFIX}${reqId}|submit`;
const encodeAskqNoopKey = (reqId: string): string => `${ASKQ_NOOP_PREFIX}${reqId}`;
const decodeAskqKey = (
  key: string,
): { reqId: string; action: AskqAction } | undefined => {
  if (!key.startsWith(ASKQ_PREFIX)) return undefined;
  const [reqId, action] = key.slice(ASKQ_PREFIX.length).split("|");
  if (!reqId || action !== "submit") return undefined;
  return { reqId, action };
};
const decodeAskqNoopKey = (key: string): string | undefined =>
  key.startsWith(ASKQ_NOOP_PREFIX) ? key.slice(ASKQ_NOOP_PREFIX.length) : undefined;

export interface AskqOption { label: string; description?: string }
export interface AskqQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskqOption[];
}

export const parseAskqInput = (i: unknown): AskqQuestion[] | undefined => {
  if (!i || typeof i !== "object") return undefined;
  const qs = (i as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return undefined;
  return qs.map((q): AskqQuestion => {
    const qq = (q ?? {}) as Record<string, unknown>;
    const opts = Array.isArray(qq.options) ? qq.options : [];
    return {
      question: typeof qq.question === "string" ? qq.question : "",
      header: typeof qq.header === "string" ? qq.header : "",
      multiSelect: Boolean(qq.multiSelect),
      options: opts.flatMap((o): AskqOption[] => {
        const oo = (o ?? {}) as Record<string, unknown>;
        return typeof oo.label === "string"
          ? [{
              label: oo.label,
              description: typeof oo.description === "string" ? oo.description : undefined,
            }]
          : [];
      }),
    };
  });
};

const ASKQ_TITLE_MAX = 26;
const ASKQ_SUB_MAX = 480;
const ASKQ_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const askqLabel = (idx: number): string => ASKQ_LETTERS[idx] ?? String(idx + 1);

// vote_interaction 只支持 card_type/source/main_title/checkbox/submit_button/task_id,
// sub_title_text/quote_area 等会被静默吞掉 → 题目和选项必须走前置 markdown 消息。
export const buildAskqMarkdown = (q: AskqQuestion, prefix = ""): string => {
  const title = q.question || q.header || "请选择";
  const head = `**🤔 ${prefix}${title}**`;
  const opts = q.options.map((o, idx) => {
    const desc = o.description ? ` — ${o.description}` : "";
    return `**${askqLabel(idx)}.** ${o.label}${desc}`;
  });
  return [head, "", ...opts].join("\n");
};

export const buildAskqCard = (reqId: string, q: AskqQuestion, transcriptTail: string, approver?: string): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "vote_interaction",
    source: buildSource(undefined, tail),
    main_title: { title: TRUNC(`🤔 ${emojiFor(approver)}${q.header || "请选择"}`, ASKQ_TITLE_MAX) },
    task_id: reqId,
    checkbox: {
      question_key: "q",
      mode: q.multiSelect ? 1 : 0,
      // 完整文案在前置 markdown 消息里以 ABCD 编号呈现,这里只显示编号,
      // 避免长 label 被卡片选项栏截断成无意义前缀。
      option_list: [
        ...q.options.map((_, idx) => ({
          id: String(idx),
          text: askqLabel(idx),
        })),
        { id: ASKQ_CHAT_OPTION_ID, text: "💬 聊聊这个" },
        { id: ASKQ_CLI_OPTION_ID, text: "🖥️ 去 CLI 中处理" },
      ],
    },
    submit_button: { text: "提交", key: encodeAskqKey(reqId) },
  } as TemplateCard;
};

type AskqOutcome = { kind: "picked"; picked: number[] } | { kind: "cli" } | { kind: "chat" } | { kind: "empty" };

// 投票卡 submit 后那张卡再被点 (askq_noop:<id>) → 终态 identity, 直接 return,
// 不再 stash 任何 outcome / question 副本。
const buildAskqResolvedCard = (
  reqId: string,
  q: AskqQuestion,
  outcome: AskqOutcome,
  transcriptTail: string,
  approver?: string,
): TemplateCard => {
  const summary = outcome.kind === "cli"
    ? "🖥️ 已转 CLI 中处理"
    : outcome.kind === "chat"
      ? "💬 就此展开讨论"
      : outcome.kind === "empty"
        ? "⚠️ 未选择"
        : `✅ ${outcome.picked.map((i) => q.options[i]?.label ?? `#${i}`).join(", ")}`;
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(undefined, tail),
    main_title: { title: TRUNC(`🤔 ${emojiFor(approver)}${q.header || "已回答"}`, ASKQ_TITLE_MAX) },
    sub_title_text: TRUNC(q.question, ASKQ_SUB_MAX),
    task_id: reqId,
    button_list: [{ text: TRUNC(summary, 30), style: 4, key: encodeAskqNoopKey(reqId) }],
  };
};

// ── ExitPlanMode 计划审批卡分支 ────────────────────────────────────────
// plan mode 的 ExitPlanMode 是个交互模态(同意/继续改),TUI 里弹 1/2/3 picker,
// 不写 jsonl → mirror 看不到。这里拦下来推一张 button_interaction 卡:
//   ✅ 同意   → allow  (跳过本地 picker, 退出 plan mode 开始执行)
//   ✏️ 继续改 → deny + reason (reason 回传 model, 留在 plan mode 据此调整)
// plan 正文可能很长, vote 卡/按钮卡正文字段都吃不下 → 走前置 markdown 消息。
const PLAN_PREFIX = "PLAN|";
const PLAN_NOOP_PREFIX = "plan_noop:";
type PlanAction = "approve" | "revise";
const encodePlanKey = (reqId: string, action: PlanAction): string => `${PLAN_PREFIX}${reqId}|${action}`;
const encodePlanNoopKey = (reqId: string): string => `${PLAN_NOOP_PREFIX}${reqId}`;
const decodePlanKey = (key: string): { reqId: string; action: PlanAction } | undefined => {
  if (!key.startsWith(PLAN_PREFIX)) return undefined;
  const [reqId, action] = key.slice(PLAN_PREFIX.length).split("|");
  if (!reqId || (action !== "approve" && action !== "revise")) return undefined;
  return { reqId, action };
};
const decodePlanNoopKey = (key: string): string | undefined =>
  key.startsWith(PLAN_NOOP_PREFIX) ? key.slice(PLAN_NOOP_PREFIX.length) : undefined;

const PLAN_PICKED_PREFIX = "plan:";
const PLAN_REVISE_REASON = "用户希望继续完善计划,请询问还需要调整哪些地方,不要直接开始执行。";

const parsePlanInput = (i: unknown): string => {
  if (!i || typeof i !== "object") return "";
  const p = (i as { plan?: unknown }).plan;
  return typeof p === "string" ? p : "";
};

// CodeBuddy 的 ExitPlanMode 不带 plan 正文 (arguments=="{}"); plan 写在
// ~/.codebuddy/plans/<slug>.md (plan mode 系统消息指定, 模型用 Write/Edit 逐步
// 成型)。从 transcript 尾部倒查最后一次指向 plans 目录的 file_path, 再读文件
// 取最新内容。arguments 是转义后的内嵌 JSON 串 (\"file_path\":\"...\") 且嵌着
// 整份 plan (单行可能数百 KB), 用正则抠路径 (\\? 兼容转义/未转义), 不做 parse。
const PLAN_PATH_RE = /\\?"file_path\\?"\s*:\s*\\?"([^"\\]*\/\.codebuddy\/plans\/[^"\\]+\.md)\\?"/;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const PLAN_FILE_CAP = 64 * 1024;

const tailText = (p: string, bytes: number): string => {
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const planPathFromTranscript = (transcriptPath: string): string | undefined => {
  const lines = tailText(transcriptPath, TRANSCRIPT_TAIL_BYTES).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PLAN_PATH_RE.exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
};

// tool_input.plan (Claude) → transcript 定位 plans 文件 (CodeBuddy) → ""。
const resolvePlanText = (toolInput: unknown, transcriptPath?: string): string => {
  const direct = parsePlanInput(toolInput);
  if (direct) return direct;
  if (!transcriptPath) return "";
  try {
    const p = planPathFromTranscript(transcriptPath);
    if (!p) return "";
    return readFileSync(p, "utf8").slice(0, PLAN_FILE_CAP);
  } catch {
    return "";
  }
};

const PLAN_TITLE_MAX = 26;
const PLAN_PREVIEW_LINES = 25;
const PLAN_PREVIEW_CHARS = 1500;
// plan 正文走前置 markdown(卡片正文字段塞不下长 plan)。截断保留前若干行。
const buildPlanMarkdown = (plan: string): string => {
  const lines = plan.split("\n");
  const clipped = lines.slice(0, PLAN_PREVIEW_LINES).join("\n");
  let body = TRUNC(clipped, PLAN_PREVIEW_CHARS);
  if (lines.length > PLAN_PREVIEW_LINES || plan.length > PLAN_PREVIEW_CHARS) {
    body += "\n\n_…计划较长,完整内容见 CLI。_";
  }
  return `**📋 计划待审批**\n\n${body}`;
};

const buildPlanCard = (reqId: string, _sessionId: string, cwd: string, transcriptTail: string, approver: string, hasPlan: boolean): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  const tag = emojiFor(approver);
  const dir = dirName(cwd);
  return {
    card_type: "button_interaction",
    source: buildSource(undefined, tail),
    main_title: { title: TRUNC(`📋 计划审批 · ${tag}${dir}/`, PLAN_TITLE_MAX + 12) },
    sub_title_text: hasPlan
      ? "审阅上方计划后选择:同意开始执行,或让 Claude 继续完善。"
      : "完整计划见 CLI。选择:同意开始执行,或继续完善。",
    task_id: reqId,
    button_list: [
      { text: "✏️ 继续改", style: 4, key: encodePlanKey(reqId, "revise") },
      { text: "✅ 同意", style: 3, key: encodePlanKey(reqId, "approve") },
    ],
  } as TemplateCard;
};

const buildPlanResolvedCard = (
  reqId: string,
  action: PlanAction,
  cwd: string,
  transcriptTail: string,
  approver?: string,
): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  const dir = dirName(cwd);
  const summary = action === "approve" ? "✅ 已同意 · 开始执行" : "✏️ 继续完善计划";
  return {
    card_type: "button_interaction",
    source: buildSource(undefined, tail),
    main_title: { title: TRUNC(`📋 计划 · ${emojiFor(approver)}${dir}/`, PLAN_TITLE_MAX + 12) },
    task_id: reqId,
    button_list: [{ text: summary, style: 4, key: encodePlanNoopKey(reqId) }],
  };
};

interface PlanHandleArgs {
  cfg: Config;
  log: Logger;
  client: WSClient;
  body: ApproveReq;
  getMirrorTarget?: (sessionId: string) => string | undefined;
  flushBeforeCard?: (sessionId: string, expect?: { toolName: string; toolInput: unknown }) => Promise<void>;
}

const handleExitPlanMode = async ({ cfg, log, client, body, getMirrorTarget, flushBeforeCard }: PlanHandleArgs): Promise<ApproveResp> => {
  // 此分支只服务 Claude 家族 (hook 即时触发, tool_input.plan 带正文)。
  // codebuddy 的 ExitPlanMode 不过 hook → 见 runMirrorPlanFlow。
  const plan = parsePlanInput(body.tool_input);
  if (!plan) return { decision: "ask", reason: "plan_unparsable" };

  const approver = resolveApprover(cfg, body.session_id, getMirrorTarget);
  if (!approver) return { decision: "ask", reason: "no_approver" };
  if (!client.isConnected) return { decision: "ask", reason: "ws_disconnected" };

  const longPollMs = cfg.approval.longPollSec * 1000;
  const { reqId, promise } = createPending({
    meta: {
      kind: "generic",
      createdAt: Date.now(),
      toolName: "ExitPlanMode",
      toolInput: body.tool_input,
      cwd: body.cwd,
      sessionId: body.session_id,
      // kind:"generic" keeps this out of the allow_window sweep; chatKey is
      // carried purely so the click listener can re-render the resolved card
      // with the same `#tag` emoji the live card showed.
      chatKey: approver,
      transcriptTail: body.transcript_tail ?? "",
    },
    timeoutMs: longPollMs,
  });

  try {
    const target = targetChatId(approver);
    // 发卡前先把 mirror 那条管道里同 turn 的"思考过程"text 推到 WeCom — 否则
    // hook 直发的卡片可能赛过 mirror 的 250ms/3s 防抖, 用户看到先卡片后解释。
    try { await flushBeforeCard?.(body.session_id, { toolName: "ExitPlanMode", toolInput: body.tool_input }); } catch (e) {
      log.warn({ err: (e as Error).message }, "plan flushBeforeCard failed; sending card anyway");
    }
    if (plan) {
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: withTagHeader(approver, buildPlanMarkdown(plan)) },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, "plan markdown prelude send failed");
      }
    }
    await client.sendMessage(target, {
      msgtype: "template_card",
      template_card: buildPlanCard(reqId, body.session_id, body.cwd ?? "", body.transcript_tail ?? "", approver, true),
    });
    log.info({ reqId, approver }, "plan card sent");
  } catch (e) {
    log.error({ err: (e as Error).message }, "plan send failed");
    resolvePending(reqId, "deny");
    return { decision: "ask", reason: `plan_send_fail:${(e as Error).message}` };
  }

  let raw: string;
  try {
    raw = (await promise) as unknown as string;
  } catch {
    return { decision: "ask", reason: "plan_timeout" };
  }

  if (raw === `${PLAN_PICKED_PREFIX}approve`) {
    // 同意也走 deny+reason,而不是 allow:实测 allow 在非 auto-mode 会话里仍会弹
    // 本地 1/2/3 picker(plan 退出的 auto/manual 选择是 TUI 本地交互,PreToolUse
    // allow 替代不了)。deny 的 reason 直接回传 model 且不弹 picker,所以用一段
    // "已批准,去执行"的明确指令驱动 Claude 退出 plan 开始干活。
    return {
      decision: "deny",
      reason:
        "✅ 用户已在企业微信批准此计划。这不是拒绝——ExitPlanMode 返回 deny 只是 wezard 的远程批准信号。请视为计划已通过,立即开始执行计划内容,不要再次调用 ExitPlanMode,也不要重新规划。",
    };
  }
  if (raw === `${PLAN_PICKED_PREFIX}revise`) {
    return { decision: "deny", reason: PLAN_REVISE_REASON };
  }
  return { decision: "ask", reason: "plan_unknown" };
};

interface AskqHandleArgs {
  cfg: Config;
  log: Logger;
  client: WSClient;
  body: ApproveReq;
  getMirrorTarget?: (sessionId: string) => string | undefined;
  flushBeforeCard?: (sessionId: string, expect?: { toolName: string; toolInput: unknown }) => Promise<void>;
  /** Resolves when the hook's HTTP connection dies before we respond
   *  (CC 按 timeout 杀 hook / curl --max-time / CC 重启) — 发卡循环的中止信号。 */
  clientGone?: Promise<"client_gone">;
}

export type AskqAnswer =
  | { kind: "cli" }
  | { kind: "chat" }
  | { kind: "empty" }
  | { kind: "picked"; labels: string };

// raw 是 click 事件 listener 塞回 pending 的字符串编码 (cli / chat / picked:i,j)。
export const interpretAskqRaw = (raw: string, q: AskqQuestion): AskqAnswer => {
  if (raw === "cli") return { kind: "cli" };
  if (raw === "chat") return { kind: "chat" };
  if (raw.startsWith(ASKQ_PICKED_PREFIX)) {
    const idxs = raw.slice(ASKQ_PICKED_PREFIX.length)
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    if (idxs.length === 0) return { kind: "empty" };
    return { kind: "picked", labels: idxs.map((i) => q.options[i]!.label).join(", ") };
  }
  return { kind: "empty" };
};

// ── mirror 驱动 vote 卡 (codebuddy 无即时 hook) 的 hook↔mirror 协调槽 ──────
// codebuddy 对 AskUserQuestion 不在提问时触发 PreToolUse — 先弹本地面板, hook
// 只在面板被提交后才到达 (实测可延迟数小时)。mirror 从 jsonl 提前看到
// function_call 直接发卡; 用户点选后答案记进本槽, mirror 注入一段触发文本提交
// 本地面板; hook 随后到达时: 有 reason → deny 覆盖(与 claude 路径同产物), 无记录
// → allow 让本地答案生效并作废挂着的 vote 卡 (resolvePending "moot")。
// TTL 兜底: 注入失败/hook 不至时槽位不永久阻塞同 session 的下一次提问。
interface MirrorAskqSlot { reqId?: string; reason?: string; at: number }
const mirrorAskqSlots = new Map<string, MirrorAskqSlot>();
const MIRROR_ASKQ_SLOT_TTL_MS = 30 * 60_000;
const freshSlot = (sessionId: string): MirrorAskqSlot | undefined => {
  const s = mirrorAskqSlots.get(sessionId);
  if (!s) return undefined;
  if (Date.now() - s.at > MIRROR_ASKQ_SLOT_TTL_MS) {
    mirrorAskqSlots.delete(sessionId);
    return undefined;
  }
  return s;
};
export const hasMirrorAskq = (sessionId: string): boolean => freshSlot(sessionId) !== undefined;

// ── 面板按键驱动 (codebuddy 本地面板的确定性提交协议) ──────────────────────
// 逆向自 codebuddy TUI 的 AskUserQuestion 组件: 每题光标初始 0 (第一个选项),
// ↑↓/j/k 移动; 单选选项上 Enter = 提交该选项 label 并自动前进下一题; 多选
// Enter = 切换选中, 须把光标落到 N+1 行 (「下一题」行) 按 Enter 才前进; 自定义
// 文本在第 N 行。全部题答完进提交页 (光标 0 = "1. Submit answers"), Enter 收工。
// 序列开头 Up 连发把光标钳到 0, 吸收用户误触造成的漂移。
// confirm_submit: 只用于「聊聊这个」收尾 —— 不盲发 Enter, 而是让 mirror 侧读屏
// (capture-pane) 确认面板真的推进到 "Submit answers" 页、按 Enter、再确认面板关闭。
// 盲发时代 (两个固定 Enter) 在光标漂移 / 文本没落下时提交不了, CLI 死等输入。
export type AskqDriveAction =
  | { kind: "keys"; keys: string[] }
  | { kind: "text"; text: string }
  | { kind: "confirm_submit" };

export const buildAskqDriveActions = (questions: AskqQuestion[], picks: number[][]): AskqDriveAction[] => {
  const maxOpts = questions.reduce((m, q) => Math.max(m, q.options.length), 0);
  const acts: AskqDriveAction[] = [{ kind: "keys", keys: Array<string>(maxOpts + 3).fill("Up") }];
  questions.forEach((q, i) => {
    const N = q.options.length;
    const picked = (picks[i] ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < N).sort((a, b) => a - b);
    if (!q.multiSelect) {
      const n = picked[0] ?? 0;
      acts.push({ kind: "keys", keys: [...Array<string>(n).fill("Down"), "Enter"] });
      return;
    }
    const keys: string[] = [];
    let cur = 0;
    for (const n of picked) {
      keys.push(...Array<string>(n - cur).fill("Down"), "Enter");
      cur = n;
    }
    // 多选的前进行在第 N+1 位 (0..N-1 选项, N 自定义行, N+1 下一题行)。
    keys.push(...Array<string>(N + 1 - cur).fill("Down"), "Enter");
    acts.push({ kind: "keys", keys });
  });
  // 提交页光标初始 0 = "1. Submit answers"。
  acts.push({ kind: "keys", keys: ["Enter"] });
  return acts;
};

// 「聊聊这个」: 光标钳 0 后落到第 N 行 (自定义文本行), 贴入引导语 — 自由文本
// 答案本身即语义完整 (hook 若触发, deny+reason 会再覆盖成同款文案)。
// text 动作里 inject 负责 paste + 首个 Enter (确认自定义文本为本题答案、前进到
// 提交页)。收尾不再盲发第二个 Enter —— codebuddy CLI 里自定义行必须有实际输入
// 才能确认, 且要真正落到 "Submit answers" 页再 Enter 才结束; 盲发在光标漂移 /
// 文本没落下时提交不了, CLI 死等输入 (talk-about-this 卡死根因)。改由 confirm_submit
// 让 mirror 侧读屏确认已到提交页 → Enter → 确认面板关闭, 失败重试。
export const buildAskqChatDriveActions = (q: AskqQuestion): AskqDriveAction[] => [
  { kind: "keys", keys: [...Array<string>(q.options.length + 3).fill("Up"), ...Array<string>(q.options.length).fill("Down")] },
  { kind: "text", text: "先不回答，我想和你讨论一下这个问题" },
  { kind: "confirm_submit" },
];

// 多问题: 逐题顺序发卡 → 收答 → 下一题。任一题选「CLI」整体转 CLI,选「聊聊」
// 整体转讨论; 全部答完合并成单个 deny+reason 注入。卡不会一次性轰炸 N 张。
interface MirrorAskqFlowArgs {
  log: Logger;
  client: WSClient;
  sessionId: string;
  /** mirror 附件的 target (可带 #tag) — 卡片/前奏都发到这一聊天。 */
  chatKey: string;
  toolInput: unknown;
  voteTimeoutMs: number;
  /** 按 buildAskqDriveActions 的序列驱动本地面板 (send-keys / 贴文本)。 */
  drive: (acts: AskqDriveAction[]) => Promise<{ ok: boolean; reason?: string }>;
}

export const runMirrorAskqFlow = async ({ log, client, sessionId, chatKey, toolInput, voteTimeoutMs, drive }: MirrorAskqFlowArgs): Promise<void> => {
  const questions = parseAskqInput(toolInput);
  if (!questions || questions.length === 0) return;
  if (questions.some((q) => q.options.length === 0)) return;
  if (!client.isConnected) return;

  const target = targetChatId(chatKey);
  const total = questions.length;
  const answers: string[] = [];
  const picks: number[][] = [];
  const flowStart = Date.now();
  const note = async (content: string): Promise<void> => {
    try {
      await client.sendMessage(target, { msgtype: "markdown", markdown: { content: withTagHeader(chatKey, content) } });
    } catch { /* best-effort */ }
  };

  for (let i = 0; i < total; i++) {
    const q = questions[i]!;
    // 剩余预算: N 题共享一份 voteTimeoutSec, 语义同 hook 流的 longPollSec 分摊。
    const remainMs = voteTimeoutMs - (Date.now() - flowStart);
    if (remainMs < 10_000) {
      mirrorAskqSlots.delete(sessionId);
      await note("⌛ 问题卡已超时，请在 CLI 中作答。");
      return;
    }
    // meta 形状与 hook 流一致: click listener 用 toolInput(单题 wrapper)/chatKey
    // 渲染 resolved 卡, 监听侧零改动。
    const { reqId, promise } = createPending({
      meta: {
        kind: "generic",
        createdAt: Date.now(),
        toolName: "AskUserQuestion",
        toolInput: { questions: [q] },
        sessionId,
        chatKey,
        transcriptTail: "",
      },
      timeoutMs: remainMs,
    });
    mirrorAskqSlots.set(sessionId, { reqId, at: Date.now() });

    const prefix = total > 1 ? `(${i + 1}/${total}) ` : "";
    try {
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: withTagHeader(chatKey, buildAskqMarkdown(q, prefix)) },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, "mirror askq markdown prelude send failed");
      }
      await client.sendMessage(target, {
        msgtype: "template_card",
        template_card: buildAskqCard(reqId, q, "", chatKey),
      });
      log.info({ reqId, chatKey, idx: i, total }, "mirror askq card sent");
    } catch (e) {
      log.error({ err: (e as Error).message }, "mirror askq send failed");
      resolvePending(reqId, "deny"); // 释放 pending 槽
      mirrorAskqSlots.delete(sessionId);
      return;
    }

    let raw: string;
    try {
      raw = (await promise) as unknown as string;
    } catch {
      mirrorAskqSlots.delete(sessionId);
      await note("⌛ 问题卡已超时，请在 CLI 中作答。");
      return;
    }
    // 本地先答, hook 侧作废了这张卡 — 中止整流, 不驱动不覆盖。
    if (raw === "moot") {
      log.info({ reqId, sessionId }, "mirror askq mooted by local answer");
      mirrorAskqSlots.delete(sessionId);
      return;
    }

    const ans = interpretAskqRaw(raw, q);
    // 「去 CLI 处理」/ 空选 → 交还本地面板, 之后 hook 到达走 allow 分支。
    if (ans.kind === "cli" || ans.kind === "empty") {
      mirrorAskqSlots.delete(sessionId);
      return;
    }
    if (ans.kind === "chat") {
      mirrorAskqSlots.set(sessionId, {
        reason: `Instead of answering "${q.header || q.question}", the user wants to chat about it first. Discuss the question with them before re-asking.`,
        at: Date.now(),
      });
      const r = await drive(buildAskqChatDriveActions(q));
      if (!r.ok) {
        log.warn({ sessionId, reason: r.reason }, "mirror askq chat drive failed");
        await note("⚠️ 已记录，但驱动 CLI 面板失败，请回到 CLI 手动处理。");
      } else {
        mirrorAskqSlots.delete(sessionId);
      }
      return;
    }
    answers.push(`"${q.header || q.question}": ${ans.labels}`);
    // 按键驱动要的是选项下标, raw 编码 picked:i,j 里直接取 (与 interpret 同源)。
    picks.push(
      raw.slice(ASKQ_PICKED_PREFIX.length)
        .split(",")
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length),
    );
  }

  const reason = total === 1
    ? `User answered ${answers[0]} via WeCom`
    : `User answered ${total} questions via WeCom — ${answers.join("; ")}`;
  mirrorAskqSlots.set(sessionId, { reason, at: Date.now() });
  // 驱动前再确认槽还是自己的: 用户若在收票期间本地答了 (hook 到达会清槽),
  // 面板已经消失, 按键会落进主输入框 (Down 翻历史 / Enter 误提交) — 必须放弃。
  if (freshSlot(sessionId)?.reason !== reason) {
    log.info({ sessionId }, "mirror askq slot lost before drive — local answer won");
    return;
  }
  const acts = buildAskqDriveActions(questions, picks);
  log.info({ sessionId, acts: acts.length, picks }, "mirror askq drive start");
  const r = await drive(acts);
  if (!r.ok) {
    // 驱动失败: 保留 reason 槽 — 用户手动提交面板时 hook 到达仍以记录答案覆盖。
    log.warn({ sessionId, reason: r.reason }, "mirror askq drive failed");
    await note("⚠️ 答案已记录，但驱动 CLI 面板失败，请回到 CLI 手动处理。");
    return;
  }
  log.info({ sessionId }, "mirror askq drive done");
  // 驱动成功 = 面板已按 WeCom 答案提交, 结果随工具自然落地。清槽放掉后续提问;
  // hook 若迟到, 无槽 → allow → 本地 (即我们驱动的) 答案原样生效, 语义一致。
  mirrorAskqSlots.delete(sessionId);
  // 回执同 hook 流: 答完后 model 进入不可见长 thinking, 先确认答案已落地。
  await note(total === 1 ? "✅ 已回传，Claude 处理中…" : `✅ ${total} 题已回传，Claude 处理中…`);
};

// ── mirror 驱动 plan 审批卡 (codebuddy 的 ExitPlanMode 完全不过 hook) ──────
// 实测 (codebuddy 日志): ExitPlanMode 由 interruption-service 本地对话框直接
// 裁决, HookExecutor 零调用 — hook 路径对它不存在。mirror 从 jsonl 提前看到
// function_call → 发计划审批卡; 点选后往活 pane send-keys 直接裁决本地对话框:
//   ✅ 同意   → Enter  (默认高亮 "1. Yes")
//   ✏️ 继续改 → Escape (选项 2 标注的快捷键)
// 本地若先答, function_call_result 落盘 → mirror 调 mootMirrorPlan 作废卡片。
// 槽位防重: jsonl 重放/tail 重连不会对同一次退出重复发卡。
interface MirrorPlanSlot { reqId?: string; at: number }
const mirrorPlanSlots = new Map<string, MirrorPlanSlot>();
const MIRROR_PLAN_SLOT_TTL_MS = 12 * 3600_000; // 与 approval.longPollSec 对齐
const freshPlanSlot = (sessionId: string): MirrorPlanSlot | undefined => {
  const s = mirrorPlanSlots.get(sessionId);
  if (!s) return undefined;
  if (Date.now() - s.at > MIRROR_PLAN_SLOT_TTL_MS) {
    mirrorPlanSlots.delete(sessionId);
    return undefined;
  }
  return s;
};
export const hasMirrorPlan = (sessionId: string): boolean => freshPlanSlot(sessionId) !== undefined;
export const mootMirrorPlan = (sessionId: string): void => {
  const s = freshPlanSlot(sessionId);
  if (!s) return;
  if (s.reqId) resolvePending(s.reqId, "moot" as never);
  mirrorPlanSlots.delete(sessionId);
};

interface MirrorPlanFlowArgs {
  log: Logger;
  client: WSClient;
  sessionId: string;
  /** mirror 附件的 target (可带 #tag) — 卡片/前奏都发到这一聊天。 */
  chatKey: string;
  cwd: string;
  /** 会话 jsonl — 从尾部倒查 ~/.codebuddy/plans/*.md 挖 plan 正文。 */
  jsonlPath: string;
  voteTimeoutMs: number;
  /** 往活 pane 裁决本地对话框: 同意=Enter / 继续改=Escape。 */
  sendKey: (key: "Enter" | "Escape") => Promise<{ ok: boolean; reason?: string }>;
}

export const runMirrorPlanFlow = async ({ log, client, sessionId, chatKey, cwd, jsonlPath, voteTimeoutMs, sendKey }: MirrorPlanFlowArgs): Promise<void> => {
  if (!client.isConnected) return;
  const target = targetChatId(chatKey);
  const note = async (content: string): Promise<void> => {
    try {
      await client.sendMessage(target, { msgtype: "markdown", markdown: { content: withTagHeader(chatKey, content) } });
    } catch { /* best-effort */ }
  };

  const plan = resolvePlanText(undefined, jsonlPath);
  if (!plan) log.warn({ sessionId }, "mirror plan: plan text not found — card without prelude");
  const { reqId, promise } = createPending({
    meta: {
      kind: "generic",
      createdAt: Date.now(),
      toolName: "ExitPlanMode",
      toolInput: {},
      cwd,
      sessionId,
      chatKey,
      transcriptTail: "",
    },
    timeoutMs: voteTimeoutMs,
  });
  mirrorPlanSlots.set(sessionId, { reqId, at: Date.now() });

  try {
    if (plan) {
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: withTagHeader(chatKey, buildPlanMarkdown(plan)) },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, "mirror plan markdown prelude send failed");
      }
    }
    await client.sendMessage(target, {
      msgtype: "template_card",
      template_card: buildPlanCard(reqId, sessionId, cwd, "", chatKey, Boolean(plan)),
    });
    log.info({ reqId, chatKey }, "mirror plan card sent");
  } catch (e) {
    log.error({ err: (e as Error).message }, "mirror plan send failed");
    resolvePending(reqId, "deny");
    mirrorPlanSlots.delete(sessionId);
    return;
  }

  let raw: string;
  try {
    raw = (await promise) as unknown as string;
  } catch {
    mirrorPlanSlots.delete(sessionId);
    await note("⌛ 计划卡已超时，请在 CLI 中处理。");
    return;
  }
  // 本地先答 (function_call_result 落盘触发的 moot)。
  if (raw === "moot") {
    log.info({ reqId, sessionId }, "mirror plan mooted by local answer");
    mirrorPlanSlots.delete(sessionId);
    return;
  }

  const approve = raw === `${PLAN_PICKED_PREFIX}approve`;
  const r = await sendKey(approve ? "Enter" : "Escape");
  mirrorPlanSlots.delete(sessionId);
  if (!r.ok) {
    log.warn({ sessionId, reason: r.reason }, "mirror plan sendKey failed");
    await note("⚠️ 已记录选择，但本地对话框按键注入失败，请回到 CLI 手动处理。");
    return;
  }
  log.info({ reqId, sessionId, approve }, "mirror plan resolved via send-keys");
  await note(approve ? "✅ 已同意，退出 plan mode 开始执行…" : "✏️ 已选择继续完善计划。");
};

// 多问题: 逐题顺序发卡 → 收答 → 下一题。任一题选「CLI」整体转 CLI,选「聊聊」
// 整体转讨论; 全部答完合并成单个 deny+reason 注入。卡不会一次性轰炸 N 张。
const handleAskUserQuestion = async ({ cfg, log, client, body, getMirrorTarget, flushBeforeCard, clientGone }: AskqHandleArgs): Promise<ApproveResp> => {
  // ── codebuddy 镜像流去重 ────────────────────────────────────────────────
  // codebuddy 的 hook 只在本地面板被提交后到达。mirror 早已发过 vote 卡:
  //   - 槽里有 reason = 面板是被我们的注入提交的 → 用记录的 reason 覆盖, 不再发卡。
  //   - 无记录 = 用户在本地答的 → allow 让本地答案生效, 并作废挂着的 vote 卡。
  const slot = freshSlot(body.session_id);
  if (slot?.reason) {
    mirrorAskqSlots.delete(body.session_id);
    log.info({ sessionId: body.session_id }, "askq hook: overriding with mirror-collected answer");
    return { decision: "deny", reason: slot.reason };
  }
  if (body.cli_backend === "codebuddy") {
    if (slot?.reqId) resolvePending(slot.reqId, "moot" as never);
    mirrorAskqSlots.delete(body.session_id);
    return { decision: "allow", reason: "codebuddy_local_panel" };
  }

  const questions = parseAskqInput(body.tool_input);
  if (!questions || questions.length === 0) return { decision: "ask", reason: "askq_unparsable" };
  if (questions.some((q) => q.options.length === 0)) return { decision: "ask", reason: "askq_no_options" };

  const approver = resolveApprover(cfg, body.session_id, getMirrorTarget);
  if (!approver) return { decision: "ask", reason: "no_approver" };
  if (!client.isConnected) return { decision: "ask", reason: "ws_disconnected" };

  const target = targetChatId(approver);
  const longPollMs = cfg.approval.longPollSec * 1000;
  const total = questions.length;
  const answers: string[] = [];
  const flowStart = Date.now();
  // hook 客户端断开后整个流程只是往死管道灌数据 — 记标志, 循环内 race、
  // 循环后回执都以它止血。正常完成时 clientGone 永不 resolve, 无副作用。
  let gone = false;
  void clientGone?.then(() => { gone = true; });

  for (let i = 0; i < total; i++) {
    const q = questions[i]!;
    // 剩余预算: N 题共享一份 longPollSec。若每题都给整份, 多题总时长上限是
    // N×longPollSec, 必然越过 hook curl 的 --max-time (longPollSec+10s),
    // 之后的答案全部写进死 socket。预算耗尽 → ask, CC 弹本地 picker 兜底。
    const remainMs = longPollMs - (Date.now() - flowStart);
    if (remainMs < 10_000) return { decision: "ask", reason: "askq_timeout" };
    // 每题独立 pending: meta.toolInput 只塞本题(包成单题 wrapper),click 事件
    // listener 里的 parseAskqInput(meta.toolInput)?.[0] 渲染的就是当前题 — 监听
    // 侧零改动。transcriptTail 一并存进 meta, resolved 卡复用同一份 source。
    const { reqId, promise } = createPending({
      meta: {
        kind: "generic",
        createdAt: Date.now(),
        toolName: "AskUserQuestion",
        toolInput: { questions: [q] },
        cwd: body.cwd,
        sessionId: body.session_id,
        chatKey: approver, // 同 plan: 只为 resolved 卡复原 `#tag` emoji, 不参与 sweep
        transcriptTail: body.transcript_tail ?? "",
      },
      timeoutMs: remainMs,
    });

    const prefix = total > 1 ? `(${i + 1}/${total}) ` : "";
    try {
      // 发卡前先把同 turn 在 mirror 那条管道里 pending 的 assistant 文本推干净 —
      // hook 直发的卡片如果赛过 mirror 的防抖, 用户会先看到卡片再看到为什么。
      try { await flushBeforeCard?.(body.session_id, { toolName: "AskUserQuestion", toolInput: body.tool_input }); } catch (e) {
        log.warn({ err: (e as Error).message }, "askq flushBeforeCard failed; sending card anyway");
      }
      // 先发 markdown 列出题目+ABCD 选项 (vote 卡不支持正文字段),
      // 失败不阻断,卡片仍按字母编号显示。
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: withTagHeader(approver, buildAskqMarkdown(q, prefix)) },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, "askq markdown prelude send failed");
      }
      await client.sendMessage(target, {
        msgtype: "template_card",
        template_card: buildAskqCard(reqId, q, body.transcript_tail ?? "", approver),
      });
      log.info({ reqId, approver, idx: i, total }, "askq card sent");
    } catch (e) {
      log.error({ err: (e as Error).message }, "askq send failed");
      resolvePending(reqId, "deny"); // 释放 pending 槽
      return { decision: "ask", reason: `askq_send_fail:${(e as Error).message}` };
    }

    let raw: string;
    try {
      const racers: Promise<string>[] = [promise as unknown as Promise<string>];
      if (clientGone) racers.push(clientGone);
      raw = await Promise.race(racers);
    } catch {
      return { decision: "ask", reason: "askq_timeout" };
    }
    if (raw === "client_gone") {
      resolvePending(reqId, "deny"); // 释放 pending 槽, 这张卡的后续点击变 no-op
      log.warn({ reqId, idx: i, total }, "askq client gone — flow aborted");
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: withTagHeader(approver, "⚠️ CLI 侧连接已断开，本轮问题卡已失效，请回到 CLI 处理。") },
        });
      } catch { /* best-effort */ }
      return { decision: "ask", reason: "askq_client_gone" };
    }

    const ans = interpretAskqRaw(raw, q);
    if (ans.kind === "cli") return { decision: "ask", reason: "askq_cli" };
    if (ans.kind === "chat") {
      return {
        decision: "deny",
        reason: `Instead of answering "${q.header || q.question}", the user wants to chat about it first. Discuss the question with them before re-asking.`,
      };
    }
    if (ans.kind === "empty") return { decision: "ask", reason: "askq_empty_pick" };
    answers.push(`"${q.header || q.question}": ${ans.labels}`);
  }

  const reason = total === 1
    ? `User answered ${answers[0]} via WeCom`
    : `User answered ${total} questions via WeCom — ${answers.join("; ")}`;
  // 答完最后一题后 model 进入不可见的长 thinking (隐藏式 thinking 不下发,
  // WeCom 端全静默,极易被当成"卡住")。推一条回执确认答案已落地。失败不阻断。
  // 客户端已断开时回执是谎言 (答案送不回去了), 跳过。
  if (!gone) {
    try {
      await client.sendMessage(target, {
        msgtype: "markdown",
        markdown: {
          content: withTagHeader(
            approver,
            total === 1 ? "✅ 已回传，Claude 处理中…" : `✅ ${total} 题已回传，Claude 处理中…`,
          ),
        },
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "askq ack send failed");
    }
  }
  return { decision: "deny", reason };
};

// ── /approve handler ───────────────────────────────────────────────────
interface ApproveReq {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  transcript_tail?: string;
  /** hook 侧探测到的 CLI 后端 (pre-tool-use.sh 经 CODEBUDDY_* env 判定)。
   *  codebuddy 的 AskUserQuestion hook 只在本地面板提交后到达 → 走去重分支。 */
  cli_backend?: string;
  /** Hook 侧原样透传。ExitPlanMode 在 codebuddy 下用它从 transcript 倒查
   *  ~/.codebuddy/plans/*.md 挖 plan 正文 (tool_input 里没有)。 */
  transcript_path?: string;
  /** Reload 续接: 上一轮长轮询被 drain 时 daemon 回传的 req_id。带着它重来 =
   *  「别再发一张卡, 把我重新挂到旧卡的那个 reqId 上」。 */
  resume_req_id?: string;
}

interface ApproveResp {
  // "retry" 只发给 hook, 不是 Claude Code 的合法 permissionDecision:
  // 语义是「daemon 正在重启, 带上 req_id 稍后重来」, hook 自己消化掉。
  decision: "allow" | "deny" | "ask" | "retry";
  reason?: string;
  req_id?: string;
}

const decisionToHook = (d: Decision): "allow" | "deny" => (d === "deny" ? "deny" : "allow");

// 必发卡的请求 (危险名单 / askRules) 永不走 fallbackOnError: "allow" — 超时/断线时
// 降级为 ask, 交回本地 CLI 由人来确认, 而不是静默放行一次 rm。只判 danger 的话,
// 用户自己配的 askRules 在 daemon 挂掉时反而失效。
//
// `.claude/**` 守卫虽然不进 mustCard, 但在**错误面**也要走同一条降级: 正常出口靠
// settleGuard 事后按框, 而这三条 (no_approver / ws_disconnected / approver_timeout)
// 要么没有 approver 可按、要么 pane 早已在等框 —— 静默 allow 就是把死锁原样放回来。
// 所以调用点传的是 `mustCard || guardActive`, 见 handler 里那三处。
const fallback = (cfg: Config, reason: string, forceSingle?: unknown): ApproveResp => ({
  decision: forceSingle && cfg.approval.fallbackOnError === "allow" ? "ask" : cfg.approval.fallbackOnError,
  reason: forceSingle ? `${reason}:force_single` : reason,
});

interface ApprovalDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  /** config.jsonc 的绝对路径 — 「✅ 总是」写回 allowRules 用。缺省时只热生效不落盘。 */
  sourcePath?: string;
  /** Mirror-only: the four pane primitives the `.claude/**` guard needs.
   *  `hasPane` decides whether the guard may promise "we'll press the confirm";
   *  `answer` presses it after approval; `cancel` + `tell` are the fallback that
   *  turns an unanswerable confirm into an explicit reason for the model.
   *  Undefined in headless mode → guard stays off (nothing to press there). */
  nativeModal?: {
    hasPane: (sessionId: string) => boolean;
    answer: (sessionId: string, opts: { waitMs: number }) => Promise<NativeModalAnswer>;
    cancel: (sessionId: string) => Promise<{ ok: boolean; reason?: string }>;
    tell: (sessionId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  };
  /** Optional: resolve a Claude sessionId to its bound WeCom mirror target (e.g. "chat:xxx").
   *  When set and the request's session has a mirror, the approval card is routed there
   *  instead of cfg.approval.approvers[0] / cfg.defaultChat — keeps the conversation and
   *  its approval prompts in the same WeCom chat. */
  getMirrorTarget?: (sessionId: string) => string | undefined;
  /** Optional: drain mirror's pending text/tool markdown for this session AND wait
   *  for the per-attachment FIFO so `client.sendMessage(card)` can't overtake the
   *  "thinking" bubble. Mirror mode wires this through; headless mode leaves it
   *  undefined (no mirror pipe to drain). */
  flushBeforeCard?: (sessionId: string, expect?: { toolName: string; toolInput: unknown }) => Promise<void>;
}

const resolveApprover = (
  cfg: Config,
  sessionId: string,
  getMirrorTarget?: (sid: string) => string | undefined,
): string | undefined => {
  const mirror = sessionId ? getMirrorTarget?.(sessionId) : undefined;
  return mirror || pickApprover(cfg);
};

export const makeApproveHandler = ({ cfg, log, client, sourcePath, getMirrorTarget, flushBeforeCard, nativeModal }: ApprovalDeps): Handler => {
  setCardQuoteMax(cfg.approval.cardQuoteMaxChars);
  const detailUrlFor = (id: string, approver?: string): string =>
    buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id, approver ? targetChatId(approver) : undefined);

  // 手机端卡片 quote 区实测只渲染前 2~3 行 —— 长命令在卡上看不全。默认解法已经
  // 挪到卡片自身 (引用区可点进详情页 + 右上角「📄 展开完整命令」按需发全文), 所以
  // fullCommandPreludeChars 默认为 0 = 不自动前置。留着这条路是给两种情况兜底:
  // 客户端不渲染 action_menu, 或者就是想让全文无条件出现在群里 (设成正数即可)。
  // 用 display(已脱敏)副本, token 类不外泄。仅单成员卡触发 (批量卡逐成员推会刷屏)。
  const PRELUDE_TRIGGER_CHARS = 200;
  const sendCommandPrelude = async (batch: ActiveBatch): Promise<void> => {
    const cap = cfg.approval.fullCommandPreludeChars;
    if (cap <= 0 || batch.members.length !== 1) return;
    const cmd = commandOf(batch.toolName, batch.members[0]!.toolInput);
    if (cmd.length <= PRELUDE_TRIGGER_CHARS) return;
    const text = cmd.length > cap ? `${cmd.slice(0, cap)}\n…（已截断，完整命令共 ${cmd.length} 字）` : cmd;
    const chunks = chunkText(text, FULLCMD_CHUNK_CHARS);
    const target = targetChatId(batch.approver);
    for (let i = 0; i < chunks.length; i++) {
      const head = i === 0
        ? `🔐 待审批完整命令（${cmd.length} 字${chunks.length > 1 ? `，${i + 1}/${chunks.length}` : ""}）：\n`
        : `（${i + 1}/${chunks.length}）\n`;
      await client.sendMessage(target, {
        msgtype: "markdown",
        markdown: { content: withTagHeader(batch.approver, head + chunks[i]!) },
      });
    }
  };

  // 「总是」的回执/说明走独立 markdown 消息: 卡片本身已被 updateTemplateCard 收成
  // 终态, 没有位置再讲"为什么这条规则没存下来"。
  const notify = async (approver: string, content: string): Promise<void> => {
    try {
      // withTagHeader: 同一 chat 可能并行跑着多个 `#tag` 会话, 裸消息看不出归属。
      await client.sendMessage(targetChatId(approver), { msgtype: "markdown", markdown: { content: withTagHeader(approver, content) } });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "notify send failed");
    }
  };

  // 批准一次 `.claude/**` 写操作之后的收尾: 把 CC 那个不过 hook 的原生确认框按掉。
  //
  // 必须在 json(res) **之后**跑 —— CC 只有等 hook 进程退出才会继续走它自己的守卫、
  // 才会把框渲染出来。所以这里是 fire-and-forget, 由 answer() 内部轮询等框出现。
  //
  // 按不掉时不干等: Esc 取消掉这次调用, 再把原因作为一条用户消息注入 pane。模型
  // 收到的就是明确的"这条路走不通 + 该怎么绕", 而不是静默卡住 —— 等价于预拦截
  // deny + reason, 只是走镜像通道传达。
  const settleOne = async (
    sessionId: string,
    approver: string,
    hit: ClaudeConfigHit,
  ): Promise<void> => {
    const nm = nativeModal;
    if (!nm) return;
    const r = await nm.answer(sessionId, { waitMs: cfg.approval.claudeConfigModalWaitMs });
    if (r.status === "answered") {
      log.info({ sessionId, path: hit.path, pressed: `${r.index}. ${r.label}` }, "claude-config modal answered");
      await notify(approver, `🔓 已代按 CLI 原生确认框「${r.title ?? "确认"}」→ 选项 ${r.index}. ${r.label}（${hit.path}）`);
      return;
    }
    if (r.status === "no_modal") {
      log.info({ sessionId, path: hit.path }, "claude-config modal never appeared (nothing to press)");
      return;
    }
    // unparsable / still_modal / no_pane —— 走取消 + 告知。
    log.warn({ sessionId, path: hit.path, status: r.status }, "claude-config modal not answered, cancelling");
    const cancelled = await nm.cancel(sessionId);
    // Esc 之后 TUI 要一拍才回到输入框; 注入本身还有 modal 守卫兜底(框没退就拒绝注入)。
    if (cancelled.ok) await new Promise((res) => setTimeout(res, 800));
    const why = `⚠️ 刚才那步（写 \`${hit.path}\`）被 wezard 取消了：`
      + `改动 \`.claude/**\` 会让 Claude Code 弹它自己的原生确认框，那个框不经过 PreToolUse hook、`
      + `企微端点不到，我这次也没能安全代按（${r.status}）。`
      + `请改用实体真实路径（例如把 skill 实体放在别处再软链回 \`.claude/skills/\`），`
      + `或让我在你本地终端旁边时再做这一步。`;
    const told = cancelled.ok ? await nm.tell(sessionId, why) : { ok: false, reason: cancelled.reason };
    await notify(
      approver,
      `⚠️ 原生确认框未能代按（${r.status}）。已${cancelled.ok ? "" : "尝试"}发 Esc 取消本次调用`
        + `${told.ok ? "，并把原因告知了会话" : `（原因注入失败：${told.reason ?? "unknown"}，请到 tmux 里看一眼）`}。`,
    );
  };

  // 同一 pane 上的收尾必须串行。守卫退出 mustCard 之后, 一轮里 N 个 `.claude/**` 写
  // 会一起走窗口/缓存/规则的快路径、同刻返回 —— 以前每张卡等人点, 天然串成一列。
  // 并发进 answer() 的话两个协程会看见同一个框都按下去, 第二下落到下一个框或输入框上。
  // 按 sessionId 串一条 promise 链: 每次收尾等前一次跑完, 失败也不断链。
  const settleChains = new Map<string, Promise<void>>();
  const settleClaudeConfigModal = (sessionId: string, approver: string, hit: ClaudeConfigHit): Promise<void> => {
    const next = (settleChains.get(sessionId) ?? Promise.resolve())
      .then(() => settleOne(sessionId, approver, hit));
    // 链尾自清: 只有还是自己时才删, 避免把后来者的链一起抹掉。
    const tail = next.catch(() => {}).finally(() => {
      if (settleChains.get(sessionId) === tail) settleChains.delete(sessionId);
    });
    settleChains.set(sessionId, tail);
    return next;
  };

  // Flush 一个 batch: 单成员 → 普通卡 (与未启用聚合一致); 多成员 → 批量卡。
  // 发送失败时调用 failPending 让每位成员的 handler 走 fallbackOnError 路径,
  // 与单卡路径上 sendMessage 抛错时的语义一致。
  const flushBatch = async (batch: ActiveBatch): Promise<void> => {
    if (batch.flushed) return;
    batch.flushed = true;
    activeBatches.delete(batchKeyOf(batch.sessionId, batch.toolName));
    const isMulti = batch.members.length > 1;
    const card: TemplateCard = isMulti
      ? buildBatchCard(batch, batch.members[0]?.transcriptTail ?? "")
      : (() => {
          const m = batch.members[0]!;
          return buildCard({
            reqId: m.reqId,
            toolName: batch.toolName,
            toolInput: m.toolInput,
            toolInputStr: m.toolInputStr,
            cwd: m.cwd,
            sessionId: batch.sessionId ?? "",
            sessionShort: batch.sessionId ? batch.sessionId.slice(-8) : "?",
            // Approver target — needed for `tagOf` to decide whether to prefix
            // the emoji (only tagged sessions get it now). Also flows through
            // to the resolved card's cancel key path.
            chatKey: batch.approver,
            transcriptTail: m.transcriptTail,
            windowMinutes: batch.windowMinutes,
            danger: batch.danger,
            forceSingle: batch.forceSingle,
            sessionName: batch.sessionName,
            denyReason: batch.denyReason,
            detailUrl: detailUrlFor(m.reqId, batch.approver),
          });
        })();
    try {
      // 卡片直发会赛过 mirror 那条管道里 pending 的 assistant 文本(防抖窗内),
      // 先 await 排干 — 不然用户先看到卡片再看到为什么。批量卡按 batch 第一位
      // 成员的 sessionId 走(同 sessionId 才会被合到一起, 任取一个都对)。
      try { await flushBeforeCard?.(batch.sessionId, { toolName: batch.toolName, toolInput: batch.members[0]!.originalToolInput }); } catch (e) {
        log.warn({ batchId: batch.batchId, err: (e as Error).message }, "flushBatch flushBeforeCard failed; sending card anyway");
      }
      // 前置完整命令消息 (best-effort, 失败不阻断发卡)
      try { await sendCommandPrelude(batch); } catch (e) {
        log.warn({ batchId: batch.batchId, err: (e as Error).message }, "command prelude send failed");
      }
      const sendCard = (c: TemplateCard): Promise<unknown> =>
        client.sendMessage(targetChatId(batch.approver), { msgtype: "template_card", template_card: c });
      try {
        await sendCard(card);
      } catch (e) {
        // quote 体可能超平台未公开的长度上限 — 缩到安全值重试一次, 保住审批流。
        log.warn({ batchId: batch.batchId, err: (e as Error).message }, "card send failed — retrying with shrunk quote");
        await sendCard(shrinkQuote(card));
      }
      log.info(
        { batchId: batch.batchId, count: batch.members.length, multi: isMulti, approver: batch.approver, tool: batch.toolName },
        "batch flushed",
      );
      // 只给单卡打「可续接」标: 批量卡的点击要靠内存里的 batchById 才能一次
      // resolve N 个成员, 那张表撑不过重启 —— 续接了反而会让成员干等一张点了
      // 没反应的卡。批量成员维持原行为 (drain → fallbackOnError)。
      if (!isMulti) markCardSent(batch.members[0]!.reqId);
    } catch (e) {
      log.error({ batchId: batch.batchId, err: (e as Error).message }, "batch send failed");
      const err = new Error(`send_card_fail:${(e as Error).message}`);
      for (const m of batch.members) failPending(m.reqId, err);
      // 单成员 batch 摘除自己的 batchById 条目, 多成员保留 (后续 click 兜底
      // 时 build*Card 期望能找到 batch — 但失败时也没人会点了, 留着也无害)。
      if (!isMulti) batchById.delete(batch.batchId);
    }
  };

  return async (req, res) => {
    if (!cfg.approval.enabled) {
      json(res, 200, { decision: "ask", reason: "approval_disabled" } satisfies ApproveResp);
      return;
    }

    const body = (await readBody(req)) as Partial<ApproveReq>;
    const sessionId = body.session_id ?? "";
    const toolName = body.tool_name ?? "";
    const toolInput = body.tool_input ?? {};
    const cwd = body.cwd ?? "";
    const transcriptTail = body.transcript_tail ?? "";

    if (!toolName) {
      json(res, 400, { decision: "ask", reason: "missing_tool_name" } satisfies ApproveResp);
      return;
    }

    // Matcher: only intercept matching tools — others pass.
    if (!new RegExp(cfg.approval.matcher).test(toolName)) {
      json(res, 200, { decision: "allow", reason: "matcher_skip" } satisfies ApproveResp);
      return;
    }

    // Claude-Code 三层规则语义: deny > ask > allow (语法同源, 见 allow-rules.ts)。
    // denyRules: 命中直接拒, 不发卡 (Bash 复合命令任一段命中即拒)。
    const denyHit = ruleMatchesAny(cfg.approval.denyRules, toolName, toolInput);
    if (denyHit) {
      log.info({ toolName, sessionId, rule: denyHit }, "deny-rule reject");
      json(res, 200, { decision: "deny", reason: `deny_rule:${denyHit}` } satisfies ApproveResp);
      return;
    }
    // askRules: 命中必发卡 — 压过 allowRules、自动放行窗口与会话缓存 (对齐
    // Claude permissions.ask 的"即使 allowlist 命中也要确认"语义)。
    const askHit = ruleMatchesAny(cfg.approval.askRules, toolName, toolInput);
    if (askHit) {
      log.info({ toolName, sessionId, rule: askHit }, "ask-rule force card");
    }

    // `.claude/**` 写守卫 (见 shared/claude-config-path.ts): 这类改动会让 CC 立起
    // 它自己的原生确认框, 那个框不过 hook —— 规则一放行就是"不发卡 + pane 阻塞"的
    // 静默死锁。命中且该 session 有活 pane 可代按时强制发卡 (压过 allowRules /
    // ⏱窗口 / 会话缓存), 批准后 settleClaudeConfigModal 去把框按掉。
    // 没有活 pane (headless / 未镜像的本地会话) → 不介入: 那种情形用户就在键盘前,
    // 自己按掉即可, 拦下来只是挡工作。
    const guardHit = cfg.approval.claudeConfigGuard ? claudeConfigWrite(toolName, toolInput) : undefined;
    const guardActive = Boolean(guardHit && nativeModal?.hasPane(sessionId));
    if (guardHit) {
      log.info(
        { toolName, sessionId, path: guardHit.path, why: guardHit.why, guardActive },
        guardActive ? "claude-config guard armed" : "claude-config write detected (no live pane, passing through)",
      );
    }
    const approver = resolveApprover(cfg, sessionId, getMirrorTarget);
    // 守卫的收尾 = 把 CC 那个不过 hook 的原生确认框按掉。它挂在**每一条 allow 出口**
    // 上, 而不是靠"强制发卡 + 人工点"来触发 —— 死锁的成因是没人按框, 不是没人点卡。
    //
    // 这条区别是有代价的历史: 守卫曾经进 mustCard, 于是 ⏱窗口/缓存/合流/sweep 全被
    // 它短路, 卡上那颗「⏱10h自动过」点了等于一次性放行, 窗口从来没开过。现在窗口
    // 照常生效, 框照样有人按。
    //
    // 必须在 json(res) 之后调用: CC 要等 hook 进程退出才会把框渲染出来。
    const settleGuard = (): void => {
      if (!guardActive || !guardHit || !approver) return;
      void settleClaudeConfigModal(sessionId, approver, guardHit).catch((e) => {
        log.warn({ err: (e as Error).message, sessionId }, "settleClaudeConfigModal failed");
      });
    };
    // 危险名单 (daemon/danger.ts): 内置的 rm / 强推 / DROP / 敏感路径等。语义上
    // 是「出厂自带的 askRules」—— 所以它必须和用户写的 askRules 站在同一层, 排在
    // allowRules 之前。放在后面的话, 一条 `Bash(git *)` 这样的宽 allow 规则 (尤其
    // 是从 Claude settings.json 批量导入来的) 就能让整份危险名单失效。
    const danger: DangerHit | undefined = dangerOf(cfg, toolName, toolInput);
    if (danger) log.info({ toolName, sessionId, rule: danger.rule }, "danger hit — forcing single approval");

    // 必发卡 = 危险名单 或 askRules 命中。这两者的语义是「每次都要人单独看一眼」,
    // 所以压过放行/窗口/缓存。守卫不在其列 —— 见上面 settleGuard 的注释。
    const mustCard = Boolean(danger) || Boolean(askHit);

    // allowRules: matcher 拦下的工具里再挖细粒度豁免 (Bash 可按命令前缀区分)。
    // 交互卡工具 (AskUserQuestion 等) 在引擎内部硬保护, 规则写了也不放行。
    // 用 evaluateAllow 而非 ruleAllows: 未命中时要把"因为哪一段"带到卡上,
    // 光知道"没放行"帮不了用户判断。判定本身零额外开销 (原本就要跑这一次)。
    const verdict = evaluateAllow(cfg.approval.allowRules, toolName, toolInput);
    if (!mustCard && verdict.allowed) {
      const ruleHit = [...new Set(verdict.hits)].join(" + ");
      log.info({ toolName, sessionId, rule: ruleHit }, "allow-rule skip");
      json(res, 200, { decision: "allow", reason: `allow_rule:${ruleHit}` } satisfies ApproveResp);
      settleGuard();
      return;
    }
    const denyReason = verdict.allowed ? undefined : verdict.reason;

    // EnterPlanMode: block model-initiated plan mode. deny + reason 回传 model,
    // 让它别进 plan mode、直接干活。用户仍可在本地 Shift+Tab 手动进 plan mode
    // (那条路径不过 hook)。由 config.approval.blockAutoPlanMode 控制(默认 true)。
    if (toolName === "EnterPlanMode" && cfg.approval.blockAutoPlanMode) {
      json(res, 200, {
        decision: "deny",
        reason:
          "请不要进入 plan mode。直接开始执行任务;如果需要先讨论方案,用文字说明即可,不要调用 EnterPlanMode。(用户已设置:仅在其本地手动 Shift+Tab 时才进 plan mode。)",
      } satisfies ApproveResp);
      return;
    }

    // AskUserQuestion 走单独的投票卡分支(deny+reason 注入答案 / ask 转 CLI)。
    if (toolName === "AskUserQuestion") {
      // writableEnded 为 false 时的 close = 响应还没写就断线 = hook 客户端先死。
      // 正常完成时 json() 先置 writableEnded, close 到来后 resolve 不再发生。
      const clientGone = new Promise<"client_gone">((resolve) => {
        res.on("close", () => {
          if (!res.writableEnded) resolve("client_gone");
        });
      });
      const resp = await handleAskUserQuestion({
        cfg,
        log,
        client,
        getMirrorTarget,
        flushBeforeCard,
        clientGone,
        body: {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          cwd,
          transcript_tail: transcriptTail,
          cli_backend: body.cli_backend,
        },
      });
      json(res, 200, resp satisfies ApproveResp);
      return;
    }

    // ExitPlanMode 走计划审批卡分支(allow 同意 / deny+reason 继续改 / ask 转 CLI)。
    if (toolName === "ExitPlanMode") {
      const resp = await handleExitPlanMode({
        cfg,
        log,
        client,
        getMirrorTarget,
        flushBeforeCard,
        body: {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          cwd,
          transcript_tail: transcriptTail,
          cli_backend: body.cli_backend,
          transcript_path: body.transcript_path,
        },
      });
      json(res, 200, resp satisfies ApproveResp);
      return;
    }

    // danger.skip / danger 模式的早退。第三个参数是「除 danger 外还有没有别的必发卡
    // 理由」—— askRules 不能被 danger 的开关顺带关掉。守卫不在其列: 它要的是事后按框,
    // 早退照样能给 (settleGuard), 拿它挡早退等于把 danger 的开关废掉。
    const earlyExit = dangerEarlyExit(cfg, danger, Boolean(askHit));
    if (earlyExit) {
      log.info({ toolName, sessionId, reason: earlyExit }, "danger switch early exit");
      json(res, 200, { decision: "allow", reason: earlyExit } satisfies ApproveResp);
      settleGuard();
      return;
    }

    // Auto-approve window: while active for THIS chat, requests short-circuit to allow.
    // mustCard (危险名单 / askRules) 的请求不吃窗口 — 即使开着 ⏱ 也逐条确认。
    if (!mustCard && approver && isAutoWindowActive(approver)) {
      const remainSec = Math.ceil(autoWindowRemainingMs(approver) / 1000);
      log.info({ toolName, sessionId, chatKey: approver, remainSec }, "auto-window allow");
      json(res, 200, {
        decision: "allow",
        reason: `auto_window:${remainSec}s`,
      } satisfies ApproveResp);
      settleGuard();
      return;
    }

    // Session cache (mustCard 的请求同样不吃缓存)
    const ck = cacheKey(sessionId, toolName, toolInput);
    // mustCard(危险名单 / askRules)一律不吃缓存 —— 缓存的语义是「这个调用批过一次
    // 就不再问」, 与「每次都要单独确认」直接冲突。
    const cached = mustCard ? undefined : cacheGet(ck);
    if (cached) {
      log.info({ ck, cached }, "cache hit");
      json(res, 200, {
        decision: decisionToHook(cached),
        reason: `cached:${cached}`,
      } satisfies ApproveResp);
      if (decisionToHook(cached) === "allow") settleGuard();
      return;
    }

    if (!approver) {
      log.warn("no approver configured");
      json(res, 200, fallback(cfg, "no_approver", mustCard || guardActive) satisfies ApproveResp);
      return;
    }
    if (!client.isConnected) {
      log.warn("ws not connected");
      json(res, 200, fallback(cfg, "ws_disconnected", mustCard || guardActive) satisfies ApproveResp);
      return;
    }

    // Build pending + card
    const display = cfg.approval.sensitiveArgRedact ? redact(toolInput) : toolInput;
    const toolInputStr = (() => {
      try {
        return JSON.stringify(display, null, 2);
      } catch {
        return String(display);
      }
    })();

    const longPollMs = cfg.approval.longPollSec * 1000;
    // 卡片标题上的会话身份 — 发卡前算一次, 存进 meta 供 resolved 卡复用
    // (#tag 直接取; 否则读 transcript 首条用户消息, 带缓存)。
    const sessionName = sessionNameFor(approver, body.transcript_path, sessionId);
    // Reload 续接: hook 带着上一轮的 req_id 回来, 复用同一个 id 重新挂起 ——
    // WeCom 上那张卡的按钮编的就是它, 于是旧卡的点击照样能 resolve 这次长轮询。
    const resumeId = (body.resume_req_id ?? "").trim();
    const { reqId, promise } = createPending({
      meta: {
        kind: "approval",
        createdAt: Date.now(),
        toolName,
        toolInput: display,
        cwd,
        sessionId,
        chatKey: approver,
        transcriptTail,
        danger: danger?.rule,
        forceSingle: mustCard,
        sessionName,
        denyReason,
        cardSent: Boolean(resumeId), // 续接的前提就是卡已经在群里
      },
      timeoutMs: longPollMs,
      reqId: resumeId || undefined,
    });

    recordApproval({
      id: reqId,
      toolName,
      toolInput: display,
      cwd,
      sessionId,
      transcriptTail,
    });

    // Batch coalesce: 同 session 同 tool 的并发请求合流为一张卡。窗口内首位
    // 创建 batch + 计时器, 后续到达者只追加成员, 不发卡。flush 时依据成员数
    // 选择普通 buildCard 或 buildBatchCard。0 = 关闭聚合, 立即 flush。
    // 续接的请求不再进 batch: 卡已经在群里, 重发就是重复轰炸。
    const member: BatchMember = { reqId, toolInput: display, originalToolInput: toolInput, toolInputStr, cwd, transcriptTail };
    const bk = batchKeyOf(sessionId, toolName);
    // 必发卡请求既不 join 也不被 join — 一次这样的操作 = 一张卡 = 一次点击。
    // 合流会把它塞进带「⏱全过 / ✅总是」的批量卡, 一次点击就连它一起放行了。
    const existing = mustCard ? undefined : activeBatches.get(bk);
    if (resumeId) {
      // no-op: 直接进下面的长轮询, 等旧卡上的点击。
    } else if (existing && !existing.flushed) {
      existing.members.push(member);
      log.info({ batchId: existing.batchId, count: existing.members.length, reqId }, "batch joined");
    } else {
      const batch: ActiveBatch = {
        batchId: newBatchId(),
        sessionId,
        toolName,
        approver,
        windowMinutes: cfg.approval.windowMinutes,
        danger: danger?.rule,
        forceSingle: mustCard,
        sessionName,
        denyReason,
        members: [member],
        flushed: false,
        flushTimer: undefined as unknown as NodeJS.Timeout, // set below
      };
      const coalesceMs = mustCard ? 0 : cfg.approval.batchCoalesceMs;
      const fire = (): void => void flushBatch(batch);
      batch.flushTimer = coalesceMs > 0 ? setTimeout(fire, coalesceMs) : setImmediate(fire) as unknown as NodeJS.Timeout;
      if (!mustCard) activeBatches.set(bk, batch);
      batchById.set(batch.batchId, batch);
      evictBatches();
      log.info({ batchId: batch.batchId, reqId, coalesceMs }, "batch opened");
    }

    // Long-poll
    let decision: Decision;
    try {
      decision = await promise;
    } catch (e) {
      // Reload drain: 卡还挂在 WeCom 上, 让 hook 带着同一个 reqId 等 daemon 回来
      // 重新长轮询 —— 而不是 fallback 成 ask 把权限框弹回本地 CLI。
      if (isReloadError(e)) {
        log.info({ reqId, toolName, sessionId }, "approval parked for reload — telling hook to resume");
        json(res, 200, { decision: "retry", reason: "daemon_reloading", req_id: reqId } satisfies ApproveResp);
        return;
      }
      log.warn({ err: (e as Error).message, reqId }, "approval timed out");
      json(res, 200, fallback(cfg, "approver_timeout", mustCard || guardActive) satisfies ApproveResp);
      return;
    }

    // 必发卡的决策一律不留痕: 不写 session cache、不开自动窗口 (卡上本就没这两个
    // 按钮, 这里是防御性兜底 —— 决策也可能来自 sweep / 旧卡)。
    if (!mustCard && decision === "allow_session" && cfg.approval.sessionCacheMinutes > 0) {
      cachePut(ck, decision, cfg.approval.sessionCacheMinutes * 60_000);
    }
    // 「✅ 总是」: 由本次调用生成规则, 热生效 + 写回 config.jsonc (对齐 Claude Code
    // 原生弹窗的 Always allow)。规则生成必须用**未脱敏**的原始 toolInput —— display
    // 可能被 sensitiveArgRedact 改写过, 拿它生成的前缀匹配不上真实命令。
    if (decision === "allow_always") {
      // 命中 askRules 的调用: allow 规则永远被 ask 压过, 存了也是死规则。提示真实
      // 的生效路径, 而不是静默写入一条永不生效的配置。
      if (askHit) {
        await notify(
          approver,
          `⚠️ 该命令命中强制审批规则 \`${askHit}\`（askRules 优先于放行规则），「总是」不会生效，本次已放行。如确要永久放行，需从 config.jsonc 的 askRules 移除该规则。`,
        );
      }
      // 危险名单同理 (与 askRules 同层, allow 压不过它)。危险卡上本就没有「总是」
      // 按钮, 这里是防御性兜底 —— 决策也可能来自 sweep / 旧卡。
      if (!askHit && danger) {
        await notify(
          approver,
          `⚠️ 该操作命中危险名单「${danger.rule}」，不支持「总是」：这类操作每次都要单独确认。`
            + `本次已放行。如确要长期免审，请在 config.jsonc 的 \`approval.danger.allowPatterns\` 里加豁免正则。`,
        );
      }
      // `.claude/**` 守卫命中的调用现在可以正常存规则: 守卫不再靠"强制发卡"兜底,
      // settleGuard 挂在每条 allow 出口上 —— 规则放行的那一次同样会去按原生框。
      const gen = askHit || danger
        ? []
        : alwaysAllowRulesFor(toolName, toolInput, cfg.approval.allowRules);
      const added = gen.filter((r) => !cfg.approval.allowRules.includes(r));
      if (added.length > 0) {
        cfg.approval.allowRules.push(...added); // 先热生效; 文件写失败也不回滚内存
        if (sourcePath) {
          try {
            for (const r of added) appendUnique(sourcePath, ["approval", "allowRules"], r);
          } catch (e) {
            log.warn({ err: (e as Error).message }, "allow_always persist failed (in-memory only)");
          }
        }
        log.info({ toolName, added, persisted: Boolean(sourcePath) }, "allow_always rules saved");
        await notify(approver, `📌 已保存永久放行规则：${added.map((r) => `\`${r}\``).join("、")}`);
      } else if (!askHit && !danger && gen.length === 0) {
        // 提炼不出可靠字面规则 —— 本次一次性放行并告知。文案必须指对排查方向:
        // 成因有四种, 笼统说"引号/结构有问题"会把用户带偏 (例如真凶是 fd 重定向
        // 的 `&` 被当成后台执行符时, 用户会去查引号)。
        const cmdStr = typeof (toolInput as Record<string, unknown> | null)?.command === "string"
          ? ((toolInput as Record<string, unknown>).command as string)
          : "";
        const why = NEVER_RULE_ALLOW.has(toolName)
          ? `\`${toolName}\` 是交互工具，永不支持免审（引擎内部硬保护）`
          : /[`]|\$\(/.test(cmdStr)
            ? "该命令含动态构造（$() / 反引号），字面规则无法可靠描述其行为"
            : splitSegments(cmdStr) === undefined
              ? "该命令含未闭合引号或后台执行符 `&`，无法安全分段"
              : "该命令的结构提炼不出可靠前缀（异形段首、或解释器头部拿不到子命令）";
        await notify(approver, `📌 ${why}，本次已一次性放行（未保存规则）。`);
      }
    }

    if (!mustCard && decision === "allow_window" && cfg.approval.windowMinutes > 0) {
      setAutoWindow(approver, cfg.approval.windowMinutes * 60_000, {
        toolName,
        toolInput: display,
        cwd,
        transcriptTail,
      });
      // 同一个 chat 里其它 pending 卡 (可能来自并发同 turn, 也可能来自绑到
      // 同一个 chat 的别的 session) — 一并放行，免得用户逐个点。
      // 我们没有那些卡的事件 frame, 不能 updateTemplateCard 改文案；
      // 改用一条 markdown 消息回执让用户知道发生了什么。
      const swept = resolvePendingsByChat(approver, "allow_window", reqId);
      log.info({ sessionId, chatKey: approver, minutes: cfg.approval.windowMinutes, swept: swept.length }, "auto-window opened");
      if (swept.length > 0) {
        try {
          const tools = swept
            .map(({ meta }) => meta.toolName)
            .filter((s): s is string => Boolean(s));
          const summary = tools.length > 0 ? tools.join(" / ") : `${swept.length} 个`;
          await client.sendMessage(targetChatId(approver), {
            msgtype: "markdown",
            markdown: { content: withTagHeader(approver, `⚡ 已批量自动放行其他 ${swept.length} 个并发请求：${summary}`) },
          });
        } catch (e) {
          log.warn({ err: (e as Error).message }, "sweep notice send failed");
        }
      }
    }

    // Resolved-card refresh happens inline in the click listener via
    // `updateTemplateCard` (5-sec window). No follow-up sendMessage here.

    json(res, 200, {
      decision: decisionToHook(decision),
      reason: decision,
    } satisfies ApproveResp);

    // 放行 `.claude/**` 写操作后, CC 会在 hook 退出后立起自己的原生确认框 —— 必须
    // 等响应发出去才能去按 (框此刻还不存在)。fire-and-forget: 这条 HTTP 请求已经
    // 结束, 失败也只能靠告知, 不能再改判决。
    if (decisionToHook(decision) === "allow") settleGuard();
  };
};

// ── Card click event → resolvePending + update card in place ────────────
export const installApprovalEventListener = (
  client: WSClient,
  log: Logger,
  cfg: Config,
  onApproved?: (sessionId: string) => void,
): void => {
  client.on("event", (frame: WsFrame<EventMessage>) => {
    try {
      log.info({ raw: JSON.stringify(frame.body).slice(0, 1200) }, "raw event frame");
    } catch {
      /* ignore */
    }
  });
  client.on(
    "event.template_card_event",
    async (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
      const ev = frame.body?.event as
        | (TemplateCardEventData & {
            template_card_event?: {
              event_key?: string;
              task_id?: string;
              // 实际 payload 是 XML→JSON 转出来的双层包装,跟 SDK 类型不一致:
              //   selected_items.selected_item[i].option_ids.option_id[j]
              // 同时也兼容 SDK 声明的扁平形态。
              selected_items?:
                | Array<{ question_key?: string; option_ids?: string[] | { option_id?: string[] } }>
                | { selected_item?: Array<{ question_key?: string; option_ids?: { option_id?: string[] } | string[] }> };
            };
          })
        | undefined;
      // SDK d.ts says ev.event_key, but the actual payload nests it under
      // ev.template_card_event.event_key. Fall back across both for safety.
      const key = ev?.template_card_event?.event_key ?? ev?.event_key ?? "";
      // Update 时 task_id 必须跟回调里的一致，否则微信会拒掉更新。
      const cbTaskId = ev?.template_card_event?.task_id ?? ev?.task_id ?? "";

      // ── action_menu「📄 展开完整命令」: 纯展示, 不改判决、不 resolve pending。
      // 取 detail store 而不是 pending —— 用户很可能是点完 ✅ 之后回头想看全文,
      // 那时 pending 早被删了; detail 记录留存 24h, 且卡片解决后依然可点。
      if (key.startsWith(FULLCMD_PREFIX)) {
        const reqId = key.slice(FULLCMD_PREFIX.length);
        const rec = getDetail(reqId);
        // 回复目标: 待决时在 pending 里, 已决时 pending 已删 —— 回落到 resolved
        // 暂存。两个都没有才用 defaultChat (`#tag` 会话会因此回到主会话, 不理想,
        // 但那已经是记录过期的边缘情形)。
        const target =
          getPending(reqId)?.chatKey
          ?? getResolvedSnapshot(reqId)?.meta.chatKey
          ?? cfg.defaultChat;
        const cmd = rec && rec.kind === "approval" ? commandOf(rec.toolName, rec.toolInput) : "";
        // 只能走主动 markdown 分块 (≤1800 字单条)。曾试过对点击事件做 stream 被动
        // 回复 (单条 20480 字节) —— 企微服务端拒绝: errcode=846605 invalid req_id,
        // 卡片事件的 req_id 仅可用于 updateTemplateCard, 不进被动回复通道。
        void (async () => {
          try {
            if (!cmd) {
              await client.sendMessage(targetChatId(target), {
                msgtype: "markdown",
                markdown: { content: withTagHeader(target, "⌛ 该命令的详情已过期（记录只保留 24 小时），无法展开。") },
              });
              return;
            }
            for (const [i, chunk] of chunkText(cmd, FULLCMD_CHUNK_CHARS).entries()) {
              const n = Math.ceil(cmd.length / FULLCMD_CHUNK_CHARS);
              const head = n > 1 ? `📄 完整命令（${cmd.length} 字，${i + 1}/${n}）：\n` : `📄 完整命令（${cmd.length} 字）：\n`;
              await client.sendMessage(targetChatId(target), {
                msgtype: "markdown",
                markdown: { content: withTagHeader(target, head + chunk) },
              });
            }
            log.info({ reqId, len: cmd.length, target }, "full command expanded on demand");
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId }, "full command expand failed");
          }
        })();
        return;
      }

      // ── AskUserQuestion 投票卡: 在普通 approval 解码前先匹配 ASKQ| 前缀。
      const askq = decodeAskqKey(key);
      if (askq) {
        const meta = getPending(askq.reqId);
        const q = parseAskqInput(meta?.toolInput)?.[0];
        // 实际 payload 是 XML→JSON 双层包装, 不能直接 [0].option_ids; 同时
        // 兼容 SDK 文档里那个扁平形态(以防固件升级)。
        const si = ev?.template_card_event?.selected_items;
        const firstItem: { option_ids?: string[] | { option_id?: string[] } } | undefined =
          Array.isArray(si)
            ? si[0]
            : si?.selected_item?.[0];
        const oids = firstItem?.option_ids;
        const rawIds: string[] = Array.isArray(oids)
          ? oids
          : (oids?.option_id ?? []);
        const cliPicked = rawIds.includes(ASKQ_CLI_OPTION_ID);
        const chatPicked = rawIds.includes(ASKQ_CHAT_OPTION_ID);
        const numericIdxs = rawIds
          .filter((s) => s !== ASKQ_CLI_OPTION_ID && s !== ASKQ_CHAT_OPTION_ID)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isInteger(n) && n >= 0);
        // 哨兵优先级: CLI > chat > 数字选项 (混选也按哨兵语义处理)。
        const outcome: AskqOutcome = cliPicked
          ? { kind: "cli" }
          : chatPicked
            ? { kind: "chat" }
            : numericIdxs.length === 0
              ? { kind: "empty" }
              : { kind: "picked", picked: numericIdxs };
        const resolved = outcome.kind === "cli"
          ? "cli"
          : outcome.kind === "chat"
            ? "chat"
            : `${ASKQ_PICKED_PREFIX}${numericIdxs.join(",")}`;
        const ok = resolvePending(askq.reqId, resolved as never);
        // 留 resolved 快照: 重复点击已决卡时据此跳过"已失效"重绘 (卡已是终态)。
        if (ok && meta) stashResolved(askq.reqId, meta, resolved as never);
        log.info({ reqId: askq.reqId, outcome, ok }, "askq event resolved");
        if (q) {
          try {
            await client.updateTemplateCard(
              frame,
              buildAskqResolvedCard(
                cbTaskId || askq.reqId,
                q,
                outcome,
                meta?.transcriptTail ?? "",
                meta?.chatKey,
              ),
            );
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId: askq.reqId }, "askq updateTemplateCard failed");
          }
        } else if (!ok && !getResolvedSnapshot(askq.reqId)) {
          // 死卡点击 (超时 / 本地先答已作废 / daemon 重启丢 pending): 给终态反馈,
          // 别让用户对着无反应的卡干瞪眼。有 resolved 快照 = 已决卡的重复点击,
          // 卡片已是终态, 不重绘。
          try {
            await client.updateTemplateCard(frame, {
              card_type: "button_interaction",
              main_title: { title: "🤔 问题卡已失效" },
              sub_title_text: "该卡已超时或已在别处处理，请以最新上下文为准。",
              task_id: cbTaskId || askq.reqId,
              button_list: [{ text: "⌛ 已失效", style: 4, key: encodeAskqNoopKey(askq.reqId) }],
            } as TemplateCard);
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId: askq.reqId }, "askq stale-card update failed");
          }
        }
        return;
      }

      // ── ExitPlanMode 计划审批卡: 在普通 approval 解码前匹配 PLAN| 前缀。
      const planClick = decodePlanKey(key);
      if (planClick) {
        const meta = getPending(planClick.reqId);
        const ok = resolvePending(planClick.reqId, `${PLAN_PICKED_PREFIX}${planClick.action}` as never);
        log.info({ reqId: planClick.reqId, action: planClick.action, ok }, "plan event resolved");
        try {
          await client.updateTemplateCard(
            frame,
            buildPlanResolvedCard(
              cbTaskId || planClick.reqId,
              planClick.action,
              meta?.cwd ?? "",
              meta?.transcriptTail ?? "",
              meta?.chatKey,
            ),
          );
        } catch (e) {
          log.warn({ err: (e as Error).message, reqId: planClick.reqId }, "plan updateTemplateCard failed");
        }
        return;
      }
      // 已决计划卡再次被点 (plan_noop:<id>) → 终态 identity, 直接吞掉。
      if (decodePlanNoopKey(key) !== undefined) return;

      const decoded = decodeKey(key);

      const detailUrlFor = (id: string, approver?: string): string =>
        buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id, approver ? targetChatId(approver) : undefined);

      // Batch 卡分支: 一次性 resolve N 个成员 pending, 单次 update 卡片状态。
      // 必须在普通 decodeKey 分支前匹配 — 否则 batchId 形如 "b...|allow" 也
      // 能被 split("|") 当作 reqId|decision 误解出来。
      const batchDec = decodeBatchKey(key);
      if (batchDec) {
        const batch = batchById.get(batchDec.batchId);
        if (!batch) {
          log.info({ batchId: batchDec.batchId }, "batch click — unknown id, ignored");
          return;
        }
        const by = frame.body?.from?.userid ?? "?";
        let resolved = 0;
        for (const m of batch.members) {
          recordApprovalDecision(m.reqId, batchDec.decision, by);
          if (resolvePending(m.reqId, batchDec.decision)) resolved++;
        }
        // 全部成员都已被先前的 allow_window sweep 拿走 → 渲染「已经放行」形态
        // 而非再画一遍三按钮的 resolved 卡, 跟单卡 swept 路径语义对齐。
        const allSwept = resolved === 0 && batch.members.length > 0;
        log.info({ batchId: batch.batchId, decision: batchDec.decision, resolved, total: batch.members.length, allSwept }, "batch resolved");
        if (resolved > 0) onApproved?.(batch.sessionId);
        try {
          const tail = batch.members[0]?.transcriptTail ?? "";
          const card = allSwept
            ? buildBatchAlreadyResolvedCard(batch, tail)
            : buildBatchResolvedCard(batch, batchDec.decision, tail);
          await client.updateTemplateCard(frame, card);
          log.info({ batchId: batch.batchId, decision: batchDec.decision, allSwept }, "batch card updated in place");
        } catch (e) {
          log.warn({ err: (e as Error).message, batchId: batch.batchId }, "batch updateTemplateCard failed");
        }
        return;
      }

      // Batch-noop / Askq-noop: 终态再点 = identity, 见下方统一 noop 分支。
      // 这里把分支提前吃掉, 防止 decodeKey 把 B-noop / askq_noop 误解成普通 noop。
      if (decodeBatchNoopKey(key) !== undefined || decodeAskqNoopKey(key) !== undefined) {
        log.info({ key }, "terminal re-click (batch/askq) — identity, no update");
        return;
      }

      // Noop branch: 任意 *_noop 前缀 = 终态卡再点 = identity。
      // 卡面已是 buildResolvedCard / buildBatchResolvedCard / buildCancelledCard
      // 渲染出的最终形态, 重画只会丢信息(把"✅ 已通过"糊成"已经放行")。
      // 不更新, 让 WeCom 端的卡面保持不变。
      if (decoded.noopReqId !== undefined) {
        log.info({ key }, "terminal re-click — identity, no update");
        return;
      }

      // Cancel branch: resolved allow_window card was clicked again to cancel
      // the auto-approve window for that chat. No pending to resolve.
      if (decoded.cancelChatKey) {
        const wmeta = getWindowMeta(decoded.cancelChatKey);
        clearAutoWindow(decoded.cancelChatKey);
        log.info({ chatKey: decoded.cancelChatKey }, "auto-window cancelled by click");
        try {
          await client.updateTemplateCard(
            frame,
            buildCancelledCard({
              reqId: cbTaskId,  // 必须用回调的 task_id，否则微信拒更新
              toolName: wmeta?.toolName ?? "授权",
              toolInput: wmeta?.toolInput ?? {},
              toolInputStr: "",
              cwd: wmeta?.cwd ?? "",
              sessionShort: "?",
              chatKey: decoded.cancelChatKey,
              transcriptTail: wmeta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: cbTaskId ? detailUrlFor(cbTaskId, decoded.cancelChatKey) : undefined,
            }),
          );
          log.info({ chatKey: decoded.cancelChatKey, cbTaskId }, "cancel card updated in place");
        } catch (e) {
          log.warn({ err: (e as Error).message }, "updateTemplateCard (cancel) failed");
        }
        return;
      }

      const { reqId, decision } = decoded;
      if (!reqId || !decision) {
        log.info({ key }, "card event ignored (bad key)");
        return;
      }
      // Snapshot meta BEFORE resolve (resolve deletes the entry).
      const livePending = getPending(reqId);
      const ok = resolvePending(reqId, decision);
      // 兜底: 这张卡如果是被 sweep 提前 resolve 掉的"鬼卡", livePending 已经没了
      // (resolvePendingsBySession 删过); 从 resolvedStash 里捞回原始 meta + 真实
      // decision, 渲染成"已自动放行"形态而非 (probe)。
      const snap = livePending ? undefined : getResolvedSnapshot(reqId);
      const meta = livePending ?? snap?.meta;
      const effectiveDecision: Decision = snap?.decision ?? decision;
      const by = frame.body?.from?.userid ?? "?";
      recordApprovalDecision(reqId, snap ? "swept" : effectiveDecision, by);
      if (ok) log.info({ reqId, decision }, "card event resolved");
      else if (snap) log.info({ reqId, snap: snap.decision }, "card event on swept card — rendering snapshot");
      else {
        // meta 完全缺失 (daemon 重启 / stash 过期 / 真探测包)。任何 update 都会用
        // 空字段把原卡覆盖成 "(probe) · /"，比保留原卡更糟。直接放弃 update。
        log.warn({ reqId, decision }, "card event for unknown reqId (probe? expired?) — skipping update to avoid clobbering original card");
        return;
      }

      // 用户实际点击的那一下 — 通知 mirror 立刻 finalize 当前 liveStream,
      // 后续的 tool_use / tool_result 走防抖 standalone 路径,避免点击后仍把
      // 内容续写进同一个气泡。sweep 二次点击 (snap 命中, ok=false) 不触发,
      // 避免重复 finalize。
      if (ok && meta?.sessionId) onApproved?.(meta.sessionId);

      // Refresh original card in place (must be within 5s of click).
      // Independent of pending resolution: we always want visual ACK on any
      // well-formed click so the user knows the click landed.
      const toolInputStr = (() => {
        try {
          return JSON.stringify(meta?.toolInput ?? {}, null, 2);
        } catch {
          return String(meta?.toolInput);
        }
      })();
      const sessionShort = meta?.sessionId ? meta.sessionId.slice(-8) : "?";
      // snap 命中分支拆开判:
      //  - snap.decision == allow_window → 这张卡是被 sweep 提前放行的"鬼卡",
      //    渲染「已经放行」, 别画 allow_window 的「点击取消」 — 不然用户在被
      //    批量放行的卡上点一下就会误取消整个自动窗口。
      //  - 其它 decision → 已是 resolvePending 留下的快照(普通 resolve 也 stash),
      //    用 buildResolvedCard 重画原文案 ("✅ 已通过" / "❌ 已拒绝" / 本会话通过),
      //    避免降级到信息量更少的「已经放行」。
      const isSwept = Boolean(snap && snap.decision === "allow_window");
      try {
        const card = isSwept
          ? buildAlreadyResolvedCard({
              reqId: cbTaskId || reqId,
              toolName: meta?.toolName ?? "授权",
              toolInput: meta?.toolInput ?? {},
              toolInputStr,
              cwd: meta?.cwd ?? "",
              sessionShort,
              sessionId: meta?.sessionId ?? "",
              chatKey: meta?.chatKey ?? "",
              transcriptTail: meta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              sessionName: meta?.sessionName,
              denyReason: meta?.denyReason,
              detailUrl: detailUrlFor(reqId, meta?.chatKey),
            })
          : buildResolvedCard({
              reqId,
              toolName: meta?.toolName ?? "授权",
              toolInput: meta?.toolInput,
              toolInputStr,
              cwd: meta?.cwd ?? "",
              sessionShort,
              transcriptTail: meta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              decision: effectiveDecision,
              by,
              sessionId: meta?.sessionId ?? "",
              chatKey: meta?.chatKey ?? "",
              danger: meta?.danger,
              sessionName: meta?.sessionName,
              denyReason: meta?.denyReason,
              detailUrl: detailUrlFor(reqId, meta?.chatKey),
            });
        await client.updateTemplateCard(frame, card);
        log.info({ reqId, decision, swept: Boolean(snap) }, "card updated in place");
      } catch (e) {
        log.warn({ err: (e as Error).message, reqId }, "updateTemplateCard failed");
      }
    },
  );
};
