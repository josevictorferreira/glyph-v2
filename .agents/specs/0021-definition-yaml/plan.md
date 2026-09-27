# 0021 — Definition mode (YAML)

## Goal

A first-class text editing mode for workflows: schema-aware YAML editor with live validation, safe apply with optimistic concurrency and a clear conflict path, export, and the shared import flow.

## Depends on

0015. (Import dialog lives in 0016 and reuses this spec's editor component.)

## Design

### Editor

- Monaco (lazy-loaded chunk, only in this mode and the import dialog) with `monaco-yaml`; schema loaded from `/schemas/workflow.json` (same origin) → completion, hover descriptions, structural errors.
- Semantic validation: debounced (500ms) `ParseDefinition{workflow_id, yaml}`; each `DefinitionError` becomes a Monaco marker at `line` (whole line), errors without line appear in a problems list under the editor. Problems list items jump to the line.
- Source of truth on entry: `ExportDefinition` → text + `fingerprint`. Dirty indicator vs exported text.

### Apply

- "Apply changes" (⌘S) → `ApplyDefinition{workflow_id, yaml, fingerprint}`.
  - Success: replace the workflow cache with the response, store `new_fingerprint`, re-export to normalize text (the editor shows server formatting; cursor kept at the same line), toast "Applied", readiness issues shown in the side problems list.
  - `INVALID_ARGUMENT` + `DefinitionErrors`: markers as above, nothing applied.
  - `ABORTED` (stale): conflict view.
- Live `WORKFLOW_UPDATED` while the editor is clean → silently re-export. While dirty → banner "This workflow changed elsewhere" with Review.

### Conflict view

Monaco diff editor: left = latest server export, right = your text. Actions: "Keep editing on top of latest" (sets base to the latest fingerprint, keeps your text for manual merge), "Discard mine" (load latest), "Overwrite" (confirm; applies with the latest fingerprint, i.e. your text wins).

### Export / download

- "Download .yml" uses `ExportDefinition.filename` and a Blob.
- "Copy" to clipboard.
- Leaving the mode with unapplied changes prompts (route blocker).

## Tasks

1. Lazy Monaco + monaco-yaml with schema from backend → verify: bundle analysis shows Monaco not in the main chunk; hover shows schema descriptions.
2. Dry-run markers + problems list → verify: tests mapping `DefinitionError` to markers; e2e unknown key shows `"bogus" is not a known key here.` on the right line.
3. Apply success/invalid paths + normalization → verify: e2e edit prompt in YAML, apply, Build mode reflects it.
4. Conflict detection + diff view + three resolutions → verify: e2e: change name in Build tab B, apply stale YAML in tab A → diff shown; each action behaves.
5. Download/copy + unsaved-changes blocker → verify: tests.
6. Editor component reused by import dialog (0016) → verify: import dialog uses the same markers pipeline without `workflow_id`.

## Acceptance

- Round trip: export → apply unchanged → no issues change, fingerprint stable, no conflict.
- Rails-exported YAML (`backend` import fixtures) pastes into import and creates a workflow.

## Out of scope

Collaborative real-time editing.
