# glyph

Visual designer, scheduler and runner for DAG-shaped AI workflows. Each step runs the Pi coding agent (or a deterministic helper); outputs flow along connections; runs are immutable evidence. This is the Rust rewrite of the Rails app: a backend (axum + tonic + sqlx) behind a typed gRPC / gRPC-Web contract.

```sh
nix run .#web     # Postgres + backend on :3000 (add GLYPH_STEP_RUNNER=fake to run without provider keys)
nix run .#test    # test suite
nix run .#check   # buf lint/breaking, fmt, clippy, cargo deny, tests
nix run .#seed    # import the sample "Design POC Tournament" workflow
```

Provider keys go in `.env` (gitignored): `VELOX_API_KEY=…`, `OMNIROUTE_API_KEY=…`.

- `proto/` — the gRPC contract (`proto/README.md`)
- `backend/` — the server (`backend/README.md` for routes and environment)
- `AGENTS.md` — architecture rules and contributor conventions
