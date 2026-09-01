# thinkStyle 设计文档

> Brief 模式的子模式：把 reasoning / tool calls / tool results 以 `<think>…</think>` 折叠块实时流入聊天气泡，最终答复跟在 `</think>` 之后。

---

## 1. 配置

```jsonc
// ~/.wezard/config.jsonc → wrc.mirror
{
  "brief": true,          // 前置条件：必须开启 brief 模式
  "thinkStyle": true      // 开关。运行时 flag = thinkStyle && brief
}
```

`shared/config.ts:100-104` 定义 schema。运行时在 `mirror-bridge.ts:1938` 取值：

```ts
const thinkStyle = cfg.wrc.mirror.thinkStyle && cfg.wrc.mirror.brief;
```

两处传入 `startMirrorTail` 的 `TailDeps.thinkStyle`（`mirror-bridge.ts:3307, 3675`），
控制 parser 是否向下游 emit `kind: "thinking"` 和 `kind: "tool_use"`（thinkStyle 下
即使 `includeTools=false` 也会 emit tool_use — 用于 think 流的 `🔧` 行）。

---

## 2. 总体架构

```mermaid
flowchart TB
    subgraph Parser["Parser 层"]
        JSONL["jsonl tail<br/>(transcript 文件)"]
        Parse["解析 content_block"]
        RI["RenderItem"]
        JSONL --> Parse --> RI
    end

    subgraph Handler["Brief Handler 层"]
        HBI["handleBriefItem()"]
        Route{item.kind?}
        HBI --> Route
    end

    subgraph ThinkPath["Think 通道"]
        PT["pushThink(chunk)"]
        BubbleCheck{气泡活着?}
        PT --> BubbleCheck
        BubbleCheck -->|是| ACC["累积到 briefThinking<br/>+ scheduleThinkFlush()"]
        BubbleCheck -->|否| STD["enqueueStandalone(chunk)<br/>3s debounce 合并"]
        ACC --> DST["doStreamThink()<br/>250ms 去抖 + 背压"]
        DST --> RS["replyStream<br/>finish=false"]
    end

    subgraph ConcludePath["结论通道"]
        CBT["concludeBriefTurn(body)"]
        STB["stripTrailingBody()<br/>去重"]
        CBT --> STB
        STB --> BubbleCheck2{气泡还活?}
        BubbleCheck2 -->|是| FBB["finishBriefBubble<br/>think+body, finish=true"]
        BubbleCheck2 -->|否| SR["sendRaw / sendStandalone"]
    end

    RI --> HBI
    Route -->|thinking| PT
    Route -->|tool_use| PT
    Route -->|tool_result| PT
    Route -->|"text (non-final)"| PT
    Route -->|"text (final=true)"| CBT
    Route -->|turn_end| CLOSE["closeBriefTurn()"]

    RS --> WeCom["WeCom 聊天"]
    FBB --> WeCom
    STD --> WeCom
    SR --> WeCom

    classDef parser fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef handler fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef think fill:#FFF3E0,stroke:#E65100,color:#BF360C
    classDef conclude fill:#F3E5F5,stroke:#6A1B9A,color:#4A148C
    classDef wecom fill:#FFEBEE,stroke:#B71C1C,color:#B71C1C

    class JSONL,Parse,RI parser
    class HBI,Route handler
    class PT,BubbleCheck,ACC,STD,DST,RS think
    class CBT,STB,BubbleCheck2,FBB,SR conclude
    class WeCom,CLOSE wecom
```

三层职责明确：**Parser** 只管解析和 emit，**Handler** 只管路由，**Delivery** 分两条管道各自处理 stream 和 standalone。

---

## 3. 与非 thinkStyle brief 模式的关键差异

| 维度 | 非 thinkStyle (默认) | thinkStyle |
|------|---------------------|------------|
| 详情链接 | 每个 turn 开头推 `[🧙](url)` | **全程不发**。`linkedTagPrefix()` 返回空串 |
| 气泡开流 | 立即发 `"…"` placeholder | `streamPending=true`，延迟到首个 content 到达 |
| thinking | parser 丢弃，只写 detail store | parser emit → `pushThink()` 累积到 `briefThinking` |
| tool_use | 按 `includeTools` 决定是否渲染 | 无论 `includeTools`，渲染为 `🔧 [Name compact](url)` 进 think |
| tool_result | 按 `includeToolResults` 走常规渲染 | 渲染为 `↳ 单行摘要` 进 think |
| 非 final text | earlyLinkBubble (收气泡) | `pushThink()` 进 think 流，不收气泡 |
| final text | concludeBriefTurn 走 standalone / 写气泡 | 与 think 拼成 `<think>…</think>\n\n正文` |
| earlyTimer (3s) | 设置 | **不设置**（气泡保持开放等 thinking 流入） |
| 无气泡 turn | 推详情链接 | 保持静默，最终答复走 standalone |

对比流程图：

```mermaid
flowchart LR
    subgraph Default["非 thinkStyle (默认)"]
        D1["开流: 立即 replyStream '…'"]
        D2["thinking → 丢弃"]
        D3["tool_use → earlyLinkBubble<br/>收气泡为详情链接"]
        D4["final text → standalone"]
        D1 --> D2 --> D3 --> D4
    end

    subgraph ThinkS["thinkStyle"]
        T1["开流: streamPending=true<br/>延迟到首内容"]
        T2["thinking → pushThink<br/>累积 + 流入气泡"]
        T3["tool_use → pushThink<br/>🔧 行进 think，气泡保持开放"]
        T4["final text →<br/>think+body 合并收口"]
        T1 --> T2 --> T3 --> T4
    end

    classDef default_style fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef think_style fill:#FFF3E0,stroke:#E65100,color:#BF360C
    class D1,D2,D3,D4 default_style
    class T1,T2,T3,T4 think_style
```

---

## 4. 气泡状态机

```mermaid
stateDiagram-v2
    [*] --> Pending: startBriefTurn()<br/>streamPending=true

    Pending --> Streaming: 首次 pushThink →<br/>doStreamThink 清 streamPending<br/>replyStream(think, finish=false)
    Pending --> Done: turn 取消 / 空 turn

    Streaming --> Streaming: 后续 pushThink →<br/>250ms 去抖 → doStreamThink<br/>replyStream(更新 think, finish=false)
    Streaming --> Concluding: final text 到达 →<br/>concludeBriefTurn(body)
    Streaming --> Done: hardTimer ~6min →<br/>快照 thinking 收口

    Concluding --> Done: finishBriefBubble<br/>(think+body, finish=true)

    Done --> [*]: closeBriefTurn 清理状态

    state Pending {
        [*] --> waiting: 等待首个内容
        note right of waiting
            streamPending=true
            尚未调用 replyStream
            避免空开流竞态
        end note
    }

    state Streaming {
        [*] --> active: 气泡活跃
        note right of active
            briefThinking 累积
            250ms 去抖 flush
            背压: thinkFlushing 锁
        end note
    }
```

### 状态字段

**BriefBubble 上**（`mirror-bridge.ts:1737-1751`）：

| 字段 | 类型 | 用途 |
|------|------|------|
| `streamPending` | `boolean?` | thinkStyle 延迟首条 replyStream；doStreamThink 首次调用时清为 false |

**AttachState 上**（`mirror-bridge.ts:1867-1872`）：

| 字段 | 类型 | 用途 |
|------|------|------|
| `briefThinking` | `string?` | 气泡存续期间累积的 thinking 内容（段间 `\n\n` 分隔）；气泡收口后清空 |
| `thinkFlushTimer` | `Timeout?` | 去抖定时器，FLUSH_MS (250ms) 后触发 doStreamThink |
| `thinkFlushing` | `boolean?` | 背压标记：上一次 replyStream 在途时挡住新 flush |

---

## 5. 核心函数

### `pushThink(a, chunk)` — 唯一入口

`mirror-bridge.ts:2511-2521`

```mermaid
flowchart TD
    Entry["pushThink(a, chunk)"] --> Trim["c = chunk.trim()"]
    Trim --> Empty{c 为空?}
    Empty -->|是| Return["return"]
    Empty -->|否| BubbleAlive{气泡活着?<br/>a.briefBubble &&<br/>!done}
    BubbleAlive -->|是| Accumulate["a.briefThinking += c<br/>(\\n\\n 分隔)"]
    Accumulate --> Schedule["scheduleThinkFlush(a)"]
    BubbleAlive -->|否| HasTurn{a.briefTurnId?}
    HasTurn -->|是| Standalone["enqueueStandalone(a, c)<br/>3s debounce 合并"]
    HasTurn -->|否| Drop["丢弃"]

    classDef entry fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef decision fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef action fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef terminal fill:#FFCDD2,stroke:#C62828,color:#B71C1C

    class Entry entry
    class Empty,BubbleAlive,HasTurn decision
    class Accumulate,Schedule,Standalone action
    class Return,Drop terminal
```

### `scheduleThinkFlush(a)` — 去抖编排

`mirror-bridge.ts:2498-2506`

- 前置守卫：气泡存在 + 未 done + 无 pending timer + 不在 flushing
- 250ms 后触发 `doStreamThink()`
- 背压：上一次在途 → 本次排走下一个 pushThink 触发

```mermaid
flowchart TD
    Entry["scheduleThinkFlush(a)"] --> Guard{"气泡存在 &&<br/>!done &&<br/>!thinkFlushTimer &&<br/>!thinkFlushing?"}
    Guard -->|否| Skip["return (跳过)"]
    Guard -->|是| Timer["setTimeout(250ms)"]
    Timer --> Fire["定时器触发"]
    Fire --> ClearTimer["thinkFlushTimer = undefined"]
    ClearTimer --> StillFlushing{thinkFlushing?}
    StillFlushing -->|是| Wait["return<br/>(下次 pushThink 重排)"]
    StillFlushing -->|否| Lock["thinkFlushing = true"]
    Lock --> Do["doStreamThink(a)"]
    Do --> Unlock["finally: thinkFlushing = false"]

    classDef guard fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef action fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    class Guard,StillFlushing guard
    class Timer,Fire,ClearTimer,Lock,Do,Unlock action
```

### `doStreamThink(a)` — 实际流写

`mirror-bridge.ts:2485-2497`

- 首次调用清 `streamPending`（解决 off-by-one 竞态）
- `replyStream(frame, streamId, openThink(target, think), false)` — 不关流
- 错误只 log 不 throw（不打断工作流）

### `stripTrailingBody(think, body)` — 去重

`mirror-bridge.ts:507-515`

解决：软后端 final text 先作为 non-final 进了 `briefThinking`，收口时再当 body 用 → 重复。
策略：如果 `think` 尾部恰好等于 `body`，剥掉那段（含前面的空行）。只剥完整尾段，中途出现过的同句子不动。

```mermaid
flowchart TD
    Entry["stripTrailingBody(think, body)"]
    Entry --> NullCheck{"think 或 body<br/>为空?"}
    NullCheck -->|是| RetThink["return think || undefined"]
    NullCheck -->|否| Equal{think === body?}
    Equal -->|是| RetNone["return undefined<br/>(全重复)"]
    Equal -->|否| EndsWith{think.endsWith(body)?}
    EndsWith -->|是| Cut["cut = think.slice(0, -body.length)<br/>.replace(/\\n{2,}$/, '')<br/>.trimEnd()"]
    Cut --> CutEmpty{cut 为空?}
    CutEmpty -->|是| RetNone2["return undefined"]
    CutEmpty -->|否| RetCut["return cut"]
    EndsWith -->|否| RetOriginal["return think<br/>(无重复)"]

    classDef decision fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef action fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    class NullCheck,Equal,EndsWith,CutEmpty decision
    class Cut,RetThink,RetNone,RetNone2,RetCut,RetOriginal action
```

### `rescueBodyFromThinking(thinking)` — 兜底提取

`mirror-bridge.ts:519-526`

当 turn 收口时无 formal body（只有 thinking），从 thinking 的末尾段落中倒序跳过工具行（`🔧` / `↳`），取第一个文本段落作为 body。防止 thinking 内容静默丢失。

### `linkedTagPrefix()` — 链接抑制

`mirror-bridge.ts:2139-2145`

thinkStyle 下直接返回空串 → 所有消息退回 `withSessionTag`（无详情链接）。

---

## 6. 完整生命周期时序图

### 6.1 正常 Turn (Happy Path)

用户从 WeCom 发消息，LLM 经历 thinking → 工具调用 → 工具返回 → 最终回复。

```mermaid
sequenceDiagram
    actor User as WeCom 用户
    participant SBT as startBriefTurn
    participant Parser as Parser 层
    participant HBI as handleBriefItem
    participant PT as pushThink
    participant DST as doStreamThink
    participant CBT as concludeBriefTurn
    participant WC as WeCom API

    User->>SBT: 发消息
    SBT->>SBT: streamPending = true<br/>(不发 replyStream)
    Note over SBT: 延迟开流，避免 off-by-one

    Parser->>HBI: kind: "thinking"<br/>"让我分析一下这个问题..."
    HBI->>PT: pushThink(reasoning)
    PT->>PT: briefThinking = reasoning
    PT->>DST: scheduleThinkFlush (250ms)

    Note over DST: 250ms 去抖后触发
    DST->>DST: 清 streamPending = false
    DST->>WC: replyStream(<think>🧙 reasoning…, finish=false)
    Note over WC: 气泡首次开流，用户看到思考过程

    Parser->>HBI: kind: "tool_use"<br/>Read /src/main.ts
    HBI->>PT: pushThink("🔧 [Read /src/main.ts](url)")
    PT->>DST: scheduleThinkFlush (250ms)
    DST->>WC: replyStream(<think>🧙 reasoning…<br/><br/>🔧 [Read …](url), finish=false)

    Parser->>HBI: kind: "tool_result"<br/>"file contents..."
    HBI->>PT: pushThink("↳ file contents (truncated)")
    PT->>DST: scheduleThinkFlush
    DST->>WC: replyStream(更新 think 内容, finish=false)

    Parser->>HBI: kind: "text" (final=true)<br/>"这是最终回复"
    HBI->>CBT: concludeBriefTurn("这是最终回复")
    CBT->>CBT: stripTrailingBody 去重
    CBT->>WC: finishBriefBubble<br/>(<think>🧙 reasoning…<br/>🔧 …<br/>↳ …</think><br/><br/>这是最终回复,<br/>finish=true)
    Note over WC: 气泡关闭，用户看到折叠思考 + 正文
```

### 6.2 软后端路径 (final=undefined)

CodeBuddy 后端的 jsonl 按完整消息落盘（非增量），text 没有明确 `final` 标记。

```mermaid
sequenceDiagram
    participant Parser as Parser 层
    participant HBI as handleBriefItem
    participant PT as pushThink
    participant DST as doStreamThink
    participant CBT as concludeBriefTurn
    participant CLO as closeBriefTurn
    participant WC as WeCom API

    Note over Parser: CodeBuddy 后端: final=undefined

    Parser->>HBI: kind: "thinking"<br/>"reasoning..."
    HBI->>PT: pushThink(reasoning)
    PT->>DST: 去抖 → replyStream(think, finish=false)
    DST->>WC: <think>🧙 reasoning…

    Parser->>HBI: kind: "text" (final=undefined)<br/>"最终回复文本"
    Note over HBI: final===undefined: 双写
    HBI->>PT: pushThink("最终回复文本")<br/>→ 进入 briefThinking
    HBI->>HBI: briefLastText = "最终回复文本"

    Note over DST: 250ms 后 flush
    DST->>WC: replyStream(更新 think, finish=false)

    Parser->>HBI: kind: "turn_end" (soft=true)
    HBI->>CLO: closeBriefTurn(soft=true)
    CLO->>CBT: concludeBriefTurn(briefLastText)
    Note over CBT: stripTrailingBody:<br/>briefThinking 尾部 === body → 剥掉
    CBT->>WC: finishBriefBubble<br/>(<think>🧙 reasoning…</think><br/><br/>最终回复文本,<br/>finish=true)
```

### 6.3 hardTimer 超时 (~6min)

LLM 长时间执行（大量工具调用），WeCom stream 窗口到期。

```mermaid
sequenceDiagram
    participant PT as pushThink
    participant DST as doStreamThink
    participant HT as hardTimer
    participant CBT as concludeBriefTurn
    participant WC as WeCom API

    Note over PT: 持续累积 thinking（工具密集型 turn）

    loop 多次工具调用
        PT->>DST: scheduleThinkFlush
        DST->>WC: replyStream(think 快照, finish=false)
    end

    HT->>HT: ~6min 触发
    Note over HT: WeCom stream 窗口到期
    HT->>WC: finishBubble(当前 think 快照, finish=true)
    HT->>HT: 清空 briefThinking

    Note over PT: 后续 pushThink 检测 bubble.done=true

    PT->>PT: 气泡已收口 → 走 standalone
    PT->>WC: enqueueStandalone(chunk)<br/>3s debounce 合并

    Note over CBT: 最终回复到达
    CBT->>CBT: briefThinking 为空<br/>(已通过 standalone 分批推出)
    CBT->>WC: sendStandalone(body)<br/>只发正文
```

---

## 7. concludeBriefTurn 详解

`mirror-bridge.ts:2657-2690`

```mermaid
flowchart TD
    Entry["concludeBriefTurn(a, body)"]
    Entry --> Guard{"!turnId ||<br/>briefConcluded ||<br/>!body.trim()?"}
    Guard -->|是| Bail["return (不发)"]
    Guard -->|否| SetFlag["briefConcluded = true"]
    SetFlag --> Dedup["think = stripTrailingBody<br/>(briefThinking, body)"]
    Dedup --> BubbleAlive{气泡还活?}

    BubbleAlive -->|是| HasThink1{think 非空?}
    HasThink1 -->|是| FBB1["finishBriefBubble<br/>(&lt;think&gt;🧙 think&lt;/think&gt;<br/>\\n\\nbody,<br/>raw=true, finish=true)"]
    HasThink1 -->|否| FBB2["finishBriefBubble<br/>(withSessionTag(body))"]

    BubbleAlive -->|否| HasThink2{think 非空?}
    HasThink2 -->|是| SendRaw["sendRaw<br/>(&lt;think&gt;🧙 think&lt;/think&gt;<br/>\\n\\nbody)"]
    HasThink2 -->|否| SendSA["sendStandalone(body)"]

    classDef guard fill:#FFCDD2,stroke:#C62828,color:#B71C1C
    classDef action fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef bubble fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef standalone fill:#F3E5F5,stroke:#6A1B9A,color:#4A148C

    class Guard guard
    class Entry,SetFlag,Dedup action
    class BubbleAlive,HasThink1,HasThink2 guard
    class FBB1,FBB2 bubble
    class SendRaw,SendSA standalone
```

核心逻辑：**有 think 则合并 `<think>…</think>\n\nbody`，无 think 则只发 body。** 气泡活着走 `finishBriefBubble`（更新已有气泡），否则走 `sendRaw`/`sendStandalone`（新发一条）。

---

## 8. closeBriefTurn 清理流程

`mirror-bridge.ts:2694-2744`

```mermaid
flowchart TD
    Entry["closeBriefTurn(a, soft)"]
    Entry --> HasTurn{briefTurnId?}
    HasTurn -->|否| Return["return"]
    HasTurn -->|是| SoftCheck{soft?}

    SoftCheck -->|是| SoftConclude["concludeBriefTurn(a, briefLastText ?? '')"]
    SoftCheck -->|否| SkipSoft[" "]

    SoftConclude --> Rescue
    SkipSoft --> Rescue

    Rescue{"thinkStyle &&<br/>!briefConcluded &&<br/>briefThinking?"}
    Rescue -->|是| DoRescue["rescued = rescueBodyFromThinking<br/>(从 thinking 末尾摘正文)"]
    DoRescue --> HasRescued{rescued?}
    HasRescued -->|是| RescueConclude["concludeBriefTurn(a, rescued)"]
    HasRescued -->|否| BubbleCheck
    Rescue -->|否| BubbleCheck
    RescueConclude --> BubbleCheck

    BubbleCheck{"气泡还活?<br/>!done?"}
    BubbleCheck -->|否| Cleanup
    BubbleCheck -->|是| Concluded{briefConcluded?}

    Concluded -->|是| CloseEmpty["finishBriefBubble(' ')<br/>内容已在 conclude 发出"]
    Concluded -->|否| HasThink{briefThinking?}
    HasThink -->|是| CloseThink["finishBriefBubble<br/>(&lt;think&gt;🧙 think&lt;/think&gt;)<br/>闭合标签收口"]
    HasThink -->|否| CloseBlank["finishBriefBubble(' ')<br/>空收 (streamPending 还在)"]

    CloseEmpty --> Cleanup
    CloseThink --> Cleanup
    CloseBlank --> Cleanup

    Cleanup["清理状态:<br/>turnId = undefined<br/>briefBubble = undefined<br/>briefThinking = undefined<br/>clearTimeout(thinkFlushTimer)<br/>thinkFlushing = false<br/>…"]
    Cleanup --> NextTurn["shift 下一个排队 turn"]

    classDef guard fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef action fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef rescue fill:#FFF3E0,stroke:#E65100,color:#BF360C
    classDef cleanup fill:#F3E5F5,stroke:#6A1B9A,color:#4A148C

    class HasTurn,SoftCheck,Rescue,HasRescued,BubbleCheck,Concluded,HasThink guard
    class Entry,SoftConclude,CloseEmpty,CloseThink,CloseBlank action
    class DoRescue,RescueConclude rescue
    class Cleanup,NextTurn cleanup
```

三层兜底设计：
1. **soft conclude** — 用 `briefLastText` 尝试结论
2. **rescue** — `briefLastText` 为空但有 `briefThinking` → 从中摘出正文
3. **气泡收口** — 确保气泡不会永远挂着（已结论空收 / 未结论用闭合 `</think>` 收 / 空收）

---

## 9. handleBriefItem 路由逻辑

`mirror-bridge.ts:2820-2920`

```mermaid
flowchart TD
    Entry["handleBriefItem(a, item)"]
    Entry --> HasTurn{briefTurnId?}
    HasTurn -->|否| Drop["return"]
    HasTurn -->|是| ClearEarly["清除 earlyTimer"]

    ClearEarly --> Kind{item.kind?}

    Kind -->|tool_use| TU["briefHadTool = true<br/>earlyLinkBubble(a)<br/>⮕ thinkStyle: 保持气泡开放"]
    TU --> TURecord["recordTurnItem"]
    TURecord --> TUThink["pushThink<br/>('🔧 [Name compact](url)')"]

    Kind -->|tool_result| TR["earlyLinkBubble(a)"]
    TR --> TRRecord["recordTurnItem"]
    TRRecord --> TRThink["pushThink<br/>('↳ 单行摘要')"]

    Kind -->|thinking| TH["recordTurnItem"]
    TH --> THPush["pushThink(reasoning)"]

    Kind -->|text| TXT["recordTurnItem"]
    TXT --> Final{item.final?}
    Final -->|false| TXTFalse["pushThink(body)<br/>仅进 think，不算结论"]
    Final -->|undefined| TXTUndef["pushThink(body)<br/>+ briefLastText = body<br/>(双写: think + 软收口备用)"]
    Final -->|true| TXTTrue["concludeBriefTurn(body)<br/>硬信号落地"]

    Kind -->|turn_end| TE["closeBriefTurn<br/>(soft=item.soft)"]

    classDef decision fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef think fill:#FFF3E0,stroke:#E65100,color:#BF360C
    classDef conclude fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef record fill:#E3F2FD,stroke:#1565C0,color:#0D47A1

    class HasTurn,Kind,Final decision
    class TUThink,TRThink,THPush,TXTFalse,TXTUndef think
    class TXTTrue,TE conclude
    class TURecord,TRRecord,TH,TXT record
```

关键路由规则：

| item.kind | thinkStyle 行为 |
|-----------|----------------|
| `thinking` | parser 仅在 thinkStyle=true 时 emit → `pushThink(reasoning)` |
| `tool_use` | 无论 `includeTools` 设置，渲染为 `🔧 [Name compact](url)` → `pushThink` |
| `tool_result` | `↳ 单行摘要` → `pushThink` |
| `text` final=false | 确知中途 → 仅 `pushThink`，不设 `briefLastText` |
| `text` final=undefined | 不确定 → `pushThink` + 写 `briefLastText`（双写策略） |
| `text` final=true | 硬信号 → `concludeBriefTurn(body)` |
| `turn_end` | → `closeBriefTurn(soft)` |

---

## 10. Stream 流控：去抖 + 背压

```mermaid
sequenceDiagram
    participant Src as pushThink 调用
    participant Acc as briefThinking
    participant Timer as thinkFlushTimer
    participant Lock as thinkFlushing
    participant DS as doStreamThink
    participant WC as WeCom API

    Note over Src,WC: 时间线 →

    Src->>Acc: chunk 1 累积
    Src->>Timer: 启动 250ms 定时器

    Src->>Acc: chunk 2 累积 (100ms 后)
    Note over Timer: 定时器仍在 countdown

    Timer->>Lock: 250ms 到期，检查 flushing
    Note over Lock: flushing = false → 放行
    Lock->>DS: thinkFlushing = true
    DS->>WC: replyStream(chunk1+chunk2, finish=false)
    WC-->>DS: response
    DS->>Lock: finally: thinkFlushing = false

    Src->>Acc: chunk 3 累积
    Src->>Timer: 启动新 250ms 定时器

    Src->>Acc: chunk 4 累积 (50ms 后)

    Timer->>Lock: 250ms 到期
    Note over Lock: flushing = false → 放行
    Lock->>DS: thinkFlushing = true
    DS->>WC: replyStream(chunk1-4 全量, finish=false)

    Note over Src,WC: 背压场景

    Src->>Acc: chunk 5 累积
    Src->>Timer: 启动 250ms 定时器
    Timer->>Lock: 250ms 到期
    Note over Lock: flushing = true (上次还没回来)<br/>→ return, 等下次 pushThink 重排
```

设计要点：
- **去抖 250ms**：把高频的 thinking 输出合并成批次更新，减少 replyStream 调用
- **背压**：上一次 replyStream 还在途时，新的 flush 不排，等下一次 pushThink 重新触发
- **全量更新**：每次 doStreamThink 发送的是 `briefThinking` 的完整内容（非增量），WeCom 气泡内容被整体替换

---

## 11. 消息输出格式

### Stream 阶段（气泡更新中）

```
<think>🧙 让我分析一下这个问题...

首先需要读取配置文件。

🔧 [Read /src/config.ts](https://...)

↳ export const config = { port: 3000, ... }

看起来端口配置在这里，需要修改。
```

### 收口阶段（气泡最终形态）

```
<think>🧙 让我分析一下这个问题...

首先需要读取配置文件。

🔧 [Read /src/config.ts](https://...)

↳ export const config = { port: 3000, ... }

看起来端口配置在这里，需要修改。</think>

端口已从 3000 改为 8080，修改位于 `/src/config.ts:3`。
```

WeCom 会将 `<think>…</think>` 渲染为折叠块，用户展开可看完整思考过程。

### 多 agent 场景（带 tag）

```
<think>🔧修复 #fix 让我检查错误日志...

🔧 [Bash grep -n "error"](https://...)

↳ line 42: TypeError: Cannot read property 'x'</think>

已修复 `line 42` 的空指针问题，添加了 optional chaining。
```

---

## 12. 边界场景处理

### 12.1 off-by-one 竞态

`mirror-bridge.ts:2607-2612`

**问题**：空 `<think>` + 紧随 `pushThink` = 两次快速 `replyStream` → WeCom 服务端合并/丢弃。

**方案**：`bubble.streamPending = true`，首条 `doStreamThink` 才发出第一次 replyStream，携带真实内容。

```mermaid
flowchart LR
    subgraph Bad["旧方案 (有竞态)"]
        B1["openBriefTurn<br/>replyStream('…')"] --> B2["100ms 后<br/>pushThink"]
        B2 --> B3["replyStream(think)"]
        B3 --> B4["WeCom: 两次快速调用<br/>→ 合并/丢弃"]
    end

    subgraph Good["新方案 (streamPending)"]
        G1["openBriefTurn<br/>streamPending=true<br/>(不发 replyStream)"] --> G2["pushThink 触发<br/>doStreamThink"]
        G2 --> G3["清 streamPending<br/>replyStream(think)"]
        G3 --> G4["WeCom: 仅一次调用<br/>→ 正常显示"]
    end

    classDef bad fill:#FFCDD2,stroke:#C62828,color:#B71C1C
    classDef good fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    class B1,B2,B3,B4 bad
    class G1,G2,G3,G4 good
```

### 12.2 软后端去重

`mirror-bridge.ts:2887-2891`

CodeBuddy 后端的 `final===undefined` 文本会同时 `pushThink` 和写 `briefLastText`：

```
briefThinking = "reasoning…\n\n最终回复文本"    ← pushThink 写入
briefLastText = "最终回复文本"                   ← 同时记录

软收口时:
  concludeBriefTurn("最终回复文本")
  → stripTrailingBody("reasoning…\n\n最终回复文本", "最终回复文本")
  → "reasoning…"                                 ← 尾部重复被剥掉
  → 输出: <think>🧙 reasoning…</think>\n\n最终回复文本
```

### 12.3 thinking rescue

`mirror-bridge.ts:2701-2706`

Turn 将收口但 `briefConcluded=false` 且有 `briefThinking` → 从中摘出 body。

```
briefThinking = "分析了一下...\n\n🔧 [Read ...](url)\n\n↳ contents\n\n结论是XYZ"

rescueBodyFromThinking 倒序遍历段落:
  ✗ "↳ contents"     (工具结果行，跳过)
  ✗ "🔧 [Read ...]"  (工具调用行，跳过)
  ✓ "结论是XYZ"       → 作为 body 传给 concludeBriefTurn
```

### 12.4 WeCom stream 窗口超时 (~6min hardTimer)

`mirror-bridge.ts:2571-2584`

- 气泡必须 `finish=true` 收口（WeCom 限制）
- thinkStyle：把当前 `briefThinking` 作为快照写入气泡，然后清空 `briefThinking`
- 后续 `pushThink` 检测到气泡不可用，走 `enqueueStandalone` 直接推送到 chat
- `concludeBriefTurn` 时 `briefThinking` 为空（已通过 standalone 分批推出），只发 body

### 12.5 排队 turn 取消

`mirror-bridge.ts:2759-2761`

- thinkStyle：排队气泡收为 `"⏳ (queued, cancelled)"`（无链接）
- 非 thinkStyle：收为详情链接

### 12.6 气泡收口 (closeBriefTurn)

`mirror-bridge.ts:2711-2728`

三种情况：
1. **已结论**（`briefConcluded`）→ 气泡收为空白（内容已在 conclude 阶段发出）
2. **未结论 + 有 thinking** → 以 `<think>…</think>`（闭合标签）收口，避免 WeCom 渲染乱版
3. **未结论 + 无 thinking**（`streamPending` 还在）→ 空收

---

## 13. Parser 层面

`mirror-bridge.ts:730-741`

```ts
// tool_use: thinkStyle 下即使 includeTools=false 也 emit (用于 think 流的 🔧 行)
} else if (b?.type === "tool_use" && (deps.includeTools || deps.thinkStyle)) {
  ...
// thinking: 仅 thinkStyle 时 emit
} else if (b?.type === "thinking" && deps.thinkStyle) {
  ...
}
```

非 thinkStyle 时 thinking blocks 被静默跳过（`只进详情, 不下发`）。

```mermaid
flowchart TD
    Block["content_block from jsonl"]
    Block --> Type{block.type?}

    Type -->|text| EmitText["emit RenderItem<br/>kind: 'text'"]

    Type -->|tool_use| ToolGate{"includeTools ||<br/>thinkStyle?"}
    ToolGate -->|是| EmitTool["emit RenderItem<br/>kind: 'tool_use'"]
    ToolGate -->|否| SkipTool["丢弃"]

    Type -->|thinking| ThinkGate{"thinkStyle?"}
    ThinkGate -->|是| EmitThink["emit RenderItem<br/>kind: 'thinking'"]
    ThinkGate -->|否| SkipThink["丢弃<br/>(只进详情页)"]

    Type -->|tool_result| EmitResult["emit RenderItem<br/>kind: 'tool_result'"]

    classDef gate fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef emit fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef skip fill:#FFCDD2,stroke:#C62828,color:#B71C1C

    class ToolGate,ThinkGate gate
    class EmitText,EmitTool,EmitThink,EmitResult emit
    class SkipTool,SkipThink skip
```

---

## 14. 端到端数据流总览

```mermaid
flowchart TB
    subgraph Source["数据源"]
        JSONL["~/.claude/projects/…/session.jsonl"]
    end

    subgraph Parser["Parser (startMirrorTail)"]
        Tail["tail -f jsonl"]
        Parse["解析 assistant message blocks"]
        Gate["thinkStyle 门控"]
        Tail --> Parse --> Gate
    end

    subgraph Items["RenderItem 类型"]
        IT["thinking"]
        ITU["tool_use"]
        ITR["tool_result"]
        ITX["text<br/>(final: true/false/undefined)"]
        ITE["turn_end"]
    end

    subgraph Handler["handleBriefItem"]
        Route["路由分发"]
    end

    subgraph ThinkPipe["Think 管道"]
        PT["pushThink"]
        ACC["briefThinking 累积"]
        FLUSH["scheduleThinkFlush<br/>250ms 去抖"]
        STREAM["doStreamThink<br/>+ 背压"]
        PT --> ACC --> FLUSH --> STREAM
    end

    subgraph ConcludePipe["Conclude 管道"]
        CBT["concludeBriefTurn"]
        STRIP["stripTrailingBody 去重"]
        MERGE["合并: &lt;think&gt;…&lt;/think&gt;\\n\\nbody"]
        CBT --> STRIP --> MERGE
    end

    subgraph Fallback["降级路径"]
        STD["enqueueStandalone<br/>3s debounce"]
        RESCUE["rescueBodyFromThinking<br/>兜底提取"]
    end

    subgraph Delivery["WeCom 投递"]
        RS["replyStream<br/>finish=false/true"]
        SM["sendMessage<br/>(standalone)"]
    end

    JSONL --> Tail
    Gate --> IT & ITU & ITR & ITX & ITE
    IT & ITU & ITR --> Route
    ITX --> Route
    ITE --> Route

    Route -->|think 类| PT
    Route -->|"final=true"| CBT
    Route -->|turn_end| CLO["closeBriefTurn"]
    CLO --> CBT
    CLO -.->|rescue| RESCUE
    RESCUE -.-> CBT

    STREAM --> RS
    MERGE --> RS
    MERGE -.->|气泡已收口| SM

    PT -.->|气泡已收口| STD
    STD --> SM

    classDef source fill:#E0E0E0,stroke:#616161,color:#212121
    classDef parser fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20
    classDef item fill:#E3F2FD,stroke:#1565C0,color:#0D47A1
    classDef think fill:#FFF3E0,stroke:#E65100,color:#BF360C
    classDef conclude fill:#F3E5F5,stroke:#6A1B9A,color:#4A148C
    classDef fallback fill:#FFF9C4,stroke:#F9A825,color:#E65100
    classDef delivery fill:#FFCDD2,stroke:#C62828,color:#B71C1C

    class JSONL source
    class Tail,Parse,Gate parser
    class IT,ITU,ITR,ITX,ITE item
    class PT,ACC,FLUSH,STREAM think
    class CBT,STRIP,MERGE conclude
    class STD,RESCUE fallback
    class RS,SM delivery
```
