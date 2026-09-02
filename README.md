<div align="center">

<img src="images/icon.png" alt="wezard" width="176" height="176" />

<h1>wezard</h1>

<p><b>把 Claude Code 装进企业微信。</b><br/>在地铁上、被窝里、开会摸鱼时，照样能跟你电脑上的 Claude 干活。</p>

<p>
  <a href="https://www.npmjs.com/package/wezard"><img src="https://img.shields.io/npm/v/wezard?style=flat-square&color=07C160&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/wezard"><img src="https://img.shields.io/npm/dm/wezard?style=flat-square&color=07C160&label=downloads" alt="npm downloads" /></a>
  <a href="https://github.com/guxi11/wezard/stargazers"><img src="https://img.shields.io/github/stars/guxi11/wezard?style=flat-square&color=E8825C" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/wezard?style=flat-square&color=E8825C" alt="license" /></a>
  <img src="https://img.shields.io/node/v/wezard?style=flat-square&color=339933" alt="node version" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555?style=flat-square" alt="platform" />
</p>

</div>

![demo](images/demo.png)

| 功能<img width="160"> | 说明 |
| --- | --- |
| 🛎 **远程审批** | Claude 要跑 `Bash` / `Edit`？审批卡片直推 IM，点 ✅/❌/⏱（放行 N 分钟）。 |
| 📋 **计划审批** | Claude 在 plan mode 结束（`ExitPlanMode`）时，把计划摘要 + 审批卡推到 IM：点 ✅同意 退出 plan mode 开始执行，或 ✏️继续改 留在 plan mode 继续完善。`AskUserQuestion` 多选题也镜像为投票卡。 |
| 🪞 **会话镜像** | 你电脑上跑的 Claude 流式打字、tool_use、思考过程，实时同步到企业微信；IM 里发消息原样落进 CLI 输入框。 |
| 🖼 **图片直贴** | 企业微信发图，自动走 macOS 剪贴板 + tmux 粘贴，Claude 当贴图处理（不走 Read，不耗 token）。 |
| 🔍 **细节页** | 工具调用 / 审批请求都生成本地 HTML 详情页，IM 里点链接看完整 input / result / git diff。 |
| 📡 **MCP 主动推送** | Claude 通过 `wecom__send_markdown` / `wecom__send_card` / `wecom__ask_user` 主动汇报或问询。 |
| 📄 **文档读写** | Claude 通过 `wecom_doc_list_tools` / `wecom_doc_call` 直接调企业微信智能机器人的 doc / smartsheet / smartpage MCP，新建在线文档、写 Markdown、读链接、操作智能表格——全程在内网，不需要 corp access_token。 |
| 🗂 **多会话发现/切换** | Claude 通过 `list_claude_sessions` / `switch_claude_session` / `new_claude_session` 列出本机 tmux 内所有在跑的会话（带摘要 + 稳定动物 emoji 标签）、切换 IM 镜像、或在指定路径新开会话。审批卡标题也带同一枚 emoji，多会话兜底到同一 IM 时一眼区分。 |
| 🔄 **重启即续** | 电脑重启 / tmux 全没了 / daemon 崩了都不掉档：IM ↔ 会话绑定持久化在 `~/.wezard/mirror-attachments.json`，下一条 IM 消息自动 `claude --resume` 拉起新 tmux pane，历史完整继承；`tmux attach -t wezard` 接管即可。 |

<details>
<summary><b>目录</b></summary>

- [快速开始](#快速开始)
- [镜像模式](#镜像模式)
- [体验是什么样](#体验是什么样)
- [文档 / 智能表格 / 智能文档](#文档--智能表格--智能文档)
- [事件订阅 / 定时广播](#事件订阅--定时广播)
- [一个聊天里跑多个会话（`#tag` 路由）](#一个聊天里跑多个会话tag-路由)
- [多 CLI 后端](#多-cli-后端claude--claude-internal--codebuddy)
- [Prompt-cache 保活（省钱心跳）](#prompt-cache-保活省钱心跳)
- [常用命令](#常用命令)
- [常见问题](#常见问题)
- [深入了解](#深入了解)
- [参与贡献](#参与贡献)
- [License](#license)

</details>

---

## 快速开始

**前置**：macOS / Linux、Node ≥ 20、`tmux`、PATH 里能找到 `claude` 或 `claude-internal`、企业微信「智能机器人」的 `botId` + `secret`。

```bash
npm install -g wezard
wezard init
```

`init` 会交互式问你 4 个问题，把配置落到 `~/.wezard/`：

| 问什么 | 落到哪 |
| --- | --- |
| botId / secret | `~/.wezard/secrets.json` |
| 用哪个 Claude（`claude` / `claude-internal` / 自定义路径） | `~/.wezard/config.jsonc` |
| 是否开启 PreToolUse 远程审批 | `~/.wezard/config.jsonc` |

然后自动：编译 → 注入 hook/MCP → 装常驻 daemon（macOS launchd / Linux systemd --user）→ 等 WebSocket 鉴权。

**最后一步：绑定默认会话。** CLI 提示后，**在企业微信里**给机器人发：

```
将本对话设置为默认会话
```

这是**唯一**绕过白名单的入口，10 分钟窗口，消费完立刻关。后续所有消息都按白名单鉴权。

---

## 镜像模式

IM 来消息 → tmux 粘进活的 TUI，CLI 里像你自己敲进去的一样；Claude 的回应、调用了哪些工具、思考过程都逐字流式推回 IM。一对一绑定 IM 聊天 ↔ tmux 窗口，原地累计上下文——真·远程结对编程。

IM 里发 `/new` 直接开新 tmux 窗口 + 新 Claude 会话；`/clear` 清当前上下文；带图消息自动注入剪贴板。所有 IM 聊天共享一个 tmux session（默认名 `wezard`），每个聊天一个独立 window，**关 tmux / daemon 崩了 / 整机重启都能自愈**：IM↔会话绑定 write-through 落到 `~/.wezard/mirror-attachments.json`，daemon 起来就 eager restore；重启后 pane 全死，下一条 IM 消息触发 `claude --resume <sid>` 拉起新 pane，`--resume` fork 出的新 jsonl 由 watcher 从 EOF 无缝接管（不会把整段历史再推一遍到 IM）。中途在别处 `/clear` 把 jsonl rotate 掉也不丢绑定，会自愈到同项目目录下最新的 jsonl。

> 💡 **mirror 不要求你必须先在 CLI 里开 tmux**：在企业微信里直接发 `/new` 就能从零起一个新 tmux 窗口 + Claude 会话；甚至首次发任意消息都会自动 spawn + 绑定（首条消息既是绑定信号也是第一句 prompt）。回家打开终端 `tmux attach -t wezard` 接管即可。

---

## 体验是什么样

**审批场景**：你正在地铁上，电脑上的 Claude 想 `rm -rf node_modules` 重装。企业微信叮一声弹卡片：

> 🛎 授权请求: Bash
> `rm -rf node_modules`
> [✅ 允许] [❌ 拒绝] [⏱ 5 分钟内自动允许]

你点 ✅，卡片立刻刷新成 `✅ Bash · 已允许`，电脑上的 Claude 解除阻塞继续跑。

**镜像场景**：你 tmux 里开着 Claude 在写代码。出门后给机器人发：

> 把刚才那个函数改成异步的

这条消息自动粘进 CLI 输入框 + 回车提交。Claude 的回应、调用了哪些工具、改了哪些文件，逐字流式推回你 IM。回家打开终端，对话一字不少都在那里。

**文档场景**：你给 Claude 说："周报给我整理成一篇企业微信文档"。Claude 自己调 `wecom_doc_list_tools` 看可用方法，再调 `wecom_doc_call` 走 `create_doc` 新建文档、`edit_doc_content` 写入 Markdown，最后把链接贴回会话——全程不离开 Claude，文档归属到你的 userid，每日 20 篇限额按 userid 计。

---

## 文档 / 智能表格 / 智能文档

`wezard` 把企业微信智能机器人的远端 MCP（doc / smartsheet / contact）桥接到本地 Claude，**全程内网、不走 corp access_token**。Claude 先调 `wecom_doc_list_tools` 看某 category 有哪些方法，再调 `wecom_doc_call` 执行——新建在线文档、写 Markdown、读链接、操作智能表格。首次用需在「工作台 - 智能机器人 - 可使用权限」里勾选「文档」「智能表格」。

桥接机制、curl 验证、`requesterUserId` 解析规则见 [技术说明](技术说明.md#文档-mcp-如何桥接)。

---

## 事件订阅 / 定时广播

一个轻量 pub/sub：任意群或单聊都能订阅一个 **topic**（自定义事件名），任何会话都能广播；daemon 内置分钟级调度器，每天定点自动推送。订阅关系与定时任务持久化到 `~/.wezard/config.jsonc` 的 `topics` 段，`wezard reload` 后自动恢复。

**全部由 MCP 工具驱动**——直接对 Claude 说人话，它自己调工具，不用记命令语法：

| 说 | 工具 | 干什么 |
| --- | --- | --- |
| 「订阅 sync-daily」 | `subscribe_topic(topic)` | 把当前聊天加进某 topic 的订阅表 |
| 「别再往这群发 sync-daily」 | `unsubscribe_topic(topic)` | 退订 |
| 「广播 sync-daily：早会 10 分钟后开始」 | `broadcast_topic(topic, markdown)` | 立即扇出给所有订阅者，返回 `sent / failed / subs` |
| 「每天 8 点广播 sync-daily：…」 | `schedule_broadcast(topic, hour, minute, content)` | 注册每日定时广播 |
| 「取消 sync-daily 的定时」 | `cancel_broadcast(topic)` | 删掉该 topic 的所有定时 |
| 「我订了什么 / 有哪些定时」 | `list_topics()` | 列出本聊天订阅 + 全部定时 |

典型用法：在群 A 说「订阅 sync-daily」，在群 B 说「每天 8 点广播 sync-daily：早会 10 分钟后开始」——第二天早 8 点群 A 自动收到。一个 agent 也能在跑完任务后自己 `broadcast_topic` 汇报结果，无需人工敲命令。

**外部触发**（CI / 监控 / 脚本，无需 MCP）：daemon 在 loopback 暴露 `POST /publish`，广播给某 topic 的所有订阅者：

```bash
curl -sS -X POST http://127.0.0.1:17890/publish \
  -H 'content-type: application/json' \
  -d '{"topic":"ci-fail","markdown":"🔴 build #1234 failed on main"}'
```

调用方只关心事件名，订阅者由 AI 通过 MCP 工具增删，代码零改动。

---

## 一个聊天里跑多个会话（`#tag` 路由）

同一个 WeCom 聊天里可以同时挂多个并行 Claude session，靠消息里的 `#tag` 前缀路由。不带 tag 就是默认 session，与旧行为一致。

![多会话](images/multi-session.png)

**创建 & 切换**

```
/new #docs        新开一个标签为 docs 的会话（tmux 窗口名也叫 docs）
/new #api         再开一个,与 #docs 完全独立(独立 sessionId / jsonl / cwd)
/new              默认 session,老玩法
```

**消息路由**

只要消息文本里任意位置带 `#tag`（空白/句首/句尾分隔），就路由到那个 tagged session：

```
#docs 帮我把 README 的目录补一下
帮我看下这个报错 #api
/pwd #docs        → 只看 docs 会话的项目路径
/stop #api        → 只打断 api 会话
/clear #docs      → 只清 docs 会话上下文
```

不带 tag 的消息始终落到默认 session。

**回复标识**

tagged session 的每条回复自带 `emoji #tag` 前缀（emoji 由 tag 名 hash 决定，稳定），一眼分辨来自哪个 session：

```
🦊 `#docs`

（这里是 docs 会话的 Claude 回复……）
```

默认 session 无前缀，视觉上保持简洁。

**tag 语法**：`[\p{L}\p{N}_-]{1,32}`，支持中英文数字与 `_`、`-`；一条消息里只识别**第一个** `#tag`，后续的 `#foo` 原样透传给 Claude（不会误伤代码里的 `#include` 或 issue 引用）。

**cwd 是聊天级的，不是 session 级**：同一聊天里所有 tagged / 默认 session **共用**一个 cwd。`/new #foo` 会在**当前聊天绑定的 cwd** 下起 pane；任意 session 里让 AI 调 `cd` MCP，写入的 pendingCwd 也挂在聊天层，下次 `/new`（无论带不带 tag）都会读到。这样多 session 天然对齐到同一个项目根，切换 tag 时不用重新指路径。

---

## 跨聊天：给聊天命名

一个 WeCom 聊天的身份是 `chat:wrkS…` 这种既读不出也打不进去的 id。所以在给聊天起名之前，跨聊天叫人只有一条路：**赌 tag 全局唯一**——两个群各有一个 `#fix`，就谁也叫不动谁，唯一的出路是回去改别人的 tag。

起个名字，这个聊天就有了能写进消息、也能传给工具的地址。

```
/name daily        给本聊天起名为 daily
/name              查看当前名字
/name -            取消命名
/chats             列出所有已知聊天、各自跑着哪些会话
```

**名字规则**：1–32 个字符，字母 / 数字 / `_` / `-`（不能有空格、`#`、`/`、`:`）。全机唯一、大小写不敏感，重名会被拒；改名即覆盖，一个聊天只留一个名字。名字写在 `~/.wezard/config.jsonc` 的 `chats` 里，手改也行。

**地址空间**随之变成两级，老写法一字不改：

| 写法 | 指向 |
|---|---|
| `fix` | 本聊天的 `#fix`；本聊天没有，才回退去找全机唯一的 `#fix` |
| `daily#fix` | daily 这个聊天的 `#fix`——不问 tag 全不全局唯一 |
| `daily#` | daily 的默认（无 tag）会话 |
| `chat:wr…#fix` | 全量 key，`/chats`、`list_peers` 吐出来的原样也能用 |

起完名之后，在**别的群**里直接说人话即可：

```
让 daily#fix 看一眼这个报错          → AI 调 send_peer("daily#fix", …)
在 daily 里开个 #ingest 跑 ~/repo    → AI 调 new_claude_session({ chat: "daily", tag: "ingest", cwd })
别的群还有谁在跑                      → AI 调 list_chats
```

最后一块是**跨群建会话**：`new_claude_session` 的 `chat` 参数可以直接在另一个已命名的聊天里拉起 peer，「目标 peer 还不存在」不再需要找个人去那个群手打 `/new`。跨群的每一次 `send_peer`，两边聊天都会收到 relay 气泡——被叫的那侧不会莫名其妙冒出一句话。

> **未命名的聊天既不可寻址、也不可被建入**，这是刻意的：往一个谁也读不出的 `chat:wr…` id 里塞会话，等于把它扔进一个调用方根本不该进的群。想让某个群能被叫到，就在那个群里发一次 `/name`。

---

## 多 CLI 后端（`claude` / `claude-internal` / `codebuddy`）

daemon 同时挂载所有已安装的 CLI，不是二选一：你可以一个 tmux 窗口跑 `claude`、另一个跑 `codebuddy`，各自绑不同的 IM 聊天。**会话身份就是它的 jsonl 路径**，daemon 由路径反推是哪个 CLI 写的，`--resume` 用哪个二进制、jsonl 用哪套 schema 解析、project-dir 怎么编码，全部由此派生。

```
/new                 沿用「当前会话」的 CLI 新开
/new codebuddy       换到 codebuddy 新开
/new claude-internal 换到 claude-internal 新开
```

默认后端由 `wrc.defaultCli` 决定（缺省 `claude`），二进制路径可用 `wrc.cliBackends.<name>.bin` 覆盖。

**和 `#tag` 完全正交**，两者可以任意组合、顺序不限：

```
/new codebuddy #docs    用 codebuddy 起一个 docs 标签会话
/new #docs codebuddy    等价写法
#docs 帮我改 README      → 路由到那个 codebuddy 会话
/clear #docs            → 只清它，且仍留在 codebuddy 上
```

切换 CLI 后 tag 路由的所有行为都保持不变：

- `/clear #tag` rotate 出的新 jsonl 仍落在该 CLI 的 projects 目录，watcher 按该后端的 dialect 迁移绑定；
- pane 挂了自愈 `--resume` 用的是**该会话所属**的二进制，不会串到 `defaultCli`；
- 首次 `/new #tag` 没有自己的历史记录时，**继承本聊天基础会话的 CLI**（与 cwd 的聊天级继承规则一致），不会悄悄退回默认后端；
- `/sessions` 列表在混用多个 CLI 时，每行自动标注 `(codebuddy)` 之类的来源。

---

## Prompt-cache 保活（省钱心跳）

Anthropic 的 prompt cache 只活 ~5 分钟，且**写缓存 1.25x、读缓存 0.1x**。一个 pane 一旦空闲（agent 在等 peer 回复、或后台任务在跑），整份上下文就会掉出缓存——下一轮真实对话得按 1.25x 把整个上下文重写一遍。保活机制会在缓存**即将过期前**往 pane 注入一次极小的 ping，逼模型发起一次廉价请求（命中缓存前缀走 0.1x 读）并把 5 分钟 TTL 往前滑，真实那轮就只需写增量。

- **锚定「真实活动」，不自我续命**：整套调度以**最后一次真实（非 ping）对话**为锚——保活自己的 ping **不会**刷新这个锚点。空闲落在 `[ttlSec - marginSec, ttlSec)`（缓存快过期）才 ping；一旦**真实空闲超过 `maxIdleSec`（默认 = TTL 5min）就彻底停手**，让缓存自然冷掉。这正是关键：老会话不会因为「ping 把 mtime 刷新了」而被误判成活跃，从而无限保活。
- **两道成本保险**：① 缓存已冷（距上次任何触碰 ≥ TTL）绝不 ping——否则就是为 no-op 付整份冷写；② 真实工作太老（≥ `maxIdleSec`）直接放弃。daemon reload 后，会先看 transcript 最后一轮是不是自己的 ping，是就把锚点当成「早已空闲」，**不会**把一个搁置很久的大会话重新烧热。
- **零污染**：ping 文案默认 `keepalive — reply with just "pong", take no other action`，逼出一个约 1 token 的极短回复且禁止任何工具动作。这轮 ping/pong **完全不进聊天**（群里一条都不推），但会 **记入 chat detail 时间线**：记录的是**真实的心跳对话**——注入的 ping 原文 + 模型的真实回复（预期就一个 `pong`）+ 那次真实的 cache-read usage，留痕可审计。
- **`/stop` 手动暂停**：在 IM 里发 `/stop`（Esc 打断当前生成）同时会暂停该会话的保活；等下次有真实新对话（IM 消息或 CLI 里新起一轮）自动恢复。
- **只针对 mirror 模式的活 pane**：spawn 模式无 TTY、pane 已死、正在流式输出或会话轮换中的，一律跳过。

全部可配（`wrc.mirror.keepalive`）：

```jsonc
"keepalive": {
  "enabled": true,    // 总开关
  "ttlSec": 300,      // 缓存 TTL，Anthropic 默认 5min
  "marginSec": 45,    // 提前多少秒 ping（留出注入落地的余量）
  "maxIdleSec": 300,  // 真实空闲超过这个就停手（默认=TTL，即只补一次；调大可跨更长等待续命）
  "ping": "keepalive — reply with just \"pong\", take no other action"
}
```

---

## 常用命令

IM 里发 `/help` 可随时拉出完整命令表；每次 `/new`、`/clear` 之后，回执会随机附一条功能提示，用来慢慢摊开命令面。

```
/new · /clear · /stop · /n          会话控制
/sessions [emoji|id]                 列出 / 切换 live 会话
/new <cli> [#tag]                    切换 CLI 后端 / 开并行会话
/peers                               本聊天的会话及忙闲状态
/name [名字|-] · /chats              给本聊天起名 / 跨聊天目录
/id · /pwd · /usage · /cost · /audit  信息查询（免授权）
/help                                全部命令
```

本机 shell：

```bash
wezard status              # 看 daemon + WS 健康
wezard logs -f             # 实时日志
wezard send <chat> <text>  # 主动推消息
wezard sync                # 重写 hook/MCP/env 进各 settings.json
wezard reload              # 重启 daemon（改了配置后用）
wezard migrate             # 一次性：从旧名 weclaude 迁移到 wezard
wezard unsync              # 卸载 hook/MCP（保留 daemon）
wezard uninstall           # 完整卸载（先于 npm uninstall）
```

> ⬆️ **升级**：`npm i -g wezard@latest` 装新版二进制，再 `wezard sync && wezard reload` 刷新 hook/MCP 注入并重启 daemon（幂等，`~/.wezard/` 的 config/secrets 原样保留）。
>
> `wezard migrate` 只用于从**旧包名 `weclaude`** 迁移（搬 `~/.weclaude` → `~/.wezard`、重装 daemon/插件），普通版本升级用不到。
>
> ⚠️ **卸载顺序**：先 `wezard uninstall` 再 `npm uninstall -g wezard`。否则 launchd/systemd 会一直尝试拉起已删除的二进制。`~/.wezard/` 下的 config/secrets 不会被清，二次安装可无缝复用。

---

## 常见问题

**Q: hook 不触发？**
`cat ~/.claude/settings.json | jq .hooks.PreToolUse`，没东西就跑 `wezard sync` 重写。

**Q: 卡片点了没反应？**
企业微信卡片就地刷新只有 5 秒窗口，超时不刷新是正常的，决策本身仍然生效。

**Q: daemon 起不来？**
`wezard logs -f` 看；常见是 `botId` / `secret` 写错卡在 WebSocket 鉴权。

**Q: 多机部署？**
`config.jsonc` 可以纳入 dotfiles；`secrets.json` 每台机器独立填。第二台机器跑 `wezard init` 会跳过覆盖提示，但仍要重新走 claim 步骤拿本机 IM principal。

---

## 深入了解

- [技术说明](技术说明.md) — 架构、消息双向同步流程、文档 MCP 桥接机制
- [CLAUDE.md](CLAUDE.md) — 模块级职责与代码约定
- [CHANGELOG.md](CHANGELOG.md) — 各版本变更

---

## 参与贡献

欢迎 issue / PR。本地开发：

```bash
git clone https://github.com/guxi11/wezard.git
cd wezard && npm install
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run dev:daemon     # tsx 直跑 daemon，热迭代不用装
./cli/wezard.sh reload # 重编译并重启常驻 daemon
./cli/wezard.sh logs -f
```

架构与模块职责见 [CLAUDE.md](CLAUDE.md)。提交前跑一遍 `npm run typecheck`；无测试套件，别伪造测试命令。

## License

[MIT](LICENSE) © [guxi11](https://github.com/guxi11)
