// `wezard sync` — write wezard's hooks / MCP / env into target settings.json files
// (e.g. ~/.claude/settings.json so claude-internal wrappers pick them up).
// Idempotent + reversible via per-target lock manifest in ~/.wezard/sync.lock.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { loadConfig } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";

// ── Plugin root resolution ────────────────────────────────────────────
// dist/cli/sync.js → repo root is two `..` up.
const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = pathResolve(here, "..", "..");

const MCP_ENTRY = `${PLUGIN_ROOT}/dist/mcp/server.js`;
const HOOK_SCRIPT = `${PLUGIN_ROOT}/hooks/pre-tool-use.sh`;
const LOCK_FILE = expandHome("~/.wezard/sync.lock.json");
const MARKER = "wezard";
// Pre-rename installs stamped `_managedBy: "weclaude"` (and, further back,
// "wecom"). Strip on any of them so a `wezard migrate` / re-sync cleans the
// old block instead of leaving a second hook + MCP entry behind.
const MANAGED_BY = new Set([MARKER, "weclaude"]);
const isOurs = (v: unknown): boolean => typeof v === "string" && MANAGED_BY.has(v);

interface Lock {
  targets: Record<string, { wroteHooks: boolean; wroteMcp: boolean; wroteEnv: string[] }>;
}

const readLock = (): Lock => {
  if (!existsSync(LOCK_FILE)) return { targets: {} };
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  } catch {
    return { targets: {} };
  }
};
const writeLock = (l: Lock): void => {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(l, null, 2));
};

const readJson = (p: string): Record<string, unknown> => {
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, "utf8");
  return (parseJsonc(txt) ?? {}) as Record<string, unknown>;
};
const writeJson = (p: string, obj: unknown): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
};

// ── Hook strip ───────────────────────────────────────────────────────
// Hook registration is owned by the Claude Code plugin (`hooks/hooks.json`
// + `${CLAUDE_PLUGIN_ROOT}`). `wezard init` runs `claude plugin install`
// to wire it up. We keep stripHooks only to clean up legacy settings.json
// entries from earlier installs — leaving both registered fires the hook
// twice per tool call → duplicate approval cards.
interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number; _managedBy?: string }>;
  _managedBy?: string;
}

const stripHooks = (settings: Record<string, unknown>): void => {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  const list = (hooks.PreToolUse as HookEntry[] | undefined) ?? [];
  hooks.PreToolUse = list.filter((e) => !isOurs(e._managedBy));
  if ((hooks.PreToolUse as HookEntry[]).length === 0) delete hooks.PreToolUse;
};

// CodeBuddy 不走 Claude Code 的 plugin marketplace (wezard 插件不会装上),
// settings.json 是唯一注册点; Claude 家族由 plugin 的 hooks/hooks.json 提供,
// 不在此写入 (否则双重触发 → 重复卡片)。
const upsertHook = (settings: Record<string, unknown>, timeoutSec: number): void => {
  const hooks = ((settings.hooks as Record<string, unknown>) ??= {});
  const list = ((hooks.PreToolUse as HookEntry[]) ??= []);
  list.push({
    matcher: ".*",
    hooks: [{
      type: "command",
      command: HOOK_SCRIPT,
      // 严格大于 daemon 的 longPollSec (= envVals.hookTimeoutSec) + 一点余量,
      // 与 hooks.json 的 timeout 语义对齐 — 否则 curl 先死, 用户点击写进死 socket。
      timeout: timeoutSec + 10,
    }],
    _managedBy: MARKER,
  });
};

// ── MCP upsert ────────────────────────────────────────────────────────
const upsertMcp = (settings: Record<string, unknown>): void => {
  const m = ((settings.mcpServers as Record<string, unknown>) ??= {});
  // drop entries from earlier install generations (`wecom` → `weclaude` → `wezard`).
  stripMcp(settings);
  m.wezard = {
    command: "node",
    args: [MCP_ENTRY],
    _managedBy: MARKER,
  };
};
const stripMcp = (settings: Record<string, unknown>): void => {
  const m = settings.mcpServers as Record<string, unknown> | undefined;
  if (!m) return;
  for (const k of ["wezard", "weclaude", "wecom"]) {
    const cur = m[k] as Record<string, unknown> | undefined;
    if (isOurs(cur?._managedBy)) delete m[k];
  }
};

// ── Env upsert ────────────────────────────────────────────────────────
const ENV_KEYS = [
  "WEZARD_DAEMON_BASE",
  "WEZARD_DAEMON_URL",
  "WEZARD_STATE_DIR",
  "WEZARD_HOOK_FALLBACK",
  "WEZARD_HOOK_TIMEOUT",
];
// Same keys under the pre-rename prefix — stripped on every sync so a migrated
// settings.json doesn't keep pointing the old hook at the old state dir.
const LEGACY_ENV_KEYS = ENV_KEYS.map((k) => k.replace(/^WEZARD_/, "WECLAUDE_"));
interface EnvVals {
  base: string;
  stateDir: string;
  hookFallback: "ask" | "allow" | "deny";
  hookTimeoutSec: number;
}
const upsertEnv = (settings: Record<string, unknown>, v: EnvVals): string[] => {
  const env = ((settings.env as Record<string, unknown>) ??= {});
  for (const k of LEGACY_ENV_KEYS) delete env[k];
  env.WEZARD_DAEMON_BASE = v.base;
  env.WEZARD_DAEMON_URL = `${v.base}/approve`;
  env.WEZARD_STATE_DIR = expandHome(v.stateDir);
  env.WEZARD_HOOK_FALLBACK = v.hookFallback;
  // curl --max-time: 严格大于 longPollSec, 否则长挂的卡在用户点击前就断线。
  env.WEZARD_HOOK_TIMEOUT = String(v.hookTimeoutSec);
  return ENV_KEYS;
};
const stripEnv = (settings: Record<string, unknown>): void => {
  const env = settings.env as Record<string, unknown> | undefined;
  if (!env) return;
  for (const k of [...ENV_KEYS, ...LEGACY_ENV_KEYS]) delete env[k];
};

// ── Pre-flight: jq is required by hooks/pre-tool-use.sh ──────────────
// The hook hard-falls back to a local `ask` when jq is missing, which means
// approval cards never reach WeCom — silent, confusing failure on fresh
// installs. Catch it here at registration time with install instructions.
const requireJq = (): void => {
  const r = spawnSync("jq", ["--version"], { stdio: "ignore" });
  if (r.status === 0) return;
  const install = (() => {
    switch (process.platform) {
      case "darwin": return "brew install jq";
      case "linux": return "sudo apt-get install -y jq   # or: sudo yum install -y jq / sudo apk add jq";
      default: return "install jq for your platform";
    }
  })();
  // eslint-disable-next-line no-console
  console.error(
    `\n[wezard-sync] ERROR: 'jq' is required by the PreToolUse hook but not found on PATH.\n` +
    `  Approval cards will NOT be delivered until it is installed.\n` +
    `  Install it, then re-run sync:\n    ${install}\n`,
  );
  process.exit(1);
};

// ── Drivers ───────────────────────────────────────────────────────────
const targetKey = (path: string): string => expandHome(path);

interface SyncOpts { remove?: boolean }

// CodeBuddy reads MCP server config from `~/.codebuddy/mcp.json`, NOT from
// settings.json. Derive the mcp.json path from the settings.json path.
const mcpJsonPath = (settingsPath: string): string =>
  pathResolve(dirname(expandHome(settingsPath)), "mcp.json");

const syncOne = (
  settingsPath: string,
  kind: "claude" | "codebuddy",
  opts: SyncOpts,
  lock: Lock,
  env: EnvVals,
): void => {
  const abs = expandHome(settingsPath);
  const settings = readJson(abs);

  // Always strip first — keeps re-runs idempotent and clears any legacy
  // hook entries from earlier installs that wrote into settings.json directly.
  stripHooks(settings);

  if (opts.remove) {
    stripEnv(settings);
    if (kind === "codebuddy") {
      // MCP lives in mcp.json for CodeBuddy; strip from both locations.
      stripMcp(settings);
      const mcpAbs = mcpJsonPath(settingsPath);
      const mcpJson = readJson(mcpAbs);
      stripMcp(mcpJson);
      writeJson(mcpAbs, mcpJson);
    } else {
      stripMcp(settings);
    }
    delete lock.targets[targetKey(settingsPath)];
  } else {
    const wroteEnv = upsertEnv(settings, env);
    let wroteHooks = false;
    if (kind === "codebuddy") {
      // CodeBuddy: hook → settings.json, MCP → mcp.json
      upsertHook(settings, env.hookTimeoutSec);
      wroteHooks = true;
      // Strip any stale MCP from settings.json (migrated to mcp.json)
      stripMcp(settings);
      const mcpAbs = mcpJsonPath(settingsPath);
      const mcpJson = readJson(mcpAbs);
      upsertMcp(mcpJson);
      writeJson(mcpAbs, mcpJson);
    } else {
      upsertMcp(settings);
    }
    lock.targets[targetKey(settingsPath)] = { wroteHooks, wroteMcp: true, wroteEnv };
  }
  writeJson(abs, settings);
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const remove = argv.includes("--remove") || argv.includes("--uninstall");
  const dryRun = argv.includes("--dry-run");

  const { config: cfg } = loadConfig();
  requireJq();
  const targets = cfg.sync.targets;
  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.error("no sync.targets in config — nothing to do.");
    process.exit(0);
  }
  const envVals: EnvVals = {
    base: `http://${cfg.daemon.host}:${cfg.daemon.port}`,
    stateDir: cfg.daemon.stateDir,
    hookFallback: cfg.approval.fallbackOnError,
    hookTimeoutSec: cfg.approval.hookTimeoutSec,
  };

  const lock = readLock();
  for (const t of targets) {
    const action = remove ? "remove" : "upsert";
    // eslint-disable-next-line no-console
    console.log(`[wezard-sync] ${action} ${t.kind} → ${t.settingsPath}`);
    if (dryRun) continue;
    syncOne(t.settingsPath, t.kind, { remove }, lock, envVals);
  }
  if (!dryRun) writeLock(lock);
  // eslint-disable-next-line no-console
  console.log(remove ? "[wezard-sync] removed." : "[wezard-sync] synced.");
};

main();
