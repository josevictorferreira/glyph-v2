# Backend guide

Single crate `glyph-backend`, binary `glyph`. One port serves plain HTTP (`/up`, downloads, previews, `/schemas/workflow.json`), native gRPC (h2c) and gRPC-Web (h1, via `tonic-web`).

## Layout

```
src/
├── main.rs            Config::load → bootstrap → run
├── config.rs          env-only configuration
├── app/               composition root, router, AppState, error → status mapping
├── features/<name>/   domain/ (pure), application/ (use cases + ports), grpc/, http
├── infrastructure/    postgres, crypto, pi, gateways, jobs, telemetry
└── shared/            error, ids, time, issue, dag, events
```

## Database

- Migrations in `migrations/` are embedded (`sqlx::migrate!`) and applied at boot.
- Queries use `sqlx` macros checked against the database. `nix run .#test`/`.#check` set `SQLX_OFFLINE=true` and read `.sqlx/`; after changing any query run `sqlx_prepare` in `nix develop` (dev Postgres running, migrations applied via `db_migrate`) and commit `.sqlx/`.
- Integration tests use `#[sqlx::test]`: each test gets a fresh database on the local cluster.

## Tests

```sh
nix run .#test                       # everything
nix run .#test -- --test server      # one integration test file
```
