// Pure HTML rendering for detail records — no IO, no state. Consumed by daemon's
// local /detail handler and the standalone svr binary. Any UI change here 自动
// 让两端保持同款外观。
import { structuredPatch, parsePatch, type StructuredPatchHunk } from "diff";
import { highlightCode, langFromPath } from "./highlight.js";
import { ansiToHtml } from "./ansi.js";
import { staleAt, turnDone } from "./chat-view.js";
import type {
  ApprovalDecision,
  ApprovalDetailRecord,
  CtxCut,
  DetailRecord,
  ToolDetailRecord,
  TurnDetailRecord,
  TurnItem,
} from "./detail-store.js";

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const fmtTs = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
};

// 42431 → "42.4k"; 999 → "999"; 12345678 → "12.35M"
const fmtTok = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1e6) {
    const v = n / 1000;
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
};

// token 分类配色 (统计卡片的堆叠条 + 图例共用)。
const TOK_COLORS = {
  ctx: "#0969da",       // 上下文峰值 (蓝)
  input: "#0a7d6b",     // 新鲜输入 (青绿)
  cacheRead: "#8250df", // 缓存读 (紫)
  cacheWrite: "#953800",// 缓存写 (棕)
  output: "#1a7f37",    // 输出 (绿)
} as const;

const decisionBadge = (d?: ApprovalDecision): { label: string; cls: string } => {
  if (!d) return { label: "待审批", cls: "pending" };
  if (d === "deny") return { label: "拒绝", cls: "deny" };
  if (d === "timeout") return { label: "超时", cls: "warn" };
  if (d === "allow_window") return { label: "通过 · 窗口", cls: "allow" };
  if (d === "allow_session") return { label: "通过 · 会话", cls: "allow" };
  if (d === "allow_always") return { label: "通过 · 已存规则", cls: "allow" };
  if (d === "swept") return { label: "通过 · 批量", cls: "allow" };
  if (d === "allow") return { label: "通过", cls: "allow" };
  return { label: String(d), cls: "pending" };
};

const highlightJson = (json: string): string => {
  const escaped = escHtml(json);
  return escaped.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (_m, key, str, kw, num) => {
      if (key) return `<span class="jk">${key}</span>`;
      if (str) return `<span class="js">${str}</span>`;
      if (kw) return `<span class="jb">${kw}</span>`;
      if (num) return `<span class="jn">${num}</span>`;
      return _m;
    },
  );
};

const toJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2) ?? "null"; } catch { return String(v); }
};

export const SHARED_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f6f8fa;color:#1f2328;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:24px 20px 60px}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  h1{margin:0;font-size:18px;font-weight:600}
  h1 .accent{color:#0969da}
  .meta{color:#656d76;font-size:12px;margin-bottom:20px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .meta .sep{margin:0 6px;opacity:.5}
  .badge{font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid #d0d7de}
  .badge.allow{color:#1a7f37;border-color:#1a7f3733;background:#1a7f3714}
  .badge.deny{color:#cf222e;border-color:#cf222e33;background:#cf222e14}
  .badge.warn{color:#9a6700;border-color:#9a670033;background:#9a670014}
  .badge.pending{color:#8250df;border-color:#8250df33;background:#8250df14}
  section{background:#fff;border:1px solid #d0d7de;border-radius:6px;
    margin-bottom:12px;overflow:hidden}
  section>h2{margin:0;padding:6px 12px;font-size:11px;font-weight:600;
    color:#656d76;text-transform:uppercase;letter-spacing:.5px;
    background:#f1f3f6;border-bottom:1px solid #d0d7de}
  pre{margin:0;padding:12px;font-size:12.5px;line-height:1.5;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .jk{color:#953800}.js{color:#0a3069}.jb{color:#9a6700}.jn{color:#8250df}
  .hc{color:#6e7781;font-style:italic}.hs{color:#0a3069}.hk{color:#cf222e}
  .hl{color:#8250df}.hn{color:#0550ae}.hv{color:#953800}
  .codeview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5;padding:8px 0}
  .codeview .row{display:grid;grid-template-columns:56px 1fr;min-width:0}
  .codeview .ln{color:#8c959f;text-align:right;padding:0 8px;
    user-select:none;font-variant-numeric:tabular-nums}
  .codeview .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5}
  .diff .row{display:grid;grid-template-columns:44px 44px 14px 1fr;min-width:0}
  .diff .row.add{background:#dafbe1}
  .diff .row.del{background:#ffebe9}
  .diff .row.hunk{background:#ddf4ff;color:#0969da;
    grid-template-columns:1fr;padding:1px 12px}
  .diff .ln{color:#8c959f;text-align:right;padding:0 6px;
    user-select:none;font-variant-numeric:tabular-nums}
  .diff .sign{text-align:center;color:#656d76;user-select:none}
  .diff .row.add .sign{color:#1a7f37}
  .diff .row.del .sign{color:#cf222e}
  .diff .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .diff-meta{padding:4px 12px;font-size:12px;color:#656d76;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    font-family:ui-monospace,monospace}
  details summary{cursor:pointer;color:#656d76;padding:6px 12px;font-size:11px;
    text-transform:uppercase;letter-spacing:.5px;font-weight:600;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    list-style:none;user-select:none}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▶ ";font-size:9px}
  details[open] summary::before{content:"▼ "}
`;

interface DiffBlock { path: string; oldStr: string; newStr: string; label?: string }

const renderHunks = (hunks: readonly StructuredPatchHunk[], label: string | undefined, path: string, lang?: string): string => {
  let adds = 0, dels = 0;
  const renderText = (t: string): string =>
    t === "" ? "&nbsp;" : (lang ? highlightCode(t, lang) : escHtml(t));
  const rowsHtml = hunks.flatMap((h) => {
    const header = `<div class="row hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>`;
    let oa = h.oldStart, nb = h.newStart;
    const body = h.lines
      .filter((ln) => !ln.startsWith("\\"))
      .map((ln) => {
        const sign = ln[0] ?? " ";
        const text = ln.slice(1);
        const tag = sign === "+" ? "add" : sign === "-" ? "del" : "eq";
        const oldLn = tag === "add" ? "" : oa++;
        const newLn = tag === "del" ? "" : nb++;
        if (tag === "add") adds++;
        else if (tag === "del") dels++;
        return `<div class="row ${tag}"><div class="ln">${oldLn}</div><div class="ln">${newLn}</div><div class="sign">${sign}</div><div class="txt">${renderText(text)}</div></div>`;
      })
      .join("");
    return [header, body];
  }).join("");
  const head = label ? `${escHtml(label)} · ` : "";
  return `<section>
    <h2>${head}<span style="color:#1a7f37">+${adds}</span> <span style="color:#cf222e">-${dels}</span>${path ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0">${escHtml(path)}</span>` : ""}</h2>
    <div class="diff">${rowsHtml}</div>
  </section>`;
};

const renderDiffBlock = (b: DiffBlock): string => {
  const norm = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  const patch = structuredPatch("a", "b", norm(b.oldStr), norm(b.newStr), "", "", { context: 3 });
  return renderHunks(patch.hunks, b.label, b.path, langFromPath(b.path));
};

const tryRenderUnifiedDiff = (text: string): string => {
  if (!/(^|\n)(diff --git |@@ -\d)/.test(text)) return "";
  let patches: ReturnType<typeof parsePatch>;
  try { patches = parsePatch(text); } catch { return ""; }
  const sections = patches
    .filter((p) => p.hunks && p.hunks.length > 0)
    .map((p, idx, arr) => {
      const path = p.newFileName || p.oldFileName || "";
      const label = arr.length > 1 ? `file ${idx + 1}/${arr.length}` : undefined;
      return renderHunks(p.hunks, label, path, langFromPath(path));
    })
    .join("");
  return sections;
};

const extractDiffBlocks = (toolName: string, input: unknown): DiffBlock[] => {
  if (!input || typeof input !== "object") return [];
  const i = input as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : "";
  if (toolName === "Edit") {
    const oldStr = typeof i.old_string === "string" ? i.old_string : "";
    const newStr = typeof i.new_string === "string" ? i.new_string : "";
    if (!oldStr && !newStr) return [];
    return [{ path, oldStr, newStr }];
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
    return edits.flatMap((e, idx) => {
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      const newStr = typeof e.new_string === "string" ? e.new_string : "";
      if (!oldStr && !newStr) return [];
      return [{ path, oldStr, newStr, label: `edit ${idx + 1}/${edits.length}` }];
    });
  }
  if (toolName === "Write") {
    const content = typeof i.content === "string" ? i.content : "";
    return [{ path, oldStr: "", newStr: content, label: "create / overwrite" }];
  }
  return [];
};

const renderBashCommand = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const cmd = typeof i.command === "string" ? i.command : "";
  if (!cmd) return "";
  const desc = typeof i.description === "string" ? i.description : "";
  const subtitle = desc ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(desc)}</span>` : "";
  return `<section><h2>command${subtitle}</h2><pre><code>${highlightCode(cmd, "bash")}</code></pre></section>`;
};

const CAT_N_RE = /^\s*(\d+)\t(.*)$/;
const renderReadContent = (text: string, filePath: string): string => {
  const lang = langFromPath(filePath);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = lines
    .map((line) => {
      const m = CAT_N_RE.exec(line);
      const num = m ? m[1]! : "";
      const content = m ? m[2]! : line;
      const txt = content === "" ? "&nbsp;" : highlightCode(content, lang);
      return `<div class="row"><div class="ln">${num}</div><div class="txt">${txt}</div></div>`;
    })
    .join("");
  const langLabel = lang ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(lang)}</span>` : "";
  const head = filePath ? `<span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(filePath)}</span>${langLabel}` : `content${langLabel}`;
  return `<section><h2>${head}</h2><div class="codeview">${rows}</div></section>`;
};

const renderToolPage = (r: ToolDetailRecord): string => {
  const inputJson = highlightJson(toJson(r.toolInput));
  const hasResult = typeof r.toolResult === "string" && r.toolResult.length > 0;
  const isBash = r.toolName === "Bash";
  const isRead = r.toolName === "Read";
  const diffResultHtml = hasResult && !isRead ? tryRenderUnifiedDiff(r.toolResult!) : "";
  const filePath = isRead && r.toolInput && typeof r.toolInput === "object"
    ? String((r.toolInput as Record<string, unknown>).file_path ?? "")
    : "";
  const readResultHtml = isRead && hasResult ? renderReadContent(r.toolResult!, filePath) : "";
  const resultBlock = readResultHtml
    ? `${readResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
    : hasResult
      ? (diffResultHtml
        ? `${diffResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
        : `<section><h2>result</h2><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></section>`)
    : `<section><h2>result</h2><pre style="color:#656d76;font-style:italic"><code>(尚未捕获)</code></pre></section>`;
  const status = hasResult
    ? `<span class="badge allow">完成${r.resultAt ? ` · ${fmtDuration(r.resultAt - r.createdAt)}` : ""}</span>`
    : `<span class="badge pending">运行中</span>`;
  const diffBlocks = extractDiffBlocks(r.toolName, r.toolInput);
  const diffSection = diffBlocks.map(renderDiffBlock).join("");
  const bashCommandHtml = isBash ? renderBashCommand(r.toolInput) : "";
  const hasPrimary = diffBlocks.length > 0 || bashCommandHtml || readResultHtml;
  const inputSection = hasPrimary
    ? `<section><details><summary>input</summary><pre><code>${inputJson}</code></pre></details></section>`
    : `<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>`;
  const metaParts = [
    fmtTs(r.createdAt),
    r.sessionId ? r.sessionId.slice(0, 8) : null,
    r.target || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>${status}</header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
${bashCommandHtml}
${diffSection}
${inputSection}
${resultBlock}
</div></body></html>`;
};

const renderApprovalPage = (r: ApprovalDetailRecord): string => {
  const badge = decisionBadge(r.decision);
  const inputJson = highlightJson(toJson(r.toolInput));
  const ageMs = (r.decidedAt ?? Date.now()) - r.createdAt;
  const transcript = r.transcriptTail.trim();
  const metaParts = [
    fmtTs(r.createdAt),
    r.decidedAt ? `用时 ${fmtDuration(ageMs)}` : null,
    r.decidedBy || null,
    r.cwd || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>
<span class="badge ${badge.cls}">${badge.label}</span></header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>
${transcript
    ? `<section><details><summary>transcript (${transcript.split("\n").length} 行)</summary><pre><code>${ansiToHtml(transcript)}</code></pre></details></section>`
    : ""}
</div></body></html>`;
};

// ── Turn (brief-mode) 聚合页 ────────────────────────────────────────────
// 一个 turn 内的所有 item 按 ts 序渲染成 claude.ai 风格气泡时间线。
// tool_use 与其配对的 tool_result 合并为一个可折叠 section (按 toolUseId 匹配)。
// assistant text 用客户端 markdown-it + highlight.js 富文本渲染 —— 服务端只输出
// 转义后的原文放到 data-md, 页尾脚本一次性 render 到 .md-body。未 closed 时页面
// 每 2s meta-refresh, closed 后移除 refresh + 状态徽章切「已完成 · 用时Xs」。
const TURN_CSS = `
  .bubbles{display:flex;flex-direction:column;gap:14px;margin-top:8px}
  .bubble{background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden}
  .bubble.assistant{background:#fff}
  .bubble.final{border-color:#1a7f3766;box-shadow:0 0 0 2px #1a7f3714}
  .bubble.approval{background:#fbfaff}
  .bubble-head{display:flex;align-items:center;gap:8px;padding:10px 14px;
    font-size:13px;color:#1f2328;flex-wrap:wrap}
  .bubble-head .role{font-weight:600}
  .bubble-head .ts{margin-left:auto;color:#8c959f;font-size:11px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .bubble-head .compact{color:#656d76;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .md-body{padding:2px 16px 14px;color:#1f2328;line-height:1.65;font-size:14px}
  .md-body p{margin:.6em 0}
  .md-body h1,.md-body h2,.md-body h3{margin:1em 0 .4em;font-weight:600}
  .md-body h1{font-size:1.4em}.md-body h2{font-size:1.2em}.md-body h3{font-size:1.05em}
  .md-body ul,.md-body ol{margin:.6em 0;padding-left:1.6em}
  .md-body li{margin:.2em 0}
  .md-body code{background:#f6f8fa;border-radius:4px;padding:1px 5px;font-size:.9em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .md-body pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;
    margin:.7em 0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .md-body pre code{background:transparent;padding:0;font-size:12.5px;line-height:1.5}
  .md-body pre code.hljs{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .md-body blockquote{margin:.6em 0;padding:.2em 1em;border-left:3px solid #d0d7de;color:#656d76}
  .md-body table{border-collapse:collapse;margin:.7em 0}
  .md-body th,.md-body td{border:1px solid #d0d7de;padding:6px 10px}
  .md-body a{color:#0969da;text-decoration:none}
  .md-body a:hover{text-decoration:underline}
  .bubble details{border-top:1px solid #eaeef2}
  .bubble details summary{background:#f6f8fa;border-bottom:0}
  .typing{color:#8c959f;font-style:italic;padding:10px 14px;
    background:#fff;border:1px dashed #d0d7de;border-radius:12px}
  .typing::after{content:"";display:inline-block;width:6px;height:6px;
    background:#8c959f;border-radius:50%;margin-left:6px;
    animation:blink 1.2s infinite}
  @keyframes blink{0%,60%,100%{opacity:.2}30%{opacity:1}}
  .turn-info{display:flex;flex-wrap:wrap;gap:6px;margin:-6px 0 12px;align-items:center}
  .turn-info:empty{display:none}
  .chip.model{font-size:12px;padding:3px 10px;border-radius:12px;color:#0969da;
    background:#0969da10;border:1px solid #0969da33;font-weight:600;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .chip.model .alt{opacity:.6;font-weight:400}
  .chip.tier{font-size:11px;padding:2px 8px;border-radius:10px;color:#9a6700;
    background:#9a670010;border:1px solid #9a670033;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  /* ── 统计卡片 ── */
  .stats{background:#fff;border:1px solid #d0d7de;border-radius:12px;
    padding:18px 18px 16px;margin:0 0 16px;
    box-shadow:0 1px 2px #1f23280a}
  .stats-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
    gap:10px;margin-bottom:16px}
  .tile{background:#f6f8fa;border:1px solid #eaeef2;border-radius:10px;
    padding:12px 14px;display:flex;flex-direction:column;gap:3px}
  .tile .k{font-size:11px;color:#8c959f;text-transform:uppercase;
    letter-spacing:.5px;font-weight:600}
  .tile .v{font-size:24px;font-weight:700;line-height:1.1;
    font-variant-numeric:tabular-nums;color:#1f2328;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .tile .v .u{font-size:14px;font-weight:600;color:#8c959f;margin-left:1px}
  .tile.accent .v{color:#0969da}
  .stats-io .io-title{font-size:11px;color:#8c959f;text-transform:uppercase;
    letter-spacing:.5px;font-weight:600;margin-bottom:8px}
  .io-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;
    background:#eaeef2;margin-bottom:10px}
  .io-bar .seg{height:100%}
  .io-legend{display:flex;flex-wrap:wrap;gap:14px}
  .io-legend .item{display:flex;align-items:center;gap:6px;font-size:12px;
    color:#57606a}
  .io-legend .dot{width:9px;height:9px;border-radius:3px;flex:none}
  .io-legend .num{font-weight:700;color:#1f2328;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-variant-numeric:tabular-nums}
  /* ── 用户提问气泡 ── */
  .bubble.user{background:#0969da0a;border-color:#0969da33}
  .bubble.user .bubble-head{color:#0969da}
  .bubble.user .q-body{padding:2px 16px 14px;color:#1f2328;line-height:1.6;
    font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  /* ── 工具调用 (Claude CLI 风): 去卡片, 默认折叠, ⎿ 结果预览 ── */
  .bubble.tool{background:transparent;border:0;border-radius:0;overflow:visible}
  .bubble .tool-call{border:0}
  .bubble .tool-call>summary{list-style:none;cursor:pointer;display:flex;
    align-items:baseline;gap:7px;padding:3px 6px;border-radius:6px;border:0;
    background:transparent;color:#1f2328;font-size:13.5px;font-weight:400;
    text-transform:none;letter-spacing:0}
  .bubble .tool-call>summary::-webkit-details-marker{display:none}
  .bubble .tool-call>summary::before{content:none}
  .bubble .tool-call>summary:hover{background:#f0f3f6}
  .tool-dot{color:#1a7f37;font-size:11px;align-self:center;flex:none}
  .tool-call[open]>summary .tool-dot{color:#0969da}
  .tool-name{font-weight:600;flex:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .tool-arg{color:#656d76;min-width:0;flex:0 1 auto;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tool-dur{color:#8c959f;font-size:11px;flex:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .tool-summary .ts{margin-left:auto;flex:none}
  .tool-body{padding:8px 0 4px 16px;margin:2px 0 0 9px;
    border-left:2px solid #eaeef2}
  .tool-body>section{margin-bottom:8px}
  .tool-body>section:last-child,.tool-body>details:last-child{margin-bottom:0}
  .tool-result-line{padding:2px 6px 4px 24px;color:#57606a;font-size:12.5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tool-call[open] ~ .tool-result-line{display:none}
  .tool-result-line .corner{color:#b1bac4;margin-right:6px}
  .tool-result-line .add{color:#1a7f37;font-weight:600}
  .tool-result-line .del{color:#cf222e;font-weight:600}
  .tool-result-line .more{color:#8c959f}
  .tool-result-line .run{color:#9a6700}
  /* ── 上下文断点条 ── */
  .tg-cut{display:flex;align-items:center;gap:8px;font-size:11px;color:#9a6700;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
  .tg-cut::before,.tg-cut::after{content:"";border-top:1px dashed #d4a72c99}
  .tg-cut::before{flex:0 0 14px}
  .tg-cut::after{flex:1}
  .tg-cut .s{opacity:.6}
  .tg-cut.switch{color:#8c959f}
  .tg-cut.switch::before,.tg-cut.switch::after{border-top-color:#d0d7de}
  /* ── graph 归因条 ── 与断点条同一视觉语法 (贯穿细线), 换成紫色: 断点讲"上下文",
     归因讲"谁派的", 两者可以同时出现在一张卡片上, 必须一眼分得开。 */
  .tg-graph{display:flex;align-items:center;gap:8px;font-size:11px;color:#6639ba;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
  .tg-graph::after{content:"";flex:1;border-top:1px dashed #8250df66}
  .tg-graph code{background:#8250df14;border-radius:4px;padding:0 4px}
  .tg-graph .s{color:#8250df;opacity:.85}
  .tg-graph .f{color:#8c959f}
`;

const renderJsonSection = (input: unknown): string =>
  `<details><summary>input</summary><pre><code>${highlightJson(toJson(input))}</code></pre></details>`;

// 结果行数 (末尾换行不计)。
const countLines = (s: string): number => {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
};

// Edit/Write/MultiEdit 的 +增 -删 汇总, 供折叠态 ⎿ 预览行用 (context:0 只数改动行)。
const diffStat = (blocks: readonly DiffBlock[]): { adds: number; dels: number } => {
  const norm = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  return blocks.reduce(
    (acc, b) => {
      const p = structuredPatch("a", "b", norm(b.oldStr), norm(b.newStr), "", "", { context: 0 });
      for (const h of p.hunks)
        for (const ln of h.lines) {
          if (ln.startsWith("+")) acc.adds++;
          else if (ln.startsWith("-")) acc.dels++;
        }
      return acc;
    },
    { adds: 0, dels: 0 },
  );
};

// Claude CLI 的 ⎿ 结果摘要: diff 工具→增删数, Read→行数, 其余→首行 + 行数。
const toolResultPreview = (
  use: Extract<TurnItem, { t: "tool_use" }>,
  diffBlocks: readonly DiffBlock[],
  rawResult: string,
  hasResult: boolean,
): string => {
  if (!hasResult) return `<span class="corner">⎿</span><span class="run">运行中…</span>`;
  if (diffBlocks.length > 0) {
    const { adds, dels } = diffStat(diffBlocks);
    return `<span class="corner">⎿</span>更新 <span class="add">+${adds}</span> <span class="del">-${dels}</span>`;
  }
  if (use.toolName === "Read")
    return `<span class="corner">⎿</span>读取 ${countLines(rawResult)} 行`;
  const lines = countLines(rawResult);
  const first = rawResult.split("\n").find((l) => l.trim() !== "") ?? "";
  const head = escHtml(truncate(first.replace(/\s+/g, " ").trim(), 88));
  const more = lines > 1 ? ` <span class="more">+${lines - 1} 行</span>` : "";
  return `<span class="corner">⎿</span>${head || "(空)"}${more}`;
};

const renderToolBubble = (
  use: Extract<TurnItem, { t: "tool_use" }>,
  result: Extract<TurnItem, { t: "tool_result" }> | undefined,
  key: string,
): string => {
  const isBash = use.toolName === "Bash";
  const isRead = use.toolName === "Read";
  const bashHtml = isBash ? renderBashCommand(use.toolInput) : "";
  const diffBlocks = extractDiffBlocks(use.toolName, use.toolInput);
  const diffHtml = diffBlocks.map(renderDiffBlock).join("");
  const rawResult = result?.body ?? "";
  const readResultHtml = isRead && rawResult ? renderReadContent(rawResult, extractFilePath(use.toolInput)) : "";
  const diffResultHtml = rawResult && !isRead ? tryRenderUnifiedDiff(rawResult) : "";
  const primary = [bashHtml, diffHtml, readResultHtml, diffResultHtml].filter(Boolean).join("");
  const inputSection = primary
    ? renderJsonSection(use.toolInput)
    : `<details open><summary>input</summary><pre><code>${highlightJson(toJson(use.toolInput))}</code></pre></details>`;
  const resultRaw = rawResult
    ? `<details><summary>result (raw)</summary><pre><code>${ansiToHtml(rawResult)}</code></pre></details>`
    : `<details><summary>result</summary><pre style="color:#656d76;font-style:italic;margin:0;padding:12px"><code>(尚未捕获)</code></pre></details>`;
  // 头部一行: ⏺ 工具名(参数) — 参数取命令/路径等主字段, 与 Claude CLI 同款。
  const arg = oneLineCompact(use.toolInput, 72);
  const dur = result ? `<span class="tool-dur">${escHtml(fmtDuration(result.ts - use.ts))}</span>` : "";
  const preview = toolResultPreview(use, diffBlocks, rawResult, Boolean(result));
  // 整个工具调用折叠进 <details> (默认收起); ⎿ 预览行是它的兄弟, 展开时 CSS 隐藏。
  return `<section class="bubble tool" data-key="${key}">
    <details class="tool-call">
      <summary class="tool-summary"><span class="tool-dot">⏺</span><span class="tool-name">${escHtml(use.toolName)}</span>${arg ? `<span class="tool-arg">(${escHtml(arg)})</span>` : ""}${dur}<span class="ts">${fmtTs(use.ts)}</span></summary>
      <div class="tool-body">${primary}${inputSection}${resultRaw}</div>
    </details>
    <div class="tool-result-line">${preview}</div>
  </section>`;
};

const oneLineCompact = (input: unknown, max = 100): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return truncate(pick.replace(/\s+/g, " ").trim(), max);
  }
  try { return truncate(JSON.stringify(input) ?? "", max); } catch { return ""; }
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const extractFilePath = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>).file_path;
  return typeof v === "string" ? v : "";
};

const renderTextBubble = (item: Extract<TurnItem, { t: "text" }>, key: string): string => {
  const role = item.final ? "assistant · final" : "assistant";
  const cls = item.final ? "bubble final" : "bubble assistant";
  // 原文用 <script type="text/plain"> 承载 —— 免转义歧义, JS 端 textContent 读回原样。
  return `<section class="${cls}" data-key="${key}">
    <div class="bubble-head"><span class="role">${escHtml(role)}</span>
      <span class="ts">${fmtTs(item.ts)}</span></div>
    <div class="md-body"></div>
    <script type="text/plain" class="md-src">${escHtml(item.body)}</script>
  </section>`;
};

const renderApprovalItem = (item: Extract<TurnItem, { t: "approval" }>, key: string): string => {
  const b = decisionBadge(item.decision);
  return `<section class="bubble approval" data-key="${key}">
    <div class="bubble-head">🔐 <span class="role">${escHtml(item.toolName)}</span>
      <span class="badge ${b.cls}">${b.label}</span>
      <span class="ts">${fmtTs(item.ts)}</span></div>
  </section>`;
};

const pairItems = (items: readonly TurnItem[]): Array<{ kind: "solo"; item: TurnItem } | { kind: "pair"; use: Extract<TurnItem, { t: "tool_use" }>; result?: Extract<TurnItem, { t: "tool_result" }> }> => {
  const results = new Map<string, Extract<TurnItem, { t: "tool_result" }>>();
  for (const it of items) if (it.t === "tool_result") results.set(it.toolUseId, it);
  const paired: ReturnType<typeof pairItems> = [];
  const consumed = new Set<string>();
  for (const it of items) {
    if (it.t === "tool_use") {
      const r = results.get(it.toolUseId);
      if (r) consumed.add(it.toolUseId);
      paired.push({ kind: "pair", use: it, result: r });
    } else if (it.t === "tool_result") {
      if (consumed.has(it.toolUseId)) continue; // 已附在 tool_use bubble 里
      paired.push({ kind: "solo", item: it });
    } else {
      paired.push({ kind: "solo", item: it });
    }
  }
  return paired;
};

// token 数 → "42.4k" 拆成 {n, u} 供 tile 用大数字 + 小单位分开排版。
const splitTok = (n: number): { n: string; u: string } => {
  const s = fmtTok(n);
  const m = /^([\d.]+)([kM]?)$/.exec(s);
  return m ? { n: m[1]!, u: m[2]! } : { n: s, u: "" };
};

const tile = (label: string, n: number, accent = false): string => {
  const { n: num, u } = splitTok(n);
  return `<div class="tile${accent ? " accent" : ""}"><span class="k">${label}</span>
    <span class="v">${num}${u ? `<span class="u">${u}</span>` : ""}</span></div>`;
};

// 累计 token I/O 的堆叠条 + 图例。上下文峰值单列一 tile, 这里画的是「总共读写了多少」
// 的计费口径 (cacheRead 常远大于窗口占用, 属正常 —— 每次调用重读同一前缀累加)。
const renderStats = (u: NonNullable<TurnDetailRecord["usage"]>, ctxPeak: number, ageMs: number, done: boolean): string => {
  const allSegs: Array<{ key: keyof typeof TOK_COLORS; label: string; n: number }> = [
    { key: "input", label: "Input", n: u.input },
    { key: "cacheRead", label: "Cache read", n: u.cacheRead },
    { key: "cacheWrite", label: "Cache write", n: u.cacheWrite },
    { key: "output", label: "Output", n: u.output },
  ];
  const segs = allSegs.filter((s) => s.n > 0);
  const total = segs.reduce((a, s) => a + s.n, 0) || 1;
  const bar = segs
    .map((s) => `<span class="seg" style="width:${((s.n / total) * 100).toFixed(2)}%;background:${TOK_COLORS[s.key]}" title="${s.label}: ${fmtTok(s.n)}"></span>`)
    .join("");
  const legend = segs
    .map((s) => `<span class="item"><span class="dot" style="background:${TOK_COLORS[s.key]}"></span>${s.label} <span class="num">${fmtTok(s.n)}</span></span>`)
    .join("");
  const tiles = [
    tile("Context", ctxPeak, true),
    tile("Output", u.output),
    `<div class="tile"><span class="k">API calls</span><span class="v">${u.calls}</span></div>`,
    `<div class="tile"><span class="k">${done ? "Duration" : "Elapsed"}</span><span class="v" style="font-size:20px">${escHtml(fmtDuration(ageMs))}</span></div>`,
  ].join("");
  return `<section class="stats">
    <div class="stats-tiles">${tiles}</div>
    <div class="stats-io">
      <div class="io-title">Token I/O · cumulative</div>
      <div class="io-bar">${bar}</div>
      <div class="io-legend">${legend}</div>
    </div>
  </section>`;
};

// djb2 → base36. reconcile 用它做「气泡内容变没变」的判据 —— 不用 outerHTML, 因为客户端
// 会往 text 气泡的 .md-body 里填渲染结果, 污染 outerHTML; data-sig 是服务端算的纯内容指纹。
const hashStr = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// 在气泡根 tag 的 data-key 后补一个 data-sig=内容指纹 (指纹基于未含 sig 的原 html)。
const tagSig = (html: string): string =>
  html ? html.replace(/(data-key="[^"]*")/, `$1 data-sig="${hashStr(html)}"`) : "";

// 一个 turn 的可复用切片: 排序后的 items、渲染好的气泡、完成态与耗时。
// 单 turn 页 (renderTurnPage) 和 chat 线程页 (renderTurnGroup) 共用同一份产物 ——
// keyPrefix 让线程页里多个 turn 的 data-key 不互撞。
const turnParts = (r: TurnDetailRecord, keyPrefix = "", now = Date.now()): {
  items: TurnItem[];
  bodies: string[];
  done: boolean;
  ageMs: number;
} => {
  const items = [...r.items].sort((a, b) => a.ts - b.ts);
  const paired = pairItems(items);
  // data-key = 稳定项键 (items 只追加、按 ts 单调, 位置永不前移 → 索引稳定唯一)。
  // 客户端 reconcile 按此键复用未变气泡的 DOM 节点, 从而保住用户手动展开/折叠的 <details>。
  const bodies = paired.map((p, i) => {
    const key = `${keyPrefix}b${i}`;
    if (p.kind === "pair") return renderToolBubble(p.use, p.result, key);
    const it = p.item;
    if (it.t === "text") return renderTextBubble(it, key);
    if (it.t === "approval") return renderApprovalItem(it, key);
    if (it.t === "tool_result") {
      return `<section class="bubble tool" data-key="${key}">
        <div class="bubble-head">↩ <span class="role">tool_result</span>
          <span class="compact">${escHtml(it.toolUseId)}</span>
          <span class="ts">${fmtTs(it.ts)}</span></div>
        <details open><summary>result</summary><pre><code>${escHtml(it.body)}</code></pre></details>
      </section>`;
    }
    return "";
  });
  // 结束判定统一收在 chat-view.turnDone (closed / final text / 静默超时), 详情页
  // 与聊天视图必须给出同一个答案 —— 否则一个显示「进行中」另一个显示「已完成」。
  const done = turnDone(r, now);
  return { items, bodies, done, ageMs: (done ? r.updatedAt : now) - r.createdAt };
};

const CUT_TEXT: Record<CtxCut, string> = {
  clear: "上下文已清空 · /clear",
  new: "新会话 · /new",
  switch: "会话已轮换",
};

// 断点条挂在 turn 卡片顶部而不是两卡之间 —— 片段必须始终只有一个根节点, chat.js 的
// upsertTurn/reconcile 是按 data-key 认领整个 turn-group 的, 多根会让它取错节点。
const renderCut = (r: TurnDetailRecord): string =>
  r.cut
    ? `<div class="tg-cut ${r.cut}"><span class="l">${escHtml(CUT_TEXT[r.cut])}</span>${
        r.sessionId ? `<span class="s">${escHtml(r.sessionId.slice(0, 8))}</span>` : ""
      }</div>`
    : "";

// 归因条: 这一轮不是人打的字。userQuery 长得和真人消息一模一样, 没有这一条就分不出
// 「有人在跟 #fix 说话」和「graph 第 3 轮把 #review 的回复喂了过来」。
const renderOrigin = (r: TurnDetailRecord): string => {
  const o = r.origin;
  if (!o) return "";
  const from = o.fromTag ? ` <span class="f">← ${escHtml(`#${o.fromTag}`)}</span>` : "";
  return `<div class="tg-graph"><span class="l">🕸 graph <code>${escHtml(o.runId)}</code></span>` +
    `<span class="s">轮 ${o.round}/${o.rounds} · 步 ${o.step}/${o.steps}</span>${from}</div>`;
};

const renderTurnPage = (r: TurnDetailRecord): string => {
  const { items, bodies, done, ageMs } = turnParts(r);
  const statusBadge = done
    ? `<span class="badge allow">已完成 · ${fmtDuration(ageMs)}</span>`
    : `<span class="badge pending">进行中</span>`;
  const modelChip = r.model
    ? `<span class="chip model">${escHtml(r.model)}${r.modelAlt ? `<span class="alt"> +${r.modelAlt}</span>` : ""}</span>`
    : "";
  const u = r.usage;
  // 上下文 = 单次 API 调用送入的 input+缓存读+缓存写 的峰值 (窗口占用高水位), 与下方
  // 累计 I/O 语义不同。窗口上限/占比不再展示 —— 长上下文变体口径不准, 易误导。
  const ctxPeak = u ? (u.ctxPeak ?? (u.input + u.cacheRead + u.cacheWrite)) : 0;
  const tierChip = u?.serviceTier && u.serviceTier !== "standard"
    ? `<span class="chip tier">${escHtml(u.serviceTier)}</span>` : "";
  const turnInfo = modelChip || tierChip ? `<div class="turn-info">${modelChip}${tierChip}</div>` : "";
  const statsCard = u ? renderStats(u, ctxPeak, ageMs, done) : "";
  const queryBubble = r.userQuery
    ? `<section class="bubble user" data-key="user">
        <div class="bubble-head">💬 <span class="role">User</span></div>
        <div class="q-body">${escHtml(r.userQuery)}</div>
      </section>`
    : "";
  const metaParts = [
    fmtTs(r.createdAt),
    r.sessionId ? r.sessionId.slice(0, 8) : null,
    r.target || null,
    `${items.length} 项`,
  ].filter(Boolean) as string[];
  const typing = done ? "" : `<div class="typing" data-key="typing">Agent 正在思考</div>`;
  // markdown-it + highlight.js from unpkg CDN. html:false 防注入; linkify + breaks 更贴聊天。
  // 未 closed 时客户端 2s 轮询同一 URL — DOMParser 抽 .bubbles 后按 data-key reconcile:
  // 未变气泡复用原 DOM 节点 (连带用户手动展开/折叠的 <details> 一并保住), 变化/新增气泡
  // 才换成新节点、并从快照回填用户改过的折叠态。整页不重刷 → 保留滚动位置 + CDN 缓存。
  // closed 时 body[data-closed=1], 轮询自终止。
  const script = `
(function(){
  var render = function(scope){
    if(!window.markdownit) return;
    var hl = function(str,lang){
      if(lang && window.hljs){
        try{return window.hljs.highlight(str,{language:lang,ignoreIllegals:true}).value}catch(e){}
      }
      if(window.hljs){try{return window.hljs.highlightAuto(str).value}catch(e){}}
      return '';
    };
    var md = window.markdownit({html:false, linkify:true, breaks:true, highlight:hl});
    scope.querySelectorAll('.bubble').forEach(function(b){
      var src = b.querySelector('script.md-src');
      var body = b.querySelector('.md-body');
      // 已渲染过的复用节点跳过 —— 免闪一下, 也不动其内部状态。
      if(src && body && body.dataset.rendered !== '1'){
        body.innerHTML = md.render(src.textContent||'');
        body.dataset.rendered = '1';
      }
    });
  };
  // key#idx → <details>.open 快照, 供换新节点后回填用户手动折叠态。
  var snapOpen = function(scope){
    var m = {};
    scope.querySelectorAll('[data-key]').forEach(function(b){
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function(d,i){ m[k+'#'+i] = d.open; });
    });
    return m;
  };
  var restoreOpen = function(scope, m){
    scope.querySelectorAll('[data-key]').forEach(function(b){
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function(d,i){
        var v = m[k+'#'+i]; if(v !== undefined) d.open = v;
      });
    });
  };
  // 按 data-key diff: data-sig (服务端内容指纹) 相同则原样保留旧节点, 否则采纳新节点。
  var reconcile = function(cur, next){
    var open = snapOpen(cur);
    var existing = {};
    Array.prototype.forEach.call(cur.children, function(c){
      var k = c.getAttribute('data-key'); if(k) existing[k] = c;
    });
    var nodes = Array.prototype.map.call(next.children, function(nc){
      var k = nc.getAttribute('data-key');
      var ex = k ? existing[k] : null;
      var same = ex && ex.getAttribute('data-sig') === nc.getAttribute('data-sig');
      return same ? ex : document.importNode(nc, true);
    });
    cur.replaceChildren.apply(cur, nodes);
    restoreOpen(cur, open);
    render(cur);
  };
  render(document);
  if(document.body.dataset.closed === '1') return;
  var url = location.href;
  var tick = function(){
    fetch(url, {cache:'no-store'}).then(function(r){return r.text()}).then(function(html){
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var newBubbles = doc.querySelector('.bubbles');
      var curBubbles = document.querySelector('.bubbles');
      if(newBubbles && curBubbles){
        reconcile(curBubbles, newBubbles);
      }
      var newBadge = doc.querySelector('header .badge');
      var curBadge = document.querySelector('header .badge');
      if(newBadge && curBadge){ curBadge.outerHTML = newBadge.outerHTML; }
      var newInfo = doc.querySelector('.turn-info');
      var curInfo = document.querySelector('.turn-info');
      if(newInfo && curInfo){ curInfo.outerHTML = newInfo.outerHTML; }
      var newStats = doc.querySelector('.stats');
      var curStats = document.querySelector('.stats');
      if(newStats && curStats){ curStats.outerHTML = newStats.outerHTML; }
      else if(newStats && curBubbles){ curBubbles.parentNode.insertBefore(newStats, curBubbles); }
      else if(newStats){ document.querySelector('.wrap').appendChild(newStats); }
      var nowClosed = doc.body.dataset.closed === '1';
      if(nowClosed){ document.body.dataset.closed = '1'; return; }
      setTimeout(tick, 2000);
    }).catch(function(){ setTimeout(tick, 2000); });
  };
  setTimeout(tick, 2000);
})();
`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turn Details</title>
<link rel="stylesheet" href="https://unpkg.com/highlight.js@11/styles/github.min.css">
<style>${SHARED_CSS}${TURN_CSS}</style>
<script src="https://unpkg.com/markdown-it@14/dist/markdown-it.min.js"></script>
<script src="https://unpkg.com/@highlightjs/cdn-assets@11/highlight.min.js"></script>
</head><body data-closed="${done ? "1" : "0"}"><div class="wrap">
<header><h1><span class="accent">Turn Details</span></h1>${statusBadge}</header>
${renderCut(r)}
${renderOrigin(r)}
${turnInfo}
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
${statsCard}
<div class="bubbles">${[queryBubble, ...bodies, typing].map(tagSig).join("")}</div>
</div>
<script>${script}</script>
</body></html>`;
};

// ── Chat 线程视图用的单 turn 片段 ──────────────────────────────────────
// 与 renderTurnPage 同源 (turnParts), 但去掉整页外壳与大统计卡: 线程里一个 turn
// 只留一条分隔头 (时间 / model / 状态 / 本轮 token), 总账走页脚 status bar。
// 返回 html + sig, 让客户端按 sig 判断"这条 turn 变没变", 不用 diff 整段 DOM。
export interface TurnFragment {
  id: string;
  html: string;
  sig: string;
  createdAt: number;
  updatedAt: number;
  done: boolean;
  /** 见 chat-view.staleAt: 无新写入时本轮到点自动算结束。0 = 已结束。
   *  SSE 只在有写入时推送, 靠它客户端才能自行把「正在思考」熄掉。 */
  staleAt: number;
}

export const renderTurnGroup = (r: TurnDetailRecord, now = Date.now()): TurnFragment => {
  const { items, bodies, done, ageMs } = turnParts(r, `${r.id}:`, now);
  const u = r.usage;
  const ctxPeak = u ? (u.ctxPeak ?? u.input + u.cacheRead + u.cacheWrite) : 0;
  const chips = [
    r.model ? `<span class="chip model">${escHtml(r.model)}${r.modelAlt ? `<span class="alt"> +${r.modelAlt}</span>` : ""}</span>` : "",
    u?.serviceTier && u.serviceTier !== "standard" ? `<span class="chip tier">${escHtml(u.serviceTier)}</span>` : "",
    ctxPeak ? `<span class="tg-tok" title="上下文峰值">ctx ${fmtTok(ctxPeak)}</span>` : "",
    u?.output ? `<span class="tg-tok" title="输出 token">out ${fmtTok(u.output)}</span>` : "",
    // 耗时只在收口后写死 —— 进行中的 turn 每次渲染都会得到不同的 ageMs, 会把 sig 打乱,
    // 让 SSE 的"内容没变就不重发"彻底失效。进行中的时长由页脚 status bar 负责。
    done ? `<span class="tg-tok">${escHtml(fmtDuration(ageMs))}</span>` : "",
  ].filter(Boolean).join("");
  const queryBubble = r.userQuery
    ? `<section class="bubble user" data-key="${r.id}:user">
        <div class="bubble-head">💬 <span class="role">User</span></div>
        <div class="q-body">${escHtml(r.userQuery)}</div>
      </section>`
    : "";
  const typing = done ? "" : `<div class="typing" data-key="${r.id}:typing">Agent 正在思考</div>`;
  const inner = [queryBubble, ...bodies, typing].map(tagSig).join("");
  const head = `<div class="tg-head">
    <span class="tg-dot${done ? "" : " live"}"></span>
    <span class="tg-time">${fmtTs(r.createdAt)}</span>${chips}
    <a class="tg-link" href="detail?id=${encodeURIComponent(r.id)}" target="_blank" title="${items.length} 项">↗</a>
  </div>`;
  // staleAt 只走 JSON, 绝不进 HTML —— 它跟着 updatedAt 变, 一旦计入 sig, SSE 的
  // "内容没变就不重发" 会彻底失效 (一个 turn 的 HTML 可以是几十 KB)。
  const body = `<section class="turn-group${r.cut ? ` cut cut-${r.cut}` : ""}${r.origin ? " graph" : ""}" data-key="t:${escHtml(r.id)}">${renderCut(r)}${renderOrigin(r)}${head}<div class="bubbles">${inner}</div></section>`;
  return {
    id: r.id, html: tagSig(body), sig: hashStr(body),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    done, staleAt: done ? 0 : staleAt(r),
  };
};

export { escHtml, fmtTs, fmtDuration, fmtTok, TURN_CSS };

export const renderDetailPage = (r: DetailRecord): string => {
  if (r.kind === "tool") return renderToolPage(r);
  if (r.kind === "turn") return renderTurnPage(r);
  return renderApprovalPage(r);
};

export const renderNotFound = (id: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;background:#f6f8fa;color:#1f2328;padding:60px 20px;text-align:center"><p style="color:#656d76">未找到 <code style="background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:2px 6px;font-family:ui-monospace,monospace">${escHtml(id)}</code></p></body>`;
