# 0005 — Model & tool catalog

## Goal

Port `ModelsCatalog::{BaseClient,Refresher}`, `Velox::*`, `Omniroute::*`, `AvailableModel`, `ToolDefinition`, `RefreshOmnirouteModelsJob` and `HandleModelsRefreshedJob`; expose `CatalogService`.

## Depends on

0003, 0004.

## Rails behaviour to preserve

- Providers: `velox` (default) and `omniroute`; base URLs `VELOX_BASE_URL` (`https://velox.josevictor.me/v1`), `OMNIROUTE_BASE_URL` (`https://omniroute.josevictor.me/v1`); keys `VELOX_API_KEY`, `OMNIROUTE_API_KEY` read at call time, never persisted/logged.
- `GET {base}/models` with `Authorization: Bearer`, `Accept: application/json`, open timeout 5s, read 30s. Payload `{data: [...]}` else error. Omniroute entry: `id`, `name` (fallback id), `capabilities` (object or `{}`). Velox: `id` only, display=id, capabilities `{}`.
- Missing key → error `"{PROVIDER}_API_KEY is not configured"`; non-2xx → `"{provider} /models answered {code}"`.
- Refresh per provider in one transaction: upsert seen models (`available=true`, `fetched_at=now`, `display_name`, `capabilities`, `raw`), flip unseen previously-available to `available=false`, compute `became_unavailable` ids, append event `{Provider}$models` / `ModelsRefreshed{model_count, unavailable_model_ids}`.
- After commit: every **active** workflow with a step whose `model_id` ∈ unavailable ids → `needs_attention`, `next_run_at=null`, event `WorkflowNeedsAttention{issues:["A selected model is no longer available."]}`.
- Ordering for listing: velox first, then by model_id. `stale` = no `fetched_at` or max `fetched_at` older than `GLYPH_MODELS_CACHE_TTL` (300s).
- `full_id = "{provider}/{model_id}"`. Validator (0006) accepts both bare `model_id` (legacy) and `full_id`.
- Recurring: refresh every 5 minutes (both providers; failures logged as warnings, never fatal).
- Tools seed: `read`, `bash`, `edit`, `write` (display names/descriptions from `db/seeds.rb`), `pi_tool_name = key`, enabled.

## Design

```
features/catalog/
├── mod.rs              // pub use: CatalogReader, AvailableModel, ToolDefinition, refresh_all
├── domain.rs           // AvailableModel, ToolDefinition, Provider enum {Velox, Omniroute} + Display/FromStr, FullModelId parsing
├── application/
│   ├── refresh_models.rs   // RefreshModels { repo, gateways, events } -> per-provider Result{count, became_unavailable, error}
│   └── list.rs             // ListModels(include_unavailable) -> (models, stale)
├── ports.rs            // ModelGateway { provider(); async fn fetch_models() -> Result<Vec<FetchedModel>, GatewayError> }, CatalogRepository (0004)
└── grpc/mod.rs         // CatalogService impl
infrastructure/gateways/{openai_compatible.rs, velox.rs, omniroute.rs}   // reqwest client, one struct parameterised by provider + parse fn
infrastructure/postgres/catalog_repo.rs
```

Cross-feature: `refresh_models` returns `became_unavailable`; the maintenance job handler (registered in bootstrap, lives in `features/catalog/application/refresh_job.rs`) calls `workflows::flag_workflows_using_models(ids)` (public op added in 0006; until then a no-op port `WorkflowFlagger`).

Recurring trigger: `tokio::time::interval(5 min)` task started by bootstrap when `GLYPH_WORKER_ENABLED`; runs in a job (`kind = refresh_models`) via the queue once 0008 lands — until then call directly. Manual `RefreshModels` RPC runs the same application op.

Config additions: `velox_base_url`, `omniroute_base_url`, `velox_api_key: Option<SecretString>`, `omniroute_api_key`, `models_cache_ttl`. Use `secrecy` crate so keys never `Debug`-print.

## Tasks

1. Domain + ports + `CatalogRepository` adapter → verify: `#[sqlx::test]` upsert/mark-unavailable/ordering/stale.
2. Gateways with `reqwest` (rustls, timeouts) → verify: `wiremock` tests: success parse (both providers), non-2xx, invalid JSON, missing `data`, missing key; assert `Authorization` header sent and never logged.
3. `RefreshModels` → port `spec/domain/{velox,omniroute}/model_refresher_spec.rb` cases: new models inserted, vanished flipped unavailable, `became_unavailable` correct, event appended, gateway error → `refreshed=false` and DB untouched.
4. `CatalogService` (`ListModels`, `ListTools`, `RefreshModels`) → verify: gRPC integration test; `RefreshModels` with stubbed gateway.
5. Tool seed migration content + `ListTools` → verify: returns 4 enabled tools ordered by key.
6. Periodic refresh task (feature-flagged) → verify: unit test with `tokio::time::pause` advancing 5 min triggers exactly one refresh.

## Acceptance

- `grpcurl … glyph.v1.CatalogService/ListModels` against `nix run .#web` with real keys in `.env` returns models; without keys returns empty + logged warning, server stays up.
- No API key string appears in logs at `RUST_LOG=trace` (test asserts on captured tracing output).

## Out of scope

Validator use of the catalog (0006), needs_attention flagging implementation (0006).
