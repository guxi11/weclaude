// Declarative config: schema (zod) + loader. Pure transforms, file IO at boundary.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { expandHome } from "./paths.js";
import { resolveCliBackend } from "./cli-backends.js";

// ── Schema ──────────────────────────────────────────────────────────
const Bot = z.object({
  botId: z.string().min(1),
  secret: z.string().min(1),
  websocketUrl: z.string().url().default("wss://openws.work.weixin.qq.com"),
});

const Daemon = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(17890),
  stateDir: z.string().default("~/.wezard/state"),
  logFile: z.string().default("~/.wezard/daemon.log"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  // 工具调用 / 授权详情页 URL。空则用 http://<host>:<port> (回环)。
  // 想让手机 WeCom 也能点开, 需要在反向代理后填外网地址。桌面端用回环即可。
  detailPublicBase: z.string().default(""),
  // 远端 detail svr (wezard svr 起的独立服务, chat + cli 共同可达的网络里)。
  // 空则不转发, 详情走本机 :port/detail。非空时:
  //   • 每次 record*() 后 fire-and-forget POST 到 <base>/d, 存到远端 store。
  //   • buildDetailUrl 用 <base> 作为链接根 (chat 端浏览器打开 <base>/detail?id=...)。
  // 用这条路径解决 daemon (公司内网) 和 chat 用户 (移动网络) 不同网段的场景。
  detailRemoteBase: z.string().default(""),
  detailRemoteToken: z.string().default(""),
  // 镜像消息里给每个 tool_use 行包成 markdown 链接, 点开本地 HTML 详情页。
  detailLinksInMirror: z.boolean().default(true),
});

const Mirror = z.object({
  // Transcript root for the DEFAULT backend only — an escape hatch for a
  // nonstandard location. Empty → auto-derived from `defaultCli` (`claude` →
  // `~/.claude/projects`, `claude-internal` → `~/.claude-internal/projects`,
  // `codebuddy` → `~/.codebuddy/projects`). Other installed backends always use
  // their own built-in roots; the mirror probes all of them, so setting this
  // does not narrow which CLIs can be mirrored.
  projectsDir: z.string().default(""),
  // Pin a specific Claude session to mirror. Empty → auto-pick latest .jsonl
  // under `<projectsDir>/<encoded(wrc.cwd)>/` by mtime.
  sessionId: z.string().default(""),
  // Where to push live assistant output. Empty → fall back to defaultChat.
  pushChat: z.string().default(""),
  // Cap a single push payload in BYTES (WeCom markdown caps `content` at 4096
  // UTF-8 bytes). Long replies are split into that many bytes per page, minus
  // the tag header. Shared/md-chunk measures in bytes too — CJK is 3 bytes/char.
  chunkBytes: z.number().int().positive().default(3800),
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
  inboxDir: z.string().default("~/.wezard/inbox"),
  // Persisted mirror attachments (principal → sessionId/jsonl/tmux). Restored
  // on daemon boot + lazily on first inbound after reload — so reloading the
  // daemon doesn't re-spawn a fresh claude for an already-bound chat.
  attachmentsFile: z.string().default("~/.wezard/mirror-attachments.json"),
  // Standalone fallback 路径(liveStream 已 closed/dead/capped) 上的防抖聚合窗口
  // (ms)。窗口内同一 attachment 的多个 item 合并为一条 markdown, 抑制连续工具
  // 调用刷屏。liveStream 仍活时不受影响——直接走 typewriter。0 = 关闭。
  standaloneDebounceMs: z.number().int().nonnegative().default(30000),
  // dispatch 后延迟开 stream 的窗口 (ms)。窗口内 item 累积:
  //   • 出现 needs-approval tool_use → 立刻把 buffer 聚合成单条 standalone 推出 (赶在
  //     授权卡之前), 切到 AWAITING_APPR 等点击; 点击后再开 stream 续 tool_result+回复。
  //   • 窗口内 turn_end (纯文本快回复) → buffer 整体作为一条 standalone, 不开 stream。
  //   • 窗口超时 → 正常开 stream, 重放 buffer。
  // 0 = 关闭, 退回到 dispatch 立即 ack "…" 的旧行为。
  outboundDeferMs: z.number().int().nonnegative().default(3000),
  // 发卡前等待目标 tool_use 在 jsonl 落盘的最长 poll 时间 (ms)。Claude Code 的
  // assistant 行写盘相对 PreToolUse hook fire 有 tens-to-hundreds ms 异步抖动,
  // 没等到的话 drain 抓空, 卡先到、思考过程后到。轮询步进 50ms。0 = 关闭等待,
  // 仅做一次同步 drain (旧行为)。
  flushBeforeCardWaitMs: z.number().int().nonnegative().default(800),
  // codebuddy 对 AskUserQuestion 不在提问时触发 PreToolUse hook (先弹本地面板),
  // mirror 从 jsonl 提前探测到 function_call 后直接下发 vote 卡。该卡与本地面板
  // 竞争 — 面板本就无限期阻塞 turn, 卡对齐 longPollSec 的 12h; 本地先答会作废它。
  askqVoteTimeoutSec: z.number().int().positive().default(43200),
  // 发卡前从活着的 tmux pane 抠出「为什么发这张卡」的 assistant 前言并先推一条。
  // 必要性: Claude Code 把以 tool_use 收尾的整个 turn 攒着, 等工具 resolve 才 flush
  // 到 jsonl —— 而工具正卡在这张授权卡上, 于是前言在发卡时点既不在 jsonl 也不在
  // hook 的 transcript_tail 里, 唯一存在处是 pane。抠不到时静默退回「只发卡」(无回归)。
  panePreamble: z.boolean().default(true),
  // Brief 模式: 只对 mirror 模式生效。一个 turn 里群里只发两条 —
  //   1. turn 起始时:「🧵 [本轮详情](url)」链接 (指向聚合详情页,含所有 tool 输入/输出+中间文本+折叠展示)
  //   2. turn 结束时: Claude 的 finish text (最终 assistant 回复)
  // 中间 tool_use / tool_result / thinking / 非 final text 全部只写进详情页,不发气泡。
  // 授权卡照常发群 (交互无法替代)。false = 现状 (逐条气泡)。
  brief: z.boolean().default(true),
  // 斜杠命令回执精简: /clear、/new 等会话边界命令的回执只发第一行 ack
  // ("cleared" / "created"), 不再附 💡 tip。cwd 信息一律不随回执下发, 随时
  // `/pwd` 可查。默认 false = ack + tip 两行气泡。
  slashAckFirstLine: z.boolean().default(false),
  // 软收口静默期 (ms)。codebuddy 后端只能说"这条消息写完了", 等这么久没有新 item
  // 才认定一轮结束。值越大越不容易误收 (model 思考时间长), 但用户等最终结论的延迟也
  // 越大。不设则按后端自动选择: codebuddy 10s, claude 4s。
  softTurnEndMs: z.number().int().positive().optional(),
  // ── Prompt-cache keepalive ────────────────────────────────────────────
  // Anthropic prompt caching: cache-write costs 1.25x, cache-read 0.1x, and the
  // cache lives only ~5min. A pane that goes idle (agent parked waiting on a
  // peer, or a long background task) lets that cache expire — so the next real
  // turn pays a full 1.25x re-write of the entire context. keepalive injects a
  // tiny ping just before expiry: it re-reads the cached prefix (0.1x) and
  // slides the TTL forward, so the eventual real turn only writes the delta.
  keepalive: z
    .object({
      // Master switch. Off → no pings, no timer overhead.
      enabled: z.boolean().default(true),
      // Prompt-cache TTL (s). Anthropic default is 300 (5min).
      ttlSec: z.number().int().positive().default(300),
      // Fire this many seconds BEFORE ttl expiry — the ping needs slack to land
      // and settle. Effective idle trigger = ttlSec - marginSec.
      marginSec: z.number().int().nonnegative().default(45),
      // How many pings to fire after the last REAL (non-ping) turn before
      // letting the cache go cold. Pings fire at the cadence (ttlSec -
      // marginSec = 255s) — i.e. always just before the cache would expire.
      // Real activity resets the count, so 6 pings = ~26min of bridging
      // restarts from each genuine turn. Each ping is a near-free cache-read;
      // a single cold-rewrite of a large context costs ~1.25x of its full
      // size, so a handful of pings beats letting it expire while the user
      // is still around.
      rounds: z.number().int().positive().default(6),
      // The ping text. Tiny (small cache-write delta) and self-describing so a
      // human glancing at the pane sees why it's there. The reply is swallowed —
      // never mirrored to chat, the detail store, or usage accounting.
      ping: z.string().default('keepalive — reply with just "pong", take no other action'),
      // Stall recovery, gated PURELY by rule — never by the model's own judgment.
      // When the newest transcript turn is a synthetic API-error/limit line
      // ("API Error: Connection closed mid-response", "You've hit your session
      // limit"), or the idle pane footer shows an error banner, a turn died
      // mid-work — so the ping carries `resumePing` (a plain "continue") INSTEAD
      // of `ping`. Any non-"pong" reply to a ping is treated as a real turn
      // (un-swallowed to chat, clocks re-anchored) — so a resumed session shows.
      resumeOnStall: z.boolean().default(true),
      resumePing: z.string().default('continue'),
    })
    .default({}),
});

const Wrc = z.object({
  allowFrom: z.array(z.string()).default([]),
  mode: z.enum(["headless", "mirror"]).default("headless"),
  // Legacy pre-v0.3: single binary path. Still honored as a back-compat alias
  // — resolveCliBackend picks it up when cliBackends.<name>.bin is unset. Kept
  // on the schema so existing configs keep parsing without migration.
  claudeBin: z.string().default("claude"),
  // DEFAULT CLI backend — the one used when there is no transcript to derive a
  // backend from (new-session spawns, headless mode). It is NOT exclusive: the
  // daemon mirrors sessions from every installed CLI concurrently, resolving
  // each attachment's binary + jsonl dialect from its own transcript path
  // (shared/cli-backends.ts bindCliBackends / backendForPath). Optional —
  // when unset, resolveCliBackend infers from claudeBin basename (so legacy
  // `claudeBin: "claude-internal"` configs still resolve correctly without
  // needing to also set defaultCli). The Wrc transform below pins the inferred
  // name back into v.defaultCli so downstream readers see a concrete value.
  defaultCli: z.enum(["claude", "claude-internal", "codebuddy"]).optional(),
  // Per-backend bin overrides. Missing entry → built-in default (`claude`,
  // `claude-internal`, `codebuddy`). Example:
  //   cliBackends: { codebuddy: { bin: "/usr/local/bin/codebuddy" } }
  cliBackends: z
    .object({
      claude: z.object({ bin: z.string().optional() }).optional(),
      "claude-internal": z.object({ bin: z.string().optional() }).optional(),
      codebuddy: z.object({ bin: z.string().optional() }).optional(),
    })
    .default({}),
  cwd: z.string().default("~/.wezard/workspace"),
  sessionMapFile: z.string().default("~/.wezard/sessions.json"),
  extraArgs: z.array(z.string()).default([]),
  mirror: Mirror.default({}),
  // Mirror-only: tmux session name prefix for auto-spawn. Final name is
  // `${prefix}-<short>`. Auto-spawn fires when an authorized inbound finds no
  // mirror attached for that chat — allowFrom IS the authorization.
  tmuxPrefix: z.string().default("wezard"),
}).transform((v) => {
  // Resolve the active backend once — honors defaultCli if set, otherwise
  // infers from claudeBin basename (legacy back-compat). Pin the inferred
  // name back into v.defaultCli so downstream readers see a concrete value
  // and so logs / sync labels can report the effective backend.
  const backend = resolveCliBackend(v);
  if (!v.defaultCli) v.defaultCli = backend.name;
  // Sync claudeBin to the resolved backend's bin so every daemon file that
  // reads cfg.wrc.claudeBin (cc-bridge, mirror-bridge, spawn-tmux, quota)
  // spawns the correct binary — even when the user set only `defaultCli`
  // without an explicit `claudeBin`. Without this, defaultCli:"codebuddy"
  // + inherited claudeBin:"claude" would spawn the wrong CLI.
  v.claudeBin = backend.bin;

  // Auto-derive projectsDir from the resolved backend when not explicitly
  // set. Replaces the old claudeBin-basename derivation — same result for the
  // standard cases (claude → ~/.claude/projects, claude-internal →
  // ~/.claude-internal/projects), plus now supports codebuddy →
  // ~/.codebuddy/projects. Explicit projectsDir still wins.
  if (!v.mirror.projectsDir) {
    v.mirror.projectsDir = backend.projectsDir;
  }
  return v;
});

// 危险操作名单 (daemon/danger.ts)。命中者强制单次审批: 不吃 auto-window、
// 不吃 session cache、不参与批量合流、卡上没有「全过」按钮、超时不静默放行。
// patterns 都是 JS 正则源码串, 大小写不敏感; allowPatterns 优先级最高。
const Danger = z.object({
  enabled: z.boolean().default(true),
  // true = 命中危险名单也直接放行 (显式的「跳过 danger」开关)。相当于对危险操作
  // 完全免卡 —— 与 enabled=false 的区别: 名单仍会计算 (日志/redact 用得到),
  // 只是不再拦。默认 false。
  skip: z.boolean().default(false),
  // true = 跳过所有审批: 命中 matcher 的调用一律静默放行, 压过危险名单 / askRules /
  // ⏱窗口 / 会话缓存 —— 比 skip 更彻底 (skip 只豁免命中名单的调用, 普通调用照审)。
  // denyRules 与 EnterPlanMode 拦截仍生效 (拒绝不是审批); AskUserQuestion /
  // ExitPlanMode 交互卡不受影响。默认 false。
  skipAll: z.boolean().default(false),
  // false = 丢掉内置名单, 只用下面三组自定义规则。
  builtin: z.boolean().default(true),
  commandPatterns: z.array(z.string()).default([]),
  toolPatterns: z.array(z.string()).default([]),
  pathPatterns: z.array(z.string()).default([]),
  allowPatterns: z.array(z.string()).default([]),
});

const Approval = z.object({
  enabled: z.boolean().default(true),
  // 审批粒度:
  //   "all"    — 每个命中 matcher 的工具调用都发卡 (默认, 现状)。
  //   "danger" — 只有命中危险名单 (approval.danger) 的调用才发卡, 其余静默 allow。
  //              名单被关掉 (danger.enabled=false) 时该模式自动退回 "all" —— 否则
  //              就成了「全放行」, 与 danger.skipAll 语义重合且更隐蔽。
  //   (跳过所有审批不在 mode 里 —— 用 danger.skipAll, 与 danger.skip 成对。)
  mode: z.enum(["all", "danger"]).default("all"),
  matcher: z.string().default(".*"),
  approvers: z.array(z.string()).default([]),
  hookTimeoutSec: z.number().int().positive().default(43210),
  longPollSec: z.number().int().positive().default(43200),
  sessionCacheMinutes: z.number().int().nonnegative().default(30),
  windowMinutes: z.number().int().nonnegative().default(600),
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
  danger: Danger.default({}),
  // Claude-Code 风格的放行规则 (语法子集见 shared/allow-rules.ts): 命中的调用
  // 跳过发卡直接 allow。例:
  //   "Bash(git log *)"  "Bash(python3 .claude/skills/*)"  "mcp__server__tool"
  // matcher 决定哪些工具进入审批, allowRules 在其中再挖细粒度豁免 (对 Bash 可
  // 按命令前缀区分, matcher 只认工具名做不到)。默认空 = 不豁免。
  allowRules: z.array(z.string()).default([]),
  // 同语法的拒绝规则: 命中直接 deny (不发卡, reason 回传给 model)。
  // Bash 复合命令任一段命中即拒。优先级最高: deny > ask > allow。
  denyRules: z.array(z.string()).default([]),
  // 同语法的强制审批规则: 命中必发卡, 压过 allowRules / 自动放行窗口 / 会话缓存。
  // 用于给危险前缀 (如 "Bash(rm *)", "Bash(git push *)") 兜底 — 即使 ⏱ 窗口开着
  // 也逐条确认, 语义对齐 Claude Code 的 permissions.ask。
  askRules: z.array(z.string()).default([]),
  // `.claude/**` 写守卫 (见 shared/claude-config-path.ts): 这类改动会触发 Claude Code
  // 自己的原生确认框, 而那个框**不经过 PreToolUse hook** —— 规则一放行就是"不发卡 +
  // pane 无限期阻塞"的静默死锁。开启后: 命中的调用必发卡 (压过 allowRules / ⏱窗口 /
  // 会话缓存), 用户点「允许」后 daemon 去 pane 上把那个框按掉 (只按一次性 Yes);
  // 按不掉则 Esc 取消并把原因注入会话, 让模型改走实体路径。
  // 仅对有活 tmux pane 的镜像会话生效 —— 本地会话用户自己按掉即可。
  claudeConfigGuard: z.boolean().default(true),
  // 批准后等原生确认框出现的最长时间 (ms)。CC 在 hook 返回后才渲染它, 轮询步进 200ms。
  // 太短会误判成 no_modal (框随后才出现, 于是没人按, 退回死锁), 4s 覆盖实测抖动。
  claudeConfigModalWaitMs: z.number().int().nonnegative().default(4000),
  // 审批卡 quote_area 里命令/参数体的最大字符数。WeCom 未公开该字段上限, 发送
  // 失败会自动缩到 600 重试一次 (见 approval.ts), 所以可以放心调大。
  // 注意手机端客户端只渲染 quote 区前 2~3 行 (实测), 看全命令靠「展开完整命令」。
  cardQuoteMaxChars: z.number().int().positive().default(1200),
  // Bash 命令超过 ~200 字 (卡片手机端可见极限) 时, 发卡前**无条件**先推一条含完整
  // 命令的 markdown 消息。默认 0 = 关闭 —— 长命令由卡片自己承载: 引用区可点进详情
  // 页, 右上角「⋯」菜单有「📄 展开完整命令」按需在群里发全文。设成正数可恢复旧
  // 行为 (客户端不渲染 action_menu、或就是要全文无条件落在群里时用)。
  // 此值为前置消息的总字数上限 (超出截断并注明; 按 1800 字/条分块发送)。
  fullCommandPreludeChars: z.number().int().nonnegative().default(0),
});

// sync.targets[].kind 的合法值。claude-internal / custom 等旧值自动 collapse
// 为 "claude" (preprocess) — settingsPath 已经表达了具体 fork, kind 只表达家族。
const SYNC_KIND_LEGACY_TO_CLAUDE = new Set(["claude-internal", "custom"]);
const normalizeSyncKind = (v: unknown): unknown =>
  typeof v === "string" && SYNC_KIND_LEGACY_TO_CLAUDE.has(v) ? "claude" : v;

const SyncTarget = z.object({
  // CLI 家族标签: "claude" (含 claude-internal 等 fork) 或 "codebuddy"。
  // 仅用于 sync 日志; 真正决定写入位置的是 settingsPath。
  kind: z.preprocess(normalizeSyncKind, z.enum(["claude", "codebuddy"])).default("claude"),
  settingsPath: z.string(),
  scope: z.enum(["user", "project", "local"]).default("user"),
});
const Sync = z.object({
  targets: z.array(SyncTarget).default([]),
});

// 独立 detail 中转服务 (wezard svr) 的默认参数。CLI 参数 (--host/--port/…) 仍可覆盖,
// 空则退回硬编码默认 (0.0.0.0:17891)。放在 top-level 而不是塞进 daemon: svr 是独立进程,
// 与 daemon 生命周期解耦。
const Svr = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(17891),
  stateDir: z.string().default("~/.wezard/svr"),
  tokenFile: z.string().default("~/.wezard/svr-token"),
  token: z.string().default(""),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

// 事件订阅 / 广播。subs 是 topic → 目标id数组 (`user:xxx` / `chat:xxx`),
// 一个 topic 可以有多个订阅者; schedules 是「每天 HH:MM 触发某 topic」的定时任务。
// 订阅关系与定时通过 MCP 工具 (subscribe_topic / schedule_broadcast …) 增删,写回 config.jsonc。
const Schedule = z.object({
  topic: z.string(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  content: z.string(),
  createdBy: z.string().default(""),
  createdAt: z.number().default(0),
});
const Topics = z.object({
  subs: z.record(z.string(), z.array(z.string())).default({}),
  schedules: z.array(Schedule).default([]),
});

// 聊天命名表: `name → base principal` (`chat:wrxxx` / `user:xxx`)。方向选 name→
// principal 而不是反过来: 名字是寻址用的 key, 这个方向天然保证唯一, 手写也更顺。
// 有了名字, 跨 chat 的 peer 才能写成 `daily#fix` 这种稳定地址 —— 否则只能靠
// "全局唯一 tag" 碰运气。见 daemon/chat-name.ts。
const Chats = z.record(z.string(), z.string());

export const ConfigSchema = z.object({
  bot: Bot,
  defaultChat: z.string().default(""),
  chats: Chats.default({}),
  daemon: Daemon.default({}),
  wrc: Wrc.default({}),
  approval: Approval.default({}),
  sync: Sync.default({ targets: [] }),
  svr: Svr.default({}),
  topics: Topics.default({ subs: {}, schedules: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG_PATHS = [
  "~/.wezard/config.jsonc",
  "~/.wezard/config.json",
];
const SECRETS_PATH = "~/.wezard/secrets.json";

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

/** Resolve config path: explicit > $WEZARD_CONFIG > defaults. */
const resolveConfigPath = (explicit?: string): string | undefined => {
  if (explicit) return explicit;
  if (process.env.WEZARD_CONFIG) return process.env.WEZARD_CONFIG;
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
      `wezard config not found. Create ~/.wezard/config.jsonc (see config.example.jsonc) or set $WEZARD_CONFIG.`,
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
    throw new Error(`wezard config invalid (${sourcePath}):\n${issues}`);
  }
  return { config: parsed.data, sourcePath: expandHome(sourcePath) };
};
