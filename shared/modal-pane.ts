// Detect whether a captured tmux pane is sitting on a MODAL Claude Code picker
// (tool-permission confirm, /model chooser, plan review, AskUserQuestion …).
//
// Why the mirror cares: a modal picker eats pasted text and reads Enter as
// "confirm the highlighted option". Injecting a WeCom message into one loses
// the message AND answers a permission prompt on the user's behalf — the user
// sees their session silently skip their input while a file edit they never
// approved goes through.
//
// The blocking case that motivated this: editing any file under `.claude/**`
// makes Claude Code raise its own "allow Claude to edit its own settings"
// confirm. That confirm does NOT go through the PreToolUse hook, so weclaude
// never learns about it, never sends a card, and the pane blocks until someone
// presses a key locally.
//
// Kept as a pure function over captured text so it is unit-testable without a
// live tmux server.

// A highlighted numbered option row: "❯ 1. Yes". The `❯` glyph alone is NOT
// evidence — the normal input box renders one too — so the digit + dot +
// non-space content are all load-bearing.
const MODAL_OPTION_ROW = /^\s*[❯>]\s*\d+\.\s+\S/mu;

// Picker footer. Present on every modal picker, absent from the idle input box.
const MODAL_FOOTER = /Esc to cancel/iu;

// Title line of the confirm, surfaced in the failure reason so the user knows
// what is waiting for them. Optional — detection never depends on it.
const MODAL_TITLE = /^\s*((?:Do|Would|Should) you .+?)\s*$/mu;

export interface ModalPaneVerdict {
  modal: boolean;
  /** Confirm title, when the pane exposed a recognizable one. */
  title?: string;
}

/**
 * Conservative by construction: BOTH an option row and the footer must be
 * present. A false positive blocks a legitimate message, which is worse than
 * missing an exotic picker layout — an "Esc to cancel" appearing inside pasted
 * text cannot fabricate a numbered option row above itself, and a message that
 * merely lists "1. …" cannot fabricate the footer.
 */
export const isModalPane = (pane: string): ModalPaneVerdict => {
  if (!pane || !MODAL_OPTION_ROW.test(pane) || !MODAL_FOOTER.test(pane)) return { modal: false };
  return { modal: true, title: pane.match(MODAL_TITLE)?.[1] };
};

// ── 选项解析 + 代按 ────────────────────────────────────────────────────
// 只服务一个场景: 用户刚在企微卡片上显式批准了某次调用, 而 Claude Code 在 hook
// 返回后又立起它自己的原生确认框(见文件头 `.claude/**` 那段)。此时把答案按进
// pane 是"完成用户已经作出的决定", 不是替他做决定。
//
// 因此这里刻意只认**权限确认框**、只挑**一次性 Yes**:
//   • 标题必须长得像 "Do you want to …" —— /model 选择器、plan review 之类同样
//     是 modal, 但按下去的语义完全不同, 一律不碰;
//   • "Yes, and don't ask again …" / "Yes, and allow …" 这类会放宽后续权限的
//     选项永不选中 —— 用户要的就是"每次都点", 代按不能顺手把门拆了。
// 解析不出可信选项 → 返回 undefined, 调用方走取消+告知的兜底路径。

/** 编号选项行: "❯ 1. Yes" / "  2. No, and tell Claude…"。 */
const OPTION_ROW = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(\S.*?)\s*$/u;

/** 权限确认框的标题形状。plan review("Would you like to proceed?")也在此列 —— 但它
 *  的选项文案不是裸 "Yes", pickModalAnswer 会自然放弃, 不需要在标题上再排除。 */
const PERMISSION_TITLE = /^(?:Do|Would|Should) you /iu;

export interface ModalOption {
  index: number;
  label: string;
  /** 当前高亮项(`❯` 打头) —— 仅供日志/展示, 代按不依赖它。 */
  selected: boolean;
}

/**
 * 抽出**最后一组**连续编号选项(从 1 开始)。
 * 为什么取最后一组: 当前屏上可能同时留着一个已答完的旧确认(它的选项行还在),
 * 取全部会把两个框的选项混成一锅 —— 按错框就是替用户批准了别的东西。
 */
export const parseModalOptions = (pane: string): ModalOption[] => {
  const groups: ModalOption[][] = [];
  let cur: ModalOption[] = [];
  for (const line of (pane ?? "").split("\n")) {
    const m = OPTION_ROW.exec(line);
    if (!m) {
      // 选项行之间允许空行(部分布局会插一行), 非空的非选项行才断组。
      if (line.trim() === "") continue;
      if (cur.length > 0) { groups.push(cur); cur = []; }
      continue;
    }
    const index = Number(m[1]);
    const opt: ModalOption = { index, label: m[2]!, selected: /^\s*[❯>]/u.test(line) };
    // 编号回到 1 = 新的一组开始。
    if (index === 1 && cur.length > 0) { groups.push(cur); cur = []; }
    cur.push(opt);
  }
  if (cur.length > 0) groups.push(cur);
  const last = groups.filter((g) => g[0]?.index === 1).pop();
  return last ?? [];
};

export interface ModalAnswer {
  index: number;
  label: string;
}

// AskUserQuestion 提交页的判据: 选项组里出现 "Submit answers" 行。到了这一页,
// 一个 Enter 就能收工。用最后一组编号选项 (parseModalOptions) 找它, 天然排除
// 屏上残留的旧确认框。纯函数, 供 mirror 侧「聊聊这个」收尾读屏确认复用。
const SUBMIT_LABEL = /submit\s+answer/iu;
export const isAskqSubmitPage = (pane: string): boolean =>
  parseModalOptions(pane).some((o) => SUBMIT_LABEL.test(o.label));

/**
 * 从选项里挑出"一次性同意"。挑不出返回 undefined(宁可不按)。
 * `title` 缺失或不像权限确认 → 直接放弃, 避免按到 /model 之类的选择器上。
 */
export const pickModalAnswer = (options: ModalOption[], title?: string): ModalAnswer | undefined => {
  if (!title || !PERMISSION_TITLE.test(title)) return undefined;
  const plainYes = options.find((o) => /^yes\s*$/iu.test(o.label));
  if (!plainYes) return undefined;
  return { index: plainYes.index, label: plainYes.label };
};
