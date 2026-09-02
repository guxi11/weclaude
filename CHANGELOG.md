# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- `mirror` 分页预算改按**字节**计,单页上限抬到 3800B(`wrc.mirror.chunkChars` → `chunkBytes`,默认 `1800` → `3800`)。企微 markdown 的 `content` 上限是 4096 **字节**而非字符,旧的字符预算对英文浪费了大半页,对中文又必然超限;`shared/md-chunk` 的 `sizeOf` / `sliceLine` 同步改成 `Buffer.byteLength` 计量,长行按 code point 切(不再切断 emoji 代理对)。头部分片预留 32 → 64B(链接态 `[🧙 #tag](url)` 可达 110B)。

## [1.2.31] - 2026-09-01

### Fixed
- `mirror` think-style: **气泡收口后的 reasoning 不再作为裸正文泄进聊天**。长 turn 里气泡一旦收口(6min 编辑窗口、`earlyLinkBubble`、工具密集),后续落盘的 thinking 只能走 standalone 补发,而 standalone 的 think 识别只认 `🔧` / `↳` 两个工具行前缀 —— 纯 reasoning 段落被当成正文整段裸奔出去。`pushThink` 现在给进 standalone 的中间内容打 `💭` 传输标记,`formatThinkStandalone` 凭它分流入 `<think>`(标记在渲染时剥掉;`🔧` / `↳` 是给用户的工具行标记,保留)。
- `mirror` think-style: **软后端(codebuddy)的最终答复不再被误包进 `<think>`**。软后端没有 `final` 标记,终句与中间文本共用 `final===undefined`,此前一律走 `pushThink` —— 气泡活着时无害(收口有 `stripTrailingBody` 剥重复纠偏),气泡死了就等于给答复打上 think 标记直接发出去。现在该分支按气泡状态分流:活则仍进 think 累积并记 `briefLastText`,终句身份留给 `closeBriefTurn(soft)` 定夺;死则按正文发 —— 没有收口阶段可纠偏,而它很可能就是终句。

## [1.2.30] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `8s → 30s`(`wrc.mirror.standaloneDebounceMs`)。长 turn 里工具调用之间的间隔动辄十几秒,8s 仍会切成多条气泡;30s 能把一整段工具链聚合成一条再补发。

## [1.2.29] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `3s → 8s`(`wrc.mirror.standaloneDebounceMs`)。连续工具调用间隔常超过 3s,窗口太短仍会按气泡刷屏;8s 能把一整串工具调用聚合成一条 markdown 后再补发。

## [1.2.22] - 2026-08-27

### Changed
- `mirror` think-style: **中间过程实时流进 `<think>`,不再只在收口时拼前缀**。开启 `wrc.mirror.thinkStyle` 后,本轮的 reasoning、非 final 的中途文本、以及**每一次工具调用/结果**(`🔧 Name …` / `↳ …` 摘要)都实时追加进气泡里那段 `<think>🧙 …` 流,只有 final 文本才结束思考、落成 `</think>` 之后的正文。用户一发消息气泡立刻以 `<think>🧙 #tag ` 开头(tag 塞在 `<think>` 内),看得到 Claude 正在想什么,而不是先干等一个 `…` 占位再一次性出全文。

### Fixed
- `mirror` think-style: **气泡过了 6min 编辑窗口后,累积的思考不再丢**。窗口外气泡刷不动了,改走 10s 防抖把 think 增量整段补发成一条独立 `<think>🧙 …</think>` standalone;turn 收口时冲干净残余,不漏最后一段思考。
- `mirror` think-style: **软后端的最终正文不再重复出现一次**。软后端(如 codebuddy)的最终正文会先作为「非 final 中途文本」进过 think 流,收口再当正文用一次;收口前把 think 尾部恰好等于正文的那段剥掉(含前导 `\n\n`),保证正文只出现在 `</think>` 之后一次。
- `inbound` 引用去重: **带引用新建 / 改投到别的 `#tag` 时,原文不再被重复注入**。去重比对的会话改成引用气泡真正的**源会话**(反解 `emoji #tag` 头得知),而非路由目标——原文天然存在于源的 transcript,与你把它投到哪个 tag 无关;源未知(用户自打的引用)才回退按目标查。
- `inbound` 引用去重: **引用一个 `🔧 Grep …` 工具气泡不再误判为「不在上下文」而重复注入**。末轮 transcript 的扁平化文本现在也纳入 `tool_use` / `tool_result`(工具名+入参、结果文本),与出站工具气泡的 `🔧 <Name> <input>` / `↳ <result>` 渲染对齐,子串比对才能命中。
- `session-label` `parseTagHeader`: **think-style 气泡被引用时能正确反解出 tag 头**。tag 头此时塞在 `<think>` 内(`<think>🦊 #fix …</think>\n\n正文`),微信引用时 `<think>` 标记有时保留有时被渲染剥掉;现在先剥掉可能存在的起始 `<think>` 再认头,body 保留 think+正文全文(仅去 `<think>`/`</think>` 标记杂质),`canonContains` 子串比对必然命中。
- `approval` 「聊聊这个」: **补第二个 Enter,talk-about-this 不再卡在提交页**。自定义文本确认为本题答案后前进到提交页,还需再一个 Enter 在提交页(光标 0 = `1. Submit answers`)收工;缺它 CLI 会一直等输入。

## [1.2.21] - 2026-08-25

### Fixed
- `peers`: **compound `chatName#tag` 地址在用户正文里被正确识别并标注**。此前 `#tag` 的正则要求 `#` 前有空白,导致 `sanitizer#handle824` 这种紧凑写法对路由和标注都不可见——消息整条落进本 chat 的默认会话,目标 chat 里什么都没被创建。现在 `peerMentions` 在 `allTags` 之外额外扫描 `word#word` 形式的 compound 地址,chat 名合法即标注;目标会话尚不存在时(unborn peer)也注入提示,告诉 agent 先 `new_claude_session` 再 `send_peer`。

### Changed
- `launchd`: plist 模板移除 `NODE_ENV=production`——daemon 不依赖该变量,且它会干扰 tsx dev 模式。

## [1.2.20] - 2026-08-24

### Fixed
- `sessions`: **`new_claude_session` 在调用方自己的 chat 里建 peer**,不再掉进 `defaultChat`。这个工具此前不带 `selfRef`,daemon 只能 `target ?? cfg.defaultChat` 兜底,于是非 default 会话里的 agent 一喊「新开一个会话」,session 就落到另一个群里 —— 叫它的人既看不见也够不着;而且落点是**不带 tag 的 key**,那就是那个 chat 的默认会话,attach 直接把原本镜像在那儿的会话顶掉。现在:调用方按 `sessionId` / `tmuxPane` 解析出自己所在的 chat,新会话一律带 `#tag` 落成同 chat 的 peer(tag 可显式给,省略则由目录名派生并去重;撞上已存在的 tag 直接拒绝,而不是 respawn 掉那个正在跑的 peer),并且改走 `newSession` 而非裸 spawn+attach —— cwd/CLI 的 chat 级继承、tmux 窗口名、以及「created + 📂 当前项目」那条气泡全都和用户手打 `/new #tag` 完全一致:群里发得出消息、chat detail 里有记录、`list_peers` / `send_peer` 立刻能寻址。

### Added
- `chats`: **给聊天命名,跨聊天寻址与建会话**。一个 WeCom 聊天的身份是 `chat:wrkS…` 这种既读不出也打不进去的 id,所以在此之前跨聊天只有「全局唯一 tag」一条路:两个群各有一个 `#fix`,就谁也叫不动谁,唯一的出路是回去改别人的 tag。现在 `/name daily` 给聊天起个名(`/name` 查看、`/name -` 取消;名字全机唯一、大小写不敏感,落在 `config.jsonc` 的 `chats` 里,和 `topics` 同一套写法),地址空间随之变成两级:`fix` 仍是本聊天的 `#fix`(老语义一字不改,不唯一时才回退全局搜),`daily#fix` 精确到那个聊天的那个会话、不问 tag 全不全局唯一,`daily#` 是它的默认会话。`send_peer` / `peek_peer` / `wait_peer` 都收这个全称,`list_peers` 的每一行现在直接给出该照抄的 `address`,`foreignPeers` 也从「只有全局唯一 tag」放宽到「全局唯一 tag **或** 所在聊天有名字」。新增 `/chats` 与 `list_chats` 作为跨聊天目录(谁有名字、各自跑着哪些会话),以及 `name_chat` 让 agent 也能读写名字。最后一块:`new_claude_session` 新增 `chat` 参数,可以直接在**另一个已命名的聊天**里建 peer —— 「目标 peer 还不存在」不再需要找个人去那个群里手打 `/new`。未命名的聊天依旧无法被寻址、也无法被建入,这是刻意的:往一个谁也读不出的 `chat:wr…` id 里塞会话,等于把它扔进一个调用方根本不该进的群。
- `peers`: **跨 chat 的 peer 寻址**。`send_peer` / `peek_peer` / `wait_peer` / `handoff` 的 `tag` 参数在本 chat 找不到目标时,会在全 host 的 sessions 里回退搜同名 tag —— 只当命中数**正好为 1** 时才认(0/多命中都拒绝、把原因回给调用方),把「跨 chat 交接」收敛成「让目标群里的 peer 起一个全局唯一的 tag」这一个约束,不引入 alias 表、不改授权模型。相应地 `list_peers` 新增 `foreignPeers`(其他 chat 里全局唯一 tag 的 session 列表),给 agent 发现可跨群命中的 peer。跨 chat 的 relay 气泡两侧 chat 都会推,免得被叫的那侧看不到「另一个群的 agent 找上门了」这件事。典型用法:daily 语料链的 peer 产出 corpus,直接 `send_peer("sanitizer-ingest")` 交给 sanitizer 群里的 `#sanitizer-ingest` 继续。

## [1.2.19] - 2026-08-19

### Fixed
- `approval`: `.claude/**` 守卫退出 `mustCard` 语义——守卫要的不是「强制发卡」而是「allow 之后有人去按 CC 原生框」,⏱ 自动过窗口恢复生效。排掉 `.claude/worktrees/**`(整棵检出代码树,非配置面）但 worktree 自己的 `.claude/` 仍拦截。错误出口保持 `ask` 降级;收尾按 sessionId 串 promise 链防并发代按;必发卡按钮面改由 `forceSingle` 决定。

## [1.2.18] - 2026-08-19

### Fixed
- `approval`: 时间窗按钮不再是红色(企微 `style:3` 渲染成红色,与「放行」语义相悖),改 `style:1`(蓝)+ 文案 `⏱10h自动过` 点明语义;单条卡与批量卡同步。

### Changed
- `keepalive`: **每轮心跳都发完整指令**,不再从第二轮起缩成裸 `ping`。缩写省下的那点 cache-write 换来的是不确定的回复 —— 裸 `ping` 在模型看来只是一次普通提问,爱怎么答怎么答,而任何非 `pong` 的回复都会被当成真实活动:心跳被"解吞"发进企微、`lastRealMs` 重新锚定、轮次计数清零。完整指令每轮重述,回复才稳定是 `pong`。`keepaliveStamps` 仍认裸 `ping`(旧 transcript 里还留着)。

## [1.2.17] - 2026-08-17

### Fixed
- `approval`: 「✅总是」补两处遗漏。① **批量卡上也给这个按钮** —— 合流的成员是同一个工具的 N 次调用,单卡有「总是」而批量卡没有,只能先等它拆开或逐个点,机制在最需要的场景(一串同类调用)恰好用不上;逐位成员各自走一遍规则生成,已被现有规则覆盖的不重复加,结果与逐个点「总是」一致。② **`.claude/**` 守卫生效时不生成规则**,并说明原因。此前这种卡上点「总是」会存下一条**永远被守卫压过**的死规则,更糟的是万一日后关掉守卫,这条 allow 就把静默死锁原样放回来(不发卡 + pane 无限期阻塞);现在只做一次性放行,并回执讲清「那个原生确认框只有在你点过卡之后才能被代按,免审就等于回到死锁」。同理,「提炼不出可靠字面规则」的兜底提示也不再在守卫卡上误报。
- `ws`: WS 握手加 15s 超时,防止睡眠唤醒后 TCP 通但 upgrade 不返回导致重连链悬挂、对企微永久失聪(补 #7 之外的第二条失聪路径)。

## [1.2.16] - 2026-08-12

### Changed
- `approval`: **审批卡信息架构重排** —— 解决的是「看不出这张卡要批的是什么」。旧布局把 `🔐 授权 · <工具名> · <目录>/` 放在一级标题(26 字里有 8 个花在固定的锁图标与「授权」二字上),真正决定要不要点的**命令主体**却挤在描述行里被截断;并行跑多个会话时,几张卡长得一模一样,分不清是谁在请求。新布局按「谁在问 > 想干什么 > 具体命令 > 上下文」重排:一级标题放 Claude 自己写的 `tool_input.description`(它回答"想干什么",是 26 字里最值钱的内容;没有 description 的 `Read`/`Write`/`Edit` 回落「工具 · 目录/」,因为路径在下面引用区里已经有了);**命令主体搬进 `quote_area`**、无标题、整块可点进详情页;`horizontal_content` 放「上文」(最近一条用户消息)与**为什么要人来点这一下**(危险卡显示命中的名单规则,普通卡显示「审核」行 —— 即这条命令是**哪一段**没被 `allowRules` 覆盖,能算出规则时直接显示「点总是会生成什么」;没配任何规则时这行不显示,免得变成每张卡都有的噪声)。
- `approval`: **卡片标题带会话名** —— 一个 chat 里并行跑多个会话时,`⏱`/`✅` 点下去到底作用在谁身上是靠猜的。会话名按可靠度降级取:`#tag`(企微侧显式命名,人起的名最准)→ Claude Code 自己的会话名(`~/.claude{,-internal}/sessions/<pid>.json` 注册表的 `name`,即 CC 会话列表显示的那个;只覆盖活着的进程,而发卡时会话必然活着 —— hook 正是它触发的)→ transcript 首条用户消息首句 → sessionId 尾八位。发卡时算好写进 pending,已决卡重渲染直接复用(点击事件回调里拿不到 `transcript_path`,现算不出来)。
- `approval`: **长命令看全文的两条路径**,都挂在卡片自己身上,不再默认额外推一条全文消息:引用区整块可点 → 详情页(有高亮,PC 端好用);右上角「⋯」→「📄 展开完整命令」→ 按需在群里发全文(不跳出企微,手机端可用,按 1800 字/条分块)。起因是手机端客户端**实测只渲染 `quote_area` 前 2~3 行**,长命令在卡上根本看不完,而无条件先发一条全文消息会把群刷满。新增 `approval.cardQuoteMaxChars`(默认 1200;企微未公开 `quote_text` 上限,发送失败自动缩到 600 重试一次)与 `approval.fullCommandPreludeChars`(默认 **0 = 关闭**旧的无条件前置;设正数可恢复,用于客户端不渲染 `action_menu`、或就是要全文无条件落在群里的场景)。

### Added
- `approval`: 审批卡新增 **「✅总是」按钮** —— 由本次调用生成 `allowRules` 规则,热生效 + 追加写回 `config.jsonc`(对齐 Claude Code 原生弹窗的 Always allow)。解决的是三层规则的**上手断层**:规则机制有了,但要用就得离开企微、打开 `config.jsonc`、自己想清楚该写 `Bash(git log *)` 还是 `Bash(git *)` —— 于是绝大多数人一条都不配,继续每次都点卡。现在在手机上点一下就长一条规则出来。生成器 `alwaysAllowRulesFor`(已随三层规则合入,此前没有调用方)负责挑安全的字面前缀。三种「点了但不该存」的情况都**明确回执、不静默**:① 命中 `askRules` → allow 永远被 ask 压过,存了是死规则,提示要改 `askRules`;② 命中危险名单 → 提示只能用 `danger.allowPatterns`;③ 提炼不出可靠前缀(含 `$()`/反引号、未闭合引号、异形段首)→ 说明**具体是哪一种**成因后一次性放行。规则生成用未脱敏的原始 `toolInput`(`sensitiveArgRedact` 改写过的副本会生成匹配不上真实命令的前缀)。写盘失败只 `warn`、不回滚内存,本次点击的意图不因文件权限问题丢失。
- `init`: **一次性导入 Claude Code 的 `permissions`**(`wezard init` 交互确认,或 `wezard-init --import-claude-permissions [settings.json]` 随时增量重跑)。三层规则的语法本来就是 Claude `permissions` 的子集,而用惯 Claude Code 的人手上早就攒了几十条 allow/ask/deny —— 让他为了少收几张卡再手抄一遍 `config.jsonc` 是没必要的门槛,而门槛的实际后果是规则一条都不配、继续每次都发卡。`mapClaudePermissions` 逐条映射,引擎不支持的条目(如带 `//` 路径限定的 `Read(~/foo/**)`、`WebFetch(domain:*)`)**跳过并计数报给用户**,不静默丢。写回走 `appendUnique`,重复导入不会堆出重复规则。刻意只读一次、不做运行时耦合:Claude 的配置格式演进不会影响 daemon,导入后 `allowRules` 由 wezard 自管。
- `approval`: **`.claude/**` 写守卫** —— 补一个架构级的静默死锁。改动 Claude 自己的配置面(`settings.json` / `hooks` / `skills` / `commands` …)时,Claude Code 会立起它**自己的**原生确认框,而那个框**不经过 PreToolUse hook**:企微端既看不到也点不到,pane 就无限期阻塞,用户只看到会话「卡住了」。配了 `allowRules` 之后更糟(尤其从 Claude `settings.json` 批量导入的宽规则):规则一放行 = 不发卡 + pane 静默阻塞,连「有东西在等确认」这个信号都没有。现在命中 `.claude/**` 写、且该 session 有**活 pane** 可代按时强制发卡(压过 `allowRules` / ⏱窗口 / 会话缓存),用户点「允许」后 daemon 去 pane 上把那个框按掉。代按的边界刻意收得很窄——它做的是「完成用户已经作出的决定」,不是替他决定:只认标题形如 `Do/Would/Should you …` 的**权限**确认框(`/model` 选择器、plan review 同样是 modal 但语义完全不同,一律不碰)、只挑**裸 `Yes`**、永不选 `Yes, and don't ask again` 这类放宽后续权限的选项、只取屏上**最后一组**连续编号选项(屏上残留的旧确认不会被误按)。挑不出可信选项就不按:Esc 取消本次调用,再把原因作为一条用户消息注入会话,模型收到的是「这条路走不通 + 该怎么绕」,等价于预拦截 `deny + reason`。没有活 pane(headless / 未镜像的本地会话)则**完全不介入**——那种情形用户就在键盘前,自己按掉即可。新增配置 `approval.claudeConfigGuard`(默认开)/ `claudeConfigModalWaitMs`(4s;CC 要等 hook 进程退出才渲染那个框,所以代按只能在响应发出之后 fire-and-forget 地轮询等它出现)。路径判定 `claudeConfigWrite` 是纯函数:认 `Write`/`Edit`/`NotebookEdit` 的 `file_path` 与 Bash 重定向目标,按**路径段**比较(`.claude` 必须是完整一段,`foo.claude/x` 不算),软链目标也解析,`Read` 不拦。新增 36 例测试(`tests/claude-config-path.test.ts` 20 例 + `tests/modal-pane.test.ts` 补 6 例选项解析与代按挑选)。
- `approval`: **Claude-Code 风格的三层规则** `allowRules` / `askRules` / `denyRules`(语法子集见 `shared/allow-rules.ts`),判定链 `denyRules → danger → askRules → allowRules → ⏱窗口 → sessionCache → 发卡`。补的是 `matcher` 的粒度缺口:`matcher` 只认工具名,而「`git log` 免卡、`git push` 必卡」这类区分只能按**命令前缀**表达。支持 `Read` / `mcp__server__tool` / `Bash(git status)` 精确 / `Bash(git log *)` 前缀 / `Bash(npm run test:*)` 冒号前缀。安全语义都在纯函数里,可单测:复合命令按 `&&` `;` `|` 逐段校验(**任一段没被覆盖就发卡**,`ruleMatchesAny` 对 deny/ask 则是任一段命中即生效)、反斜杠转义的分隔符不切、引号内的分隔符不切、heredoc 体不参与匹配、段首 `VAR=value` 前缀剥掉后再比、fd 重定向里的 `&` 当数据而非后台符、命令含 `$()`/反引号一律不命中(展开结果静态判不了)。`AskUserQuestion` / `ExitPlanMode` / `EnterPlanMode` 在引擎内部硬保护,写了规则也不放行。**危险名单(`danger`)与 `askRules` 同层、排在 `allowRules` 之前**:否则一条 `Bash(git *)` 这样的宽 allow 规则就能让整份危险名单失效;`danger.skip` / `danger` 模式的早退也不再顺带关掉用户显式配的 `askRules`(`dangerEarlyExit`)。`fallbackOnError:"allow"` 的降级保护同样从「只护 danger」扩到「护住一切必发卡的请求」—— 否则 daemon 挂掉时 `askRules` 反而失效。新增 88 例单测(`tests/allow-rules.test.ts` / `tests/deny-reason.test.ts` / `tests/danger-early-exit.test.ts`,独立可执行,无 runner 依赖)。
- `inbound`: `/kill` —— 结束会话并移除 pane。先 Esc(给 CLI 一拍收尾 transcript 的时间)再 `kill-pane`,随后 detach 并**丢掉持久化绑定**:留着的话下一条消息会走死 pane 的 `--resume` 自愈把它原地复活,与 `/kill` 语义相反。之后该聊天的下一条消息自动新开会话。与 `/stop` 一样按 `#tag` 路由(`/kill #docs` 只干掉那个兄弟会话)。
- `chat details`: turn 记录带上运行时 `cwd`(取自 pane 的 `runningCwd`,而非全局 `wrc.cwd`),详情页两处呈现:顶栏 `📁 …/尾两段`(hover 出全路径)、侧栏会话行末尾 `📁 <目录名>`。同一 chat 的兄弟会话可以各跑各的目录(主仓 / worktree),不标出来光看 `#tag` 分不清谁在哪。
- `keepalive`: stall 恢复,**纯规则判定、不让 model 自判**。transcript 末轮是 synthetic API-error/limit 行(`API Error: Connection closed mid-response` / `You've hit your session limit`),或空闲 pane footer 出现错误横幅 —— 判定某轮因限流/接口失败中途夭折,ping 改发 `resumePing`(直接“继续未完成的工作”)。新增 config `keepalive.resumeOnStall`(默认开)/ `keepalive.resumePing`;`transcriptStalled` / `paneIsStalled` 两个规则信号。
- `inbound`: **引用即路由** —— 直接「引用」某个 `#tag` 会话的气泡来回复,等价于手打该 tag,消息投递到那个会话;且 quote 内容**不再进 prompt**(被引用的那条本就在目标会话自己的上下文里,重复贴入纯属污染)。识别依据是出站气泡的 `emoji #tag` 头(`parseTagHeader`,裸头与 chat-detail 链接头 `[🦊 #fix](url)` 两种形态都认,分片序号 / `← View chat details` 一并算作头),用户自己发的行首 `#tag` 消息同样可被引用。引用之外自己打的 `#tag` 优先级更高。配套规则:引用内容若**已在目标会话 context 尾部**(先比对最近一条出站气泡,miss 再归一化匹配目标 transcript 末 12 轮)则只保留这层路由绑定、正文丢弃;不在(跨会话转发 / 引同事的消息 / 目标已 `/clear`)才照旧渲染成引用块。text / image / mixed 三条入站路径统一走 `composeInbound`,图片消息因此也能被引用路由到 `#tag` 会话。
- `keepalive`: ping 的 assistant 回复只要不是纯 "pong" 即视为 real activity —— 从 chat 里放行(un-swallow)整轮续跑内容,并重锚 `lastRealMs` / 重置 round 预算。据此“回复是 pong 还是其他内容”刷新真实输出时钟。

- `chat details`: **graph 归因**。graph 注入的每一轮在 turn 记录上落一枚 `origin`(`runId` / 轮次 / 步序 / `fromTag`),随 `details.jsonl` 持久化 —— graph run 本身是内存态,一次 reload 就没了,归因必须自己过夜,否则重启后历史 turn 说不清是谁派的。三处呈现:turn 卡片顶部的紫色归因条(与上下文断点条并列,两者可同时出现)、侧栏会话行的 `🕸 runId` 徽标(区分「有人在跟 #fix 说话」和「graph 在喂它」)、以及主区顶部的运行条 `🕸 id · 🦊#fix → 🐢#review · ⟳ 轮 3/5`,当前步高亮、可点击跳转。**不画节点图**:`steps` 结构上不可能分叉,拓扑永远是一条线,画出来是纯装饰;真正有信息量的时间维度已经由 thread 承载。运行条的流水线从这些 `origin` 反推(`graphSummaries`),不依赖内存 run,svr 侧同样成立。

### Changed
- `peers`: **peer 之间的对话改从 transcript 读,不再抓 tmux pane**。`peek_peer` 返回 `dialog` —— 目标会话最近 N 轮的真实对话(`▸` 问 / `◂` 答),来自它自己的 jsonl:整条消息(pane 会被视口截断)、无 ANSI / TUI 噪声、天然带 role。pane 只保留两个它独有的职责:`busy` 判定,以及 transcript 尚未可读(没绑定 / 刚 `/clear`)时的兜底 `pane` 字段。入参 `rows` → `turns`(1-40,默认 6)。新增 `renderDialog`(纯函数)/ `peekTurns`(bridge)。
- `peers`: **agent↔agent 的问询与回复下发到 chat**。`send_peer` 注入成功后推一条 `<发起方> → <目标>` 气泡带原文,`wait_peer` 等到目标真正空闲后推一条 `<目标> → <发起方>` 带回复(超时不推 —— 半截的回答不是答案)。此前这些流量只发生在两个没人盯着的 pane 里。
- `graph`: 步骤气泡带上流量本身 —— `▸` 本步注入的 prompt、`◂` 该节点的回复,而非只有 `2/6 ✅`。
- `peers`: `keepaliveStamps` 判据从「紧跟 ping 的 assistant 回复一律算 keepalive」收窄为「仅纯 pong 算 keepalive」,配合 stall 恢复识别续跑;签名改收 `pingSigs: string[]`(同时匹配普通 ping 与 resume ping 的注入 user 行)。
- `peers`: `/peers` 输出重排 —— 摘要文本剥掉 markdown 活跃字符(反引号/星号/竖线,来自 transcript 的原文会被 WeCom 渲染成代码块而撕裂排版),同值字段(项目目录 / CLI)上提到标题行,条目之间空行分隔。
- `mirror`: 移除 `broadcastTo` 转发管道 —— `base#tag` 与 `base` 剥出来是同一个 WeCom chatid,节点自己的推送本就落在这个会话里,再广播一次纯属重复。

### Removed
- `keepalive`: 移除 KeepAlive 心跳通知(`keepalive.notify` 配置项及第 1/3/6 轮的 `KeepAlive n/N · ~Nk` 气泡)。保活是纯后台省钱动作,群里不需要看见;完整 ping/pong 仍留痕在 chat detail 时间线。

### Fixed
- `sessions`: **`/sessions` 扫描的子进程加硬超时**(`SCAN_CMD_TIMEOUT_MS`,15s)。`session-scan.ts` 的 `runCmd` 是上一轮 tmux 超时收敛漏掉的第四条 exec 路径 —— 它跑 `lsof` 和 `tmux`,两者都能无限期挂住:`lsof` 卡在僵死的网络挂载上、tmux server wedged。挂住的后果比丢一次扫描严重得多:`/sessions` 永远不回答,调用方的 `await` 也永远不返回。现在到点 `SIGKILL` 并退化成「没有输出」,与其它失败路径同一处理。
- `approval`: **`askRules` 的「必须单独确认」补齐到所有旁路**。上一版只在判定链上让 `askRules` 压过 `allowRules` 与 ⏱窗口,但发卡之后的五条旁路仍然只认 `danger`,于是命中 `askRules` 的卡照样会被绕过:① 另一张卡的「⏱ N 分钟全过」sweep 把它一并放行(`resolvePendingsByChat` 只排除 `p.meta.danger`);② 与其它请求合流成批量卡,被「全过」一次点掉;③ 命中会话缓存直接放行;④ 用户在这张卡上点「本会话都放行」/「N 分钟全过」时落缓存、开窗口;⑤ daemon 超时/断线时走 `fallbackOnError:"allow"` 静默放行(`fallback` 的第三参已改名 `forceSingle`,但传进去的仍是 `danger`)。现在这五处统一判 `mustCard`(危险名单 ∪ `askRules`),并把「必须单独点」作为 `forceSingle` 落到 pending meta 上 —— `danger` 字段退回只负责卡片渲染(⚠️ 标题 + 去掉「全过」按钮)。
- `mirror`: **tmux 调用全部收敛到一条 exec 路径并加硬超时**(`TMUX_TIMEOUT_MS`,默认 10s,`WEZARD_TMUX_TIMEOUT_MS` 可调,0 关闭)。此前 daemon 里有三份手写的 `spawn("tmux", …)`(`spawn-tmux.runTmux`、`mirror-bridge` 模块级 `tmuxRun`、`startMirror` 内又一个同名局部 `tmuxRun` 遮蔽了它),全部无超时:tmux server 一旦卡住,调用方永久 pending 且零日志 —— 一条入站消息建了 pane,随后 `tmuxPaneAlive` 再也不返回,该会话的 inject 队列被僵尸 job 锁住,那个聊天从此彻底静默,只能重启 daemon。现在三处合一,超时用 `SIGKILL`(卡在 wedged server 上的 tmux client 不理 `SIGTERM`)并以普通失败态 resolve,所有现存 `if (!r.ok)` 分支照旧生效;超时必留痕,由 daemon 启动时注入的 reporter 打 `warn`。`load-buffer -` 这类 stdin 变体一并走同一路径。
- `mirror`: **inject job 加 watchdog**(`INJECT_JOB_TIMEOUT_MS`)。job 链上每个 `await` 原本都是无界的,超时后队列不再释放;现在到点释放队列、告知用户,并 bump `injectGen` 让僵尸 job 醒来后不再往 pane 里贴。job 起手先打一行 `inject job start`,下次卡住能定位到具体步骤。
- `mirror`: **`/stop` 改为先收口、后 Esc**。旧实现先探 pane、探不到就早退 —— 而 tmux 本身就是卡住的那一环时,用户手上留着一个关不掉的 `…` 气泡和一条谁也过不去的 inject 队列。现在先做与 tmux 无关的部分(bump `injectGen`、清 inject 队列、收掉所有挂起气泡/stream),再尽力 Esc;Esc 失败只报告不致命,并带上收了几个气泡。只想按 Esc 的调用方(不传 `opts`)行为不变。
- `mirror`: **拒绝往 modal 状态的 CLI picker 里注入**。权限确认框 / `/model` 选择器 / plan review 这类 modal 会把粘贴进去的文本吃掉,并把随后的 Enter 读成「确认当前高亮项」—— 一条 WeCom 消息就此丢失,同时替用户点掉了一个他没看到的确认框。最典型的触发场景:编辑 `.claude/**` 下任何文件都会让 Claude Code 立起它自己的「allow Claude to edit its own settings」确认,而那个框**不过 PreToolUse hook**,daemon 完全不知情,pane 就一直阻塞在那里。现在注入前先 `capture-pane -p` 看一屏,判定为 modal 就带标题原因返回失败(消息不丢,用户可去 tmux 处理或 `/stop` 后重发)。判定放在**按后端分流之前** —— 每个 CLI 后端都有自己的原生确认框,放到分流之后只保护得住 claude 一家;图片注入路径同样先过这道判定。判据刻意保守:必须同时出现「编号选项行」与「`Esc to cancel` footer」两个信号才算 modal(误判会挡住正常消息,比漏判一个冷门布局更糟);capture 只取当前屏、不进 scrollback(用户答完的旧确认会永远留在 scrollback 里,带上它会把镜像永久堵死)。逃生开关 `WEZARD_MODAL_GUARD=0`。
- `ws`: **重连上限改为无限**(`MAX_RECONNECT = -1`,走 SDK 原生无限重连 + 30s 封顶的指数退避)。有限次数是个陷阱:睡眠唤醒 / 切网时 DNS 短暂 `ENOTFOUND`,10 次重连累计只撑约 2 分钟就耗尽,此后 SDK 抛 `WSReconnectExhaustedError` 彻底躺平 —— 进程活着、`/healthz` 的 `ok` 仍为 true、HTTP 端口也通,但对 WeCom 完全失聪:发不出卡、收不到按钮点击,且不会自行恢复(DNS 早已好了也没用)。两个 fail-fast 边界不受影响:认证失败走独立的 `MAX_AUTH_FAIL` 计数器;被服务端踢下线(别处建了新连接)时 SDK 置 `isManualClose` 后本就不重连,不会两个 daemon 互抢。
- `mirror`: **`/clear` 轮换的会话认领必须可归属到本 pane**,否则拒绝认领。轮换后的 transcript 只有「首条 user 行是 `/clear`」这一个特征,每个 chat 的 `/clear` 都长这样;同一 project dir 下两个 chat 先后 `/clear` 时,先起的 watcher 会把后者刚轮换出来的会话抢走 —— 两个 chat 就此永久串线(还会写盘固化):A 的消息注进自己的 pane,产出却镜像到 B 的会话里。现在目录扫描只在「候选唯一 且 窗口内本目录没有别的 chat 也在 `/clear`」时才认领,否则退让给下一条注入的文本指纹(`armSilentForkRebind`,pane 级确定)来定位。`/clear` 的登记发生在 inject **之前**,以便更早武装的兄弟 watcher 能看见重叠。
- `mirror`: `injectText` 成功后清除 `muteUntilInject` / `justSpawned`。graph 拉起的节点由 `newSession` 置静音、再由 `injectText` 注入,而清除静音只写在 WeCom dispatch 路径上 —— 结果 `onItem` 永远在静音分支早退,节点既不推气泡也不 `recordTurnStart`,在 chat 列表和 chat 详情里完全不存在。

## [1.2.15] - 2026-08-07

### Fixed
- `session-label`: `withTagHeader` 对无 tag 默认会话不加前缀 —— approval vote 回执、plan 卡、error 等经 `withTagHeader` 发送的消息无 🧙 标识。现统一为所有 target 都带前缀(tagged → `emoji #tag`，untagged → `🧙`)。

## [1.2.14] - 2026-08-07

### Changed
- `mirror`: 所有 emoji+tag 前缀和 detail link 文本去掉反引号包裹 —— WeCom markdown 里 backtick 渲染为代码样式,与可点击链接视觉冲突。
- `mirror`: 默认会话（无 tag）所有推送现统一带 🧙 前缀,不再裸发。
- `mirror`: KeepAlive 通知也带 chat detail 链接(使用 `keepaliveTurnId`)。

### Fixed
- `peers`: `keepaliveStamps` 对 ping 后紧跟的 assistant pong 未识别为 keepalive 回复,导致 pong 误算为 real activity 重置 round。

## [1.2.13] - 2026-08-07

### Added
- `mirror`: 所有 standalone 消息和 finalized bubble 的 emoji+tag 前缀现在是可点击的 chat detail 链接(有活跃 turn 时);无 tag 的默认会话使用 🧙 作为链接图标。

### Fixed
- `inbound`: `/stop` 成功时不再回复消息,仅失败时通知。
- `mirror`: KeepAlive 通知只在第 1、3、6 轮发送(不再每轮都推)。
- `mirror`: KeepAlive 轮次计数修复 —— ping/pong 结算后的 mtime 抖动不再误触 `grewSinceLast` 重置 round(添加 30s `settledAt` 宽限窗口)。
- `mirror`: chat detail 链接格式统一:emoji+tag 包在反引号内作为链接文本,🧙 作为无 tag 会话的默认图标,"← View chat details" 变为普通文本提示。

### Fixed
- `mirror`: inline peer spawn(`#tag` 首条消息自动建会话)和 graph runner spawn 不再下发 "📂 当前项目" 提示消息到 WeCom — `newSession` 新增 `silent` 选项,隐式路径传 `silent: true` 跳过 `pushProjectInfo`;显式 `/new` 仍正常推送。

## [1.2.11] - 2026-08-06

### Added
- `mirror`: `muteUntilInject` — 新 spawn 的 session 在首次 inject 成功前静默初始输出(greeting/system),避免 `#tag` 自动建会话时把 CLI 开场白推到 WeCom。
- `mirror`: `earlyTimer` (3s) — inject 后若 CLI 在 3s 内无任何产出,先把 loading 气泡收成 chat detail 链接;首条 item 到达即清除,不影响正常流。

### Fixed
- `mirror`: `muteUntilInject` 在 inject 失败路径未清除(return 在赋值前),导致会话永久静默。
- `mirror`: `earlyTimer` 对排队中的 turn 错引 `a.briefBubble`(仍指向前一个活跃 bubble),改为闭包捕获的 bubble ref。

## [1.2.10] - 2026-08-06

### Changed
- `mirror`: 保活默认轮次 8 → 6(桥接窗口 ~34min → ~26min)。
- `mirror`: 保活连击瘦身 —— 一轮连击里只有第一发 ping 带完整指令文案,后续轮次只注入 bare `ping`(指令已在上下文里,cache-write delta 更小、pane 更干净)。`keepaliveStamps` 同步识别 bare `ping`,否则连击轮会被误判为真实活动、重置轮次并自我续命。

### Fixed
- `mirror`: TUI 里手打 `/clear` 后保活仍继续 —— `migrateAttachment`(所有会话轮换的唯一漏斗)此前不碰保活态,旧时钟接着 ping 空上下文;且其 `store.set` 整记录替换会把 dispatch 刚落盘的 `/clear` 暂停从盘上抹掉(reload 后复活)。现迁移目标判定为真清空时像 `/stop` 一样置 `keepaliveOff` 并清时钟,暂停态随迁移记录一并落盘。

## [1.2.9] - 2026-08-05

### Fixed
- `mirror`: `/clear` 与 `/new` 现和 `/stop` 一样暂停保活。二者都把会话重置为空壳 —— 缓存里没有任何真实上下文可保温,继续 ping 只是白烧预算(此前 `/new` 建会话不暂停、`/clear` 在 dispatch 里反而**解除**了暂停)。`/new` 在 `newSession` attach 后落停,`/clear` 在 dispatch 里改为暂停而非解除;停顿持久化,下一个真实 turn(WeCom inbound,或 pane 过 grace 后转 busy)自动恢复。

## [1.2.8] - 2026-08-05

### Fixed
- `inbound`: `#tag` 后夹一个不可见格式字符(输入法/复制常带的 `U+2060` word-joiner、零宽空格等)时,tag 右边界断言 `(?=\s|$)` 落空 —— 整个 `TAG_RE` 不匹配,`parseTag` 返回空 tag,消息被误路由到**默认会话**而非目标 `#tag` 会话。右边界字符类补入零宽(`U+200B–200D`)、word joiner(`U+2060`)、BOM(`U+FEFF`),与空白同等视作合法分隔。

## [1.2.7] - 2026-08-01

### Fixed
- `mirror`: KeepAlive 轮次计数卡在 `1/N` —— 1.2.6 把调度改用消息时钟后,`grewSinceLast`(轮次重置 + 真实活动重锚的判据)错用了 `lastMs`(**含保活自己的 ping/pong**)。心跳的 ping+pong 也是消息 turn,会推高 `lastMs`,在交互式会话里 pong 隔几秒才生成、时序有缝,导致下一个非 pinging tick 把自己的心跳误判为「新活动」而把 `round` 归零,`n` 永远爬不过 1。改为只看 `lastRealMs`(已滤除 ping/pong):纯保活期间轮次正常累加 `1/N→2/N→…`,只有真实对话才重置。

## [1.2.6] - 2026-07-31

### Fixed
- `mirror`: **保活调度彻底改用消息 turn 时间戳,不再依赖文件 mtime**。Claude Code 每轮会往 jsonl 追加 `file-history-snapshot` / `ai-title` / `mode` / `permission-mode` 等**无 `timestamp` 的非消息行**,它们顶高文件 mtime 却不代表任何真实对话。旧逻辑 `idleSinceTouch` / `realIdle` / `grewSinceLast` 全建立在 `statSync(mtime)` 上,于是这些元数据写入被误判为「活跃」:`grewSinceLast` 每周期重锚 `realMtime` 使 `realIdle` 永不过 `maxIdleSec` —— **真实对话在数小时前的死会话被无限保活**(daemon 每次启动/reload 还会把「末行是 ping」的死会话集体复活)。现新增 `keepaliveStamps` 从消息 turn 取 `lastMs`(最后一条消息=缓存触碰)/`lastRealMs`(最后一条非 ping/非 pong=真实空闲基准),文件 mtime 仅作「要不要重读 tail」的廉价闸门;tail 内无真实 turn ⇒ 判死。移除 `realMtime` 字段;`n/N` 分母按实际 cadence(`ttlSec-marginSec`)floor 计。
- `mirror`: `/stop` 暂停保活现**持久化**(`keepaliveOff` / `keepaliveOffAt` 写入 `mirror-attachments.json`),daemon reload / launchd 重启不再复活一个被用户显式静音的会话;真实 inbound 或 busy-resume 解除时同步落盘。

## [1.2.5] - 2026-07-31

### Added
- `mcp`: 新增 `config_set` tool — 在对话中直接读写 wezard 配置（allowFrom、审批时间窗口、danger skip、cwd、log level 等），无需手动编辑 config.jsonc。

## [1.2.4] - 2026-07-31

### Changed
- `mirror`: KeepAlive 心跳通知带回轮次计数 —— 从 `KeepAlive · ~Nk tokens` 恢复为 `KeepAlive n/N · ~Nk tokens`。`n` = 上次真实（非 ping）活动以来的 ping 轮数（真实活动重新锚定时归零），`N` = 当前配置下缓存冷掉前的最大保活轮数。1.2.1 随 `maxPings`→`maxIdleSec` 一并去掉的 `n/max`，现按需求改以派生分母回归。

## [1.2.3] - 2026-07-31

### Fixed
- `mirror`: `/stop` 暂停保活的第二个自我唤醒漏洞 —— 1.2.0 给 busy-resume 加了 grace，但 `grewSinceLast`（transcript 增长）分支没有守卫。`/stop` 的 Esc 打断会产生尾部写入（被中断的 turn + 残留 tool result），下一个 tick 把它当成真实活动立刻解除刚请求的暂停，KeepAlive 照常触发。现在纯 transcript 增长不再解除 `/stop` 暂停，只有 busy pane（过 grace）或 WeCom inbound 能恢复。

## [1.2.2] - 2026-07-31

### Fixed
- `mirror`: tagged-only chat（无 untagged 默认会话）中 `enter` 设置 cwd 后 `/clear` 不触发目录切换 — `chatCwdFallback` 只读 base principal，base 不存在时返回空；dispatch 和 newSession 现在都 fallback 到 caller 自身的 `pendingCwd`。

## [1.2.1] - 2026-07-31

### Changed
- `mirror`: 保活调度改为**锚定最后一次真实（非 ping）对话** — 保活自己的 ping 不再刷新空闲锚点，因此不会把一个搁置很久的会话误判成活跃而无限续命。真实空闲超过 `maxIdleSec`（新配置，默认 = `ttlSec` 5min）即停手，让缓存自然冷掉；reload 时若 transcript 末轮是自己的 ping，则视作早已空闲、不重新烧热。配置项 `maxPings` 移除，替换为 `maxIdleSec`（保活功能在 1.2.0 刚发布，此为随即修正）。聊天心跳去掉 `n/max` 计数，只显示 `❤️ 保活 · context ~Nk tokens`。

## [1.2.0] - 2026-07-31

### Added
- `mcp`: 事件订阅/广播全面 MCP 化 — 新增 `subscribe_topic` / `unsubscribe_topic` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` / `list_topics`,直接对 AI 说人话即可订阅/广播/定时。
- `mcp`: 新增 `handoff` tool — 原地把一个 pane 的会话交接给全新会话。
- `mirror`: prompt-cache 保活心跳 — 空闲 pane 在缓存过期前廉价续命；心跳记入 chat detail，留痕含真实 cache-read usage。
- `approval`: 新增 `danger.skip` — 命中危险名单也免卡直接放行。

### Changed
- `mirror`: `/stop` 暂停保活 + 明确终止语义。

### Removed
- **BREAKING** `topics`: 移除订阅/广播的 IM 文本命令(「订阅」「广播」「每天…广播」「取消广播」「订阅列表」「广播列表」)及 `/skill-b`,全部改由 MCP 工具驱动。`POST /publish` 外部触发接口保留。

### Fixed
- `mirror`: `/stop` 暂停保活失效 — 保活自身的 ping 会让 pane 变 busy，而 busy 被当成「真实活动」立刻解除暂停；改为对 busy-resume 加 30s grace 窗口，只有暂停后真正的新一轮才恢复（WeCom dispatch 仍即时恢复）。
- `sync`: 为 CodeBuddy targets 把 MCP entry 写入 `mcp.json`。
- 发布包补齐 svr plist/service 模板。

## [1.1.4] - 2026-07-31

### Fixed
- `approval`: reload 续接 — 重启时挂着的审批不再 fallback 成本地权限框。

## [1.1.3] - 2026-07-31

### Added
- `approval`: 新增 `danger` 模式 — 只对危险名单发卡,其余静默放行。

### Changed
- `mcp`: 重命名 `cd` 工具为 `enter` — 更贴合实际语义。

## [1.1.2] - 2026-07-30

### Added
- `approval`: codebuddy 下 `AskUserQuestion` / `ExitPlanMode` 由 mirror 接管下发卡片。
- `detail`: detail/chat url 参数加 `ww_uniq=1`。

## [1.1.1] - 2026-07-30

### Changed
- `approval`: 危险名单移除普通 `git push` — 仅保留强推等不可逆操作。

## [1.1.0] - 2026-07-30

### Added
- `chat`: 上下文断点可见化 — `/clear`、`/new`、会话轮换在线程里显式分隔。

## [1.0.0] - 2026-07-29

首个稳定版:项目更名 `weclaude` → `wezard`。

### Changed
- **BREAKING**: 项目更名 `weclaude` → `wezard`,新增 `wezard migrate` 迁移命令。
- `init`: 本地拉起 svr,详情/会话链接默认走内网 IP。

### Added
- `approval`: 危险操作名单 — 命中者强制逐次单独审批。
- `session-scan`: 通过 `ps` + `lsof` fallback 支持 macOS。

### Fixed
- `chat`: 修复移动端滚动 — `.main` 加 `min-height:0`,叠加 overscroll + safe-area。

[Unreleased]: https://github.com/guxi11/wezard/compare/v1.2.31...HEAD
[1.2.31]: https://github.com/guxi11/wezard/compare/v1.2.30...v1.2.31
[1.2.30]: https://github.com/guxi11/wezard/compare/v1.2.29...v1.2.30
[1.2.29]: https://github.com/guxi11/wezard/compare/v1.2.28...v1.2.29
[1.2.21]: https://github.com/guxi11/wezard/compare/v1.2.20...v1.2.21
[1.2.20]: https://github.com/guxi11/wezard/compare/v1.2.19...v1.2.20
[1.2.19]: https://github.com/guxi11/wezard/compare/v1.2.18...v1.2.19
[1.2.18]: https://github.com/guxi11/wezard/compare/v1.2.17...v1.2.18
[1.2.17]: https://github.com/guxi11/wezard/compare/v1.2.16...v1.2.17
[1.2.16]: https://github.com/guxi11/wezard/compare/v1.2.15...v1.2.16
[1.2.15]: https://github.com/guxi11/wezard/compare/v1.2.14...v1.2.15
[1.2.14]: https://github.com/guxi11/wezard/compare/v1.2.13...v1.2.14
[1.2.13]: https://github.com/guxi11/wezard/compare/v1.2.12...v1.2.13
[1.2.12]: https://github.com/guxi11/wezard/compare/v1.2.11...v1.2.12
[1.2.11]: https://github.com/guxi11/wezard/compare/v1.2.10...v1.2.11
[1.2.10]: https://github.com/guxi11/wezard/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/guxi11/wezard/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/guxi11/wezard/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/guxi11/wezard/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/guxi11/wezard/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/guxi11/wezard/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/guxi11/wezard/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/guxi11/wezard/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/guxi11/wezard/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/guxi11/wezard/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/guxi11/wezard/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/guxi11/wezard/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/guxi11/wezard/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/guxi11/wezard/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/guxi11/wezard/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guxi11/wezard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guxi11/wezard/releases/tag/v1.0.0
