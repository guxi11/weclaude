// Stable per-session visual tag. Hash a sessionId to a fixed animal emoji so
// the same Claude session always shows the same icon — on approval cards and
// in the /sessions list — letting the user tell sibling sessions apart when
// several un-mirrored sessions all fall back to the same WeCom chat.
//
// Stateless + deterministic: same sessionId → same emoji across daemon
// restarts, no persistence needed.

const ANIMALS = [
  "🦊", "🐬", "🦄", "🐙", "🦉", "🐢", "🦋", "🐝",
  "🐳", "🦁", "🐯", "🐰", "🦝", "🐼", "🐨", "🦓",
  "🦔", "🦇", "🐧", "🦜", "🦩", "🐸", "🐺", "🦅",
  "🐡", "🦞", "🦗", "🐌", "🦚", "🐲",
];

// FNV-1a — small, fast, good spread for short ascii ids.
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const labelFor = (sessionId: string): string => {
  if (!sessionId) return "❔";
  return ANIMALS[hash(sessionId) % ANIMALS.length] ?? "❔";
};

// ── `#tag` lexicon ──────────────────────────────────────────────────────
// One rule for what counts as a tag token, shared by everything that reads
// them out of user prose: the inbound router (FIRST match = which session gets
// the message) and peer-mention annotation (the REST = references to sibling
// sessions). Two readers of the same text must not disagree on where the tokens
// are, or a mention the router left in the body could go unannotated.
// Must be space-delimited or edge-of-string so genuine URLs / paths like
// "#L45-foo/bar" survive. 右边界除空白/行尾外,零宽与 word-joiner 等不可见格式
// 字符也算分隔 —— 输入法/复制常在 tag 后夹一个 U+2060 之类。
const TAG_TOKEN = "(^|\\s)#([\\p{L}\\p{N}_-]{1,32})(?=[\\s\\u200B-\\u200D\\u2060\\uFEFF]|$)";

/** Fresh non-global matcher — capture 2 is the tag. Own instance per caller so
 *  nobody inherits another's `lastIndex`. */
export const tagTokenRe = (): RegExp => new RegExp(TAG_TOKEN, "u");

/** Every distinct `#tag` in `text`, in first-appearance order. */
export const allTags = (text: string): string[] => [
  ...new Set([...text.matchAll(new RegExp(TAG_TOKEN, "gu"))].map((m) => m[2] ?? "").filter(Boolean)),
];

// Compound address: `chatName#tag` (no space before `#`). Captures word-boundary
// delimited `name#tag` tokens that TAG_TOKEN misses because the `#` isn't preceded
// by whitespace. The left part MIGHT be a chat name — caller must validate.
const COMPOUND_ADDR = "(?:^|(?<=\\s))([\\p{L}\\p{N}_-]{1,32})#([\\p{L}\\p{N}_-]{1,32})(?=[\\s\\u200B-\\u200D\\u2060\\uFEFF]|$)";

/** Every distinct `name#tag` compound address in `text`. */
export const allCompoundAddresses = (text: string): Array<{ raw: string; chat: string; tag: string }> => {
  const seen = new Set<string>();
  const results: Array<{ raw: string; chat: string; tag: string }> = [];
  for (const m of text.matchAll(new RegExp(COMPOUND_ADDR, "gu"))) {
    const raw = m[0]!.trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push({ raw, chat: m[1]!, tag: m[2]! });
  }
  return results;
};

// ── Target-key tagging ──────────────────────────────────────────────────
// Daemon-internal target keys are `user:xxx[#tag]` / `chat:xxx[#tag]`. Every
// user-visible artifact bound to a TAGGED session must carry the same visual
// so a chat hosting parallel sessions stays disambiguated:
//   • markdown bubbles → `emoji \`#tag\`` header line  (withTagHeader)
//   • card titles      → `emoji ` badge                 (tagBadge)
// Untagged (default session) passes through unchanged — single-session users
// see no extra glyphs. Emoji is keyed on the TAG STRING, not the sessionId,
// so it survives `/clear` rotations.

/** `#tag` suffix of a target key, "" when untagged. */
export const tagOfKey = (target: string | undefined): string => {
  if (!target) return "";
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(h + 1) : "";
};

/** Drop the `#tag` suffix — collapses a tagged session key to the chat-scoped
 *  base principal (`user:xxx#foo` → `user:xxx`). Everything shared across a
 *  chat's sessions (cwd, peer discovery, graph runs) keys off this. */
export const baseOfKey = (target: string): string => {
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(0, h) : target;
};

/** Compose a session key from a base principal and a tag ("" → default session). */
export const keyOf = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);

/** Coerce an arbitrary string into the tag charset `TAG_TOKEN` accepts — an
 *  agent-supplied tag that the header parser can't round-trip would make its
 *  own bubbles unaddressable. "" when nothing usable survives. */
export const normalizeTag = (raw: string | undefined): string =>
  (raw ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** Default tag for a session spawned in `cwd` — the project's own name is what
 *  a human would have typed. */
export const tagFromCwd = (cwd: string): string => normalizeTag(cwd.split("/").filter(Boolean).pop());

/** `want`, or the first `want-N` its chat isn't already using. */
export const uniqueTag = (want: string, taken: ReadonlySet<string>, n = 1): string => {
  const candidate = n < 2 ? want : `${want.slice(0, 29)}-${n}`;
  return taken.has(candidate) ? uniqueTag(want, taken, n + 1) : candidate;
};

// 出站气泡的头 (`🦊 #fix …` / 未打 tag 的 `🧙 …`) 是可被「引用」的路由信息:
// 群里要跟某个 `#tag` 会话说话,引用它的气泡比手打 tag 快得多。这里做反向解析。
// 头部 emoji 取自固定表 —— 用户消息以这些 emoji 开头且后接 `#tag` 的概率可忽略。
// 分片序号 (`2/5`) 也属于头,一并吃掉 —— 留在 body 里会污染"引用内容是否已在
// 目标 context 里"的比对。
// 头有两种形态,都要认:裸 `🦊 #fix …`,以及 mirror 的 chat-detail 链接形态
// `[🦊 #fix](https://…) …`(无 tag 时是 `[🧙](url)`)。链接里的 URL 若留在 body
// 里,既污染比对又会被当成用户内容贴进 prompt。
// 分片序号 (`2/5`) 与折叠气泡的 `← View chat details` 提示同理,一并算作头。
const HEAD_EMOJI = [...ANIMALS, "🧙", "❔"];
const EMO = `(?:${HEAD_EMOJI.join("|")})`;
const TAG_PART = `(?:\\s+#([\\p{L}\\p{N}_-]{1,32}))?`;
const HEADER_RE = new RegExp(
  `^(?:\\[${EMO}${TAG_PART}\\]\\([^)]*\\)|${EMO}${TAG_PART})` +
    `(?:\\s+\\d+/\\d+)?(?:\\s*←\\s*View chat details)?(?![\\p{L}\\p{N}_-])\\s*`,
  "u",
);

/** 反解一条出站气泡的 `emoji #tag` 头,返回 tag 与剥头后的正文。
 *  `fromBot=false` 表示这不是 wezard 发的,body 原样返回。
 *  think-style 气泡把 tag 头塞进了 `<think>` 内 (`<think>🦊 #fix …thinking…</think>\n\n正文`);
 *  微信引用时 think 段与正文会被整体带上,`<think>` 标记有时保留有时被渲染剥掉。这里:
 *    1. 先剥掉可能存在的 `<think>` 起始标记 (无标记也不影响, 头就在最前);
 *    2. 认出 tag 头拿 tag —— 这是路由继承唯一需要的信息;
 *    3. body 保留 think+正文全文 (仅去掉 `<think>`/`</think>` 标记杂质), 因为 last-response
 *       里存的也是同一整串, `canonContains` 子串比对必然命中 —— 不去切正文, 避免标记被剥时切错。 */
export const parseTagHeader = (text: string): { fromBot: boolean; tag: string; body: string } => {
  const t = text.trim();
  const afterThink = t.replace(/^<think>\s*/, "");
  const m = HEADER_RE.exec(afterThink);
  if (!m) return { fromBot: false, tag: "", body: t };
  const tag = m[1] ?? m[2] ?? "";
  const body = afterThink.slice(m[0].length).replace(/<\/?think>/g, "").trim();
  return { fromBot: true, tag, body };
};

/** Trailing-space emoji badge for card titles; "" for untagged targets. */
export const tagBadge = (target: string | undefined): string => {
  const tag = tagOfKey(target);
  return tag ? `${labelFor(tag)} ` : "🧙 ";
};

/** Prefix markdown content with the `emoji \`#tag\`` header; identity when untagged.
 *  `seq` ("2/5") marks one piece of a split push — it rides in the same header
 *  line so every chunk of a long reply is attributable on its own, and shows
 *  alone when the session is untagged. */
export const withTagHeader = (target: string | undefined, content: string, seq?: string): string => {
  const tag = tagOfKey(target);
  const head = [tag ? `${labelFor(tag)} #${tag}` : "🧙", seq ?? ""].filter(Boolean).join(" ");
  return `${head} ${content}`;
};
