#!/usr/bin/env bash
# Stand-in for the Pi CLI. The environment is scrubbed, so behaviour is chosen
# by --model; a CAPTURE_DIR=<dir> line in the prompt file makes the script
# record its argv (NUL-separated), environment names and models.json there.
model="" api_key="" prompt_file=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --model) j=$((i + 1)); model="${!j}" ;;
    --api-key) j=$((i + 1)); api_key="${!j}" ;;
    @*) prompt_file="${arg#@}" ;;
  esac
done

capture=""
if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
  while IFS= read -r line; do
    case "$line" in CAPTURE_DIR=*) capture="${line#CAPTURE_DIR=}" ;; esac
  done < "$prompt_file"
fi
if [ -n "$capture" ]; then
  printf '%s\0' "$@" > "$capture/argv"
  export -p > "$capture/env"
  printf '%s' "$(< "$HOME/.pi/agent/models.json")" > "$capture/models.json"
  printf '%s' "$(< "$prompt_file")" > "$capture/prompt.md"
  printf '%s' "$PWD" > "$capture/cwd"
  printf '%s' "${prompt_file%/prompt.md}" > "$capture/workdir"
fi

session() {
  printf '{"type":"session","version":3,"id":"fake","env_has_key":"%s"}\n' "${VELOX_API_KEY:+SET}"
  echo '{"type":"agent_start"}'
  echo '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}'
}

# $1 must already be a JSON string literal (quoted and escaped).
answer() {
  printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop","usage":{"totalTokens":12}}}\n' "$1"
  echo '{"type":"agent_end"}'
}

case "$model" in
  ok-model) session; answer '"the answer"' ;;
  velox-only) session; answer '"the answer"' ;;
  json-model) session; answer '"{\"key\":\"value\"}"' ;;
  bad-json-model) session; answer '"not json at all"' ;;
  html-model) session; answer '"<!doctype html><html><body>Hi</body></html>"' ;;
  fenced-html-model) session; answer '"Here you go:\n```html\n<!doctype html>\n<html><body>Hi</body></html>\n```"' ;;
  fragment-model) session; answer '"just some prose"' ;;
  zip-model) session; answer '"UEsDBC0AAAAIAIRUDV2FEUoN//////////8IABQAZmlsZS50eHQBABAACwAAAAAAAAANAAAAAAAAAMtIzcnJVyjPL8pJAQBQSwECNAMtAAAACACEVA1dhRFKDf//////////CAAUAAAAAAABAAAApIEAAAAAZmlsZS50eHQBABAACwAAAAAAAAANAAAAAAAAAFBLBQYAAAAAAQABAEoAAABHAAAAAAA="' ;;
  bad-zip-model) session; answer '"aGVsbG8gd29ybGQ="' ;;
  secret-model) session; answer "\"the key is $api_key\"" ;;
  tools-model)
    session
    echo '{"type":"tool_execution_start","toolCallId":"1","toolName":"bash","args":{"command":"ls -la"}}'
    echo '{"type":"tool_execution_end","toolCallId":"1","toolName":"bash","result":{},"isError":false}'
    echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash"}],"stopReason":"toolUse"}}'
    answer '"listed"'
    ;;
  error-model)
    session
    echo '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400: no such model"}}'
    ;;
  garbage-model) echo 'this is not json' ;;
  exit-model) echo 'boom happened' >&2; exit 3 ;;
  hang-model) session; exec sleep 30 ;;
  stubborn-model) session; trap '' TERM; exec sleep 8 ;;
  slow-model) session; sleep 3.3; answer '"slow answer"' ;;
  chatty-model)
    # ~2.4 MB of token deltas: far beyond a pipe buffer.
    session
    echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
    for ((n = 0; n < 20000; n++)); do
      echo '{"type":"message_update","usage":{"input":100,"output":1,"totalTokens":101},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"chatty chatty chatty chatty chatty chatty "}}'
    done
    answer '"chatty answer"'
    ;;
  utf8-model) answer '"café → 日本語"' ;;
  empty-model)
    echo '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"totalTokens":1}}}'
    ;;
  *) echo "unknown model $model" >&2; exit 2 ;;
esac
