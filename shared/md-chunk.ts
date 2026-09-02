// Markdown-aware chunking for WeCom pushes. WeCom caps a single markdown
// payload (~2048), so long replies must be cut — but a naive line-wise cut
// bisects fenced code and tables, and the tail piece then renders as raw
// garbage (unterminated ``` swallows the rest, a headerless table row shows
// as pipes). So: parse into blocks, keep each block whole when it fits, and
// when a block alone is oversized, re-emit its *head* (fence opener / table
// header+separator) on every piece so each chunk stands on its own.
//
// Pure — no IO, no config. Callers own the budget and the per-chunk tagging.

interface Block {
  /** Re-emitted at the top of every piece when the block has to be cut. */
  head: string[];
  body: string[];
  /** Re-emitted at the bottom of every piece (closing fence). */
  tail: string[];
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** A table separator row: only pipes, dashes, colons, spaces — and ≥1 dash. */
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

// Budgets are BYTES, not chars: WeCom caps a markdown payload at 4096 UTF-8
// bytes and CJK is 3 bytes/char, so a char budget either wastes most of the
// page on English or blows the cap on Chinese.
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Rendered length of a line run joined by "\n". */
const sizeOf = (lines: string[]): number =>
  lines.length === 0 ? 0 : lines.reduce((n, l) => n + bytes(l) + 1, -1);

// Walk code points — a byte-offset slice can split a surrogate pair (emoji)
// and hand WeCom invalid UTF-8.
const sliceLine = (line: string, max: number): string[] => {
  const out: string[] = [];
  for (const ch of line) {
    const last = out.at(-1);
    if (last !== undefined && bytes(last) + bytes(ch) <= max) out[out.length - 1] = last + ch;
    else out.push(ch);
  }
  return out;
};

const isTableRow = (l: string | undefined): boolean => !!l && l.includes("|");

const parseBlocks = (s: string): Block[] => {
  const lines = s.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = line.match(FENCE_RE)?.[1];
    if (fence) {
      const closes = (l: string): boolean => l.trimStart().startsWith(fence);
      let j = i + 1;
      while (j < lines.length && !closes(lines[j] as string)) j++;
      // Unterminated fence (truncated transcript) still gets a closer so every
      // piece — and the chat after it — renders sanely.
      out.push({ head: [line], body: lines.slice(i + 1, j), tail: [j < lines.length ? (lines[j] as string) : fence] });
      i = j + 1;
      continue;
    }
    if (isTableRow(line) && isTableRow(lines[i + 1]) && TABLE_SEP_RE.test(lines[i + 1] as string)) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      out.push({ head: lines.slice(i, i + 2), body: lines.slice(i + 2, j), tail: [] });
      i = j;
      continue;
    }
    out.push({ head: [], body: [line], tail: [] });
    i += 1;
  }
  return out;
};

/** Cut one oversized block into self-contained pieces (head/tail repeated). */
const explode = (b: Block, max: number): string[] => {
  const frame = sizeOf([...b.head, ...b.tail]);
  const budget = Math.max(1, max - (frame ? frame + 1 : 0));
  const pieces: string[][] = [];
  let cur: string[] = [];
  for (const line of b.body) {
    for (const p of bytes(line) > budget ? sliceLine(line, budget) : [line]) {
      if (cur.length && sizeOf(cur) + 1 + bytes(p) > budget) { pieces.push(cur); cur = []; }
      cur.push(p);
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces.map((p) => [...b.head, ...p, ...b.tail].join("\n"));
};

const blockLines = (b: Block): string[] => [...b.head, ...b.body, ...b.tail];

/** Greedy block-wise packing into ≤max chunks; atomic blocks stay whole unless
 *  they alone exceed max, in which case they split into renderable pieces. */
export const splitMarkdown = (s: string, max: number): string[] => {
  if (bytes(s) <= max) return [s];
  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const t = cur.join("\n").replace(/^\n+|\n+$/g, "");
    if (t) chunks.push(t);
    cur = [];
  };
  for (const b of parseBlocks(s)) {
    const lines = blockLines(b);
    if (cur.length && sizeOf(cur) + 1 + sizeOf(lines) > max) flush();
    if (sizeOf(lines) > max) {
      flush();
      const pieces = explode(b, max);
      chunks.push(...pieces.slice(0, -1));
      // Last piece stays open so a short trailing block (a closing sentence)
      // rides along instead of arriving as its own two-character bubble.
      cur = (pieces.at(-1) ?? "").split("\n");
      continue;
    }
    cur.push(...lines);
  }
  flush();
  return chunks.length ? chunks : [s];
};
