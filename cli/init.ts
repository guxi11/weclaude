#!/usr/bin/env node
// `wezard init` — interactive onboarding for new users.
// Flow:
//   1. Prompt creds + agent kind + hook toggle.
//   2. Write ~/.wezard/config.jsonc + secrets.json (split secrets).
//   3. Build (if needed), run `wezard sync` against chosen agent settings.json,
//      install resident daemon.
//   4. Arm bootstrap claim. Wait for the user to send a magic phrase in IM.
//      That message bypasses allowFrom, sets defaultChat, and adds the sender.
//   5. Mirror 模式下:拉起 tmux+claude pane,提示用户在 WeCom 发首条消息。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { input, password, select, confirm, checkbox } from "@inquirer/prompts";
import { parse as parseJsonc } from "jsonc-parser";
import { appendUnique, patchJsonc } from "../shared/config-writer.js";
import { mapClaudePermissions, readClaudePermissions } from "../shared/claude-permissions.js";
import { expandHome } from "../shared/paths.js";
import { resolvePublicHost } from "../shared/lan-ip.js";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(here, "..", "..");

const CONFIG = "~/.wezard/config.jsonc";
const SECRETS = "~/.wezard/secrets.json";
const CLAIM_PHRASE = "将本对话设置为默认会话";
const SVR_HOST = "0.0.0.0";
const SVR_PORT = 17891;
const SVR_STATE = "~/.wezard/svr";
const SVR_TOKEN_FILE = "~/.wezard/svr-token";

// ── Pretty output (no ink — keep deps light) ─────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const log = (s: string): void => console.log(s);
const step = (n: number, title: string): void =>
  log(`\n${c.cyan(`[${n}/3]`)} ${c.bold(title)}`);

// ── Agent kind → settings.json path ──────────────────────────────────
// sync.targets 可多选: 每个 agent 一个 target, 全部注入 hook/MCP/env。
// wrc.defaultCli 是单值, 由第一个选中项决定 —— 它只决定「新会话默认用哪个 CLI 起」。
// daemon 会同时 tail 所有已安装 CLI 的 projectsDir (backend 由 transcript 路径反推),
// 所以 claude 和 codebuddy 的会话可以并存、各自镜像到不同的 WeCom 会话。
type AgentKind = "claude" | "claude-internal" | "codebuddy";
type WrcMode = "headless" | "mirror";
const settingsPathFor = (kind: AgentKind): string => {
  switch (kind) {
    case "claude": return "~/.claude/settings.json";
    case "claude-internal": return "~/.claude-internal/settings.json";
    case "codebuddy": return "~/.codebuddy/settings.json";
  }
};
const claudeBinFor = (kind: AgentKind): string => {
  if (kind === "claude-internal") return "claude-internal";
  if (kind === "codebuddy") return "codebuddy";
  return "claude";
};
// sync.targets[].kind: "claude-internal" 是 claude 家族的特例,
// collapse 为 "claude" (settingsPath 已表达 internal 语义)。
const syncKindFor = (kind: AgentKind): "claude" | "codebuddy" =>
  kind === "codebuddy" ? "codebuddy" : "claude";
// wrc.defaultCli: daemon active backend。与 sync.targets 多值独立。
const backendNameFor = (kind: AgentKind): "claude" | "claude-internal" | "codebuddy" => kind;

// ── HTTP helpers (talk to local daemon) ──────────────────────────────
const DAEMON = "http://127.0.0.1:17890";
const get = async (p: string): Promise<unknown> => {
  const r = await fetch(`${DAEMON}${p}`);
  return r.json().catch(() => ({}));
};
const post = async (p: string, body: unknown): Promise<unknown> => {
  const r = await fetch(`${DAEMON}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Existing credentials ─────────────────────────────────────────────
// secrets.json 是 botId/secret 的唯一落盘点 (config.jsonc 只留非敏感字段)。
// 重跑 init 最常见的场景是换 agent / 换模式, 凭证没变 —— 每次重敲一遍 secret
// 既烦又容易敲错, 所以检测到已有值就默认复用。
interface BotCreds { botId?: string; secret?: string }
const readBotCreds = (): BotCreds => {
  const p = expandHome(SECRETS);
  if (!existsSync(p)) return {};
  try {
    const bot = (parseJsonc(readFileSync(p, "utf8")) as { bot?: BotCreds } | undefined)?.bot;
    return bot ?? {};
  } catch {
    return {};
  }
};
// 只露头尾, 中间省略 —— 足够用户确认"是这个机器人", 又不把凭证打进终端 scrollback。
const mask = (s: string): string =>
  s.length <= 10 ? `${s.slice(0, 2)}***` : `${s.slice(0, 6)}***${s.slice(-4)}`;

// ── Build + install + reload daemon ──────────────────────────────────
const ensureBuild = (): void => {
  if (existsSync(`${REPO}/dist/daemon/index.js`)) return;
  log(c.dim("  building..."));
  const r = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) throw new Error("build failed");
};

const runSync = (): void => {
  log(c.dim("  syncing hooks/MCP/env into agent config files..."));
  const r = spawnSync(process.execPath, [`${REPO}/dist/cli/sync.js`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("sync failed");
};

const installDaemon = (): void => {
  log(c.dim("  installing resident daemon..."));
  const r = spawnSync("bash", [`${REPO}/scripts/install.sh`, "daemon"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("install.sh failed");
};

// ── Detail relay (svr) ───────────────────────────────────────────────
// 卡片里的 chat/detail 链接根不能是回环 —— 用户点开是在手机/企微内置浏览器里,
// 回环指向的是他自己的设备。所以链接用本机 LAN IP,同网段即可直连。
// svr 与 daemon 同机也值得独立跑: 记录经 POST /d 转发, 日后把 svr 挪到公网机器
// 只需改 daemon.detailRemoteBase, daemon 侧零改动。
const installSvr = (): void => {
  log(c.dim("  installing detail relay (svr)..."));
  const r = spawnSync("bash", [`${REPO}/scripts/install.sh`, "svr"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("install.sh svr failed");
};

// 探活走回环 —— svr 绑 0.0.0.0, 本机 curl 得到的是同一个监听。LAN IP 只用于链接文案。
const waitSvrReady = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error(
    `svr did not answer /healthz on :${port} — 查看 ~/.wezard/svr.stderr.log (端口占用?)`,
  );
};

// 回环通 ≠ 链接可用: macOS 应用防火墙的 block-all 模式放行 loopback, 却把 LAN
// 入连接建连后直接掐断 (curl 表现为 "Empty reply from server")。等用户点开卡片
// 链接才发现是死链就太晚了 —— init 阶段按最终链接根实测一次。
const warnIfLanBlocked = async (base: string, ip: string): Promise<void> => {
  if (ip === "127.0.0.1") return;
  const ok = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (ok) return;
  log(c.yellow(`  ⚠ ${base} 回环可达但内网不可达 — 手机/企微里点开链接会打不开。`));
  if (process.platform === "darwin") {
    log(c.yellow("    macOS 应用防火墙拦了 node 的入连接，放行后即可:"));
    log(c.dim("      sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setblockall off"));
    log(c.dim(`      sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v node)"`));
  } else {
    log(c.yellow(`    检查防火墙是否放行 ${SVR_PORT}/tcp。`));
  }
};

// Register the local repo as a Claude Code marketplace and install the
// `wezard` plugin from it. This is what wires up `hooks/hooks.json` (so
// `${CLAUDE_PLUGIN_ROOT}` resolves) + `commands/wrc.md` + the MCP server
// declared in `.claude-plugin/plugin.json`. Idempotent: marketplace add
// re-uses the existing entry, install upgrades in place.
//
// 失败即 throw — 没装上 hook 等于整套授权链路废掉,继续往下跑只会让用户看到
// 假的"✅ 引导完成",再被 auto mode 拦截一脸懵。
// status 为 null 的两种真实原因: spawn 失败 (error, 多为 ENOENT —— bin 是
// alias/函数或不在继承的 PATH 里) 或进程被信号杀死。两者都不是「退出码」,
// 必须分开报,否则用户拿到 null 一脸懵。
const describeSpawn = (r: ReturnType<typeof spawnSync>): string =>
  r.error ? `无法启动 (${r.error.message})`
  : r.signal ? `被信号 ${r.signal} 杀死`
  : `退出码 ${r.status}`;

const installPlugin = (claudeBin: string): void => {
  log(c.dim(`  注册 marketplace + 安装插件 (${claudeBin}) ...`));
  const m = spawnSync(claudeBin, ["plugin", "marketplace", "add", REPO], { stdio: "inherit" });
  if (m.status !== 0) {
    throw new Error(
      `plugin marketplace add 失败 (${describeSpawn(m)}) — hook 无法注册。\n` +
      `  若提示无法启动: ${claudeBin} 不在 PATH 或是 shell alias/函数, 请用绝对路径重试。\n` +
      `  手动: ${claudeBin} plugin marketplace add ${REPO}`,
    );
  }
  const i = spawnSync(claudeBin, ["plugin", "install", "wezard@wezard-local", "--scope", "user"], { stdio: "inherit" });
  if (i.status !== 0) {
    throw new Error(
      `plugin install 失败 (${describeSpawn(i)}) — hook 无法注册。\n` +
      `  常见原因: ${claudeBin} 版本过旧,不支持当前插件源类型 — 请先升级 ${claudeBin} 后重试 init。\n` +
      `  手动: ${claudeBin} plugin install wezard@wezard-local --scope user`,
    );
  }
};

const waitDaemonReady = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = (await get("/status")) as { wsConnected?: boolean };
      if (s.wsConnected) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("daemon did not become ready in time");
};

// ── Claude permissions 一次性导入 ─────────────────────────────────────
// 把 Claude Code settings.json 的 permissions.allow/ask/deny 映射进 approval
// 三层规则(语法同源, 不兼容条目跳过)。只做一次性同步, 之后 allowRules 由
// wezard 侧自管(不再回读 settings.json)。可随时用
// `wezard-init --import-claude-permissions [settings.json 路径]` 重新同步(增量去重)。
const importClaudePerms = async (settingsPath: string, interactive: boolean): Promise<void> => {
  const perms = readClaudePermissions(settingsPath);
  if (!perms) {
    log(c.dim(`  未读到 ${settingsPath} 的 permissions，跳过导入（保持 wezard 自己的规则配置）`));
    return;
  }
  const m = mapClaudePermissions(perms);
  const total = m.allow.length + m.ask.length + m.deny.length;
  if (total === 0) {
    log(c.dim("  Claude permissions 为空或全部不兼容，跳过导入"));
    return;
  }
  log(`  检测到 Claude Code 权限规则: allow ${m.allow.length} / ask ${m.ask.length} / deny ${m.deny.length}`
    + (m.skipped.length ? c.dim(`（${m.skipped.length} 条引擎不支持将跳过）`) : ""));
  if (interactive) {
    const ok = await confirm({
      message: "导入到企微审批规则？(allow→免审直行, ask→强制发卡, deny→直接拒绝；导入后由 wezard 自管)",
      default: true,
    });
    if (!ok) return;
  }
  for (const r of m.allow) appendUnique(CONFIG, ["approval", "allowRules"], r);
  for (const r of m.ask) appendUnique(CONFIG, ["approval", "askRules"], r);
  for (const r of m.deny) appendUnique(CONFIG, ["approval", "denyRules"], r);
  log(c.green(`  ✓ 已导入 ${total} 条规则到 ${CONFIG}`));
  if (m.skipped.length) log(c.dim(`  跳过: ${m.skipped.join(", ")}`));
};

// ── Main flow ────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  log(c.bold("\nwezard · 新用户引导\n"));
  log(c.dim("  目标：3 步内完成 → IM 授权转发 + 远程 CC 控制可用。\n"));

  if (existsSync(expandHome(CONFIG))) {
    const ok = await confirm({
      message: `检测到已有 ${CONFIG}，覆盖关键字段后继续？`,
      default: false,
    });
    if (!ok) {
      log(c.yellow("已取消。"));
      return;
    }
  }

  // ── Step 1: prompts ────────────────────────────────────────────
  step(1, "采集配置");
  const existing = readBotCreds();
  const reuseCreds = existing.botId
    ? await confirm({
        message: `检测到已有凭证 botId=${mask(existing.botId)}${existing.secret ? " (含 secret)" : ""}，复用？`,
        default: true,
      })
    : false;
  const botId = reuseCreds && existing.botId
    ? existing.botId
    : await input({ message: "智能机器人 botId:", required: true });
  // 复用 botId 但 secrets.json 里没有 secret (老配置手写过 config.jsonc) 时仍要问。
  const secret = reuseCreds && existing.secret
    ? existing.secret
    : await password({ message: "机器人 secret:", mask: "•" });
  const agentKinds = (await checkbox({
    message: "选择 Claude agent (空格多选, 至少一个 — hook/MCP/env 会注入到每个选中项):",
    choices: [
      { name: "claude (Anthropic 官方)", value: "claude", checked: true },
      { name: "claude-internal (Tencent 内部)", value: "claude-internal" },
      { name: "codebuddy (Tencent CodeBuddy)", value: "codebuddy" },
    ],
    required: true,
    loop: false,
  })) as AgentKind[];
  const wrcMode = (await select({
    message: "选择 wrc 模式：",
    choices: [
      {
        name: "mirror (推荐：远程消息注入到本地 tmux 里的 Agent 会话，CLI 可见双向同步)",
        value: "mirror",
      },
      {
        name: "headless (远程消息触发新的 `claude -p` 子进程，CLI 不可见)",
        value: "headless",
      },
    ],
    default: "mirror",
  })) as WrcMode;
  const enableHook = await confirm({
    message: "开启 PreToolUse 授权拦截 hook？(IM 按钮卡片授权)",
    default: true,
  });

  const targets = agentKinds.map((k) => ({
    kind: syncKindFor(k),
    settingsPath: settingsPathFor(k),
    scope: "user" as const,
  }));
  // 第一个选中项决定 wrc.defaultCli —— 新会话 (/new, sessions/new) 的默认 CLI。
  // 其余已安装的 CLI 依然会被 daemon 镜像, 无需额外配置。
  // checkbox required:true 保证非空, 但 TS 不感知, 这里 narrow 一下。
  const [primary] = agentKinds;
  if (!primary) {
    log(c.red("  ✗ 未选择任何 agent"));
    process.exit(1);
  }
  const claudeBin = claudeBinFor(primary);

  // ── Step 1b: write configs ─────────────────────────────────────
  // svr 的 base/token 必须在 daemon 起来之前落盘 —— daemon 只在 boot 时读一次
  // detailRemoteBase/Token, 晚写等于第一轮链接全指向回环。
  const svrIP = resolvePublicHost(SVR_HOST);
  const svrBase = `http://${svrIP}:${SVR_PORT}`;
  const svrToken = loadOrCreateSvrToken(SVR_TOKEN_FILE);
  if (svrIP === "127.0.0.1") {
    log(c.yellow("  ⚠ 未探测到内网 IP，详情链接将只在本机可打开 (可稍后改 daemon.detailPublicBase)"));
  }

  log(c.dim(`  写入 ${CONFIG} ...`));
  patchJsonc(CONFIG, [
    { path: ["bot", "websocketUrl"], value: "wss://openws.work.weixin.qq.com" },
    { path: ["defaultChat"], value: "" },
    { path: ["wrc", "mode"], value: wrcMode },
    { path: ["wrc", "claudeBin"], value: claudeBin },
    { path: ["wrc", "defaultCli"], value: backendNameFor(primary) },
    { path: ["wrc", "cwd"], value: "~/.wezard/workspace" },
    { path: ["wrc", "allowFrom"], value: [] },
    { path: ["approval", "enabled"], value: enableHook },
    { path: ["approval", "matcher"], value: ".*" },
    { path: ["sync", "targets"], value: targets },
    { path: ["svr", "host"], value: SVR_HOST },
    { path: ["svr", "port"], value: SVR_PORT },
    { path: ["svr", "stateDir"], value: SVR_STATE },
    { path: ["svr", "tokenFile"], value: SVR_TOKEN_FILE },
    { path: ["daemon", "detailRemoteBase"], value: svrBase },
  ]);
  // token 走 secrets.json 而不是 config.jsonc —— 后者常被丢进 dotfile 仓库。
  const credsChanged = botId !== existing.botId || secret !== existing.secret;
  if (!credsChanged) log(c.dim(`  复用 ${SECRETS} 中的凭证 (未改写)`));
  else log(c.dim(`  写入 ${SECRETS} ...`));
  patchJsonc(SECRETS, [
    ...(credsChanged
      ? [
          { path: ["bot", "botId"], value: botId },
          { path: ["bot", "secret"], value: secret },
        ]
      : []),
    { path: ["daemon", "detailRemoteToken"], value: svrToken },
  ]);

  // ── Step 1c: 一次性导入 Claude permissions → approval 规则 ───────
  // 多后端场景只读主后端 (agentKinds 的第一项) 的 settings.json: 导入是交互式的,
  // 逐个后端问一遍等于把引导流程拖成 N 轮; 其余后端的规则可事后用
  // `wezard-init --import-claude-permissions <path>` 增量补进来 (内部去重)。
  if (enableHook) await importClaudePerms(settingsPathFor(primary), true);

  ensureBuild();
  if (enableHook) runSync();
  // marketplace 插件只存在于 claude 家族; codebuddy 的 hook 由 sync 直接
  // 写进 ~/.codebuddy/settings.json (插件未发布到其市场), 装插件必然失败。
  if (enableHook) {
    const pluginBins = [...new Set(agentKinds.filter((k) => k !== "codebuddy").map(claudeBinFor))];
    for (const bin of pluginBins) installPlugin(bin);
  }
  installSvr();
  await waitSvrReady(SVR_PORT, 20_000);
  log(c.green(`  ✓ svr ready — 详情/会话链接根: ${c.bold(svrBase)}`));
  await warnIfLanBlocked(svrBase, svrIP);
  installDaemon();

  log(c.dim("  等待 daemon 上线..."));
  await waitDaemonReady(20_000);
  log(c.green("  ✓ daemon ready"));

  // ── Step 2: claim default chat ─────────────────────────────────
  step(2, "绑定默认会话");
  await post("/claim/start", { phrase: CLAIM_PHRASE, ttlSec: 600 });
  log(`\n  ${c.bold("→ 现在打开企业微信，给该机器人发送：")}`);
  log(`     ${c.cyan(CLAIM_PHRASE)}\n`);
  log(c.dim("  等待中... (10 分钟超时)"));

  const claimed = await pollClaim(10 * 60_000);
  if (!claimed) {
    log(c.red("\n  超时未收到消息。可稍后手动编辑 config 的 defaultChat / wrc.allowFrom。"));
    return;
  }
  log(c.green(`\n  ✓ 已绑定: ${c.bold(claimed)}`));

  // ── Step 3: spin up mirror pane ────────────────────────────────
  step(3, "拉起 mirror 会话");
  if (!enableHook || wrcMode !== "mirror") {
    log(c.green("\n✅ 引导完成。后续可用 `wezard status` / `wezard logs -f` 观察。"));
    return;
  }
  // Mirror 路径:拉起 tmux+claude pane,然后让用户在 WeCom 发首条消息。
  // 首条 inbound 走完整 dispatch 链路:openStream → 注入 tmux → tail 回流为
  // 打字机气泡。比 frame-less /mirror/inject 体验好得多(后者无 liveStream)。
  log(c.dim("  正在拉起 tmux+claude pane (mirror 模式) ..."));
  const r = (await post("/mirror/spawn", { target: claimed })) as {
    ok?: boolean; reason?: string; tmuxSession?: string; tmuxPane?: string; sessionId?: string;
  };
  if (!r.ok) {
    log(c.red(`  ✗ /mirror/spawn 失败: ${r.reason ?? "unknown"}`));
    log(c.yellow("  可手动: tmux new-session -s wezard 后跑 claude;或在 WeCom 发任意消息触发 auto-spawn。"));
    return;
  }
  log(c.green(`  ✓ tmux session=${c.bold(r.tmuxSession ?? "")} pane=${r.tmuxPane ?? ""} sid=${r.sessionId ?? ""}`));
  log(c.dim(`  附加: tmux attach -t ${r.tmuxSession ?? "wezard"}`));
  log(`\n  ${c.bold("→ 现在去 WeCom 给机器人发一条消息(比如 \"hi\"):")}`);
  log(c.dim("    inbound → openStream → 注入 tmux pane → 输出回流为打字机气泡"));
  log(c.green("\n✅ 引导完成。后续可用 `wezard status` / `wezard logs -f` 观察。"));
};

const pollClaim = async (timeoutMs: number): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await get("/claim/status")) as {
      claimed?: { principal: string } | null;
      armed?: boolean;
    };
    if (s.claimed) return s.claimed.principal;
    if (s.armed === false) break;
    await sleep(1000);
  }
  return undefined;
};

// 独立入口: `wezard-init --import-claude-permissions [settings.json 路径]`
// 只跑权限导入(增量去重), 不走完整引导。改完记得重启 daemon 生效。
const importFlagIdx = process.argv.indexOf("--import-claude-permissions");
const entry = importFlagIdx >= 0
  ? importClaudePerms(process.argv[importFlagIdx + 1] ?? "~/.claude/settings.json", false)
      .then(() => log(c.dim("  提示: 重启 daemon 生效 (launchctl kickstart / systemctl restart)")))
  : main();

entry.catch((e) => {
  // eslint-disable-next-line no-console
  console.error(c.red(`\n[wezard-init] ${(e as Error).message}`));
  process.exit(1);
});

// keep loadConfig reference reachable for tree-shaking sanity (used by sub-binaries)
void readFileSync;
