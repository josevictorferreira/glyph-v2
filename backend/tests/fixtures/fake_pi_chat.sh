#!/usr/bin/env bash
# Stand-in for the Pi CLI in chat mode. The environment is scrubbed, so
# behaviour is chosen by --model; a CAPTURE_DIR=<dir> line in the message
# file makes the script record its argv (NUL-separated), environment names,
# the restored session file and the session dir it wrote.
model="" message_file=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --model) j=$((i + 1)); model="${!j}" ;;
    @*) message_file="${arg#@}" ;;
  esac
done
capture=""
if [ -n "$message_file" ] && [ -f "$message_file" ]; then
  while IFS= read -r line; do
    case "$line" in CAPTURE_DIR=*) capture="${line#CAPTURE_DIR=}" ;; esac
  done < "$message_file"
fi
if [ -n "$capture" ]; then
  printf '%s\0' "$@" > "$capture/argv"
  export -p > "$capture/env"
  printf '%s' "$PWD" > "$capture/cwd"
fi
# The runner restores a session file under <session-dir>/<relative-path>.
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  if [ "$arg" = "--session" ]; then
    j=$((i + 1)); restored="${!j}"
    mkdir -p "$(dirname "$restored")"
    if [ -n "$capture" ]; then
      printf '%s' "$(< "$restored")" > "$capture/restored_session"
    fi
  fi
done
# Pi writes the session as one .jsonl under the session dir, grouped by
# working directory: <session-dir>/<cwd-slug>/<uuid>.jsonl.
session_write() {
  dir="$1"
  mkdir -p "$dir/$(basename "$PWD")"
  printf '%s\n' '{"type":"session","version":3,"id":"fake-chat"}' \
    > "$dir/$(basename "$PWD")/00000000-0000-0000-0000-000000000001.jsonl"
}
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  if [ "$arg" = "--session-dir" ]; then
    j=$((i + 1)); session_write "${!j}"
  fi
done
case "$model" in
  ok-chat-model)
    echo '{"type":"agent_start"}'
    echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}'
    echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"there."}}'
    echo '{"type":"agent_end"}'
    ;;
  tool-chat-model)
    echo '{"type":"agent_start"}'
    echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Looking."}}'
    echo '{"type":"tool_execution_start","toolCallId":"c1","toolName":"list_workflows","args":{}}'
    echo '{"type":"tool_execution_end","toolCallId":"c1","toolName":"list_workflows","result":{"content":[{"type":"text","text":"none"}],"details":{"n":1}},"isError":false}'
    echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Done."}}'
    echo '{"type":"agent_end"}'
    ;;
  fail-chat-model)
    echo '{"type":"message_update","assistantMessageEvent":{"type":"error","reason":"provider","error":{"message":"boom VELOX-KEY-1"}}}' >&2
    exit 1
    ;;
  sleep-chat-model)
    sleep 600
    ;;
  *)
    echo "fake_pi_chat: unknown model $model" >&2
    exit 2
    ;;
esac
