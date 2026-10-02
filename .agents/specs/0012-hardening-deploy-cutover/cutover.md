# Cutover runbook — Rails `glyph` → Rust `glyph-v2`

Assumption (0001): fresh database. Run history is **not** migrated (evidence encryption is not ActiveRecord-compatible); keep the Rails app read-only for history.

## 1. Export every workflow from Rails

```sh
cd ../glyph
mkdir -p /tmp/glyph-export
nix develop --command bundle exec rails runner '
  Workflow.find_each do |w|
    path = "/tmp/glyph-export/#{w.id}.yml"
    File.write(path, Workflows::Definition::Exporter.call(w))
    puts "#{w.id}\t#{w.status}\t#{w.name}"
  end' | tee /tmp/glyph-export/index.tsv
```

## 2. Import into v2 and compare readiness

```sh
nix run .#web &          # or point grpcurl at the deployed v2
for f in /tmp/glyph-export/*.yml; do
  jq -n --rawfile yaml "$f" '{yaml: $yaml}' |
    grpcurl -plaintext -d @ localhost:3000 glyph.v1.DefinitionService/ImportWorkflow |
    jq -r '[.workflow.summary.name, (.issues | length)] | @tsv'
done
```

- Compare each workflow's issues with the Rails validator (`Workflows::Validator.call(w).map(&:message)`). Messages are identical by design.
- Fix model ids to the `provider/model_id` form when a Rails step stored a bare id (the validator accepts both; full ids are required for capability checks on omniroute models).
- `RefreshModels` first so the catalog is current: `grpcurl -plaintext localhost:3000 glyph.v1.CatalogService/RefreshModels`.

## 3. Schedules and values

- Schedules and their values arrive in the YAML (`schedule:` block). Imported workflows are drafts, so schedules come in disabled-for-dispatch until activation.
- Secret run-time values that Rails held only in `supplied_values` are not exported; re-enter any scheduled value that is missing with `WorkflowService.SetScheduleValue`.
- `ActivateWorkflow` each workflow that was active in Rails (`index.tsv` column 2). For workflows whose schedule should run, re-save it with `SaveSchedule` (`enabled: true`) after activation so `next_run_at` is computed.

## 4. One manual run per workflow

```sh
grpcurl -plaintext -d '{"workflow_id":"<id>","values":{"<input>":"<value>"}}' localhost:3000 glyph.v1.RunService/StartRun
grpcurl -plaintext -d '{"workflow_id":"<id>","run_id":"<run>"}' localhost:3000 glyph.v1.RunService/GetRun
```

Confirm `RUN_STATUS_SUCCEEDED` with the real Pi runner (`GLYPH_STEP_RUNNER=pi`, default) and real provider keys.

## 5. Switch traffic

1. `nix run .#deploy` (only when the owner asks) — builds `.#image`, pushes to GHCR, restarts `deployment/glyph`.
2. Set production env (see `backend/README.md`): `DATABASE_URL`, `GLYPH_ENCRYPTION_KEY` (new key, base64 32 bytes: `openssl rand -base64 32`), `VELOX_API_KEY`, `GLYPH_CORS_ORIGINS`, `GLYPH_PUBLIC_URL`, `GLYPH_LOG_JSON=true`.
3. Point DNS/ingress at v2. Keep Rails running read-only for run history; disable its Solid Queue recurring tasks so both systems never dispatch the same schedules.

## Verification log (2026-09-27)

| Check | Result |
|---|---|
| `nix run .#web` (fake runner) + grpcurl: 4-step diamond `StartRun` → `SUCCEEDED`, outputs flowed into resolved inputs | ✅ |
| `grpcurl -plaintext localhost:3000 list` shows 5 services + health + reflection | ✅ |
| `WatchWorkflow` via grpcurl prints `WORKFLOW_UPDATED` live on an edit | ✅ |
| `nix run .#seed` imports "Design POC Tournament"; second run is a no-op | ✅ |
| `nix build .#glyph` (offline sqlx, no protoc) | ✅ |
| `nix build .#image`, `podman load`, `podman run` against dev Postgres: `/up` ok, uid 1000, `/tmp` 1777, Pi 0.83.0 inside, diamond run `SUCCEEDED` | ✅ |
| Real Pi 0.83.0 CLI against a local OpenAI-compatible mock through the full stack: argv, models.json base URL, `--api-key`, `@prompt`, NDJSON → `SUCCEEDED` "pong"; key absent from logs (now automated: `tests/pi_contract.rs`) | ✅ |
| Real Pi against velox/omniroute | ⏳ not possible from the build machine (gateway hosts do not resolve there); do it on the homelab after deploy |
| Rails live-DB YAML exports import cleanly | ⏳ cutover step 2 (the Rails-authored `full.yml` fixture imports in tests) |
| `nix run .#deploy` | ⏳ not run (only on explicit request) |
