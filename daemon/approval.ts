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
import type { Config } from "../shared/config.js";
import { createPending, getPending, getResolvedSnapshot, resolvePending, resolvePendingsBySession, failPending, type Decision } from "./pending.js";
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
import { redact } from "./redact.js";
import { recordApproval, recordApprovalDecision, buildDetailUrl } from "./detail.js";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";
import { labelFor } from "./session-label.js";

// ── Routing helpers ────────────────────────────────────────────────────
const targetChatId = (principal: string): string => {
  // "user:abc" → "abc" (DM chatid == userid for aibot)
  // "chat:wc..." → "wc..."
  // raw fallthrough
  const i = principal.indexOf(":");
  return i >= 0 ? principal.slice(i + 1) : principal;
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
  transcriptTail: string;
  windowMinutes: number;
  detailUrl?: string;  // 空则不渲染 jump_list
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

const SOURCE_BASE = {
  icon_url: "https://wwcdn.weixin.qq.com/node/wework/images/3d-claude-ai-logo.bce0ddae70.jpg",
  desc: "Claude Code",
  desc_color: 0,
};

// Source bar sits ABOVE main_title — only place we can hoist transcript context.
const buildSource = (tail: string): TemplateCard["source"] => {
  const desc = tail ? TRUNC(tail, 80) : SOURCE_BASE.desc;
  return { ...SOURCE_BASE, desc } as TemplateCard["source"];
};

interface Rendered {
  body: string;  // wrapped in quote_area as the parameters block
  desc?: string; // 渲染到 sub_title_text — 跟 quote_area 里的命令/参数体分离
}

const prefixLines = (s: string, prefix: string): string =>
  s.split("\n").map((l) => `${prefix} ${l}`).join("\n");

// Flat key:val summary for unknown tools — never dump raw JSON.
const UNKNOWN_VAL_LEN = 140;
const UNKNOWN_TOTAL_LEN = 480;
const summarizeUnknown = (i: Record<string, unknown>): string => {
  const lines: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(i)) {
    if (total >= UNKNOWN_TOTAL_LEN) { lines.push("…"); break; }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const line = `${k}: ${TRUNC(oneLine(s), UNKNOWN_VAL_LEN)}`;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
};

const QUOTE_MAX = 600;
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
  return { body: summarizeUnknown(i) };
};

const quoteArea = (text: string): TemplateCard["quote_area"] =>
  ({ type: 0, quote_text: text } as TemplateCard["quote_area"]);

const MAIN_DESC_MAX = 30;
const mainTitle = (title: string, desc?: string): TemplateCard["main_title"] =>
  desc ? { title, desc: TRUNC(desc, MAIN_DESC_MAX) } : { title };

const dirName = (cwd: string): string => cwd.replace(/^.*\//, "") || cwd;

const detailJumpList = (url?: string): TemplateCard["jump_list"] | undefined =>
  url ? [{ type: 1, title: "🔍 详情", url }] : undefined;

// Stable per-session animal emoji, matching list_claude_sessions, so the user
// can tell which session a card belongs to when several un-mirrored sessions
// fall back to the same WeCom chat. Needs the FULL sessionId; returns "" when
// only a short id / none is available.
const tagOf = (a: CardArgs): string => (a.sessionId ? `${labelFor(a.sessionId)} ` : "");

const buildCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`🔐 授权 · ${tagOf(a)}${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [
      { text: "❌", style: 4, key: encodeKey(a.reqId, "deny") },
      { text: "10min", style: 3, key: encodeKey(a.reqId, "allow_window") },
      { text: "✅", style: 4, key: encodeKey(a.reqId, "allow") },
    ],
  };
};

const verbOf = (d: Decision, windowMinutes: number): string => {
  switch (d) {
    case "deny": return "已拒绝";
    case "allow_window": return `${windowMinutes}min会话内全过`;
    case "allow_session": return "本会话通过";
    default: return "已通过";
  }
};

const emojiOf = (d: Decision): string => (d === "deny" ? "❌" : "✅");

// allow_window 仍可点击以取消自动窗口；其余决策为最终态 noop。
const resolvedButton = (
  d: Decision,
  windowMinutes: number,
  reqId: string,
  sessionId: string,
): { text: string; style: number; key: string } => {
  if (d === "allow_window") {
    return {
      text: `${verbOf(d, windowMinutes)} · 点击取消`,
      style: 4,
      key: encodeCancelKey(sessionId),
    };
  }
  return {
    text: `${emojiOf(d)} ${verbOf(d, windowMinutes)}`,
    style: 4,
    key: `noop:${reqId}`,
  };
};

const buildResolvedCard = (
  a: CardArgs & { decision: Decision; by: string; sessionId: string },
): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${tagOf(a)}${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [resolvedButton(a.decision, a.windowMinutes, a.reqId, a.sessionId)],
  };
};

const buildCancelledCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${tagOf(a)}${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
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
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${tagOf(a)}${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
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

const buildBatchCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `🔐 授权 · ${batch.sessionId ? labelFor(batch.sessionId) + " " : ""}${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [
      { text: "❌", style: 4, key: encodeBatchKey(batch.batchId, "deny") },
      { text: "10min", style: 3, key: encodeBatchKey(batch.batchId, "allow_window") },
      { text: "✅", style: 4, key: encodeBatchKey(batch.batchId, "allow") },
    ],
  };
};

const buildBatchResolvedCard = (
  batch: ActiveBatch,
  decision: Decision,
  transcriptTail: string,
): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  const button = decision === "allow_window"
    ? {
        text: `${verbOf(decision, batch.windowMinutes)} · 点击取消`,
        style: 4,
        key: encodeCancelKey(batch.sessionId),
      }
    : {
        text: `${emojiOf(decision)} ${verbOf(decision, batch.windowMinutes)} ×${batch.members.length}`,
        style: 4,
        key: encodeBatchNoopKey(batch.batchId),
      };
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `${batch.sessionId ? labelFor(batch.sessionId) + " " : ""}${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [button],
  };
};

const buildBatchAlreadyResolvedCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `${batch.sessionId ? labelFor(batch.sessionId) + " " : ""}${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [{ text: "已经放行", style: 4, key: encodeBatchNoopKey(batch.batchId) }],
  };
};

const encodeKey = (reqId: string, decision: Decision): string => `${reqId}|${decision}`;
const NOOP_PREFIX = "noop:";
const CANCEL_PREFIX = "cancel_window:";
const BATCH_PREFIX = "B|";
const BATCH_NOOP_PREFIX = "B-noop:";
const encodeCancelKey = (sessionId: string): string => `${CANCEL_PREFIX}${sessionId}`;
const encodeBatchKey = (batchId: string, decision: Decision): string =>
  `${BATCH_PREFIX}${batchId}|${decision}`;
const encodeBatchNoopKey = (batchId: string): string => `${BATCH_NOOP_PREFIX}${batchId}`;
const decodeBatchKey = (key: string): { batchId: string; decision: Decision } | undefined => {
  if (!key.startsWith(BATCH_PREFIX)) return undefined;
  const [batchId, d] = key.slice(BATCH_PREFIX.length).split("|");
  if (!batchId || !d) return undefined;
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "deny") return undefined;
  return { batchId, decision: d };
};
const decodeBatchNoopKey = (key: string): string | undefined =>
  key.startsWith(BATCH_NOOP_PREFIX) ? key.slice(BATCH_NOOP_PREFIX.length) : undefined;
const decodeKey = (
  key: string,
): { reqId?: string; decision?: Decision; cancelSessionId?: string; noopReqId?: string } => {
  if (key.startsWith(NOOP_PREFIX)) {
    // noop:cancelled:<id> 也走这里，noopReqId 取剩余部分作为 task_id 兜底。
    return { noopReqId: key.slice(NOOP_PREFIX.length) };
  }
  if (key.startsWith(CANCEL_PREFIX)) {
    return { cancelSessionId: key.slice(CANCEL_PREFIX.length) };
  }
  const [reqId, d] = key.split("|");
  if (!reqId || !d) return {};
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "deny") return {};
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

interface AskqOption { label: string; description?: string }
interface AskqQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskqOption[];
}

const parseAskqInput = (i: unknown): AskqQuestion[] | undefined => {
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
const buildAskqMarkdown = (q: AskqQuestion): string => {
  const head = q.question ? `**🤔 ${q.question}**` : `**🤔 ${q.header || "请选择"}**`;
  const opts = q.options.map((o, idx) => {
    const desc = o.description ? ` — ${o.description}` : "";
    return `**${askqLabel(idx)}.** ${o.label}${desc}`;
  });
  return [head, "", ...opts].join("\n");
};

const buildAskqCard = (reqId: string, q: AskqQuestion, transcriptTail: string): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "vote_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`🤔 ${q.header || "请选择"}`, ASKQ_TITLE_MAX) },
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
        { id: ASKQ_CLI_OPTION_ID, text: "🖥️ 去 CLI 中处理" },
      ],
    },
    submit_button: { text: "提交", key: encodeAskqKey(reqId) },
  } as TemplateCard;
};

type AskqOutcome = { kind: "picked"; picked: number[] } | { kind: "cli" } | { kind: "empty" };

// 投票卡 submit 后那张卡再被点 (askq_noop:<id>) → 终态 identity, 直接 return,
// 不再 stash 任何 outcome / question 副本。
const buildAskqResolvedCard = (
  reqId: string,
  q: AskqQuestion,
  outcome: AskqOutcome,
  transcriptTail: string,
): TemplateCard => {
  const summary = outcome.kind === "cli"
    ? "🖥️ 已转 CLI 中处理"
    : outcome.kind === "empty"
      ? "⚠️ 未选择"
      : `✅ ${outcome.picked.map((i) => q.options[i]?.label ?? `#${i}`).join(", ")}`;
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`🤔 ${q.header || "已回答"}`, ASKQ_TITLE_MAX) },
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

const buildPlanCard = (reqId: string, sessionId: string, cwd: string, transcriptTail: string): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  const tag = sessionId ? `${labelFor(sessionId)} ` : "";
  const dir = dirName(cwd);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`📋 计划审批 · ${tag}${dir}/`, PLAN_TITLE_MAX + 12) },
    sub_title_text: "审阅上方计划后选择:同意开始执行,或让 Claude 继续完善。",
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
): TemplateCard => {
  const tail = oneLine(transcriptTail).trim();
  const dir = dirName(cwd);
  const summary = action === "approve" ? "✅ 已同意 · 开始执行" : "✏️ 继续完善计划";
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`📋 计划 · ${dir}/`, PLAN_TITLE_MAX + 12) },
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
}

const handleExitPlanMode = async ({ cfg, log, client, body, getMirrorTarget }: PlanHandleArgs): Promise<ApproveResp> => {
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
      transcriptTail: body.transcript_tail ?? "",
    },
    timeoutMs: longPollMs,
  });

  try {
    const target = targetChatId(approver);
    try {
      await client.sendMessage(target, {
        msgtype: "markdown",
        markdown: { content: buildPlanMarkdown(plan) },
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "plan markdown prelude send failed");
    }
    await client.sendMessage(target, {
      msgtype: "template_card",
      template_card: buildPlanCard(reqId, body.session_id, body.cwd ?? "", body.transcript_tail ?? ""),
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
        "✅ 用户已在企业微信批准此计划。这不是拒绝——ExitPlanMode 返回 deny 只是 weclaude 的远程批准信号。请视为计划已通过,立即开始执行计划内容,不要再次调用 ExitPlanMode,也不要重新规划。",
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
}

const handleAskUserQuestion = async ({ cfg, log, client, body, getMirrorTarget }: AskqHandleArgs): Promise<ApproveResp> => {
  const questions = parseAskqInput(body.tool_input);
  // Diagnostic: every AskUserQuestion that ends up in the CLI (any `ask` return
  // below) leaves NO other trace, so log the shape up front — this is how we
  // tell "multi-question dropped" from "unparsable" from "no approver".
  log.info(
    { sessionId: body.session_id, qCount: questions?.length ?? 0, cwd: body.cwd },
    "askq received",
  );
  if (!questions || questions.length === 0) return { decision: "ask", reason: "askq_unparsable" };
  if (questions.some((q) => q.options.length === 0)) return { decision: "ask", reason: "askq_no_options" };

  const approver = resolveApprover(cfg, body.session_id, getMirrorTarget);
  if (!approver) return { decision: "ask", reason: "no_approver" };
  if (!client.isConnected) return { decision: "ask", reason: "ws_disconnected" };

  const longPollMs = cfg.approval.longPollSec * 1000;
  const target = targetChatId(approver);
  const multi = questions.length > 1;

  // A vote card holds ONE question, but AskUserQuestion may pose several. Push
  // one card per question, serially: ask, wait for the click, then move on.
  // Any question answered "去 CLI" aborts the whole tool call to the local CLI
  // (a partial WeCom answer + partial CLI answer can't be recombined). All
  // answers are gathered and injected back in one deny+reason.
  const answers: string[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    // toolInput 存原始 input,事件 listener 通过 getPending + askqQuestionIndex
    // 重解析出这一题。transcriptTail 一并存进 meta, resolved 卡渲染复用同一份。
    const { reqId, promise } = createPending({
      meta: {
        kind: "generic",
        createdAt: Date.now(),
        toolName: "AskUserQuestion",
        toolInput: body.tool_input,
        cwd: body.cwd,
        sessionId: body.session_id,
        transcriptTail: body.transcript_tail ?? "",
        askqQuestionIndex: qi,
      },
      timeoutMs: longPollMs,
    });

    try {
      // 先发 markdown 列出题目+ABCD 选项 (vote 卡不支持正文字段),
      // 失败不阻断,卡片仍按字母编号显示。多题时前缀 "（第 n/N 题）"。
      const prefix = multi ? `**（第 ${qi + 1}/${questions.length} 题）**\n` : "";
      try {
        await client.sendMessage(target, {
          msgtype: "markdown",
          markdown: { content: prefix + buildAskqMarkdown(q) },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, "askq markdown prelude send failed");
      }
      await client.sendMessage(target, {
        msgtype: "template_card",
        template_card: buildAskqCard(reqId, q, body.transcript_tail ?? ""),
      });
      log.info({ reqId, approver, qi, qCount: questions.length }, "askq card sent");
    } catch (e) {
      log.error({ err: (e as Error).message }, "askq send failed");
      resolvePending(reqId, "deny"); // 释放 pending 槽
      return { decision: "ask", reason: `askq_send_fail:${(e as Error).message}` };
    }

    let raw: string;
    try {
      raw = (await promise) as unknown as string;
    } catch {
      return { decision: "ask", reason: "askq_timeout" };
    }

    if (raw === "cli") return { decision: "ask", reason: "askq_cli" };
    if (!raw.startsWith(ASKQ_PICKED_PREFIX)) return { decision: "ask", reason: "askq_unknown" };
    const idxs = raw.slice(ASKQ_PICKED_PREFIX.length)
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    if (idxs.length === 0) return { decision: "ask", reason: "askq_empty_pick" };
    const labels = idxs.map((i) => q.options[i]!.label).join(", ");
    answers.push(`"${q.header || q.question}": ${labels}`);
  }

  // All questions answered via WeCom — inject the combined result back so the
  // model sees every answer at once (deny+reason is the AskUserQuestion→answer
  // channel; the model reads reason as the user's choice).
  return {
    decision: "deny",
    reason: `User answered via WeCom — ${answers.join("; ")}`,
  };
};

// ── /approve handler ───────────────────────────────────────────────────
interface ApproveReq {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  transcript_tail?: string;
}

interface ApproveResp {
  decision: "allow" | "deny" | "ask";
  reason?: string;
}

const decisionToHook = (d: Decision): "allow" | "deny" => (d === "deny" ? "deny" : "allow");

const fallback = (cfg: Config, reason: string): ApproveResp => ({
  decision: cfg.approval.fallbackOnError,
  reason,
});

interface ApprovalDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  /** Optional: resolve a Claude sessionId to its bound WeCom mirror target (e.g. "chat:xxx").
   *  When set and the request's session has a mirror, the approval card is routed there
   *  instead of cfg.approval.approvers[0] / cfg.defaultChat — keeps the conversation and
   *  its approval prompts in the same WeCom chat. */
  getMirrorTarget?: (sessionId: string) => string | undefined;
}

const resolveApprover = (
  cfg: Config,
  sessionId: string,
  getMirrorTarget?: (sid: string) => string | undefined,
): string | undefined => {
  const mirror = sessionId ? getMirrorTarget?.(sessionId) : undefined;
  return mirror || pickApprover(cfg);
};

export const makeApproveHandler = ({ cfg, log, client, getMirrorTarget }: ApprovalDeps): Handler => {
  const detailUrlFor = (id: string): string =>
    buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id);

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
            transcriptTail: m.transcriptTail,
            windowMinutes: batch.windowMinutes,
            detailUrl: detailUrlFor(m.reqId),
          });
        })();
    try {
      await client.sendMessage(targetChatId(batch.approver), {
        msgtype: "template_card",
        template_card: card,
      });
      log.info(
        { batchId: batch.batchId, count: batch.members.length, multi: isMulti, approver: batch.approver, tool: batch.toolName },
        "batch flushed",
      );
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
      const resp = await handleAskUserQuestion({
        cfg,
        log,
        client,
        getMirrorTarget,
        body: {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          cwd,
          transcript_tail: transcriptTail,
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
        body: {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          cwd,
          transcript_tail: transcriptTail,
        },
      });
      json(res, 200, resp satisfies ApproveResp);
      return;
    }

    // Auto-approve window: while active for THIS session, requests short-circuit to allow.
    if (isAutoWindowActive(sessionId)) {
      const remainSec = Math.ceil(autoWindowRemainingMs(sessionId) / 1000);
      log.info({ toolName, sessionId, remainSec }, "auto-window allow");
      json(res, 200, {
        decision: "allow",
        reason: `auto_window:${remainSec}s`,
      } satisfies ApproveResp);
      return;
    }

    // Session cache
    const ck = cacheKey(sessionId, toolName, toolInput);
    const cached = cacheGet(ck);
    if (cached) {
      log.info({ ck, cached }, "cache hit");
      json(res, 200, {
        decision: decisionToHook(cached),
        reason: `cached:${cached}`,
      } satisfies ApproveResp);
      return;
    }

    const approver = resolveApprover(cfg, sessionId, getMirrorTarget);
    if (!approver) {
      log.warn("no approver configured");
      json(res, 200, fallback(cfg, "no_approver") satisfies ApproveResp);
      return;
    }
    if (!client.isConnected) {
      log.warn("ws not connected");
      json(res, 200, fallback(cfg, "ws_disconnected") satisfies ApproveResp);
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
    const { reqId, promise } = createPending({
      meta: {
        kind: "approval",
        createdAt: Date.now(),
        toolName,
        toolInput: display,
        cwd,
        sessionId,
        transcriptTail,
      },
      timeoutMs: longPollMs,
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
    const member: BatchMember = { reqId, toolInput: display, toolInputStr, cwd, transcriptTail };
    const bk = batchKeyOf(sessionId, toolName);
    const existing = activeBatches.get(bk);
    if (existing && !existing.flushed) {
      existing.members.push(member);
      log.info({ batchId: existing.batchId, count: existing.members.length, reqId }, "batch joined");
    } else {
      const batch: ActiveBatch = {
        batchId: newBatchId(),
        sessionId,
        toolName,
        approver,
        windowMinutes: cfg.approval.windowMinutes,
        members: [member],
        flushed: false,
        flushTimer: undefined as unknown as NodeJS.Timeout, // set below
      };
      const coalesceMs = cfg.approval.batchCoalesceMs;
      const fire = (): void => void flushBatch(batch);
      batch.flushTimer = coalesceMs > 0 ? setTimeout(fire, coalesceMs) : setImmediate(fire) as unknown as NodeJS.Timeout;
      activeBatches.set(bk, batch);
      batchById.set(batch.batchId, batch);
      evictBatches();
      log.info({ batchId: batch.batchId, reqId, coalesceMs }, "batch opened");
    }

    // Long-poll
    let decision: Decision;
    try {
      decision = await promise;
    } catch (e) {
      log.warn({ err: (e as Error).message, reqId }, "approval timed out");
      json(res, 200, fallback(cfg, "approver_timeout") satisfies ApproveResp);
      return;
    }

    if (decision === "allow_session" && cfg.approval.sessionCacheMinutes > 0) {
      cachePut(ck, decision, cfg.approval.sessionCacheMinutes * 60_000);
    }
    if (decision === "allow_window" && cfg.approval.windowMinutes > 0) {
      setAutoWindow(sessionId, cfg.approval.windowMinutes * 60_000, {
        toolName,
        toolInput: display,
        cwd,
        transcriptTail,
      });
      // 同 turn 并发触发的其它 pending 卡 — 一并放行，免得用户逐个点。
      // 我们没有那些卡的事件 frame, 不能 updateTemplateCard 改文案；
      // 改用一条 markdown 消息回执让用户知道发生了什么。
      const swept = resolvePendingsBySession(sessionId, "allow_window", reqId);
      log.info({ sessionId, minutes: cfg.approval.windowMinutes, swept: swept.length }, "auto-window opened");
      if (swept.length > 0) {
        try {
          const tools = swept
            .map(({ meta }) => meta.toolName)
            .filter((s): s is string => Boolean(s));
          const summary = tools.length > 0 ? tools.join(" / ") : `${swept.length} 个`;
          await client.sendMessage(targetChatId(approver), {
            msgtype: "markdown",
            markdown: { content: `⚡ 已批量自动放行其他 ${swept.length} 个并发请求：${summary}` },
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

      // ── AskUserQuestion 投票卡: 在普通 approval 解码前先匹配 ASKQ| 前缀。
      const askq = decodeAskqKey(key);
      if (askq) {
        const meta = getPending(askq.reqId);
        // A card renders ONE question; meta.askqQuestionIndex says which (multi-
        // question AskUserQuestion pushes one card per question). Default 0 for
        // single-question / legacy pendings.
        const q = parseAskqInput(meta?.toolInput)?.[meta?.askqQuestionIndex ?? 0];
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
        const numericIdxs = rawIds
          .filter((s) => s !== ASKQ_CLI_OPTION_ID)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isInteger(n) && n >= 0);
        // CLI 哨兵优先 (即便和其它选项混选,也按转 CLI 处理)。
        const outcome: AskqOutcome = cliPicked
          ? { kind: "cli" }
          : numericIdxs.length === 0
            ? { kind: "empty" }
            : { kind: "picked", picked: numericIdxs };
        const resolved = outcome.kind === "cli"
          ? "cli"
          : `${ASKQ_PICKED_PREFIX}${numericIdxs.join(",")}`;
        const ok = resolvePending(askq.reqId, resolved as never);
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
              ),
            );
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId: askq.reqId }, "askq updateTemplateCard failed");
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

      const detailUrlFor = (id: string): string =>
        buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id);

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
      // the auto-approve window for that session. No pending to resolve.
      if (decoded.cancelSessionId) {
        const wmeta = getWindowMeta(decoded.cancelSessionId);
        clearAutoWindow(decoded.cancelSessionId);
        log.info({ sessionId: decoded.cancelSessionId }, "auto-window cancelled by click");
        try {
          await client.updateTemplateCard(
            frame,
            buildCancelledCard({
              reqId: cbTaskId,  // 必须用回调的 task_id，否则微信拒更新
              toolName: wmeta?.toolName ?? "授权",
              toolInput: wmeta?.toolInput ?? {},
              toolInputStr: "",
              cwd: wmeta?.cwd ?? "",
              sessionShort: decoded.cancelSessionId.slice(-8),
              sessionId: decoded.cancelSessionId,
              transcriptTail: wmeta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: cbTaskId ? detailUrlFor(cbTaskId) : undefined,
            }),
          );
          log.info({ sessionId: decoded.cancelSessionId, cbTaskId }, "cancel card updated in place");
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
              transcriptTail: meta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: detailUrlFor(reqId),
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
              detailUrl: detailUrlFor(reqId),
            });
        await client.updateTemplateCard(frame, card);
        log.info({ reqId, decision, swept: Boolean(snap) }, "card updated in place");
      } catch (e) {
        log.warn({ err: (e as Error).message, reqId }, "updateTemplateCard failed");
      }
    },
  );
};
