// Declarative config: schema (zod) + loader. Pure transforms, file IO at boundary.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { expandHome } from "./paths.js";

// ── Schema ──────────────────────────────────────────────────────────
const Bot = z.object({
  botId: z.string().min(1),
  secret: z.string().min(1),
  websocketUrl: z.string().url().default("wss://openws.work.weixin.qq.com"),
  // Forward proxy for outbound egress (WeCom WebSocket + file download). Needed
  // on internal-network hosts with no direct route to openws.work.weixin.qq.com.
  // The `ws` lib does NOT honor HTTPS_PROXY env vars, so the WebSocket needs an
  // explicit agent — env-only proxy setups leave wsConnected stuck false.
  // Empty → fall back to HTTPS_PROXY / https_proxy env, else no proxy.
  proxy: z.string().default(""),
});

const Daemon = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(17890),
  stateDir: z.string().default("~/.weclaude/state"),
  logFile: z.string().default("~/.weclaude/daemon.log"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  // 工具调用 / 授权详情页 URL。空则用 http://<host>:<port> (回环)。
  // 想让手机 WeCom 也能点开, 需要在反向代理后填外网地址。桌面端用回环即可。
  detailPublicBase: z.string().default(""),
  // 镜像消息里给每个 tool_use 行包成 markdown 链接, 点开本地 HTML 详情页。
  detailLinksInMirror: z.boolean().default(true),
});

const Mirror = z.object({
  // Where Claude Code writes per-project transcripts. Forks like `claude-internal`
  // use a parallel dir (e.g. `~/.claude-internal/projects`). The mirror tails
  // `<projectsDir>/<encoded(wrc.cwd)>/<sid>.jsonl`. Empty → auto-derive from
  // `wrc.claudeBin` basename (handled by the Wrc transform below): `claude` →
  // `~/.claude/projects`, `claude-internal` → `~/.claude-internal/projects`.
  projectsDir: z.string().default(""),
  // Pin a specific Claude session to mirror. Empty → auto-pick latest .jsonl
  // under `<projectsDir>/<encoded(wrc.cwd)>/` by mtime.
  sessionId: z.string().default(""),
  // Where to push live assistant output. Empty → fall back to defaultChat.
  pushChat: z.string().default(""),
  // Cap a single push payload (WeCom markdown ~2048 limit). Long replies are split.
  chunkChars: z.number().int().positive().default(1800),
  // Mirror the user's CLI prompts (type:"user" with string content). Off by
  // default: WeCom-sourced inbounds get dedup'd anyway, and local CLI typing
  // is rare in the bot-driven flow — keeping it on mostly produced echo noise.
  includeUser: z.boolean().default(false),
  // Mirror assistant tool_use blocks (Bash/Edit/Read/...).
  includeTools: z.boolean().default(true),
  // Mirror tool_result blocks. Off by default — usually noisy.
  includeToolResults: z.boolean().default(false),
  // Truncate each tool_result body to this many chars.
  toolResultMaxChars: z.number().int().positive().default(400),
  // 工具调用气泡里 `compact` 一行的最大字符数 (`🔧 Name <compact>` / `[• compact](url)`).
  // 旧值 40 太窄, 长 bash / 长 file_path 直接被截掉; 抬到 120 兼顾可读与单行。
  toolUseInlineMaxChars: z.number().int().positive().default(120),
  // Where inbound images/files from WeCom get saved before being pasted into
  // the live TTY. Files persist — claude reads them by absolute path.
  inboxDir: z.string().default("~/.weclaude/inbox"),
  // Persisted mirror attachments (principal → sessionId/jsonl/tmux). Restored
  // on daemon boot + lazily on first inbound after reload — so reloading the
  // daemon doesn't re-spawn a fresh claude for an already-bound chat.
  attachmentsFile: z.string().default("~/.weclaude/mirror-attachments.json"),
  // Standalone fallback 路径(liveStream 已 closed/dead/capped) 上的防抖聚合窗口
  // (ms)。窗口内同一 attachment 的多个 item 合并为一条 markdown, 抑制连续工具
  // 调用刷屏。liveStream 仍活时不受影响——直接走 typewriter。0 = 关闭。
  standaloneDebounceMs: z.number().int().nonnegative().default(3000),
  // dispatch 后延迟开 stream 的窗口 (ms)。窗口内 item 累积:
  //   • 出现 needs-approval tool_use → 立刻把 buffer 聚合成单条 standalone 推出 (赶在
  //     授权卡之前), 切到 AWAITING_APPR 等点击; 点击后再开 stream 续 tool_result+回复。
  //   • 窗口内 turn_end (纯文本快回复) → buffer 整体作为一条 standalone, 不开 stream。
  //   • 窗口超时 → 正常开 stream, 重放 buffer。
  // 0 = 关闭, 退回到 dispatch 立即 ack "…" 的旧行为。
  outboundDeferMs: z.number().int().nonnegative().default(3000),
});

const Wrc = z.object({
  allowFrom: z.array(z.string()).default([]),
  mode: z.enum(["headless", "mirror"]).default("headless"),
  claudeBin: z.string().default("claude"),
  cwd: z.string().default("~/.weclaude/workspace"),
  sessionMapFile: z.string().default("~/.weclaude/sessions.json"),
  extraArgs: z.array(z.string()).default([]),
  mirror: Mirror.default({}),
  // Mirror-only: tmux session name prefix for auto-spawn. Final name is
  // `${prefix}-<short>`. Auto-spawn fires when an authorized inbound finds no
  // mirror attached for that chat — allowFrom IS the authorization.
  tmuxPrefix: z.string().default("weclaude"),
}).transform((v) => {
  // Auto-derive projectsDir from claudeBin basename when not explicitly set.
  // `claude` → `~/.claude/projects`, `claude-internal` → `~/.claude-internal/projects`.
  // Without this, a user running claude-internal sees the daemon tailing the
  // wrong dir → pane→chat silently drops every reply.
  if (!v.mirror.projectsDir) {
    const name = v.claudeBin.split("/").pop() || "claude";
    v.mirror.projectsDir = `~/.${name}/projects`;
  }
  return v;
});

const Approval = z.object({
  enabled: z.boolean().default(true),
  matcher: z.string().default(".*"),
  approvers: z.array(z.string()).default([]),
  hookTimeoutSec: z.number().int().positive().default(7210),
  longPollSec: z.number().int().positive().default(7200),
  sessionCacheMinutes: z.number().int().nonnegative().default(30),
  windowMinutes: z.number().int().nonnegative().default(10),
  sensitiveArgRedact: z.boolean().default(true),
  fallbackOnError: z.enum(["ask", "allow", "deny"]).default("ask"),
  // 同 session 同 tool 的并发 PreToolUse 合流窗口: 第一次到达后等待这么久,
  // 期间到的同类请求合成一张批量卡 (减少 N 张并发卡的轰炸)。0 = 关闭聚合,
  // 每次立刻发卡 (旧行为)。单次到达走单卡路径, 仅多了一次性的延迟。
  batchCoalesceMs: z.number().int().nonnegative().default(250),
  // 拦截 model 主动调用的 EnterPlanMode (deny + reason),让 Claude 不要自动进
  // plan mode、直接干活。用户仍可在本地 Shift+Tab 手动进 plan mode(那条路径
  // 不过 hook)。默认 true。设 false 恢复原行为(允许模型自动进 plan mode)。
  blockAutoPlanMode: z.boolean().default(true),
});

const SyncTarget = z.object({
  // 仅作为 sync 日志里的标签使用; 真正决定写入位置的是 settingsPath。
  // 留成自由字符串以兼容 claude / claude-internal / custom 等任何 fork。
  kind: z.string().default("claude"),
  settingsPath: z.string(),
  scope: z.enum(["user", "project", "local"]).default("user"),
});
const Sync = z.object({
  targets: z.array(SyncTarget).default([]),
});

export const ConfigSchema = z.object({
  bot: Bot,
  defaultChat: z.string().default(""),
  daemon: Daemon.default({}),
  wrc: Wrc.default({}),
  approval: Approval.default({}),
  sync: Sync.default({ targets: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG_PATHS = [
  "~/.weclaude/config.jsonc",
  "~/.weclaude/config.json",
];
const SECRETS_PATH = "~/.weclaude/secrets.json";

const readJsoncIfExists = (p: string): unknown | undefined => {
  const abs = expandHome(p);
  if (!existsSync(abs)) return undefined;
  const text = readFileSync(abs, "utf8");
  return parseJsonc(text);
};

const deepMerge = <T extends Record<string, unknown>>(a: T, b: Partial<T>): T => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    const av = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av)) {
      out[k] = deepMerge(av as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined && v !== "") {
      out[k] = v;
    }
  }
  return out as T;
};

/** Resolve config path: explicit > $WECLAUDE_CONFIG > defaults. */
const resolveConfigPath = (explicit?: string): string | undefined => {
  if (explicit) return explicit;
  if (process.env.WECLAUDE_CONFIG) return process.env.WECLAUDE_CONFIG;
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (existsSync(expandHome(p))) return p;
  }
  return undefined;
};

export interface LoadResult {
  config: Config;
  sourcePath: string;
}

export const loadConfig = (explicitPath?: string): LoadResult => {
  const sourcePath = resolveConfigPath(explicitPath);
  if (!sourcePath) {
    throw new Error(
      `weclaude config not found. Create ~/.weclaude/config.jsonc (see config.example.jsonc) or set $WECLAUDE_CONFIG.`,
    );
  }
  const base = (readJsoncIfExists(sourcePath) ?? {}) as Record<string, unknown>;
  const secrets = (readJsoncIfExists(SECRETS_PATH) ?? {}) as Record<string, unknown>;
  const merged = deepMerge(base, secrets);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`weclaude config invalid (${sourcePath}):\n${issues}`);
  }
  return { config: parsed.data, sourcePath: expandHome(sourcePath) };
};
