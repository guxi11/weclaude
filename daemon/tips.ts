// Rotating one-line hints appended to the `/new` / `/clear` project-info push.
//
// Why random-one instead of a fixed "输入 /help": a static line becomes visual
// noise within a day and stops being read, while the command surface is wide
// enough that most users never discover half of it. Sampling one tip per
// session boundary keeps the footer cheap (one line) but eventually exposes
// everything. `/help` is in the pool too, so the discoverability entry point
// still surfaces on its own.

const TIPS: readonly string[] = [
  "`/help` 查看全部命令",
  "`#tag` 前缀可在同一聊天并行跑多个会话，如 `#docs 帮我改 README`",
  "`/sessions` 列出所有 live 会话，`/sessions 🐼` 切过去",
  "`/new codebuddy` 换个 CLI 后端开会话（claude / claude-internal / codebuddy）",
  "`/stop` 打断当前生成，`/n` 补一个回车",
  "`/usage` 看真实订阅额度 %，`/cost` 看 token 成本估算",
  "`/audit` 看本会话（含 subagent）的 token / 成本明细",
  "换项目：对 AI 说「切到 /path/to/proj」，`set_workspace` 一步换目录重开会话",
  "直接发图片即可，会自动粘进 CLI 输入框",
  "引用自己发过的命令再发一次，可以绕开微信的相同文本去重",
  "对 AI 说「订阅 xxx」「每天8点广播 xxx: …」即可做事件订阅 / 定时播报（走 MCP 工具）",
  "`/pwd` 看当前项目路径，`/id` 看会话 / 权限 id",
];

/** One random tip, already formatted as a markdown quote line. */
export const randomTip = (): string => `> 💡 ${TIPS[Math.floor(Math.random() * TIPS.length)]!}`;
