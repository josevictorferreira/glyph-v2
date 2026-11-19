# 0024 — Chat agent (implementation plan)

## Goal

Ship the design in `design.md`: a `/chat` page where the user talks to a Pi-backed agent that creates, edits, schedules and runs workflows through ten Glyph tools, with token streaming, per-change Revert, and a `/settings` page that picks the agent's model.

Not a Rails port: this is new behaviour. Nothing in `../glyph` constrains wording here.

## Depends on

0007 (YAML definition), 0008 (job worker, run engine), 0009 (Pi runner), 0011 (live updates), 0015 (frontend data layer), 0021 (definition mode).

## Rules for every task (read first)

1. **Tests first.** Write the failing test named in the task, then the minimum code to pass it. When a test fails, change the implementation, never the test.
2. **Touch only the files the task lists.** One-line registrations (`mod` lines, `build.rs` file list, `fakeTransport.ts` service map) are allowed where the task says so. More than three unexpected files means stop and re-plan.
3. **Dependencies: use only what `backend/Cargo.toml` and `frontend/package.json` already list.** The single permitted manifest change is enabling the `util` feature on the existing `tower` dependency (task 4.3).
4. **Layering** (`backend/tests/architecture.rs` enforces it): `features/chat/domain` and `features/settings` domain code import only `shared`, `chrono`, `uuid`, `serde`, `serde_json`, `regex`. `application` and `ports` add `async_trait`, `tokio::sync` and `tokio_util::sync`. SQL lives in `infrastructure/postgres`. Process spawning lives in `infrastructure/pi`. Other features are reached through their `mod.rs` re-exports. `app/bootstrap.rs` is the only file naming concrete adapters.
5. **Safety** (root `AGENTS.md`): Pi runs through an argv vector with `env_clear()`, temp HOME, closed stdin, timeout and SIGTERM → SIGKILL. Every agent or provider text passes the `Redactor` before it is persisted, logged or published. State changes, their events and their jobs commit in one transaction. Turn jobs run once.
6. **Each RPC enters the proto in the task that implements it**, because `backend/tests/contract.rs` requires every declared RPC to answer.
7. **After changing any SQL:** from the repo root, `nix develop`, then `db_start && db_migrate && sqlx_prepare`, and commit `.sqlx/`.
8. **One commit per task** on branch `feat/0024-chat-agent`, message `feat(0024): <task title>`. Run the task's verify command before committing.

Stop and report instead of continuing when: a verify command fails and the fix needs files outside the task, a new dependency seems necessary, or Pi 1.0.3 behaves differently from `design.md` § "Pi contract".

## Style anchors

Backend:

| Pattern | Anchor |
|---|---|
| Feature module layout and re-exports | `backend/src/features/catalog/mod.rs`, `backend/src/features/live/mod.rs` |
| Application service with store + clock | `backend/src/features/catalog/application/list.rs:16-40` |
| gRPC handler style, id parsing, `?` on `DomainError` | `backend/src/features/definition/grpc/mod.rs:24-96` |
| Server-streaming RPC with heartbeat, lag → RESYNC, stop token | `backend/src/features/live/grpc/mod.rs:100-164` |
| NOTIFY payload type + its unit tests | `backend/src/features/live/domain.rs:29-117` |
| LISTEN → broadcast hub with reconnect | `backend/src/infrastructure/postgres/listener.rs:19-99` |
| In-transaction notify and enqueue | `backend/src/infrastructure/postgres/uow.rs:54-84` |
| Job constants and constructors | `backend/src/features/runs/application/mod.rs:27-40` |
| Worker queue + handler wiring, recovery wiring | `backend/src/app/bootstrap.rs:300-346` |
| Orphan query for recovery | `backend/src/infrastructure/postgres/jobs.rs:117-132` |
| Pi spawn, stdout drain, timeout, terminate | `backend/src/infrastructure/pi/runner.rs:214-352` |
| Temp HOME + `models.json`, provider resolution | `backend/src/infrastructure/pi/runner.rs:73-143` |
| Marker-driven fake runner | `backend/src/infrastructure/fake_runner.rs:1-37` |
| Plain HTTP route + state | `backend/src/features/runs/http.rs`, `backend/src/app/router.rs:11-27` |
| Integration test server | `backend/tests/common/mod.rs:66-92` |
| Pi process tests against a script | `backend/tests/pi_runner.rs:171` and `backend/tests/fixtures/fake_pi.sh` |
| Real-Pi contract test with a model mock | `backend/tests/pi_contract.rs:1-60` |
| Migration style | `backend/migrations/0006_shared_texts.sql` |

Frontend:

| Pattern | Anchor |
|---|---|
| Named query hooks | `frontend/src/features/runs/hooks.ts:22-48` |
| Cache keys | `frontend/src/shared/api/keys.ts:19-90` |
| Streaming subscription with backoff | `frontend/src/features/live/use-workflow-live.ts:148-190` |
| Sanitised markdown | `frontend/src/features/runs/OutputView.tsx:20-29` |
| Model picker | `frontend/src/features/catalog/Catalog.tsx:30-48` |
| File route | `frontend/src/routes/workflows.$id.definition.tsx:1-11` |
| Sidebar link, palette command | `frontend/src/features/library/Sidebar.tsx:106-112`, `frontend/src/app/commands.tsx:147-214` |
| Fake transport for component tests | `frontend/test/fakeTransport.ts:16-22` |
| E2E against the fake runner | `frontend/e2e/runs.spec.ts`, `frontend/playwright.config.ts:78-89` |

Pi 1.0.3 references (under `$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")/lib/node_modules/pi-monorepo/` in `nix develop`): `docs/json.md` (event stream), `docs/extensions.md` § Tools, `examples/extensions/hello.ts`, `docs/cli.md` § sessions.

## Design details the tasks rely on

### Names

- Tools, in this order everywhere: `list_workflows`, `get_workflow_yaml`, `validate_yaml`, `update_workflow`, `create_workflow`, `set_workflow_state`, `start_run`, `get_run`, `list_models`, `list_tools`. One Rust constant `chat::AGENT_TOOLS` is the source of truth.
- Job kind `run_chat_turn`, queue `chat` with concurrency 2. NOTIFY channel `glyph_chat`.
- Events (audit log, ids and status only): `ChatTurnStarted`, `ChatTurnFinished`, `ChatTurnFailed` on stream `Chat${id}`; `SettingsUpdated` on stream `Settings$app`.
- Setting key `chat_model_id`.
- Agent routes: `POST /agent/v1/<tool name>`, JSON body = tool parameters. Success is `200 {"text": <model-facing>, "details": {…}}`; failure is `4xx/5xx {"error": <message>}`.
- Agent API base URL: `http://127.0.0.1:<port of GLYPH_LISTEN_ADDR>`, passed to Pi as env `GLYPH_AGENT_API_URL`.

### User-facing messages (verbatim)

| Situation | Message |
|---|---|
| Send with no model set (`FAILED_PRECONDITION`, code `CHAT_MODEL_MISSING`) | `Choose a chat model in Settings before sending a message.` |
| Send while a turn runs (`FAILED_PRECONDITION`, code `CHAT_TURN_RUNNING`) | `The agent is still replying. Wait for it to finish or stop it.` |
| Blank message | `Write a message first.` |
| Delete while running | `Stop the agent before deleting this chat.` |
| Cancelled turn | `Cancelled.` |
| Worker died mid-turn | `The agent was interrupted before it finished. Send your message again.` |
| Pi or provider failure | `The agent could not complete this reply.` |
| Turn timeout | `The agent took longer than {n} seconds and was stopped.` |
| Unknown or unavailable model in Settings | `“{id}” is not an available model. Pick one from the list.` |
| `update_workflow` without fingerprint (tool error) | `update_workflow needs the fingerprint from get_workflow_yaml.` |
| Stale fingerprint (tool error) | `The workflow changed since you exported it. Call get_workflow_yaml again and reapply your edit.` |
| Revert after a later change | `This workflow changed after the agent's edit, so it can't be reverted automatically.` |
| Revert twice | `This change was already reverted.` |

### Storage

`0009_app_settings.sql`:

```sql
CREATE TABLE app_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

`0010_chat.sql`:

```sql
-- Encrypted columns are bytea holding nonce ‖ ciphertext ‖ tag.
CREATE TABLE chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'idle'
        CONSTRAINT chats_status_check CHECK (status IN ('idle', 'running')),
    cancel_requested boolean NOT NULL DEFAULT false,
    -- encrypted Pi session .jsonl and its path relative to the session dir
    pi_session bytea,
    pi_session_path text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    seq integer NOT NULL,
    kind text NOT NULL
        CONSTRAINT chat_messages_kind_check CHECK (kind IN ('user', 'assistant', 'tool')),
    status text NOT NULL
        CONSTRAINT chat_messages_status_check CHECK (status IN ('streaming', 'done', 'failed')),
    -- encrypted: markdown for user/assistant, JSON ToolCall for tool
    content bytea NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_chat_messages_on_chat_id_and_seq ON chat_messages (chat_id, seq);
```

### Proto

`settings.proto`: `SettingsService { GetSettings, UpdateSettings }`, `Settings { optional string chat_model_id = 1; }`. `UpdateSettings` with an empty id clears the setting.

`chat.proto`:

```proto
enum ChatStatus { CHAT_STATUS_UNSPECIFIED = 0; CHAT_STATUS_IDLE = 1; CHAT_STATUS_RUNNING = 2; }
enum ChatMessageKind { …_UNSPECIFIED = 0; …_USER = 1; …_ASSISTANT = 2; …_TOOL = 3; }
enum ChatMessageStatus { …_UNSPECIFIED = 0; …_STREAMING = 1; …_DONE = 2; …_FAILED = 3; }
enum ChatEventType { …_UNSPECIFIED = 0; …_TEXT_DELTA = 1; …_MESSAGE_UPDATED = 2; …_CHAT_UPDATED = 3; …_RESYNC = 4; …_HEARTBEAT = 5; }

message Chat { string id = 1; string title = 2; ChatStatus status = 3; Timestamp created_at = 4; Timestamp updated_at = 5; }
message ToolCall {
  string name = 1; string summary = 2; bool is_error = 3;
  optional string workflow_id = 4; optional string workflow_name = 5; optional string run_id = 6;
  bool revertible = 7; bool reverted = 8;
  optional string detail = 9;   // expandable body, e.g. validation errors
}
message ChatMessage {
  string id = 1; string chat_id = 2; int32 seq = 3; ChatMessageKind kind = 4; ChatMessageStatus status = 5;
  string text = 6;              // markdown; empty for tool messages
  int32 length = 7;             // characters of `text`, the unit of ChatEvent offsets
  optional ToolCall tool = 8; optional string error = 9; Timestamp created_at = 10;
}
message ChatEvent {
  ChatEventType type = 1; string chat_id = 2; optional string message_id = 3;
  optional int32 offset = 4; optional int32 end = 5; optional string text = 6;
}
```

RPCs, each added by the task that implements it: `ListChats`, `GetChat` (chat + messages), `CreateChat`, `RenameChat`, `DeleteChat` (2.3); `SendMessage` (3.3); `CancelTurn` (3.5); `WatchChat` (3.6); `RevertChange` (5.1). The pre-change YAML never appears in the proto; `revertible` is derived.

### Runner port (`features/chat/ports`)

```rust
pub struct SessionFile { pub relative_path: String, pub bytes: Vec<u8> }
pub struct Turn { pub chat_id: ChatId, pub model_id: String, pub message: String, pub session: Option<SessionFile> }
pub enum AgentEvent {
    TextDelta(String),
    ToolStarted { call_id: String, name: String },
    ToolFinished { call_id: String, name: String, text: String, details: serde_json::Value, is_error: bool },
}
pub struct TurnError { pub human: String, pub technical: String }
pub struct TurnEnd { pub session: Option<SessionFile>, pub error: Option<TurnError> }

#[async_trait]
pub trait ChatRunner: Send + Sync {
    async fn run(&self, turn: Turn, events: mpsc::Sender<AgentEvent>, cancel: CancellationToken) -> TurnEnd;
}
```

The application owns the turn loop: it consumes `AgentEvent`s, publishes coalesced deltas every 75 ms, persists published text and reads `cancel_requested` every second, and finalises in one transaction. Runners only translate a process (or a script) into events.

### Stable redaction

`Redactor::stable_len(&self, text: &str) -> usize` returns the length of the longest prefix whose redaction later text cannot change: `len − (longest secret − 1)`, pulled back to the start of the trailing `(?i)(Bearer\s*)?\S*$`, and pulled back again to the start of any redaction match that straddles it. `chat::domain::StreamBuffer` wraps it: `push(delta)`, `publish(&Redactor) -> Option<Delta { offset, end, text }>`, `finish(&Redactor) -> Option<Delta>`.

## Tasks

### Phase 1 — Settings

**1.1 Settings storage (60 min)**
- Touch only: `proto/glyph/v1/settings.proto`, `backend/build.rs` (file list), `backend/migrations/0009_app_settings.sql`, `backend/src/features/settings/{mod.rs,ports.rs}`, `backend/src/infrastructure/postgres/settings_repo.rs`; one `mod` line each in `features/mod.rs` and `infrastructure/postgres/mod.rs`; new `backend/tests/settings.rs`.
- Tests first: `#[sqlx::test]` get on an empty table returns `None`; set then get round-trips; set twice keeps one row; clear removes it.
- Then: `SettingsStore { get(key), set(key, value), clear(key) }` on `PgStore`, with `set`/`clear` available inside a transaction for the event in 1.2.
- Verify: `nix run .#test -- --test settings`.

**1.2 `SettingsService` RPCs (90 min)**
- Touch only: `backend/src/features/settings/{application.rs,grpc.rs,mod.rs}`, `backend/src/app/bootstrap.rs`, `backend/tests/settings.rs`.
- Tests first (gRPC): `GetSettings` on a fresh database has no model; `UpdateSettings` with a catalog model stores it and appends `SettingsUpdated`; an unknown or unavailable id returns `INVALID_ARGUMENT` with the message above; empty id clears.
- Then: `SettingsService` holds the store and `catalog::ListModels`; expose `chat_model_id()` for the chat feature.
- Verify: `nix run .#test -- --test settings && nix run .#test -- --test contract`.

**1.3 Settings page (90 min)**
- Touch only: `frontend/src/gen/**` (via `pnpm gen`), `frontend/src/shared/api/keys.ts`, `frontend/src/features/settings/{index.ts,hooks.ts,SettingsPage.tsx,SettingsPage.test.tsx}`, `frontend/src/routes/settings.tsx`, `frontend/test/fakeTransport.ts`.
- Tests first: the page shows the stored model; picking another calls `UpdateSettings` and shows the saved state; a rejected update shows the server message; the input-values note is present ("The agent sees workflow input and schedule values, and they are sent to this model's provider.").
- Then: `useSettings`, `useUpdateSettings`, page built on `ModelPicker` from `@/features/catalog`.
- Verify: `cd frontend && pnpm gen && pnpm test src/features/settings && pnpm typecheck && pnpm lint`.

### Phase 2 — Chat persistence and CRUD

**2.1 Chat domain model (90 min)**
- Touch only: `backend/src/shared/ids.rs` (`ChatId`, `ChatMessageId`), `backend/src/features/chat/{mod.rs,domain/mod.rs,domain/model.rs}`; one `mod` line in `features/mod.rs`.
- Tests first (unit): `title_from` trims, collapses whitespace and truncates to 60 characters with `…`; `ToolCall` serde round-trips and `revertible()` is true only for a successful, unreverted `update_workflow` with stored YAML; blank message rejected with `Write a message first.`.
- Then: `Chat`, `ChatStatus`, `Message`, `MessageKind`, `MessageStatus`, `ToolCall { name, summary, is_error, workflow_id, workflow_name, run_id, detail, revert: Option<Revert { previous_yaml, fingerprint }>, reverted }`.
- Verify: `nix run .#test -- --lib chat`.

**2.2 Chat storage (120 min)**
- Touch only: `backend/migrations/0010_chat.sql`, `backend/src/features/chat/ports/mod.rs`, `backend/src/infrastructure/postgres/chats_repo.rs`; one `mod` line in `infrastructure/postgres/mod.rs`; new `backend/tests/chat.rs`.
- Tests first: create, list newest-first, rename, delete cascades messages; message `content` and `pi_session` are not readable as plaintext in the raw columns; `begin_turn` (compare-and-set `idle → running`, clears `cancel_requested`) succeeds once and returns false the second time; `seq` is gap-free per chat.
- Then: `ChatStore` (reads, `begin()`), `ChatTx: UnitOfWork` (insert/update message, `begin_turn`, `end_turn`, save session, `request_cancel`, delete empty message), implemented on `PgTx`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test schema`.

**2.3 `ChatService` CRUD RPCs (120 min)**
- Touch only: `proto/glyph/v1/chat.proto`, `backend/build.rs`, `backend/src/features/chat/{application/mod.rs,grpc/mod.rs,mod.rs}`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`.
- Tests first (gRPC): the five CRUD RPCs; `GetChat` on an unknown id is `NOT_FOUND`; `DeleteChat` on a running chat is `FAILED_PRECONDITION` with the message above; `ChatMessage.length` equals the character count of `text`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test contract`; `cd proto && buf lint`.

**2.4 Chat list and routes (120 min)**
- Touch only: `frontend/src/gen/**`, `frontend/src/shared/api/keys.ts`, `frontend/src/features/chat/{index.ts,hooks.ts,ChatPage.tsx,ChatPage.test.tsx}`, `frontend/src/routes/{chat.tsx,chat.index.tsx}`, `frontend/test/fakeTransport.ts`.
- Tests first: the list renders newest first; New creates a chat and navigates to it; rename and delete call their RPCs and update the list; the empty state invites a first chat.
- Then: `/chat` is a two-pane layout (conversation list, `<Outlet />`); below `md` the list and the conversation are separate screens.
- Verify: `cd frontend && pnpm gen && pnpm test src/features/chat && pnpm typecheck && pnpm lint`.

**2.5 Conversation view, shared markdown, navigation (120 min)**
- Touch only: `frontend/src/shared/ui/{markdown.tsx,index.ts}`, `frontend/src/features/runs/OutputView.tsx` (use the shared component, no visual change), `frontend/src/features/chat/{Conversation.tsx,Conversation.test.tsx}`, `frontend/src/routes/chat.$chatId.tsx`, `frontend/src/features/library/Sidebar.tsx`, `frontend/src/app/commands.tsx`. Six files, justified by the markdown extraction replacing a duplicate.
- Tests first: user and assistant messages render in `seq` order; assistant markdown renders a table and strips a `<script>`; a failed message shows its error; Chat and Settings links exist in the sidebar and as palette commands `nav:chat`, `nav:settings`; `OutputView` tests stay green untouched.
- Verify: `cd frontend && pnpm test src/features/chat src/features/runs src/features/library src/app && pnpm typecheck && pnpm lint`.

### Phase 3 — Turn pipeline on the fake runner

**3.1 Stable redaction and `StreamBuffer` (90 min)**
- Touch only: `backend/src/shared/redactor.rs`, `backend/src/features/chat/domain/{stream.rs,mod.rs}`.
- Tests first (unit): for a text containing a literal secret, an `sk-…` token and a `Bearer …` token, **every** split into two and into three chunks yields deltas whose concatenation equals `redact(whole)`, with contiguous offsets, and no delta contains a secret fragment longer than what `redact(whole)` contains; plain prose is published up to the last word boundary; `finish` flushes the tail; offsets count characters, checked with multi-byte text.
- Verify: `nix run .#test -- --lib redactor && nix run .#test -- --lib chat`.

**3.2 Chat events and hub (90 min)**
- Touch only: `backend/src/features/chat/domain/events.rs`, `backend/src/features/chat/ports/mod.rs` (`ChatBus`, `ChatPublisher`), `backend/src/infrastructure/postgres/listener.rs`, `backend/src/infrastructure/postgres/chats_repo.rs`, `backend/tests/chat.rs`.
- Tests first: payload shape test as in `live/domain.rs:104-116`; a `TEXT_DELTA` whose text exceeds 2000 bytes is split on a character boundary into several events; publish → a subscriber receives it; `pg_terminate_backend` on the listener connection → subscribers get `RESYNC`; `tests/live.rs` stays green untouched.
- Then: make the reconnect loop in `listener.rs` generic over channel and payload so `LiveHub` and a new `ChatHub` share it. `ChatPublisher::publish` issues `pg_notify` on the pool, outside any transaction; in-transaction events go through `ChatTx`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test live`.

**3.3 `SendMessage` (90 min)**
- Touch only: `proto/glyph/v1/chat.proto`, `backend/src/features/chat/{application/mod.rs,grpc/mod.rs,ports/mod.rs}`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`.
- Tests first (worker disabled): a send inserts the user message and an empty `streaming` assistant message, flips the chat to `running`, sets the title on the first message, appends `ChatTurnStarted` and enqueues exactly one `run_chat_turn` job with only `chat_id` in its payload; a second send returns `CHAT_TURN_RUNNING` and writes nothing; no model returns `CHAT_MODEL_MISSING` and writes nothing; a blank message is `INVALID_ARGUMENT`.
- Then: add the `ChatRunner` port types from "Runner port"; `ChatService` gains `settings::SettingsService`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test contract`.

**3.4 Turn loop and fake runner (150 min)**
- Touch only: `backend/src/features/chat/application/{mod.rs,turn.rs}`, `backend/src/infrastructure/fake_chat_runner.rs`, `backend/src/infrastructure/mod.rs`, `backend/src/app/bootstrap.rs` (`Overrides.chat_runner`, queue `chat`, handler), `backend/tests/chat.rs`.
- Tests first (background on, scripted fake): a turn ends with the assistant message `done`, the chat `idle`, `ChatTurnFinished` appended and the session blob saved; the `TEXT_DELTA` events seen by a subscriber concatenate to the final text with contiguous offsets; a `GetChat` taken mid-turn returns a `streaming` message whose `length` matches the offsets published so far; a scripted secret split across deltas appears in neither a notification nor the stored content; a runner error leaves the message `failed` with the human message, keeps the partial text, appends `ChatTurnFailed` and returns the chat to `idle`.
- Then: `FakeChatRunner::scripted(events)` for tests and a marker mode for `GLYPH_STEP_RUNNER=fake`: default reply `Fake reply to: <message>` emitted word by word, `FAKE_FAIL`, `FAKE_SLEEP:<ms>`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test worker`.

**3.5 Cancel and recovery (90 min)**
- Touch only: `proto/glyph/v1/chat.proto`, `backend/src/features/chat/{application/mod.rs,application/turn.rs,grpc/mod.rs}`, `backend/src/infrastructure/postgres/jobs.rs`, `backend/src/infrastructure/jobs/recovery.rs`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`. Seven files: the recovery change spans the query, the sweep and its wiring.
- Tests first: `CancelTurn` during a `FAKE_SLEEP` turn ends it within two seconds as `failed` / `Cancelled.` with the chat `idle`; `CancelTurn` on an idle chat is a no-op; a `run_chat_turn` job abandoned by a dead worker (stale lock, no heartbeat) is recovered to `failed` with the interrupted message; a `running` chat with no unfinished job is recovered the same way; existing `tests/worker.rs` recovery tests stay green.
- Then: `jobs::orphaned_chats`, `Recovery { chat_kind, recover_chat }`, a `run_chat_turn` arm in `recover_job`, `ChatService::interrupt_turn`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test worker && nix run .#test -- --test contract`.

**3.6 `WatchChat` (90 min)**
- Touch only: `proto/glyph/v1/chat.proto`, `backend/src/features/chat/grpc/mod.rs`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`.
- Tests first (gRPC-Web streaming): the stream opens with `HEARTBEAT`; during a fake turn it delivers `TEXT_DELTA`s for that chat only, then `MESSAGE_UPDATED` and `CHAT_UPDATED`; a lagging subscriber gets `RESYNC`; idle for twice the heartbeat interval yields heartbeats; server stop ends the stream.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test contract`.

**3.7 Live conversation and composer (150 min)**
- Touch only: `frontend/src/gen/**`, `frontend/src/features/chat/{lib/stream.ts,lib/stream.test.ts,use-chat-live.ts,Composer.tsx,Conversation.tsx,Conversation.test.tsx,hooks.ts}`.
- Tests first: `applyDelta` appends when `offset` equals the known length, ignores a delta ending at or before it, and asks for a refetch on a gap; a streamed reply grows in place; `MESSAGE_UPDATED`, `CHAT_UPDATED` and `RESYNC` refetch the chat; Enter sends and Shift+Enter adds a newline; while running the input is disabled and Stop calls `CancelTurn`; with no model the composer is replaced by a link to Settings; the view follows the bottom only when the user was already there.
- Then: `use-chat-live` reuses the backoff logic of `use-workflow-live.ts:148-190` and writes deltas into the `GetChat` cache with `setQueryData` on the exact key.
- Verify: `cd frontend && pnpm gen && pnpm test src/features/chat && pnpm typecheck && pnpm lint`; then `GLYPH_STEP_RUNNER=fake nix run .#web` and watch a reply stream in the browser.

### Phase 4 — Agent tools and the real Pi runner

**4.1 Read-only agent routes (120 min)**
- Touch only: `backend/src/features/chat/{http.rs,mod.rs}` (`AGENT_TOOLS`, `AgentApi` state, error mapping), `backend/src/app/router.rs`, `backend/src/app/bootstrap.rs`; new `backend/tests/agent_api.rs`.
- Tests first: `list_workflows`, `get_workflow_yaml` (text carries the YAML and the fingerprint; `details` has `workflow_id`, `workflow_name`), `validate_yaml` (valid, and invalid with line numbers in the text), `list_models`, `list_tools`; unknown workflow is `404 {"error": "workflow not found"}`; `DomainError` variants map to 404 / 422 / 409 / 500 with the same messages their gRPC twins return.
- Verify: `nix run .#test -- --test agent_api && nix run .#test -- --test architecture`.

**4.2 Write agent routes (120 min)**
- Touch only: `backend/src/features/chat/http.rs`, `backend/tests/agent_api.rs`.
- Tests first: `update_workflow` without a fingerprint is rejected with the message above and changes nothing; with a stale one it returns the re-export message; with a fresh one it applies and `details` carries `previous_yaml`, `fingerprint` (the new one), `workflow_id`, `workflow_name` and a `summary`; setting a `schedule` block through it round-trips in the next export; `create_workflow` returns the new id and issues; `set_workflow_state` covers `activate`, `pause`, `resume` and returns the blocking issues when activation is refused; `start_run` returns the run id and `get_run` its status and per-step states.
- Verify: `nix run .#test -- --test agent_api`.

**4.3 Tool calls in the turn loop (90 min)**
- Touch only: `backend/Cargo.toml` (`tower` feature `util`), `backend/src/features/chat/application/turn.rs`, `backend/src/infrastructure/fake_chat_runner.rs`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`.
- Tests first: text → tool → text produces three messages in `seq` order (assistant `done`, tool, assistant); a tool call with no preceding text leaves no empty assistant message; tool `summary` and `detail` are redacted; `revert` data is stored but absent from the proto; a failed tool call is stored with `is_error`; marker `FAKE_TOOL:create_workflow {…}` creates a real workflow through the agent router.
- Then: the fake's marker mode executes `FAKE_TOOL:<name> <json>` lines against the agent `Router` in-process (`tower::ServiceExt::oneshot`), so tests and `nix run .#web` exercise the real routes with no network.
- Verify: `nix run .#test -- --test chat`.

**4.4 Extract shared Pi process helpers (90 min)**
- Touch only: `backend/src/infrastructure/pi/{mod.rs,process.rs,runner.rs}`.
- No new tests: this is a move. Provider resolution, `models.json`, `child_env` and `terminate` move to `process.rs`; `runner.rs` calls them.
- Verify: `nix run .#test -- --test pi_runner && nix run .#test -- --test pi_contract`, both unchanged and green.

**4.5 Pi chat event parser (60 min)**
- Touch only: `backend/src/features/chat/domain/{pi_events.rs,mod.rs}`, `backend/tests/fixtures/pi_chat_events.ndjson`.
- Tests first (unit, fixture lines copied from `docs/json.md`): `message_update` / `text_delta` → `TextDelta`; `thinking_delta` and `toolcall_delta` ignored; `tool_execution_start` / `_end` → `ToolStarted` / `ToolFinished` with text joined from `result.content` and `details` passed through; an assistant `message_end` with a provider error yields the technical error; unreadable lines are skipped.
- Verify: `nix run .#test -- --lib chat`.

**4.6 `PiChatRunner`, extension and prompts (150 min)**
- Touch only: `backend/agent/{glyph-tools.ts,system-prompt.md,workflow-guide.md}` (guide as a stub with one valid example), `backend/src/infrastructure/pi/{chat_runner.rs,mod.rs}`, `backend/src/app/bootstrap.rs`, `backend/tests/pi_chat_runner.rs`, `backend/tests/fixtures/fake_pi_chat.sh`.
- Tests first (against the script, as `tests/pi_runner.rs:171`): the argv matches `design.md` § "Pi contract" exactly, with `--session-id <chat id>` on the first turn and `--session <path>` when a session is supplied; the child environment is HOME, PATH, TZ, CA variables and `GLYPH_AGENT_API_URL` only; the restored session file has the stored bytes at the stored relative path; the session file written by the script comes back in `TurnEnd`; the temp dir is gone afterwards; a timeout and a cancel both terminate the process and return the matching error; stderr is redacted in the technical error.
- Then: `glyph-tools.ts` registers the ten tools with `defineTool`, each a POST to `${GLYPH_AGENT_API_URL}/agent/v1/<name>` returning `{ content: [{ type: "text", text }], details }` and throwing `Error(error)` on a non-2xx. `system-prompt.md` follows `design.md` § "Prompt and guide". Bootstrap picks `PiChatRunner` or the fake by `config.step_runner`.
- Verify: `nix run .#test -- --test pi_chat_runner`.

**4.7 Real-Pi contract test (120 min)**
- Touch only: `backend/tests/pi_chat_contract.rs`; `backend/src/infrastructure/pi/chat_runner.rs` and `backend/agent/glyph-tools.ts` only to fix what the test exposes.
- Tests first (skipped when `GLYPH_PI_BIN` is unset; model mock as `tests/pi_contract.rs:1-60`, plus a mock for the agent routes): the tools offered to the model are exactly `AGENT_TOOLS`; a mocked tool call to `list_workflows` reaches the agent mock and its `details` come back in `ToolFinished`; text arrives as several `TextDelta`s; turn two, resumed from turn one's session, sends turn one's messages to the model; a tool route error becomes `is_error`.
- Verify: `nix run .#test -- --test pi_chat_contract` inside `nix develop`. If Pi contradicts the design here, stop and report.

**4.8 Workflow guide and drift tests (120 min)**
- Touch only: `backend/agent/workflow-guide.md`, `backend/agent/system-prompt.md`, `backend/tests/agent_guide.rs`.
- Tests first: every fenced block tagged `yaml workflow` in the guide parses with zero errors through `DefinitionService::parse`; every name in `AGENT_TOOLS` appears in `glyph-tools.ts` and the extension registers no other; the guide mentions each top-level key of `features/definition/schema.json`.
- Then: write the guide: document shape, steps and connections, inputs, shared texts and `{ ref, vars }`, schedule block, helper steps, the export → edit → validate → apply loop, and common mistakes with their error messages. Source: `schema.json`, `backend/seeds/design_poc_tournament.yml`, `.agents/specs/0007-yaml-definition/plan.md`, `.agents/specs/0023-shared-texts/plan.md`.
- Verify: `nix run .#test -- --test agent_guide`.

### Phase 5 — Revert, tool cards, release checks

**5.1 `RevertChange` (90 min)**
- Touch only: `proto/glyph/v1/chat.proto`, `backend/src/features/chat/{application/mod.rs,grpc/mod.rs}`, `backend/src/app/bootstrap.rs`, `backend/tests/chat.rs`.
- Tests first: reverting an `update_workflow` tool message restores the previous YAML (the next export equals it) and marks the message `reverted`; a second revert returns `This change was already reverted.`; after a later edit to the workflow it returns the "changed after the agent's edit" message and writes nothing; a non-revertible message is `FAILED_PRECONDITION`; reverting emits `MESSAGE_UPDATED`.
- Verify: `nix run .#test -- --test chat && nix run .#test -- --test contract`.

**5.2 Tool cards and Revert (120 min)**
- Touch only: `frontend/src/gen/**`, `frontend/src/features/chat/{ToolCard.tsx,ToolCard.test.tsx,Conversation.tsx,hooks.ts}`.
- Tests first: an update card shows the summary, links to `/workflows/$id` and offers Revert only when `revertible`; Revert calls the RPC, then shows "Reverted"; a rejected revert shows the server message; a run card links to the run; a validation card expands its `detail`; an error card is visibly an error.
- Verify: `cd frontend && pnpm gen && pnpm test src/features/chat && pnpm typecheck && pnpm lint`.

**5.3 End-to-end spec (120 min)**
- Touch only: `frontend/e2e/chat.spec.ts`.
- Scenario, on the fake runner: choose a model in Settings; open Chat, start a conversation, send a message and see the reply finish; send a `FAKE_TOOL:create_workflow` message and follow the card to the new workflow; send a `FAKE_TOOL:update_workflow` message, see the change in Definition mode, click Revert and see it gone; start a `FAKE_SLEEP` turn and stop it.
- Verify: `cd frontend && pnpm e2e chat.spec.ts`.

**5.4 Contributor docs (45 min)**
- Touch only: `AGENTS.md`, `backend/AGENTS.md`, `frontend/AGENTS.md`.
- Add: project-map line for `backend/agent/`; a safety bullet (the chat agent runs with the ten Glyph tools only, never built-in Pi tools, and its routes must not be proxied by the frontend nginx); the new test files in the backend table; the chat live-sync pattern (deltas written into the `GetChat` cache) in the frontend guide.
- Verify: read-through; `nix run .#check` still green.

**5.5 Full check and manual pass (90 min)**
- Run `nix run .#check`.
- With a real model, under `nix run .#web`: create a workflow from a description; edit it; add a schedule and activate it; start a run and ask how it went; revert an edit; stop a long reply; restart the backend mid-reply and confirm the chat recovers; confirm `ps` shows no surviving `pi` process afterwards; confirm `curl -X POST <frontend>/agent/v1/list_workflows` does not reach the backend.
- Record what was run and what was not in the PR description.

## Acceptance

- A workflow can be created, edited, scheduled, activated and run entirely from chat, and each definition change can be reverted from its card.
- Replies stream; a page refresh mid-reply shows the text so far and keeps streaming.
- A second message during a reply is refused; Stop ends a reply within two seconds; a dead worker never leaves a chat stuck `running`.
- No configured secret value appears in a notification payload, a stored message or a log line.
- The model is offered exactly the ten Glyph tools (asserted against real Pi 1.0.3).
- `nix run .#check` is green, including `tests/architecture.rs` and `buf breaking`.

## Out of scope

Auth and per-user data, attachments, steering mid-turn, a chat panel inside the workflow workspace, deleting workflows or runs from chat, masking workflow input values, deploy (`nix run .#deploy` only when asked).

## Reminder (same rules as the top)

Tests first and never weakened. Touch only the listed files. No new dependencies. Pi through argv with a cleared environment and only the ten tools. Redact before persisting, logging or publishing. State, events and jobs in one transaction; turn jobs run once. Stop and report on drift.
