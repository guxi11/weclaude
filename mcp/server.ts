// MCP server `wezard`. Stdio transport. Single tool `wrc` = "wecom remote
// control": attaches the *current* Claude session for WeCom mirror — session
// resolved via CLAUDE_CODE_SESSION_ID env (Claude Code populates this for
// every child process), so multiple windows can each /wrc without trampling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DAEMON_BASE = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (msg: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: msg }],
});

// Project-dir encoding is backend-specific:
//   Claude Code / claude-internal: `/` `.` → `-`  (yields leading `-`)
//   CodeBuddy:                     strip leading `/`, then `/` `.` → `-`  (no leading `-`)
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

interface ProjectRoot {
  dir: string;
  encode: (absCwd: string) => string;
}
const PROJECT_ROOTS: ProjectRoot[] = [
  { dir: join(homedir(), ".claude-internal", "projects"), encode: encodeClaude },
  { dir: join(homedir(), ".claude", "projects"), encode: encodeClaude },
  { dir: join(homedir(), ".codebuddy", "projects"), encode: encodeCodebuddy },
];

const findProjectDir = (cwd: string): string | undefined => {
  for (const root of PROJECT_ROOTS) {
    const p = join(root.dir, root.encode(cwd));
    if (existsSync(p)) return p;
  }
  return undefined;
};

const latestJsonlByMtime = (projectDir: string): string | null => {
  const files = readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"));
  if (files.length === 0) return null;
  return files
    .map((n) => ({ p: join(projectDir, n), m: statSync(join(projectDir, n)).mtimeMs }))
    .reduce((a, b) => (b.m > a.m ? b : a)).p;
};

const resolveCallerSession = ():
  | { sessionId: string; jsonlPath: string }
  | { error: string } => {
  // CodeBuddy exports CODEBUDDY_PROJECT_DIR / CODEBUDDY_SESSION_ID (native) and
  // also CLAUDE_PROJECT_DIR / CLAUDE_SESSION_ID (compat). Check native first so
  // a codebuddy session inside a claude project dir doesn't mis-resolve.
  const cwd = process.env.CODEBUDDY_PROJECT_DIR
    ?? process.env.CLAUDE_PROJECT_DIR
    ?? process.cwd();
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return { error: `no claude project dir for cwd ${cwd}` };

  // Primary: env tells us exactly which session invoked us. Trust it
  // unconditionally — claude only writes the jsonl after the first user
  // message lands, so a fresh session (e.g. /clear-then-/wrc, or a brand-new
  // CLI window) will have envSid set but no file yet. The daemon's tail
  // tolerates a missing path (see mirror-bridge.ts attach()), and any
  // existsSync gate here would mis-route to a stale jsonl picked by mtime.
  const envSid = process.env.CODEBUDDY_SESSION_ID
    ?? process.env.CLAUDE_CODE_SESSION_ID
    ?? process.env.CLAUDE_SESSION_ID;
  if (envSid) return { sessionId: envSid, jsonlPath: join(projectDir, `${envSid}.jsonl`) };
  // Fallback: most-recently-written jsonl. Only reached when env is absent
  // (older claude versions, exotic launchers).
  const jsonlPath = latestJsonlByMtime(projectDir);
  if (!jsonlPath) return { error: `no .jsonl under ${projectDir}` };
  return { sessionId: basename(jsonlPath, ".jsonl"), jsonlPath };
};

// Resolve the current pane's tmux session name. `tmux display-message -p` runs
// against the tmux server pointed at by $TMUX (set in every process running
// inside tmux), so it returns the session containing *this* pane without us
// needing to pass a target. Returns undefined if not in tmux or query failed.
const detectTmuxSession = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (!process.env.TMUX) return resolve(undefined);
    const p = spawn("tmux", ["display-message", "-p", "#{session_name}"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => resolve(code === 0 ? out.trim() || undefined : undefined));
  });

const server = new McpServer(
  { name: "wezard", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// Accept user-friendly prefixes from the LLM: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
// Pass anything else (already user:/chat:/group:, or empty) through unchanged.
const normalizeTarget = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("vid:")) return `user:${raw.slice(4)}`;
  if (raw.startsWith("chatid:")) return `chat:${raw.slice(7)}`;
  return raw;
};

server.registerTool(
  "wrc",
  {
    title: "WeCom remote control",
    description: "wecom remote control — attach current Claude session to a WeCom chat for live mirror push",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'Optional push target. Accepts "vid:<userid>" (DM), "chatid:<chatid>" (group), or raw "user:<id>"/"chat:<id>". Empty → use config defaultChat / mirror.pushChat.',
        ),
    },
  },
  async ({ target }) => {
    const r = resolveCallerSession();
    if ("error" in r) return fail(r.error);
    const normalizedTarget = normalizeTarget(target);
    // tmux sets $TMUX_PANE for every process inside a pane (e.g. `%5`); we
    // inherit it through claude → MCP child, so each /wrc auto-picks its own
    // pane without the user touching config. Pane ids are not stable across
    // tmux server restarts, so we also capture the session name — the daemon
    // uses it to re-derive a fresh paneId after reload, and as the "user wants
    // a tmux pane" signal that drives respawn when their pane dies.
    const tmuxPane = process.env.TMUX_PANE?.trim();
    const tmuxSession = tmuxPane ? await detectTmuxSession() : undefined;
    const resp = await fetch(`${DAEMON_BASE}/mirror/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: r.sessionId,
        jsonlPath: r.jsonlPath,
        ...(normalizedTarget ? { target: normalizedTarget } : {}),
        ...(tmuxPane ? { tmuxPane } : {}),
        ...(tmuxSession ? { tmuxSession } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string; target?: string };
    return j.ok
      ? ok({ ok: true, sessionId: r.sessionId, target: j.target })
      : fail(`attach failed: ${j.reason ?? "unknown"}`);
  },
);

// set_workspace — one-shot project switch: the daemon applies the switch
// itself by walking the exact /new path — setPendingCwd → kill pane →
// respawn in the new cwd → attach → "📂 当前项目" push. NOTE: when the
// caller IS the chat's session being replaced (the common case), its own
// pane is killed mid-tool-call — the tool result never returns, and the
// project-info bubble in the chat is the receipt. On spawn failure the
// pendingCwd stays queued, so a manual /new from WeCom still completes
// the switch.
server.registerTool(
  "set_workspace",
  {
    title: "Switch workspace directory",
    description:
      "Switch this chat's Claude session to a different project directory in ONE shot: kill the current pane and spawn a FRESH session rooted at the given cwd — equivalent to a /new into that directory. The chat receives the new session's 📂 project-info bubble as the receipt; conversation context is NOT carried over (fresh session, same as /new). If the caller is the session being replaced it is terminated mid-call — expected, the bubble is the receipt. Use absolute paths (or paths starting with ~).",
    inputSchema: {
      cwd: z.string().describe("Absolute project path, e.g. /Users/foo/projects/bar. ~ is expanded."),
      target: z
        .string()
        .optional()
        .describe(
          'Optional target override. "vid:<userid>" / "chatid:<chatid>" / raw "user:<id>"/"chat:<id>". Empty → derive from this Claude session.',
        ),
    },
  },
  async ({ cwd, target }) => {
    const { sessionId, tmuxPane } = selfRef();
    const normalizedTarget = normalizeTarget(target);
    const resp = await fetch(`${DAEMON_BASE}/mirror/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        ...(normalizedTarget ? { target: normalizedTarget } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(tmuxPane ? { tmuxPane } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string; target?: string; sessionId?: string; cwd?: string; pendingCwd?: string };
    if (!j.ok) {
      return fail(`set_workspace failed: ${j.reason ?? "unknown"}${j.pendingCwd ? ` (switch queued for ${j.pendingCwd} — send /new from WeCom to apply)` : ""}`);
    }
    return ok({ ok: true, target: j.target, sessionId: j.sessionId, cwd: j.cwd });
  },
);

// 企业微信 doc / smartsheet / contact MCP 桥接。把 daemon 远端的 MCP 转发
// 给本地 Claude: list_tools 列工具, call_tool 调用 (创建文档 / 写表格 / 读
// 内容)。category 当前可选: "doc" | "smartsheet" | "contact"。
// 大模型先调 list_tools 看可用方法和入参 schema, 再 call_tool。
server.registerTool(
  "wecom_doc_list_tools",
  {
    title: "List WeCom doc/smartsheet tools",
    description:
      "List available WeCom MCP tools for a given category. Categories: 'doc' (online documents), 'smartsheet' (smart sheets), 'contact'. Returns tool names + JSON Schema. Call this BEFORE wecom_doc_call to discover method names and required arguments.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid that owns the resulting docs. Optional — daemon falls back to config.wedoc.requesterUserId or defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, requesterUserId }) => {
    const resp = await fetch(`${DAEMON_BASE}/wedoc/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, ...(requesterUserId ? { requesterUserId } : {}) }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    return j.ok ? ok(j.result) : fail(`wecom_doc_list_tools failed: ${j.error ?? `http ${resp.status}`}`);
  },
);

server.registerTool(
  "wecom_doc_call",
  {
    title: "Call WeCom doc/smartsheet tool",
    description:
      "Invoke a specific WeCom MCP tool (after discovering it via wecom_doc_list_tools). Typical flow: list tools for 'doc' → pick a method like 'doc_create' → call it with args matching its inputSchema. Daily quota: 20 docs per requesterUserId.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      method: z.string().describe("Tool name from wecom_doc_list_tools (e.g. 'doc_create', 'smartsheet_add_records')."),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON object matching the tool's inputSchema. Empty object if the tool takes no params."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid acting as document owner. Optional — daemon falls back to config / defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, method, args, requesterUserId }) => {
    const resp = await fetch(`${DAEMON_BASE}/wedoc/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category,
        method,
        args: args ?? {},
        ...(requesterUserId ? { requesterUserId } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    return j.ok ? ok(j.result) : fail(`wecom_doc_call failed: ${j.error ?? `http ${resp.status}`}`);
  },
);

// ── Session discovery / switching (conversational) ─────────────────────────
// These let the WeCom-side Claude answer "列出所有 claude session" / "切到 xxx
// 那个" / "在 /path 下新建一个 session" in natural language. The daemon does the
// host-wide /proc + tmux scan (an MCP tool can only see its OWN session).
server.registerTool(
  "list_claude_sessions",
  {
    title: "List running Claude sessions",
    description:
      "List all Claude Code sessions currently running in tmux on this host, each with a stable animal-emoji label, its working directory, tmux location, and a short summary of what it's recently been doing. Call this whenever the user asks to see / list / switch between Claude sessions (e.g. '列出所有 claude session', '有哪些会话在跑', '我想切换 session'). Present the result to the user as a readable numbered list (emoji + dir + summary), and note which one is the current mirror target (`current: true`).",
    inputSchema: {},
  },
  async () => {
    const resp = await fetch(`${DAEMON_BASE}/sessions/list`, { method: "GET" });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    return j.ok ? ok(j) : fail(`list_claude_sessions failed: ${j.reason ?? `http ${resp.status}`}`);
  },
);

server.registerTool(
  "switch_claude_session",
  {
    title: "Switch WeCom mirror to another Claude session",
    description:
      "Re-point the WeCom mirror at a different already-running Claude session, so the user's IM chat starts mirroring (and injecting into) that session instead. Call this when the user picks a session to switch to — e.g. '切到 wezard 那个', '镜像第2个', '换到 🦊 那个会话'. First call list_claude_sessions to resolve the user's natural-language reference (emoji / directory / topic) to a concrete sessionId, then pass that sessionId here.",
    inputSchema: {
      sessionId: z.string().describe("The target session's sessionId (a UUID), as returned by list_claude_sessions."),
    },
  },
  async ({ sessionId }) => {
    const resp = await fetch(`${DAEMON_BASE}/sessions/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    return j.ok ? ok(j) : fail(`switch_claude_session failed: ${j.reason ?? `http ${resp.status}`}`);
  },
);

// ── Peer collaboration (agent ↔ agent inside one WeCom chat) ───────────────
// One WeCom chat can host several concurrent agent sessions, each addressed by
// a `#tag` (`#fix`, `#docs`, …) and each free to run a different CLI / model /
// project. They are peers: siblings that can watch and drive each other. This
// process can only see ITSELF, so every question about a sibling goes to the
// daemon, which owns all the attachments.
//
// `selfRef` is how the daemon figures out which session is asking: sessionId
// from env (frozen at MCP spawn — goes stale after a `/clear`) plus TMUX_PANE
// (stable for the pane's lifetime), so one of the two always resolves.
const selfRef = (): { sessionId?: string; tmuxPane?: string } => {
  const sessionId =
    process.env.CODEBUDDY_SESSION_ID ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID;
  const tmuxPane = process.env.TMUX_PANE?.trim();
  return { ...(sessionId ? { sessionId } : {}), ...(tmuxPane ? { tmuxPane } : {}) };
};

const daemonPost = async (path: string, body: Record<string, unknown>): Promise<{ j: Record<string, unknown>; status: number }> => {
  const resp = await fetch(`${DAEMON_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...selfRef(), ...body }),
  });
  return { j: (await resp.json().catch(() => ({}))) as Record<string, unknown>, status: resp.status };
};

const unwrap = (name: string, { j, status }: { j: Record<string, unknown>; status: number }) =>
  j.ok ? ok(j) : fail(`${name} failed: ${(j.reason as string) ?? `http ${status}`}`);

// The one address grammar, restated in full wherever a tool takes one: a model
// reading a single tool schema in isolation has no other place to learn it, and
// a guessed address silently resolves to the wrong agent's terminal.
const ADDRESS_DOC =
  "Peer address. `''` = this chat's own default (untagged) session. A bare tag like `'fix'` means THIS chat's `#fix`, falling back to a GLOBALLY UNIQUE `#fix` in some other chat. `'daily#fix'` names the chat outright — the reliable cross-chat form, and the only one that works when several chats each hold a `#fix`. Never invent one: list_peers and list_chats return the exact string to pass, as `address`.";

// Creating a session is a peer operation, not a global one: it lands in the
// caller's own chat (hence `selfRef` via daemonPost) under its own `#tag`, or —
// with `chat` — in another NAMED chat, which is what chat naming buys.
server.registerTool(
  "new_claude_session",
  {
    title: "Spawn a new peer session",
    description:
      "Spawn a brand-new agent session in a fresh tmux pane rooted at the given project path, as a `#tag` PEER — by default of THIS chat, exactly what the user gets by typing `/new #tag` here. The peer posts into that chat (its bubbles are headed `emoji #tag`, and it shows up in chat detail), and you can drive it afterwards with list_peers / peek_peer / send_peer / wait_peer. Call this when the user asks to start a new session somewhere — e.g. '在 /path/to/proj 下新建一个 claude session', '帮我在 xxx 目录起个新会话', '再开一个 agent 干这件事'. Pass `chat` to create it in ANOTHER chat instead ('在 daily 群里开一个 #ingest 跑这个目录') — that chat must have a name (list_chats shows them); this is the way to stand up a cross-chat collaborator that doesn't exist yet, instead of asking a human to go type `/new` over there. The directory is created if it doesn't exist. Never takes over a chat's default session.",
    inputSchema: {
      cwd: z.string().describe("Absolute project path to start the new session in, e.g. /Users/foo/projects/bar. Created if missing."),
      tag: z
        .string()
        .optional()
        .describe("Tag to address the new peer by, WITHOUT '#' (e.g. 'fix', 'docs'). Pick a short name describing its job; use it later with send_peer / peek_peer. Must not collide with an existing peer in the target chat — call list_peers / list_chats first if unsure. Omitted → derived from the directory name."),
      chat: z
        .string()
        .optional()
        .describe("Name of the chat to create the peer in (as shown by list_chats). Omit for this chat, which is what the user almost always means. Only NAMED chats can be targeted — an unnamed one has no address, so someone must run `/name <name>` in it first."),
      cli: z
        .enum(["claude", "claude-internal", "codebuddy"])
        .optional()
        .describe("Which CLI to launch. Omit unless the user names one (e.g. '用 codebuddy 起一个'); the peer then inherits that chat's current backend. Multiple backends can run side by side."),
    },
  },
  async ({ cwd, tag, chat, cli }) =>
    unwrap("new_claude_session", await daemonPost("/sessions/new", {
      cwd,
      ...(tag ? { tag } : {}),
      ...(chat ? { chat } : {}),
      ...(cli ? { cli } : {}),
    })),
);

// ── Chat naming (the cross-chat address space) ─────────────────────────────
// A WeCom chat's identity is an unreadable `chat:wrkS…` id, so before naming,
// the ONLY way to reach across chats was a tag that happened to be globally
// unique. A name turns the chat into a token a human can type and an agent can
// pass, which is what makes `daily#fix` — and spawning into `daily` — possible.
server.registerTool(
  "name_chat",
  {
    title: "Name this WeCom chat",
    description:
      "Give THIS chat a short name, so agents in other chats can address its sessions as `name#tag` and spawn peers into it. Call this when the user says '给这个群起个名叫 daily' / '把这个聊天命名为 xxx' / '这个群叫什么' (omit `name` to just read the current one) / '取消命名' (pass '-'). Names are unique across the host and case-insensitive; renaming replaces the old name, and any address written against the old one stops resolving. After naming, tell the user the address form their other chats should use (`name#tag`).",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("The new name: 1-32 chars, letters/digits/'_'/'-' only (no spaces, '#', '/', ':'). Omit to read the current name without changing it. Pass '-' to remove the name."),
    },
  },
  async ({ name }) =>
    name === undefined
      ? unwrap("name_chat", await daemonPost("/chats/list", {})) // read-only path: roster carries this chat's name
      : unwrap("name_chat", await daemonPost("/chats/name", { name })),
);

server.registerTool(
  "list_chats",
  {
    title: "List every chat and its sessions",
    description:
      "The cross-chat directory: every WeCom chat the daemon knows, its name (empty = unnamed), whether it is the one you live in (`self`), and the sessions running in each with the exact `address` to pass to send_peer / peek_peer / wait_peer. Call this whenever the user points at work outside this chat — '别的群有谁在跑', '把这个交给 daily 群的 agent', '在 sanitizer 群里开个会话' — or when a peer address failed to resolve and you need the real one. Unnamed chats cannot be addressed or spawned into; if the user wants one used, they must run `/name <name>` inside it.",
    inputSchema: {},
  },
  async () => unwrap("list_chats", await daemonPost("/chats/list", {})),
);

server.registerTool(
  "list_peers",
  {
    title: "List sibling agent sessions in this chat",
    description:
      "List the OTHER agent sessions running in the SAME WeCom chat as this one. A chat hosts one default session plus any number of `#tag` sessions (e.g. `#fix`, `#review`), each with its own tmux pane, CLI, model and working directory. Returns for each peer: its tag, the `address` to pass to the other peer tools, emoji label, cwd, CLI, whether its pane is alive, whether it is mid-turn (`busy`), when it last did anything, and a one-line summary of its recent conversation. `self: true` marks your own session. Also returns `foreignPeers`: reachable sessions in OTHER chats — either their `#tag` is globally unique (plain `send_peer('theirTag')` hits it) or their chat has a name, in which case `address` is the qualified `chatName#tag` form. Always send back the `address` verbatim rather than reassembling one. Call this FIRST whenever the user refers to another agent or tag — '#fix 进展如何', '还有谁在跑', '让 #docs 也看看', '把语料交给 #sanitizer 处理' — then use peek_peer / send_peer / wait_peer to actually collaborate. For chats with no session you can see yet, use list_chats.",
    inputSchema: {},
  },
  async () => unwrap("list_peers", await daemonPost("/peers/list", {})),
);

server.registerTool(
  "peek_peer",
  {
    title: "Read a sibling agent's conversation",
    description:
      "Observe another agent WITHOUT interrupting it: returns `dialog` — the last N turns of its actual conversation, read from its session transcript, `▸` for what was asked and `◂` for what it answered — plus whether it is currently mid-turn (`busy`) and its most recent complete reply (`lastText`). This is the readable record of what that agent and whoever drives it have been saying; use it to answer '查看 #fix 的进展', '他们聊到哪了', or to decide whether a peer needs a nudge. A `#tag` written INSIDE a user message means that peer: the daemon appends a system-reminder naming every mentioned tag that resolves to a live session, so `#b` in the prompt is peer `b` — peek it here instead of guessing what it is doing or answering on its behalf. If the peer has no readable transcript yet, `pane` falls back to its raw terminal tail. `foreign: true` in the reply means the tag resolved to a session in another chat. Read-only and safe to poll.",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      turns: z.number().optional().describe("How many recent conversation turns to return (1-40, default 6)."),
    },
  },
  async ({ tag, turns }) => unwrap("peek_peer", await daemonPost("/peers/peek", { tag, ...(turns ? { turns } : {}) })),
);

server.registerTool(
  "send_peer",
  {
    title: "Send a message into a sibling agent's session",
    description:
      "Type a message into another agent's session, exactly as if the user had sent it there — the peer picks it up as a new turn. This is how you DRIVE a peer: unblock it, answer its question, hand it work, or tell it to keep going. Typical loop for '推动 #fix 直到结束': peek_peer → send_peer with the nudge → wait_peer until it goes idle → peek_peer again. Cross-chat handoff (e.g. daily pipeline → sanitizer): the target agent lives in a DIFFERENT WeCom chat, addressed either by a globally-unique tag like `#sanitizer-ingest` or, when that chat has a name, in full as `sanitizer#ingest`; the daemon routes across chats automatically and both chats see the exchange in their timelines. If the peer doesn't exist yet, create it yourself with new_claude_session (pass `chat` for another chat). Refuses to target your own session.",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      text: z.string().describe("Message to inject. Plain prompt text; slash commands like '/clear' also work."),
    },
  },
  async ({ tag, text }) => unwrap("send_peer", await daemonPost("/peers/send", { tag, text })),
);

server.registerTool(
  "wait_peer",
  {
    title: "Wait until a sibling agent finishes its turn",
    description:
      "Block until the named peer stops working (its terminal no longer shows an interrupt hint), then return its latest reply. Use it after send_peer so you act on a finished answer instead of a half-written one. Returns `idle: false` with a reason if the timeout hits first — the peer is simply still working, so you can peek and wait again. Cheap: the daemon polls the pane, it does not consume tokens.",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      timeoutSec: z.number().optional().describe("Max seconds to wait (10-7200, default 900)."),
    },
  },
  async ({ tag, timeoutSec }) => unwrap("wait_peer", await daemonPost("/peers/wait", { tag, ...(timeoutSec ? { timeoutSec } : {}) })),
);

server.registerTool(
  "run_agent_graph",
  {
    title: "Run a loop graph over several tagged agents",
    description:
      "Declare a multi-agent loop inside this chat and let the daemon drive it. `nodes` are the participating `#tag` sessions (each may pick its own cli / model / cwd; missing sessions are spawned, existing ones are reused with their context intact). `steps` is the ordered pipeline — each step sends a prompt to one node, waits for it to finish, captures its reply, and feeds it forward. The step list is walked `rounds` times, which is what makes it a LOOP: `fix → review → fix → review …` until `until` appears in a reply or the rounds run out. Prompt templates may reference earlier output: `{{last}}` = the previous step's reply, `{{<tag>}}` = that node's latest reply, `{{round}}` = round number. Returns a runId immediately and narrates progress into the chat; poll with graph_status, cancel with stop_graph. Use this when the user asks for several agents to work together / review each other / iterate to a conclusion. For a one-off nudge to a single peer, prefer send_peer + wait_peer.",
    inputSchema: {
      nodes: z
        .array(
          z.object({
            tag: z.string().describe("Session tag without '#', e.g. 'fix'."),
            cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("CLI backend for this node. Omit to inherit the chat's."),
            model: z.string().optional().describe("Model slug passed as --model when the node has to be spawned, e.g. 'opus' / 'haiku'. Ignored for an already-running session."),
            cwd: z.string().optional().describe("Absolute project path for this node. Omit to inherit the chat's."),
          }),
        )
        .describe("Participating sessions. Every step's `to` must name one of these tags."),
      steps: z
        .array(
          z.object({
            to: z.string().describe("Tag of the node this step drives."),
            prompt: z.string().describe("Prompt template. Supports {{last}}, {{<tag>}}, {{round}}."),
          }),
        )
        .describe("Ordered pipeline, replayed once per round."),
      rounds: z.number().optional().describe("How many times to walk the step list (1-50, default 1). >1 makes it a genuine loop."),
      until: z.string().optional().describe("Case-insensitive substring; when a node's reply contains it the run stops early and reports 'converged'. E.g. 'LGTM' or 'DONE'."),
      idleTimeoutSec: z.number().optional().describe("Per-step ceiling on waiting for a node to finish (30-7200, default 900). A timeout is reported but the graph keeps walking."),
    },
  },
  async ({ nodes, steps, rounds, until, idleTimeoutSec }) =>
    unwrap(
      "run_agent_graph",
      await daemonPost("/graph/run", {
        nodes,
        steps,
        ...(rounds ? { rounds } : {}),
        ...(until ? { until } : {}),
        ...(idleTimeoutSec ? { idleTimeoutSec } : {}),
      }),
    ),
);

server.registerTool(
  "graph_status",
  {
    title: "Inspect running / finished agent graphs",
    description:
      "Report progress of loop graphs started by run_agent_graph: per-step round, target tag, status (running / done / timeout / error) and each node's captured reply. Omit runId to list every graph belonging to this chat. Note graphs live in daemon memory — a daemon reload clears them (the panes survive).",
    inputSchema: {
      runId: z.string().optional().describe("Run id from run_agent_graph. Omit to list all runs for this chat."),
    },
  },
  async ({ runId }) => {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const resp = await fetch(`${DAEMON_BASE}/graph/status${qs}`);
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    return j.ok ? ok(j) : fail(`graph_status failed: ${j.reason ?? `http ${resp.status}`}`);
  },
);

server.registerTool(
  "stop_graph",
  {
    title: "Cancel a running agent graph",
    description:
      "Stop a loop graph after its current step. Does NOT interrupt the agent that is mid-turn — it finishes, then no further steps are dispatched. Use when the user says to abort the loop.",
    inputSchema: { runId: z.string().describe("Run id from run_agent_graph.") },
  },
  async ({ runId }) => unwrap("stop_graph", await daemonPost("/graph/stop", { runId })),
);

server.registerTool(
  "handoff",
  {
    title: "Hand off a session's work to a fresh session",
    description:
      "Hand off the work in a tmux pane / peer session to a BRAND-NEW session, in place: the daemon asks that session to compress everything into a self-contained handoff brief, waits for it, then sends `/clear` into the SAME pane (resets the context window, new sessionId, same cwd) and pastes the brief in as the new session's first message. Use this when a session's context window is bloated / near its limit, or the user says '交接一下' / 'handoff' / '开个新会话接着干' / '压缩上下文重开'. Address the session by tmux `pane` id (e.g. '%5', from list_peers / list_claude_sessions) OR by peer `tag`. Refuses to hand off your OWN session (would deadlock). Returns the brief that was carried across.",
    inputSchema: {
      pane: z.string().optional().describe("Target tmux pane id, e.g. '%5'. Takes precedence over tag. Get it from list_peers / list_claude_sessions."),
      tag: z.string().optional().describe("Peer tag WITHOUT '#'. Empty string = this chat's default session. Non-empty prefers same-chat, falls back to a GLOBALLY UNIQUE match in another chat. Ignored when pane is given."),
      focus: z.string().optional().describe("Optional emphasis for the handoff brief, e.g. '重点交代还没跑通的测试'."),
      timeoutSec: z.number().optional().describe("Max seconds to wait for the summary before aborting (30-7200, default 600)."),
    },
  },
  async ({ pane, tag, focus, timeoutSec }) =>
    unwrap(
      "handoff",
      await daemonPost("/handoff", {
        ...(pane ? { pane } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(focus ? { focus } : {}),
        ...(timeoutSec ? { timeoutSec } : {}),
      }),
    ),
);

// ── Topic pub/sub (注册订阅 + 广播) ────────────────────────────────────────
// A lightweight event bus layered on WeCom chats: a session registers its chat
// as a subscriber of a named topic, anyone broadcasts to every subscriber at
// once. Same store the IM commands「订阅」/「广播」use — persisted to config.jsonc
// (`topics.subs`), surviving daemon reloads. subscribe resolves the caller's
// chat via selfRef; broadcast is subscriber-agnostic, so it hits the shared
// /publish route directly.
server.registerTool(
  "subscribe_topic",
  {
    title: "Subscribe this chat to a topic",
    description:
      "Register the CURRENT WeCom chat (the one mirroring this session) as a subscriber of a named topic, so it receives every future broadcast_topic push and scheduled daily broadcast on that topic. Equivalent to the user typing 「订阅 <topic>」 in the chat, but driven by the agent. Topics are free-form event names (e.g. 'ci-fail', 'daily-report'); subscriptions persist across daemon reloads. Use when the user says 「订阅 xxx」/「注册到 xxx 事件」/「以后 xxx 的消息也发这个群」. Returns `added` (false if already subscribed) and the topic's current subscriber count.",
    inputSchema: {
      topic: z.string().describe("Topic name to subscribe to, e.g. 'ci-fail'. Free-form: letters / digits / CJK / - / _ / . , no whitespace."),
    },
  },
  async ({ topic }) => unwrap("subscribe_topic", await daemonPost("/topics/subscribe", { topic })),
);

server.registerTool(
  "broadcast_topic",
  {
    title: "Broadcast a message to a topic's subscribers",
    description:
      "Fan a markdown message out to EVERY chat/session subscribed to the given topic. Equivalent to 「广播 <topic> <内容>」. Each subscriber receives it as a normal WeCom bubble in its own channel (tagged sessions get their `#tag` header). Returns `sent` / `failed` / `subs` so you know the reach. Use when the user says 「广播 xxx」/「给订阅 xxx 的都发一下」, or an agent needs to notify a fleet of sessions at once. For a private nudge into ONE peer session, use send_peer instead.",
    inputSchema: {
      topic: z.string().describe("Topic to publish to. Subscribers are whoever ran subscribe_topic / 「订阅」 on this topic."),
      markdown: z.string().describe("Message body in WeCom markdown."),
    },
  },
  async ({ topic, markdown }) => {
    const resp = await fetch(`${DAEMON_BASE}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, markdown }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return j.ok ? ok(j) : fail(`broadcast_topic failed: ${j.error ?? `http ${resp.status}`}`);
  },
);

server.registerTool(
  "unsubscribe_topic",
  {
    title: "Unsubscribe this chat from a topic",
    description:
      "Remove the CURRENT WeCom chat from a topic's subscriber list, so it stops receiving that topic's broadcasts and scheduled pushes. The inverse of subscribe_topic. Returns `removed` (false if it wasn't subscribed). Use when the user says 「退订 xxx」/「别再往这个群发 xxx 了」.",
    inputSchema: {
      topic: z.string().describe("Topic name to unsubscribe from."),
    },
  },
  async ({ topic }) => unwrap("unsubscribe_topic", await daemonPost("/topics/unsubscribe", { topic })),
);

server.registerTool(
  "list_topics",
  {
    title: "List this chat's subscriptions and all scheduled broadcasts",
    description:
      "Show what THIS chat is subscribed to (`subs`: topic + subscriber count) plus every daily scheduled broadcast on the host (`schedules`: topic, HH:MM, creator). Use when the user asks 「订阅列表」/「有哪些定时广播」/「我订了什么」. Read-only.",
    inputSchema: {},
  },
  async () => unwrap("list_topics", await daemonPost("/topics/list", {})),
);

server.registerTool(
  "schedule_broadcast",
  {
    title: "Schedule a daily broadcast to a topic",
    description:
      "Register a recurring daily broadcast: every day at hour:minute (host local time) the daemon publishes `content` to all subscribers of `topic`. Equivalent to 「每天 HH:MM 广播 <topic> <内容>」. Persists across daemon reloads. Use when the user says 「每天 8 点广播 xxx」/「定时给订阅者发 xxx」. To fire once immediately instead, use broadcast_topic.",
    inputSchema: {
      topic: z.string().describe("Topic whose subscribers receive the daily push."),
      hour: z.number().int().min(0).max(23).describe("Hour of day, 0-23 (host local time)."),
      minute: z.number().int().min(0).max(59).optional().describe("Minute, 0-59. Default 0."),
      content: z.string().describe("Message body in WeCom markdown, sent every day at the given time."),
    },
  },
  async ({ topic, hour, minute, content }) =>
    unwrap("schedule_broadcast", await daemonPost("/topics/schedule", { topic, hour, minute: minute ?? 0, content })),
);

server.registerTool(
  "cancel_broadcast",
  {
    title: "Cancel a topic's daily scheduled broadcasts",
    description:
      "Delete ALL daily scheduled broadcasts for a topic (does NOT touch subscriptions or fire anything). Equivalent to 「取消广播 <topic>」. Returns how many schedules were removed. Use when the user says 「取消 xxx 的定时」/「别再每天发 xxx 了」.",
    inputSchema: {
      topic: z.string().describe("Topic whose scheduled broadcasts should be removed."),
    },
  },
  async ({ topic }) => unwrap("cancel_broadcast", await daemonPost("/topics/cancel-schedule", { topic })),
);

// ── Config ──────────────────────────────────────────────────────────
server.registerTool(
  "config_set",
  {
    title: "Wezard config",
    description:
      "Read or modify wezard daemon configuration. Supported keys: allow_from (add/remove authorized chats/users), approval_window (auto-approve window minutes), approval_cache (session decision cache minutes), danger_skip (auto-allow ONLY calls hitting the danger list), danger_skip_all (skip ALL approvals), danger_enabled (toggle danger detection), approval_mode (all|danger), cwd (default workspace), default_chat (outbound target), log_level (trace|debug|info|warn|error), slash_ack_first_line (/clear & /new acks reply first line only, no project info/tip). Use action='add'/'remove' for array keys (allow_from), 'set' for scalars. Keywords: 设置、配置、cfg、wezard、allowFrom、授权、自动通过、时间窗口、danger skip、跳过审批、workspace、回执精简、斜杠命令简洁.",
    inputSchema: {
      key: z
        .enum(["allow_from", "approval_window", "approval_cache", "danger_skip", "danger_skip_all", "danger_enabled", "approval_mode", "cwd", "default_chat", "log_level", "slash_ack_first_line"])
        .describe("Config key to read or modify."),
      value: z
        .string()
        .optional()
        .describe("New value. Omit to read current value. For booleans: 'true'/'false'. For arrays with action=set: JSON array string."),
      action: z
        .enum(["set", "add", "remove"])
        .optional()
        .describe("For array keys (allow_from): 'add' appends, 'remove' deletes an item. Scalars always use 'set'. Default: 'set'."),
    },
  },
  async ({ key, value, action }) => {
    if (value === undefined) {
      return unwrap("config_set", await daemonPost("/config/get", { key }));
    }
    return unwrap("config_set", await daemonPost("/config/set", { key, value, action: action ?? "set" }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
