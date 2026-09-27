# 0002 — Backend skeleton + Nix dev stack

## Goal

A running Rust server with the final module layout, config, error type, tracing, one port serving axum HTTP and tonic gRPC-Web, a Postgres pool with embedded migrations, and `nix run .#web` / `.#test` / `.#reset`.

## Depends on

None (first spec). Repo currently has empty `flake.nix`, `AGENTS.md`, `README.md`, `backend/`, `frontend/`.

## Scope

- `backend/` Cargo package `glyph-backend`, binary `glyph`.
- `src/main.rs`, `config.rs`, `app/{mod,bootstrap,router,state}.rs`, `shared/{error,ids,time}.rs`, `features/health/http.rs`, `infrastructure/{postgres/{pool,migrate}.rs,telemetry.rs}`.
- Empty `migrations/` dir with one no-op migration (`0001_init.sql`: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`).
- `flake.nix` with devShell + apps, `.gitignore`, `AGENTS.md` (root contributor guide, mirrors Rails one), `backend/AGENTS.md`.
- gRPC health: `grpc.health.v1.Health` via `tonic-health`, wrapped with `tonic-web`.

## Design

### Dependencies (Cargo.toml, pin at implementation time)

`tokio` (full), `axum`, `tonic`, `tonic-web`, `tonic-health`, `tower`, `tower-http` (cors, trace), `prost`, `sqlx` (postgres, runtime-tokio, tls-rustls, uuid, chrono, json, migrate), `serde`, `serde_json`, `uuid` (v4, serde), `chrono`, `thiserror`, `anyhow` (main/bootstrap only), `tracing`, `tracing-subscriber` (env-filter, json), `dotenvy`.
Build: `tonic-build`, `protox`. Dev: `tower` (util), `http-body-util`.

### Config (`config.rs`)

```rust
pub struct Config {
    pub listen_addr: SocketAddr,          // GLYPH_LISTEN_ADDR, default 0.0.0.0:3000
    pub database_url: String,             // DATABASE_URL (required)
    pub database_max_connections: u32,    // GLYPH_DATABASE_MAX_CONNECTIONS, 10
    pub cors_origins: Vec<String>,        // GLYPH_CORS_ORIGINS, comma list, default http://localhost:5173
    pub log_json: bool,                   // GLYPH_LOG_JSON, false
    // later specs append: pi, gateways, encryption, worker
}
impl Config { pub fn load() -> Result<Self, ConfigError> }  // reads env only; dotenvy in main
```

### Errors (`shared/error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("{0} not found")] NotFound(&'static str),
    #[error("{0}")] Invalid(String),                 // → INVALID_ARGUMENT / 422
    #[error("{reason}")] Precondition { reason: String, code: &'static str, meta: Vec<(String, String)> }, // → FAILED_PRECONDITION
    #[error("conflict")] Conflict,                   // → ABORTED / 409
    #[error(transparent)] Internal(#[from] anyhow::Error), // → INTERNAL, logged, message hidden
}
```
Edge mappers: `impl From<DomainError> for tonic::Status` (in `app/` or a `features/*/grpc/` helper) and `impl IntoResponse` for HTTP. Domain never touches `Status`/`StatusCode`.

### Router (`app/router.rs`)

```rust
pub fn build(state: AppState, grpc: tonic::service::Routes, cors: CorsLayer) -> axum::Router {
    axum::Router::new()
        .route("/up", get(health::http::up))
        .merge(grpc.into_axum_router())     // each service pre-wrapped with tonic_web::enable
        .layer(cors)                        // allow origins from config; expose grpc-status/grpc-message headers
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
```
`axum::serve` on the listener handles HTTP/1.1 (gRPC-Web) and h2 (native gRPC) on the same port.

### Bootstrap (`app/bootstrap.rs`)

```rust
pub struct App { router: axum::Router, listen_addr: SocketAddr }
pub async fn build(config: &Config) -> anyhow::Result<App> {
    let pool = postgres::pool::connect(config).await?;
    postgres::migrate::run(&pool).await?;
    let state = AppState { /* filled by later specs */ };
    let (health_reporter, health_svc) = tonic_health::server::health_reporter();
    let grpc = tonic::service::Routes::new(tonic_web::enable(health_svc));
    Ok(App { router: router::build(state, grpc, cors(config)), listen_addr: config.listen_addr })
}
impl App { pub async fn run(self) -> anyhow::Result<()> /* axum::serve + graceful shutdown on ctrl_c */ }
```
`main.rs`: `dotenvy::dotenv().ok(); telemetry::init(); let cfg = Config::load()?; bootstrap::build(&cfg).await?.run().await`.

### Nix (`flake.nix`)

Port `../glyph/flake.nix` structure (bootstrapLib, `.dev/` state, `mkApp`). Changes:

- Toolchain: `rustc cargo clippy rustfmt rust-analyzer sqlx-cli pkg-config openssl postgresql_18 pi-coding-agent nodejs_22 pnpm buf`.
- Postgres: `listen_addresses=localhost`, port `55432`, socket dir kept. Export `DATABASE_URL=postgres://postgres:postgres@localhost:55432/glyph_development`, `GLYPH_PI_BIN=${pi}/bin/pi`, `TZ`, `SSL_CERT_FILE`. Source `.env` if present (gitignored) for API keys.
- `db_prepare`: `createdb glyph_development` if missing (migrations run by the server at boot; `sqlx migrate run` also available in shell as `db_migrate`).
- `web`: `pg_start; db_prepare; (cd backend && cargo run) &` then `if [ -f frontend/package.json ]; then (cd frontend && pnpm install --frozen-lockfile && pnpm dev) & fi`; banner; `wait`; trap kills children + `pg_stop`. Kill stale listeners on `:3000`/`:5173` first.
- `test`: `pg_start; createdb glyph_test` if missing; `export DATABASE_URL=…/glyph_test SQLX_OFFLINE=true`; `(cd backend && cargo test "$@")`.
- `reset`: stop pg, `rm -rf .dev`.
- `check`: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`.
- devShell exports helpers `db_start db_stop db_psql db_migrate`.
- `packages.default` = `web`; `formatter = nixfmt`.
- `.gitignore`: `.dev/`, `.env`, `.env*.local`, `backend/target/`, `node_modules/`, `.omc/`, `.omo/`.

### AGENTS.md (root)

Project map (backend/frontend/proto), dev commands (`nix run .#web|test|reset|check`), architecture rules (copy dependency rules from 0001), execution-safety rules (copy from Rails `AGENTS.md` and `app/domain/execution/AGENTS.md`, reworded for Rust).

## Tasks

1. `cargo init backend --name glyph-backend`, add deps, module tree with empty `mod.rs` files → verify: `cargo build` clean.
2. `config.rs` + `shared/error.rs` + `telemetry.rs` → verify: unit test `Config::load` errors without `DATABASE_URL`, parses defaults.
3. `infrastructure/postgres/{pool,migrate}.rs` + `migrations/0001_init.sql` → verify: `#[sqlx::test]` connects and `SELECT 1`.
4. `app/{state,router,bootstrap}.rs`, `features/health/http.rs`, `main.rs` → verify: integration test spins server on port 0, `GET /up` → 200 body `ok`; gRPC health check via `tonic_health` client → SERVING; gRPC-Web request (`content-type: application/grpc-web+proto`) → 200.
5. `flake.nix`, `.gitignore`, root + backend `AGENTS.md` → verify: `nix run .#web` prints banner, `curl localhost:3000/up` → ok, Ctrl-C stops pg; `nix run .#test` green; `nix run .#reset` wipes `.dev`.
6. Graceful shutdown: SIGINT/SIGTERM drains in-flight requests (max 10s) → verify: manual, server logs "shutting down".

## Acceptance

- `nix run .#web` from a clean checkout ends with a listening server and a live Postgres.
- `nix run .#test` green; `nix run .#check` green.
- `main.rs` ≤ 15 lines.

## Out of scope

Proto contract (0003), domain tables (0004), worker loop (0008).
