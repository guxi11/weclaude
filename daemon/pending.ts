// Pending request store: req_id → resolver. In-memory, daemon-lifetime.
// Used for both PreToolUse approvals and any other "send card → wait click" flows.
import { randomUUID } from "node:crypto";

export type Decision = "allow" | "allow_session" | "allow_window" | "deny";

export interface PendingMeta {
  kind: "approval" | "generic";
  createdAt: number;
  toolName?: string;
  toolInput?: unknown;
  cwd?: string;
  sessionId?: string;
  transcriptTail?: string;
  // For AskUserQuestion cards: which question in tool_input.questions THIS card
  // renders. AskUserQuestion may carry several questions but a vote card holds
  // only one, so we push one card per question — each pending records its index
  // so the resolved-card renderer picks the right question (not always [0]).
  askqQuestionIndex?: number;
}

interface Pending {
  meta: PendingMeta;
  resolve: (decision: Decision) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const store = new Map<string, Pending>();

export interface CreatePendingOpts {
  meta: PendingMeta;
  timeoutMs: number;
}

export interface PendingHandle {
  reqId: string;
  promise: Promise<Decision>;
}

export const createPending = ({ meta, timeoutMs }: CreatePendingOpts): PendingHandle => {
  const reqId = randomUUID();
  const promise = new Promise<Decision>((resolve, reject) => {
    const timer = setTimeout(() => {
      store.delete(reqId);
      reject(new Error("pending_timeout"));
    }, timeoutMs);
    store.set(reqId, { meta, resolve, reject, timer });
  });
  return { reqId, promise };
};

export const resolvePending = (reqId: string, decision: Decision): boolean => {
  const p = store.get(reqId);
  if (!p) return false;
  clearTimeout(p.timer);
  store.delete(reqId);
  p.resolve(decision);
  return true;
};

// Used by batch send-failure: kicks each member's awaiting handler into its
// catch path so it can return the configured fallbackOnError (incl. "ask").
export const failPending = (reqId: string, err: Error): boolean => {
  const p = store.get(reqId);
  if (!p) return false;
  clearTimeout(p.timer);
  store.delete(reqId);
  p.reject(err);
  return true;
};

export const getPending = (reqId: string): PendingMeta | undefined => store.get(reqId)?.meta;

export const listPending = (): Array<{ reqId: string; meta: PendingMeta }> =>
  Array.from(store.entries()).map(([reqId, p]) => ({ reqId, meta: p.meta }));

// ── Resolved snapshot stash ─────────────────────────────────────────────
// Sweep 路径会先 resolve 掉同 session 的并发 pending — 但那些卡片仍在 WeCom 上
// 显示三按钮态(我们没拿到它们的 frame，没法主动 update)。用户后续若点了这些
// "鬼卡"，handler 需要原始 toolName/cwd 才能把 update 渲染成正确的"已自动放行"
// 形态，否则会看到 (probe) · /。这里给 sweep 留 5min 的 meta 副本兜底。
interface ResolvedSnapshot {
  meta: PendingMeta;
  decision: Decision;
  resolvedAt: number;
}
const resolvedStash = new Map<string, ResolvedSnapshot>();
const RESOLVED_TTL_MS = 5 * 60_000;
const RESOLVED_MAX = 200;

const gcResolved = (): void => {
  const cutoff = Date.now() - RESOLVED_TTL_MS;
  for (const [k, v] of resolvedStash) {
    if (v.resolvedAt < cutoff) resolvedStash.delete(k);
  }
};

const stashResolved = (reqId: string, meta: PendingMeta, decision: Decision): void => {
  resolvedStash.set(reqId, { meta, decision, resolvedAt: Date.now() });
  if (resolvedStash.size > RESOLVED_MAX) gcResolved();
};

export const getResolvedSnapshot = (
  reqId: string,
): { meta: PendingMeta; decision: Decision } | undefined => {
  const e = resolvedStash.get(reqId);
  if (!e) return undefined;
  if (Date.now() - e.resolvedAt > RESOLVED_TTL_MS) {
    resolvedStash.delete(reqId);
    return undefined;
  }
  return { meta: e.meta, decision: e.decision };
};

// 批量 resolve 同 session 下仍在长轮询的 approval 请求。
// 用途: 用户点 allow_window 时，Claude 同 turn 并发触发的其它 pending 卡
// 不应再要求逐个点击 — 直接按 decision 放行。返回被放行的 (reqId, meta) 列表，
// 供调用方做提示展示 (resolve 后 store 里就拿不到 meta 了)。
export const resolvePendingsBySession = (
  sessionId: string,
  decision: Decision,
  excludeReqId?: string,
): Array<{ reqId: string; meta: PendingMeta }> => {
  const hits: Array<{ reqId: string; meta: PendingMeta }> = [];
  for (const [reqId, p] of store.entries()) {
    if (reqId === excludeReqId) continue;
    if (p.meta.kind !== "approval") continue;
    if (p.meta.sessionId !== sessionId) continue;
    hits.push({ reqId, meta: p.meta });
  }
  hits.forEach(({ reqId, meta }) => {
    stashResolved(reqId, meta, decision);
    resolvePending(reqId, decision);
  });
  return hits;
};
