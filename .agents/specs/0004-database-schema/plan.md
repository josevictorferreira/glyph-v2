# 0004 — Database schema, crypto, repository ports

## Goal

All Postgres tables (translated from `../glyph/db/schema.rb`, minus Rails-framework tables), the `events` + `jobs` infrastructure tables, the encryption adapter, and the repository port traits every later spec implements against.

## Depends on

0002.

## Scope

- `backend/migrations/0002_domain.sql`, `0003_events_jobs.sql`.
- `infrastructure/crypto/aes_gcm.rs` + `Cipher` trait.
- `features/*/ports/*.rs` trait skeletons (compile-only; adapters land with their feature spec).
- `sqlx` offline data workflow (`cargo sqlx prepare`, `.sqlx/` committed).

## Design

### Tables (all `id uuid pk default gen_random_uuid()`, `created_at/updated_at timestamptz not null default now()`)

Translate 1:1 with these adjustments: `timestamp` → `timestamptz`; encrypted columns → `bytea`; JSON columns stay `jsonb`; keep every index, unique, check constraint and FK from schema.rb.

| Table | Notes |
|---|---|
| `workflows` | `status text check in (draft,active,paused,needs_attention) default 'draft'`, `name text not null default ''`, `description`, `fail_fast bool`, `last_run_at`, `last_run_status text`, `next_run_at` (partial index where not null), `lock_version int` (unused; drop). Drop `retired_at` (unused). |
| `workflow_inputs` | unique `(workflow_id, lower(name))` — Rails uniqueness is case-insensitive; enforce in DB via expression index. `ask_at_run_time bool default true`, `required bool default true`, `value text`, `position int`. |
| `workflow_steps` | `kind check (pi,helper)`, `output_file_format check (…) default 'free_text_markdown'`, `model_settings jsonb default '{}'`, `enabled_tool_ids jsonb default '[]'`, `canvas_x/y int default 0`, `position int`. |
| `step_inputs` | FK step (cascade), FK `workflow_input_id` (on delete set null — Rails `dependent: :nullify`), unique `(workflow_step_id, lower(name))`. |
| `workflow_connections` | FKs (cascade on step/input delete), unique `destination_input_id`, check `source_step_id <> destination_step_id`, index `(workflow_id, source_step_id)`. |
| `workflow_schedules` | unique `workflow_id`, `enabled bool default false`, `cron_expression`, `timezone`, `human_description`, `next_run_at`, `last_dispatched_at`. |
| `workflow_schedule_values` | `value bytea` (encrypted JSON string), unique `(workflow_schedule_id, workflow_input_id)`, FK input cascade. |
| `workflow_runs` | `status check (queued,running,succeeded,failed,cancelled)`, `trigger check (manual,scheduled)`, `draft_test bool`, `snapshot jsonb not null`, `supplied_values bytea` (encrypted JSON object), `schedule_occurrence_key text` unique partial where not null, `first_failed_step_run_id uuid` FK step_runs **deferrable initially deferred** (avoids the Rails before_destroy hack), index `(workflow_id, created_at desc)`, index `status`. |
| `step_runs` | `status check (queued,running,succeeded,failed,skipped,cancelled)`, `step_kind check`, `output_file_format check`, `snapshot_step_id uuid`, unique `(workflow_run_id, snapshot_step_id)`, index `(workflow_run_id, status)`; encrypted `bytea`: `resolved_inputs`, `output`, `output_text`, `messages`, `session_content`, `technical_error`; plain: `prompt`, `additional_context`, `expected_output`, `model_id`, `model_settings jsonb`, `enabled_tools jsonb`, `output_name`, `human_error`, `skipped_reason`, timestamps, `elapsed_ms bigint`, `position`. FK run cascade. |
| `available_models` | unique `(provider, model_id)`, `capabilities jsonb`, `raw jsonb`, `available bool`, `fetched_at`, `display_name`. |
| `tool_definitions` | unique `key`, `pi_tool_name`, `display_name`, `description`, `enabled`. |
| `events` | `id bigserial`, `event_id uuid unique default gen_random_uuid()`, `event_type text`, `stream text`, `correlation_id uuid null`, `data jsonb`, `created_at`; index `(stream, id)`, `event_type`. |
| `jobs` | `id bigserial`, `kind text`, `payload jsonb`, `queue text`, `run_at timestamptz default now()`, `locked_at`, `locked_by text`, `finished_at`, `error text`, `created_at`; index `(queue, run_at) where finished_at is null and locked_at is null`. |

Seeds are migrations too where idempotent: `0004_seed_tools.sql` inserts read/bash/edit/write with `on conflict (key) do update` (0005 owns content).

### Encryption

```rust
pub trait Cipher: Send + Sync { fn encrypt(&self, plain: &[u8]) -> Vec<u8>; fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>, CryptoError>; }
pub struct AesGcmCipher { key: Key<Aes256Gcm> }   // blob = 12-byte nonce ‖ ciphertext ‖ 16-byte tag
```
Key from `Config.encryption_key` (`GLYPH_ENCRYPTION_KEY` base64 32 bytes; dev fallback `glyph-dev-encryption-key-not-secret-000` padded/hashed via SHA-256 → log a warning when fallback used). Repositories hold `Arc<dyn Cipher>` and encrypt/decrypt in the row-mapping layer; domain structs hold plaintext. Add `GLYPH_ENCRYPTION_KEY` to Redactor secret list (0009).

### Repository ports (traits, `async_trait`)

```rust
// features/workflows/ports/repository.rs
pub trait WorkflowRepository {
    async fn find(&self, id: WorkflowId) -> Result<Option<Workflow>>;          // full aggregate: inputs, steps(+inputs), connections, schedule(+values)
    async fn list(&self, filter: ListFilter) -> Result<Vec<WorkflowSummary>>;
    async fn insert(&self, wf: &Workflow) -> Result<()>;
    async fn save(&self, wf: &Workflow, events: &[DomainEvent]) -> Result<()>; // one transaction: diff-persist aggregate + append events + NOTIFY
    async fn with_lock<F, T>(&self, id, f: F) -> Result<T>;                    // SELECT … FOR UPDATE scope (used by scheduler + run creation)
}
// features/runs/ports/repository.rs
pub trait RunRepository { find, list_for_workflow, insert_with_step_runs, update_run_cas(id, from_status, patch), update_step_run_cas, step_runs_for, delete, with_run_lock(...) }
// features/catalog/ports/repository.rs
pub trait CatalogRepository { available_models, models_by_ids, upsert_models, mark_unavailable, enabled_tools, tools_by_keys, max_fetched_at }
// shared ports
pub trait EventPublisher { fn append(&self, tx, event: &DomainEvent) }      // implemented inside postgres repos (same tx)
pub trait JobQueue { async fn enqueue(&self, tx, job: Job) -> Result<()>; }
```
Aggregate persistence strategy: load full aggregate, mutate in memory (domain), `save` computes diff vs. a loaded snapshot of child rows (`upsert` + `delete where id not in`) inside one transaction. Simple; workflows are small (tens of steps).

### sqlx offline

`nix run .#test`/`.#check` set `SQLX_OFFLINE=true`; devShell helper `sqlx_prepare` = `cargo sqlx prepare --workspace` against the live dev DB. `.sqlx/` committed. CI/Nix build never needs a DB.

## Tasks

1. Migrations `0002`–`0004` → verify: `#[sqlx::test(migrations = "./migrations")]` applies; `\d` matches table list; constraint tests (self-edge check, unique occurrence key, unique lower(name)) each assert a DB error.
2. Cipher → verify: round-trip test, tamper test fails, distinct nonces per call, fallback key warns.
3. Port traits + domain id newtypes (`WorkflowId`, `StepId`, `StepInputId`, `WorkflowInputId`, `ConnectionId`, `ScheduleId`, `RunId`, `StepRunId`) in `shared/ids.rs` → verify: compiles; `Display`/`FromStr`/serde tests.
4. `sqlx prepare` workflow documented in `backend/AGENTS.md`; `.sqlx/` committed → verify: `SQLX_OFFLINE=true cargo build` in a shell without DB.

## Acceptance

- Fresh cluster → server boot applies all migrations idempotently (second boot no-op).
- Encrypted columns unreadable in `psql` (bytea), readable through the cipher.

## Out of scope

Adapter implementations (each feature spec), data migration from Rails (non-goal).
