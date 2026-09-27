# glyph

Visual designer, scheduler and runner for DAG-shaped AI workflows — Rust backend (axum + tonic + sqlx) with a typed gRPC contract.

```sh
nix run .#web     # Postgres + backend on :3000
nix run .#test    # test suite
nix run .#check   # lint + tests
```

See `AGENTS.md` for architecture and conventions, `backend/README.md` for the environment contract.
