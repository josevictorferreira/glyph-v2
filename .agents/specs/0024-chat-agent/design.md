# 0024 — Chat agent (design)

A chat page where the user talks to a Pi-backed agent that creates, edits, schedules and runs workflows. The agent answers in markdown, works through a fixed set of Glyph tools, and its model is chosen in a new Settings page.

Status: design approved in conversation on 2026-11-15; implementation plan not yet written.

## Decisions

| Topic | Decision |
|---|---|
| Identity | Single-user, no auth and no token. The agent calls the API on loopback. |
| Model setting | One app-wide setting (`app_settings`), edited on a new `/settings` page. No default. |
| Writes | The agent applies changes itself; no confirm step. |
| Safety net | Every definition change is revertible from the chat. |
| Scope | Definitions, schedules, activation state and starting runs. No deletes. |
| Placement | Global `/chat` page with many saved conversations. |
| Tools | Glyph tools only. No shell, no file access, no web. |
| Process model | One Pi process per user message; Pi's session file carries the conversation. |
| Updates | Token streaming over the existing `pg_notify` → broadcast → gRPC stream path. |

## Out of scope

Auth and per-user data, file attachments, steering a turn mid-flight, a chat panel inside the workflow workspace, deleting workflows or runs, masking of workflow input values (see "Input values").

## Pi contract (verified against Pi 1.0.3 in the dev shell)

```
pi --print --mode json --provider P --model M --api-key K
   --session-dir <tmp>/sessions (--session-id <chat uuid> | --session <restored file>)
   --tools <the ten Glyph tool names> --no-extensions -e <tmp>/agent/glyph-tools.ts
   --no-skills --no-context-files --offline
   --system-prompt <purpose prompt> --append-system-prompt <tmp>/agent/workflow-guide.md
   @<tmp>/message.md
```

- `--session-id` creates the session on the first turn. Its lookup is scoped to the working directory, which is a fresh temp dir each turn, so later turns restore the stored file and pass it with `--session <path>`.
- `--tools` is an allow-list that applies to built-in and extension tools alike, so naming only the ten Glyph tools leaves bash/read/write/edit off. `--no-extensions` disables discovery while explicit `-e` still loads.
- `--mode json` emits `message_update` records whose `assistantMessageEvent` is `text_delta` (`contentIndex`, `delta`), plus `tool_execution_start` / `tool_execution_end` (`toolCallId`, `toolName`, `args`, `result`, `isError`).
- Extensions register tools with `pi.registerTool()` (name, description, TypeBox schema, `execute()`); throwing from `execute()` yields a failed tool result.
- Sessions are one `.jsonl` file under the session dir, grouped by working directory.

**The "skill" is delivered as system prompt, not as a Pi skill.** Pi skills are loaded lazily: the model reads `SKILL.md` with the `read` tool when a task matches. This agent has no `read` tool by design, so the workflow guide is appended to the system prompt with `--append-system-prompt`. It is still authored as one markdown document in the repo.

Spawn hardening is the step runner's: argv vector only, `env_clear()` plus an allow-list, a throwaway HOME, stdin closed, timeout (`GLYPH_PI_TIMEOUT_SECONDS`), SIGTERM → SIGKILL. The working directory is an empty temp dir. The extension receives the loopback base URL through one allow-listed env var.

## Backend

### Module layout

- `features/chat/domain` — chat and message model, status transitions, delta coalescing, redaction hold-back.
- `features/chat/application` — send, cancel, list, rename, delete, revert; `ports` for the repository, the chat runner and the delta publisher.
- `features/chat/grpc` — `ChatService`.
- `features/chat/http` — the agent tool routes (JSON).
- `features/settings/` — `SettingsService` over `app_settings`.
- `infrastructure/pi/chat_runner.rs` — the Pi adapter; shares spawn/kill code with `runner.rs` by extracting it, without changing step-run behaviour.
- `infrastructure/pi/fake_chat_runner.rs` — scripted deltas and tool calls, selected by `GLYPH_STEP_RUNNER=fake`.
- Postgres repository and one migration.

`backend/agent/` holds `glyph-tools.ts`, `system-prompt.md` and `workflow-guide.md`. They are compiled into the binary with `include_str!` and written into the per-turn temp dir, so neither image nor configuration changes.

### Storage

| Table | Columns |
|---|---|
| `chats` | `id`, `title`, `status` (`idle` / `running`), `pi_session` (encrypted bytea, the session `.jsonl`), `created_at`, `updated_at` |
| `chat_messages` | `id`, `chat_id`, `seq`, `kind` (`user` / `assistant` / `tool`), `status` (`streaming` / `done` / `failed`), `content` (encrypted; markdown for user/assistant, JSON for tool), `created_at` |
| `app_settings` | `key`, `value`; first key `chat_model_id` |

`content` and `pi_session` use the existing column encryption, because they carry workflow YAML and tool results. The UI renders only from `chat_messages`; `pi_session` is opaque and exists so Pi can resume.

A `tool` message stores: tool name, a one-line summary, `is_error`, the workflow or run id it touched, and for `update_workflow` the pre-change YAML plus the post-change fingerprint (for Revert). These extras travel in the tool result's `details` field, which Pi reports in `tool_execution_end` but does not send to the model: the agent route returns them, the extension passes them through, and the worker reads them from the event.

`chats` also carries `cancel_requested` and `pi_session_path` (the session file's path relative to the session dir).

### `ChatService` (gRPC)

`ListChats`, `GetChat` (chat + messages), `CreateChat`, `RenameChat`, `DeleteChat`, `SendMessage`, `CancelTurn`, `RevertChange`, and server-streaming `WatchChat`.

### A turn

1. `SendMessage`, in one transaction: compare-and-set `chats.status` `idle → running` (a second send while running fails with `FAILED_PRECONDITION`), insert the user message and an empty `streaming` assistant message, enqueue the turn job. It fails with `FAILED_PRECONDITION` and a message pointing at Settings when `chat_model_id` is unset.
2. The worker reads the model from `app_settings`, writes `pi_session` into a temp session dir, and spawns Pi.
3. For each `text_delta`, the worker appends to the accumulated text, redacts it, and publishes what is safe to show (see "Streaming"). Each `tool_execution_end` closes the current assistant message, becomes a `tool` message, and the next text starts a new assistant message, so a turn reads as text → tool card → text.
4. On exit: save the session file back to `pi_session`, set the assistant message `done` (or `failed` with the redacted error), set the chat `idle`. One transaction, with a "chat updated" event.

No retries, as for execution jobs. `CancelTurn` sets `chats.cancel_requested`; the worker reads it on its one-second persistence tick and kills the process, which works when web and worker are different processes. The message ends `failed` with "Cancelled". The dead-worker recovery sweep marks a stranded `streaming` message `failed` and the chat `idle`. Chat turns run on their own queue so they do not wait behind step runs.

### Streaming

Worker → `pg_notify` on a chat channel → the web process's listener → in-process broadcast → `WatchChat`, mirroring `infrastructure/postgres/listener.rs`.

- **Events:** `TEXT_DELTA` (chat id, message id, character offset, text), `MESSAGE_UPDATED` (ids only: a tool message was added or a message changed status; the client refetches), `HEARTBEAT`.
- **Coalescing:** deltas are batched for 50–100 ms and capped well under Postgres's 8000-byte notify payload.
- **Persistence:** the worker writes the accumulated assistant text to `chat_messages` about once a second and at the end, so opening or refreshing mid-turn loses nothing.
- **Gaps:** a client that sees an offset it did not expect refetches the message and resumes from its persisted length.
- **Offsets:** each delta carries `offset` and `end` in characters of the published text, and each fetched message carries its `length`. The client appends when `offset` equals the length it has, ignores a delta that ends at or before it, and refetches otherwise.
- **Redaction:** the `Redactor` runs on the accumulated text, not per delta. The worker publishes only a prefix that later text cannot change: it holds back (longest secret length − 1) characters and the trailing word, including a preceding `Bearer`, because the token patterns (`sk-…`, `Bearer …`) have no fixed length. The remainder is flushed when the turn ends. The invariant under test: for every way of chunking a text, the published deltas concatenate to `redact(whole text)`.

### Agent routes (`features/chat/http`)

JSON over HTTP, called by the extension on loopback, backed by the same application services as the gRPC handlers. The frontend nginx does not proxy this prefix.

| Tool | Route backs onto | Notes |
|---|---|---|
| `list_workflows` | `ListWorkflows` | id, name, state |
| `get_workflow_yaml` | `ExportDefinition` | YAML + fingerprint |
| `validate_yaml` | `ParseDefinition` | dry run; optional workflow id |
| `update_workflow` | `ApplyDefinition` | fingerprint required: empty is rejected here even though the gRPC call allows it |
| `create_workflow` | `ImportWorkflow` | returns id and issues |
| `set_workflow_state` | `ActivateWorkflow` / `PauseWorkflow` / `ResumeWorkflow` | `activate`, `pause` or `resume` |
| `start_run` | `StartRun` | workflow id + values by input name |
| `get_run` | `GetRun` | status and per-step state |
| `list_models` | `ListModels` | valid `model_id` values |
| `list_tools` | `ListTools` | valid tool keys |

Schedules need no tool of their own: the YAML `schedule` block (`cron`, `timezone`, `enabled`, `values`) is part of the definition, so `update_workflow` sets it and Revert restores it. A schedule only dispatches once the workflow is active, which is what `set_workflow_state` is for.

Errors come back as the existing user-facing messages, verbatim, so the agent can act on them. A stale fingerprint maps from `ABORTED` to a tool error telling the agent to re-export.

### Revert

`RevertChange(tool message id)` re-applies the stored pre-change YAML using the stored post-change fingerprint. If the workflow has changed since, the existing stale-fingerprint error is shown and nothing is written. Only `update_workflow` is revertible; a created workflow, a state change or a started run is undone from the normal UI, which the tool card links to.

### Input values

Workflow input values and schedule values are encrypted at rest but exported in plain text by `ExportDefinition`, and there is no "secret" marker on an input. The agent therefore sees them, and they are sent to the model provider. This version does not mask them: the same values are already sent to models as step inputs during runs, and masking would need a placeholder round-trip through `ApplyDefinition`. The Settings page states this next to the model picker.

### Prompt and guide

- `--system-prompt`: the agent authors Glyph workflows; always answers in markdown; follows export → edit → validate → apply; after a change says what changed and links the workflow; confirms in words before starting a run or activating a workflow unless the user asked for it in that message; says plainly when a request is outside its tools.
- `workflow-guide.md`: the YAML format with worked examples and common mistakes. The guide-drift test below keeps its examples valid.

## Frontend

- **Routes:** `/chat` (list, empty state, New) and `/chat/$chatId`; `/settings`.
- **`features/chat/`:** conversation list (newest first; rename, delete; title defaults to the first message, truncated), message list, composer, tool cards, and `use-chat-live` modelled on `use-workflow-live.ts`.
- **Messages** render with the existing `react-markdown` + `remark-gfm` + `rehype-sanitize` stack.
- **Tool cards:** "Updated *name*" with a workflow link and Revert; "Created *name*"; "Started run" with a run link; "Validated YAML: N errors", expandable; failed calls show the error.
- **Composer:** Enter sends, Shift+Enter is a newline. While a turn runs the input is disabled and Send becomes Stop. With no model configured it is replaced by a prompt linking to Settings.
- **Settings:** one field, the chat model, using the catalog-backed model picker from the step editor, plus the input-values note.
- **Entry points:** a Chat item in the shell navigation and in the command palette; Settings likewise.

## Testing

- **Domain (tests first):** status transitions and the compare-and-set; delta coalescing; redaction hold-back with a secret split across deltas; Pi event parsing for `text_delta` and tool events.
- **Integration:** send → job → persisted messages using the fake chat runner; second send while running rejected; cancel; recovery after a dead worker; no model configured.
- **Agent routes:** empty fingerprint rejected; stale fingerprint → re-export error; each route returns the same errors as its gRPC twin.
- **Revert:** restores the previous YAML; refuses when the workflow changed since.
- **Guide drift:** a cargo test runs every YAML example in `workflow-guide.md` through the real parser.
- **Architecture:** `tests/architecture.rs` covers `features/chat` and `features/settings`.
- **Frontend:** component tests for streaming, gap refetch, tool cards, Revert, the no-model state and Settings.
- **Manual:** one pass against real Pi 1.0.3 with a real model (create, edit, schedule, run, revert, cancel), since the fake cannot prove the Pi contract.

## Suggested split for the plan

1. Settings: `app_settings`, `SettingsService`, `/settings` page.
2. Chat persistence and `ChatService` CRUD, `/chat` page with static history.
3. Turn pipeline with the fake runner: job, streaming channel, `WatchChat`, live UI, cancel, recovery.
4. Agent routes, extension and guide; real Pi chat runner.
5. Revert, tool cards, navigation entries, manual pass.
