#!/usr/bin/env bash
# weclaude PreToolUse hook: forward to local daemon → long-poll → emit decision.
# Any failure → ask (never break workflow).
set -uo pipefail

DAEMON_URL="${WECLAUDE_DAEMON_URL:-http://127.0.0.1:17890/approve}"
# curl --max-time for the long-poll. MUST be ≥ daemon approval.longPollSec
# (default 7200s) or the hook aborts while the daemon is still waiting on your
# click — you'd get a local picker AND a stale WeCom card, and a late answer
# would land on a dead request. 7210 mirrors approval.hookTimeoutSec.
HOOK_TIMEOUT="${WECLAUDE_HOOK_TIMEOUT:-7210}"
STATE_DIR="${WECLAUDE_STATE_DIR:-$HOME/.weclaude/state}"
# Fallback policy when the daemon is unreachable / replies garbage. ask|allow|deny.
# Default keeps the safe behavior; set to `allow` in trusted local-only setups.
FALLBACK="${WECLAUDE_HOOK_FALLBACK:-ask}"

emit() {
  local decision="$1" reason="${2:-}"
  # 用 jq 拼 JSON: reason 可能含字面引号(askq deny 把答案塞进 reason),
  # printf 直接拼会漏出内层 " 把 JSON 撕烂, Claude Code 解析失败 fallback
  # 弹原生 picker → askq 失效。
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg d "$decision" --arg r "weclaude: $reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  else
    # jq 缺失兜底: 手动转义 \ 和 " (足够覆盖 reason 里的字面引号)。
    local esc="${reason//\\/\\\\}"; esc="${esc//\"/\\\"}"
    printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${decision}\",\"permissionDecisionReason\":\"weclaude: ${esc}\"}}"
  fi
  exit 0
}
ask() { emit "ask" "${1:-bridge unreachable}"; }

# Daemon-down fallback. Consults the persisted auto-approve window first so a
# session-level "allow N min" survives daemon restart / outage; otherwise falls
# back to FALLBACK. SESSION_ID must already be parsed.
bridge_down() {
  local reason="$1"
  local sf="$STATE_DIR/auto-windows.json"
  if [[ -n "${SESSION_ID:-}" && -r "$sf" ]] && command -v jq >/dev/null 2>&1; then
    local active
    active=$(jq -r --arg s "$SESSION_ID" \
      'if (.windows[$s].until // 0) > (now * 1000) then "1" else "0" end' \
      "$sf" 2>/dev/null) || active=""
    if [[ "$active" == "1" ]]; then
      emit "allow" "auto-window (offline): $reason"
    fi
  fi
  case "$FALLBACK" in
    allow|deny|ask) emit "$FALLBACK" "$reason" ;;
    *) emit "ask" "$reason" ;;
  esac
}

PAYLOAD=$(cat) || ask "stdin read failed"
command -v jq >/dev/null 2>&1 || ask "jq missing"

SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')
TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty')
TOOL_INPUT=$(printf '%s' "$PAYLOAD" | jq -c '.tool_input // {}')
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')
TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // ""')
PERMISSION_MODE=$(printf '%s' "$PAYLOAD" | jq -r '.permission_mode // ""')

# 会话已处于"完全自动"权限模式时, 用户已经表达了"别问我"的意图 —— 直接放行,
# 不要再把每个工具调用拦去推 IM 审批卡 (否则 auto mode 形同虚设, 用户得反复点
# "10分钟内同意")。只认真正的全自动模式: auto / bypassPermissions / dontAsk。
# acceptEdits 只自动接受编辑、Bash 等仍应过审批, 故不在此列, 保持推卡。
# 可设环境变量 WECLAUDE_HONOR_AUTO_MODE=0 关掉此行为。
#
# 例外: AskUserQuestion 是"用户主动决策"而非"工具放行"——即便 auto 模式也必须
# 推到 IM, 否则选择题只在本地 TUI 弹出, 远程用户完全看不到、也答不了。它本身
# 不是 auto 想自动化掉的"别问我"那类授权, 故不在 auto 短路之列, 始终走审批卡。
# (ExitPlanMode 不豁免: auto 模式下 allow 即让计划自动通过、不弹本地 picker,
#  这正是 auto 该有的语义, 强行推卡反而拧巴。)
if [[ "$TOOL_NAME" != "AskUserQuestion" ]] && [[ "${WECLAUDE_HONOR_AUTO_MODE:-1}" != "0" ]]; then
  case "$PERMISSION_MODE" in
    auto|bypassPermissions|dontAsk)
      emit "allow" "auto-mode passthrough ($PERMISSION_MODE)" ;;
  esac
fi

# weclaude 自家 MCP 工具全部走 loopback 到本 daemon, 自审会把 /wrc 首次绑定卡死
# (还没 defaultChat, 卡片无处可推 → 鸡生蛋), 直接放行。
# 命名两条路径:
#   1. cli/sync.ts (legacy claude-internal): mcp__weclaude__<tool>
#   2. .claude-plugin/plugin.json:           mcp__plugin_weclaude_weclaude__<tool>
# 用 *weclaude__* 同时覆盖两种前缀。
if [[ "$TOOL_NAME" == mcp__*weclaude__* ]]; then
  emit "allow" "weclaude mcp self-call bypass"
fi

# weclaude 自家 Skill (slash commands like /wrc) 也是本地插件代码, 无须审批。
# tool_input.skill 形如 "weclaude:wrc"; plugin 命名空间用冒号分隔。
if [[ "$TOOL_NAME" == "Skill" ]]; then
  SKILL_NAME=$(printf '%s' "$TOOL_INPUT" | jq -r '.skill // ""')
  if [[ "$SKILL_NAME" == weclaude:* ]]; then
    emit "allow" "weclaude skill self-call bypass"
  fi
fi

# Bash read-only fast-path: bypass cards for grep / rg etc.
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(printf '%s' "$TOOL_INPUT" | jq -r '.command // ""')
  if [[ "$CMD" =~ ^[[:space:]]*(grep|egrep|fgrep|rg|ls|cat|head|tail|wc|file)([[:space:]]|$) ]] \
     && [[ ! "$CMD" =~ [\;\|\&\>\<\`\$\(] ]]; then
    emit "allow" "read-only bypass"
  fi
  # weclaude CLI 同理: /wrc /cd 这些 slash command 的 ! bash 都打到本 daemon,
  # 自己审自己没意义, 也避免首次绑定时无处推卡。
  if [[ "$CMD" =~ (^|/|[[:space:]])weclaude(\.sh)?([[:space:]]|$) ]]; then
    emit "allow" "weclaude self-call bypass"
  fi
fi

# Tail of recent user messages for context on the card.
# 注意 .message.content 可能是 string 或 content blocks 数组；过滤 tool_result 与
# Claude Code 注入的 <system-reminder>/<command-*>/<local-command-*> 包裹标签。
TRANSCRIPT_TAIL=""
if [[ -n "$TRANSCRIPT_PATH" && -r "$TRANSCRIPT_PATH" ]]; then
  TRANSCRIPT_TAIL=$(tail -n 200 "$TRANSCRIPT_PATH" 2>/dev/null \
    | jq -r '
        select(.type == "user" or .role == "user")
        | select((.isMeta // false) == false)
        | (.message.content // .content) as $c
        | ( if ($c | type) == "string" then $c
            elif ($c | type) == "array" then
              ([ $c[]? | select(.type == "text") | .text ] | join("\n"))
            else "" end )
        | gsub("(?s)<system-reminder>.*?</system-reminder>"; "")
        | gsub("(?s)<command-name>.*?</command-name>"; "")
        | gsub("(?s)<command-message>.*?</command-message>"; "")
        | gsub("(?s)<command-args>.*?</command-args>"; "")
        | gsub("(?s)<local-command-stdout>.*?</local-command-stdout>"; "")
        | gsub("(?s)<local-command-caveat>.*?</local-command-caveat>"; "")
        | gsub("\\s+"; " ")
        | sub("^\\s+"; "") | sub("\\s+$"; "")
        | select(length > 0)
      ' 2>/dev/null \
    | tail -n 3 \
    | head -c 800 || true)
fi

BODY=$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg tn "$TOOL_NAME" \
  --argjson ti "$TOOL_INPUT" \
  --arg cwd "$CWD" \
  --arg tail "$TRANSCRIPT_TAIL" \
  '{session_id:$sid,tool_name:$tn,tool_input:$ti,cwd:$cwd,transcript_tail:$tail}')

RESP=$(curl -sS --max-time "$HOOK_TIMEOUT" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "$DAEMON_URL" 2>/dev/null) || bridge_down "daemon curl failed"

DECISION=$(printf '%s' "$RESP" | jq -r '.decision // "ask"' 2>/dev/null) || bridge_down "bad daemon response"
REASON=$(printf '%s' "$RESP" | jq -r '.reason // ""' 2>/dev/null)

case "$DECISION" in
  allow|deny|ask) emit "$DECISION" "$REASON" ;;
  *) bridge_down "unknown decision: $DECISION" ;;
esac
