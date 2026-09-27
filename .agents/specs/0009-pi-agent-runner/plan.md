# 0009 — Pi agent runner, redaction, output validation, session transcript

## Goal

Port `Execution::{PiAgentRunner, Redactor, OutputFormatValidator, SessionTranscript}` as the real `StepRunner` adapter plus the pure domain helpers it needs. Safety-critical: read `../glyph/app/domain/execution/AGENTS.md` first.

## Depends on

0008.

## Rails behaviour to preserve

**Invocation** (argv only, never a shell):
```
{pi_bin} --print --mode json --provider {provider} --model {bare_model_id} --api-key {key}
  (--no-tools | --tools a,b) --no-session --no-extensions --no-skills --no-context-files
  --system-prompt {system_prompt} @{workdir}/prompt.md
```
- provider resolution: `model_id` = `provider/model` → catalog lookup by (provider, model) else the prefix; bare → catalog lookup by model_id else default `velox`. Key from config per provider; missing → `internal_error` with technical `"{PROVIDER}_API_KEY is not configured"`.
- Temp dir `glyph-step-run-*` (`tempfile`), `home/.pi/agent/models.json` = `{providers: {provider: {api: "openai-completions", apiKey: "supplied-via-cli-flag", baseUrl, models: [{id, name, maxTokens: 131072}]}}}`; cwd `work/`; prompt written to `prompt.md`.
- Child env **only**: `HOME={workdir}/home`, `PATH` (inherited), `TZ` (inherited or `UTC`), and `SSL_CERT_FILE`/`SSL_CERT_DIR`/`NODE_EXTRA_CA_CERTS` when non-empty. `env_clear()` first. stdin closed.
- Read stdout/stderr concurrently; timeout `GLYPH_PI_TIMEOUT_SECONDS` (900): SIGTERM, 3s grace, SIGKILL. `kill_on_drop(true)`.
- Progress: every ≥3s while reading, `progress(redact(stdout_so_far))`; once more at end.
- Bytes → UTF-8 lossy.

**System prompt**: verbatim from Rails (`You are executing one step of an automated workflow…` with `Expected output`, format directive for html/json/zip, and the `Rules:` block). **User prompt**: `Step instructions:\n{interp(prompt)}` + optional `\n\nAdditional context:\n{interp(context)}` + optional `\n\nInputs:\n{name}:\n{value}` joined by blank lines. Interpolation `{{name}}` → resolved input (string as-is, else JSON) → workflow value → leave token.

**Normalise** (in order): timed out → `timeout` (`"The agent did not finish within {n} seconds."`, technical `Process timed out. Partial output: {tail(stdout)} {tail(stderr)}`); NDJSON parse failure (any non-object line) → `malformed_output` (`"The agent produced unreadable output."`); no assistant `message_end` → `exit_error` (`"The agent stopped before producing a result."`); last assistant message `stopReason == "error"` → `model_error` (`"The selected model or provider could not complete the step."`, technical = redacted errorMessage); non-zero exit → `exit_error` (`"The agent process exited with an error."`); text = join of `text` blocks, trimmed; empty → `malformed_output` (`"The agent finished without producing any output."`); redact; `OutputFormatValidator` failure → `malformed_output` with its human message; success → `output_text = validated value ?? redacted`, `output_json = parse json (optional)`, `usage`, `exit_status`. `messages` = per assistant/user `message_end`: `{role, text (redacted), tool_calls (count of toolCall blocks), stop_reason?, error?}` skipping empty. `session_content` = redacted raw stdout on every path that has it. `tail` = last 2000 chars, redacted. Any panic/IO error → `internal_error` (`"The step could not be executed."`, technical `Runner internal error: {redacted}`).

**Redactor** (`shared`-level pure struct built in bootstrap with secret values): replace each non-blank secret env value (`VELOX_API_KEY OMNIROUTE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GLYPH_DATABASE_PASSWORD GLYPH_ENCRYPTION_KEY` + password part of `DATABASE_URL`) and patterns `sk-[A-Za-z0-9][A-Za-z0-9_\-]{8,}`, `(?i)Bearer\s+[A-Za-z0-9][A-Za-z0-9._\-]{8,}` with `[redacted]`. Applied before persist/log/publish/progress.

**OutputFormatValidator**: markdown/unknown → ok. json → `serde_json::from_str` ok else `"The agent did not produce valid JSON."`. html → strip ``` fences, regex `(?is)(<!doctype\s+html[^>]*>.*?</html>|<html[^>]*>.*?</html>)`, parse with an HTML5 parser must yield a root, value = extracted document; else `"The agent did not produce a complete HTML document."`. zip → empty/base64-invalid/not `PK\x03\x04` → `"The agent did not produce valid base64 ZIP data."`; decoded > 100 MiB → `"The ZIP archive exceeds the size limit."`; iterate entries (streaming): count > 1000 → entry-count message; Σ uncompressed > 500 MiB → size message; zip error → base64 message; zero entries → `"The ZIP archive is empty."`.

**SessionTranscript** (pure, tolerant of partial trailing line): events `message_start|update` (assistant) → pending; `message_end` (assistant) → blocks from content parts `text`/`thinking` (trimmed, non-empty); `tool_execution_start` → tool block `{name: toolName, summary: args.command ?? args.path ?? json, truncated 120, state running}` keyed by `toolCallId`; `tool_execution_end` → state `error|done` (or new block if unknown id); flush pending at end.

## Design

```
features/runs/domain/{redactor.rs, output_format_validator.rs, session_transcript.rs, prompt.rs}  // pure; prompt.rs builds system/user prompts + interpolation
infrastructure/pi/runner.rs   // PiStepRunner: implements StepRunner; owns process handling + normalise() (normalise is pure fn in features/runs/domain/pi_events.rs taking (stdout, stderr, exit, timed_out))
```
Selection in bootstrap: `GLYPH_STEP_RUNNER=pi|fake` (default `pi`). Config: `pi_bin`, `pi_timeout_seconds`, provider keys/base urls (0005), `default_provider = velox`.
Crates: `tokio::process`, `nix` (signal), `tempfile`, `zip`, `base64`, `regex`, `html5ever`/`scraper`.

Test fixture `backend/tests/fixtures/fake_pi.sh`: argv-driven (env is scrubbed, so behaviour is selected by a marker inside the prompt file, e.g. `FAKE_PI: model_error`): emits NDJSON scenarios (success text, success with tool calls, stopReason error, no assistant message, garbage line, non-zero exit, sleep for timeout, output with fenced HTML, base64 zip). Asserts on received argv by echoing it into `{cwd}/argv.json`.

## Tasks

1. Redactor → verify: port `redactor_spec.rb` (env values, patterns, blank passthrough, no mutation of input).
2. OutputFormatValidator → verify: port `output_format_validator_spec.rb` incl. zip bomb caps (entry count, uncompressed size via a crafted archive), fenced HTML extraction.
3. SessionTranscript → verify: port `session_transcript_spec.rb` (partial trailing line, tool state transitions).
4. Prompt builder + `normalise` → verify: port the pure parts of `pi_agent_runner_spec.rb` (each outcome branch, message extraction, usage).
5. `PiStepRunner` process handling → verify: with `fake_pi.sh`: argv exact match (flags, `@prompt` path, `--no-tools` vs `--tools read,bash`), env contains only allowed keys, `models.json` content, timeout kills (SIGTERM then SIGKILL, elapsed ≈ timeout), progress callback called ≥1 with redacted content, temp dir removed after run.
6. Wire `GetStepRun.transcript` from `session_content` → verify: gRPC test returns blocks.
7. Real smoke (manual, documented): `nix run .#web` with real `VELOX_API_KEY`, one-step workflow, `StartRun` → `SUCCEEDED`; record Pi version used in `backend/AGENTS.md`.

## Acceptance

- `grep -r "sh -c\|Command::new(\"sh\")" backend/src` empty; only `Command::new(pi_bin)` with `.args(vec)`.
- Log capture test at trace level shows no API key with a real-shaped key in env.
- Full engine spec (0008 task 5) passes with `PiStepRunner` + `fake_pi.sh`.

## Out of scope

Retries, streaming partial output to the UI beyond 3s snapshots (kept as Rails), Pi upgrades.
