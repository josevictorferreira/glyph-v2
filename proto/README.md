# Glyph gRPC contract

`glyph/v1/*.proto` is the single typed contract between backend and frontend.

- Backend: compiled by `backend/build.rs` (`protox` + `tonic-prost-build`, no `protoc` needed). Served by tonic on the same port as HTTP, both native gRPC (h2c) and gRPC-Web (h1). Reflection is enabled: `grpcurl -plaintext localhost:3000 list`.
- Frontend: `cd proto && buf generate` with `protoc-gen-es` on `PATH` (writes `frontend/src/gen`), then use `@connectrpc/connect-web`'s gRPC-Web transport against `http://localhost:3000`.

## Error details

Errors carry a `google.rpc.Status` in `grpc-status-details-bin`:

| Code | Details |
|---|---|
| `INVALID_ARGUMENT` | message is user-facing copy; definition errors add `glyph.v1.DefinitionErrors` |
| `FAILED_PRECONDITION` | `google.rpc.ErrorInfo{reason, domain: "glyph", metadata}`, plus `glyph.v1.ValidationIssues` when validation blocked the action |
| `ABORTED` | stale YAML fingerprint |
| `NOT_FOUND` | unknown id |

## Compatibility rules

- Additive changes only: new fields, messages, enum values, RPCs.
- Never renumber, retype or delete a field; reserve removed numbers instead.
- `nix run .#check` runs `buf lint` and `buf breaking` against `main`.
