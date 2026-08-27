// Real subscription rate-limit readout �? the numbers usage.ts CANNOT compute.
//
// usage.ts estimates cost/tokens from local jsonl. But the authoritative
// "X% of your weekly limit" lives server-side and is only ever surfaced by
// Claude Code's interactive `/usage` TUI panel. There is no file, header, or
// headless flag that exposes it. So we drive the real thing: spawn a throwaway
// `claude` in a DEDICATED, isolated tmux session (never touches the user's live
// mirror panes), open `/usage`, scrape the rendered panel, then tear the pane
// down. Both "Current session" (rolling 5h window) and "Current week" are
// account-level, so a throwaway pane reports them just as accurately as the
// user's own session would �? with zero disruption to real work.
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { parseTmuxVersion, runTmux, trustWorkspace } from "./spawn-tmux.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// One rate-limit bar from the panel. `label` is verbatim from the header
// ("session", "week (all models)", "week (Opus 4.8)", �?) �? kept generic so a
// new model-specific weekly cap needs no code change.
export interface LimitRow {
  label: string;
  pct: number;
  resets?: string;
}

export interface QuotaReport {
  limits: LimitRow[];
  factors: string[]; // "What's contributing to your limits usage" headlines
  raw?: string; // cleaned panel text, kept for the failure path
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\[[0-9;?]*[A-Za-z]/g, "");

// Parse the `/usage` panel (Usage tab). Layout, per Claude Code v2.1.x:
//   Current session
//   ██████�?                22% used
//   Resets 11:10pm (Asia/Shanghai)
//   Current week (all models)
//   ██████�?                82% used
//   Resets Jul 10 at 2pm (Asia/Shanghai)
//   What's contributing to your limits usage?
//   62% of your usage was at >150k context   �? factor headlines
// Section headers switch the bucket; "% used" / "Resets" lines fill it.
export const parseUsagePanel = (text: string): QuotaReport => {
  const limits: LimitRow[] = [];
  const factors: string[] = [];
  const header = /^Current\s+(.+?)\s*$/i; // "Current session", "Current week (all models)"
  const pctUsed = /(\d+)%\s*used/i;
  const resets = /Resets\s+(.+?)\s*$/i;
  const factor = /^\s*(\d+)%\s+of your usage\b(.*)$/i;
  let cur: LimitRow | undefined;
  const close = (): void => { if (cur && Number.isFinite(cur.pct)) limits.push(cur); cur = undefined; };
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim();
    // A factor headline ("N% of your usage �?") also ends any open limit block.
    const fm = factor.exec(raw);
    if (fm) { close(); factors.push(`${fm[1]}%${fm[2]}`.replace(/\s+/g, " ").trim()); continue; }
    // A "Current �?" line with no % is a new limit header (generic over
    // session / week (all models) / week (<model>) / any future bucket).
    const hm = header.exec(line);
    if (hm && !pctUsed.test(line) && !/resets/i.test(line)) { close(); cur = { label: hm[1] ?? "", pct: NaN }; continue; }
    if (!cur) continue;
    const pm = pctUsed.exec(line);
    if (pm && !Number.isFinite(cur.pct)) { cur.pct = Number(pm[1]); continue; }
    const rm = resets.exec(line);
    if (rm && cur.resets == null) cur.resets = rm[1];
  }
  close();
  return { limits, factors };
};

// Poll `fn` every `stepMs` until it resolves truthy or `budgetMs` elapses.
const pollUntil = async <T>(fn: () => Promise<T | undefined>, budgetMs: number, stepMs: number): Promise<T | undefined> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(stepMs);
  }
};

const capture = async (pane: string, rows: number): Promise<string> => {
  const r = await runTmux(["capture-pane", "-t", pane, "-p", "-S", `-${rows}`]);
  return r.ok ? r.stdout : "";
};

// Drive `/usage` in a throwaway pane and return the parsed panel. Best-effort
// teardown in `finally` so a dead session name never lingers.
export const captureQuota = async (cfg: Config, log: Logger): Promise<QuotaReport> => {
  const cwd = expandHome(cfg.wrc.cwd);
  const session = `${cfg.wrc.tmuxPrefix}-usage`; // isolated from the mirror session
  const claudeBin = cfg.wrc.claudeBin;

  const probe = await runTmux(["-V"]);
  if (!probe.ok) throw new Error(`tmux not available: ${probe.stderr.trim() || probe.code}`);
  const ver = parseTmuxVersion(probe.stdout);
  const supportsC = ver >= 1.9; // `-c <start-dir>` (tmux 1.9)
  const supportsE = ver >= 3.0; // `-e KEY=VAL` (tmux 3.0)

  trustWorkspace(claudeBin, cwd, log); // skip the "trust this folder" prompt
  await runTmux(["kill-session", "-t", session]); // clear any stale probe pane

  const paneEnv = supportsE ? ["-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true"] : [];
  const cwdArg = supportsC ? ["-c", cwd] : [];
  const created = await runTmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"]);
  if (!created.ok) throw new Error(`tmux new-session failed: ${created.stderr.trim() || created.code}`);
  const pane = created.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  if (!pane) throw new Error("tmux returned no pane id");

  try {
    const envPrefix = [
      ...(supportsE ? [] : ["DISABLE_AUTO_UPDATE=true", "DISABLE_UPDATE_PROMPT=true"]),
      "DISABLE_AUTOUPDATER=1",
    ].join(" ");
    const cd = supportsC ? "" : `cd ${cwd.includes(" ") ? `'${cwd}'` : cwd} && `;
    await runTmux(["send-keys", "-t", pane, `${cd}${envPrefix} ${claudeBin}`, "Enter"]);

    // Wait for the TUI to reach an interactive prompt. Clear a stray trust
    // dialog defensively (pre-trust usually handles it, but be robust).
    const ready = await pollUntil(async () => {
      const cap = await capture(pane, 60);
      if (/trust this folder|Yes, I trust/i.test(cap)) {
        await runTmux(["send-keys", "-t", pane, "1"]);
        await sleep(300);
        await runTmux(["send-keys", "-t", pane, "Enter"]);
        return undefined;
      }
      return /for shortcuts|auto mode on|Try "/i.test(cap) ? true : undefined;
    }, 30_000, 500);
    if (!ready) throw new Error("claude TUI did not reach interactive prompt in 30s");

    await sleep(1200); // let the input box settle before the slash command
    await runTmux(["send-keys", "-t", pane, "/usage"]);
    await sleep(1000); // let the slash-command menu resolve, then run it
    await runTmux(["send-keys", "-t", pane, "Enter"]);

    // Wait for the panel to render the weekly block.
    const panelText = await pollUntil(async () => {
      const cap = await capture(pane, 180);
      return /Current week/i.test(cap) && /%\s*used/i.test(cap) ? cap : undefined;
    }, 20_000, 500);
    if (!panelText) throw new Error("/usage panel did not render in 20s");

    await sleep(800); // let percentages finish painting
    const finalText = await capture(pane, 180);
    const report = parseUsagePanel(finalText || panelText);
    report.raw = stripAnsi(finalText || panelText);
    return report;
  } finally {
    await runTmux(["send-keys", "-t", pane, "Escape"]).catch(() => undefined);
    await runTmux(["kill-session", "-t", session]).catch(() => undefined);
  }
};

const bar20 = (pct: number): string => {
  const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
  return "�?".repeat(n) + "�?".repeat(20 - n);
};

// Map the raw panel label to a WeCom heading. Generic: "session" �? 5h window,
// "week (X)" �? 本周·X, "week" �? 本周, anything else passes through verbatim so a
// future limit bucket still renders.
const headingFor = (label: string): string => {
  if (/^session\b/i.test(label)) return "�? 当前 5h 窗口";
  const wk = /^week\s*(?:\(([^)]*)\))?/i.exec(label);
  if (wk) return wk[1] ? `🗓�? 本周 · ${wk[1]}` : "🗓�? 本周";
  return `📊 ${label}`;
};

export const renderQuotaReport = (r: QuotaReport): string => {
  const out: string[] = ["[wezard] 📊 真实额度 · Claude Code /usage"];

  for (const l of r.limits) {
    out.push("", headingFor(l.label), `  ${bar20(l.pct)} **${l.pct}%**`);
    if (l.resets) out.push(`  重置: ${l.resets}`);
  }
  if (r.limits.length === 0) {
    out.push("", "⚠️ 未能�? /usage 面板读到额度数字");
    if (r.raw) out.push("```", r.raw.split("\n").filter((l) => l.trim()).slice(0, 12).join("\n"), "```");
  }

  if (r.factors.length) {
    out.push("", "🔎 额度构成 (�?24h · 本机本地会话估算)");
    for (const f of r.factors.slice(0, 6)) out.push(`  �? ${f}`);
  }
  return out.join("\n");
};
