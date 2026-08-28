#!/usr/bin/env bash
# wezard PreToolUse hook: forward to local daemon → long-poll → emit decision.
# Any failure → ask (never break workflow).
set -uo pipefail

# --noproxy '*' on every daemon curl below: the daemon is on 127.0.0.1, but an
# http_proxy/all_proxy in env makes curl tunnel localhost through the proxy,
# which answers a down daemon with an empty 200 — a false "up" that makes
# wait_for_daemon re-post approvals into a dead process. Never proxy loopback.
NOPROXY=(--noproxy '*')
DAEMON_URL="${WEZARD_DAEMON_URL:-http://127.0.0.1:17890/approve}"
# 必须严格大于 daemon 的 approval.longPollSec (默认 43200) 且小于 hooks.json
# 的 timeout, 否则卡在 WeCom 里挂 >30min 后 curl 先死, 用户的点击写进死 socket。
HOOK_TIMEOUT="${WEZARD_HOOK_TIMEOUT:-43210}"
STATE_DIR="${WEZARD_STATE_DIR:-$HOME/.wezard/state}"
# Fallback policy when the daemon is unreachable / replies garbage. ask|allow|deny.
# Default keeps the safe behavior; set to `allow` in trusted local-only setups.
FALLBACK="${WEZARD_HOOK_FALLBACK:-ask}"
# daemon 重启 (wezard reload / launchd 拉起) 时等它回来的最长秒数。等回来后带着
# 上一轮的 req_id 续接同一张卡, 而不是 fallback 把权限框弹回本地 CLI。
RESUME_WAIT="${WEZARD_RESUME_WAIT:-60}"
HEALTH_URL="${DAEMON_URL%/approve}/healthz"

emit() {
  local decision="$1" reason="${2:-}"
  # 用 jq 拼 JSON: reason 可能含字面引号(askq deny 把答案塞进 reason),
  # printf 直接拼会漏出内层 " 把 JSON 撕烂, Claude Code 解析失败 fallback
  # 弹原生 picker → askq 失效。
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg d "$decision" --arg r "wezard: $reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  else
    # jq 缺失兜底: 手动转义 \ 和 " (足够覆盖 reason 里的字面引号)。
    local esc="${reason//\\/\\\\}"; esc="${esc//\"/\\\"}"
    printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${decision}\",\"permissionDecisionReason\":\"wezard: ${esc}\"}}"
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
command -v jq >/dev/null 2>&1 || ask "jq not installed — approval cards disabled; run: apt-get install jq (or yum/apk/brew) then reload"

SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')
TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty')
TOOL_INPUT=$(printf '%s' "$PAYLOAD" | jq -c '.tool_input // {}')
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')
TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // ""')
PERMISSION_MODE=$(printf '%s' "$PAYLOAD" | jq -r '.permission_mode // ""')

# CLI 后端: 与下方 ExitPlanMode 同款判别 — transcript 落在 ~/.codebuddy/ 即
# codebuddy。daemon 的 AskUserQuestion 分支据此走去重逻辑 (codebuddy 的 hook
# 只在本地面板提交后触发, vote 卡由 mirror 提前下发)。
CLI_BACKEND="claude"
case "$TRANSCRIPT_PATH" in
  */.codebuddy/*) CLI_BACKEND="codebuddy" ;;
esac

# 权限模式短路: 只对用户主动选的"完全跳过"模式放掉, 其它一律走 daemon 发 IM
# 卡, 让 wezard 远端用户能在 IM 上点决策。
#   - bypassPermissions: 用户已经主动选了"全跳", emit allow 直接放, 不打 daemon。
#   - auto: 不在此短路。第一次发卡用户点 10min 后, daemon 的 isAutoWindowActive
#     会接管, 后续 tool 自动放行不再发卡, 既不丢 IM 控制权也不会变成"卡刷屏"。
#     若 emit "ask" 让 Claude 自己处理, 不安全 tool 会弹本地 CLI picker, 远端用户
#     完全看不见也答不了 — 那是 v0.1.35 的回退原因。
#   - dontAsk: Claude 默认拒, 但 wezard 用户可能希望从 IM 端覆盖, 不在此短路。
# acceptEdits / default / plan 不在此列, 维持 daemon 流程。AskUserQuestion 始终
# 走卡 (远端用户的主动决策), 故任何 mode 都不在此短路。
# WEZARD_HONOR_AUTO_MODE=0 关掉本段对齐行为。
if [[ "$TOOL_NAME" != "AskUserQuestion" ]] && [[ "${WEZARD_HONOR_AUTO_MODE:-1}" != "0" ]]; then
  case "$PERMISSION_MODE" in
    bypassPermissions)
      emit "allow" "bypass-mode passthrough" ;;
  esac
fi

# ExitPlanMode 只是把 plan mode 的产出交给用户确认, 本地 CLI 会再弹一次原生
# 确认框, 走 IM 审批纯属多此一举, 直接放行。
# (codebuddy 更不走过这里: 实测它的 ExitPlanMode 完全由 interruption-service
# 本地裁决, PreToolUse hook 不触发 — IM 侧审批卡由 mirror 从 jsonl 驱动。)
if [[ "$TOOL_NAME" == "ExitPlanMode" ]]; then
  emit "allow" "ExitPlanMode passthrough"
fi

# wezard 自家 MCP 工具全部走 loopback 到本 daemon, 自审会把 /wrc 首次绑定卡死
# (还没 defaultChat, 卡片无处可推 → 鸡生蛋), 直接放行。
# 命名两条路径:
#   1. cli/sync.ts (legacy claude-internal): mcp__wezard__<tool>
#   2. .claude-plugin/plugin.json:           mcp__plugin_wezard_wezard__<tool>
# 用 *wezard__* 同时覆盖两种前缀。
if [[ "$TOOL_NAME" == mcp__*wezard__* ]]; then
  emit "allow" "wezard mcp self-call bypass"
fi

# wezard 自家 Skill (slash commands like /wrc) 也是本地插件代码, 无须审批。
# tool_input.skill 形如 "wezard:wrc"; plugin 命名空间用冒号分隔。
if [[ "$TOOL_NAME" == "Skill" ]]; then
  SKILL_NAME=$(printf '%s' "$TOOL_INPUT" | jq -r '.skill // ""')
  if [[ "$SKILL_NAME" == wezard:* ]]; then
    emit "allow" "wezard skill self-call bypass"
  fi
fi

# Bash read-only fast-path: bypass cards for grep / rg etc.
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(printf '%s' "$TOOL_INPUT" | jq -r '.command // ""')
  if [[ "$CMD" =~ ^[[:space:]]*(grep|egrep|fgrep|rg|ls|cat|head|tail|wc|file)([[:space:]]|$) ]] \
     && [[ ! "$CMD" =~ [\;\|\&\>\<\`\$\(] ]]; then
    emit "allow" "read-only bypass"
  fi
  # wezard CLI 同理: /wrc /cd 这些 slash command 的 ! bash 都打到本 daemon,
  # 自己审自己没意义, 也避免首次绑定时无处推卡。
  if [[ "$CMD" =~ (^|/|[[:space:]])wezard(\.sh)?([[:space:]]|$) ]]; then
    emit "allow" "wezard self-call bypass"
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

build_body() {
  jq -nc \
    --arg sid "$SESSION_ID" \
    --arg tn "$TOOL_NAME" \
    --argjson ti "$TOOL_INPUT" \
    --arg cwd "$CWD" \
    --arg tail "$TRANSCRIPT_TAIL" \
    --arg tp "$TRANSCRIPT_PATH" \
    --arg cb "$CLI_BACKEND" \
    --arg rid "$RESUME_ID" \
    '{session_id:$sid,tool_name:$tn,tool_input:$ti,cwd:$cwd,transcript_tail:$tail,transcript_path:$tp,cli_backend:$cb}
     + (if $rid == "" then {} else {resume_req_id:$rid} end)'
}

# drain 到进程真正退出之间还有 ~200ms。不等它先死就重投, 会打进这个将死的进程,
# 那次 curl 必然半路断掉、还白白丢掉 req_id。最多等 5s, 期间它没死也就算了。
wait_for_exit() {
  local waited=0
  while (( waited < 5 )); do
    curl -sS "${NOPROXY[@]}" --max-time 1 "$HEALTH_URL" >/dev/null 2>&1 || return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# daemon 回来了吗。reload 是「退出 → launchd 重新拉起」, 中间有几百 ms 到几秒
# 的空窗; 这段时间内的 curl 必然 connection refused。
wait_for_daemon() {
  local waited=0
  while (( waited < RESUME_WAIT )); do
    if curl -sS "${NOPROXY[@]}" --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# 长轮询 + 重启续接。整个循环共享 HOOK_TIMEOUT 预算 (hooks.json 的 timeout 只比
# 它多 10s), 所以每轮 --max-time 用的是剩余额度而不是重新计时。
RESUME_ID=""
COLD_RETRIES=0
while :; do
  REMAIN=$(( HOOK_TIMEOUT - SECONDS ))
  (( REMAIN > 5 )) || bridge_down "hook budget exhausted"

  RESP=$(curl -sS "${NOPROXY[@]}" --max-time "$REMAIN" \
    -H 'Content-Type: application/json' \
    -d "$(build_body)" \
    "$DAEMON_URL" 2>/dev/null) || RESP=""

  if [[ -z "$RESP" ]]; then
    # 没走 drain 就没了 (硬杀 / 崩溃)。等它回来重投一次 —— 工具还没执行, 重投
    # 是安全的; 只是没有 req_id 可续, daemon 会发一张新卡, 旧卡沦为鬼卡。
    COLD_RETRIES=$((COLD_RETRIES + 1))
    (( COLD_RETRIES <= 2 )) || bridge_down "daemon unstable"
    wait_for_daemon || bridge_down "daemon curl failed"
    continue  # RESUME_ID 有就带着 (卡还活着), 没有就是重发一张新卡
  fi

  DECISION=$(printf '%s' "$RESP" | jq -r '.decision // "ask"' 2>/dev/null) || bridge_down "bad daemon response"
  REASON=$(printf '%s' "$RESP" | jq -r '.reason // ""' 2>/dev/null)

  # daemon 正在重启: 卡还挂在 IM 上, 拿着它给的 req_id 等 daemon 回来续接。
  if [[ "$DECISION" == "retry" ]]; then
    RESUME_ID=$(printf '%s' "$RESP" | jq -r '.req_id // ""' 2>/dev/null)
    wait_for_exit
    wait_for_daemon || bridge_down "daemon did not come back"
    continue
  fi

  case "$DECISION" in
    allow|deny|ask) emit "$DECISION" "$REASON" ;;
    *) bridge_down "unknown decision: $DECISION" ;;
  esac
done
