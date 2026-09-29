# 0013 — Epic: Glyph frontend (React + TypeScript + Vite)

## Story

The Rust backend (0002–0012) is done and exposes everything over a typed gRPC / gRPC-Web contract (`proto/glyph/v1/*.proto`) plus a few plain HTTP routes (download, preview, schema). This epic builds the web client in `frontend/`.

The Rails UI is **not** a reference for layout or interaction. We keep the product intent (`../glyph/features.md` principles and acceptance criteria) and the backend contract, and redesign the experience from the user's jobs.

## Users and their jobs

| Job | Question the user has | Where it is answered |
|---|---|---|
| Compose | "What does this workflow do and is it ready?" | Workflow workspace, Build mode |
| Operate | "What is running, what is broken, what runs next?" | Home (operations overview), sidebar status |
| Understand | "What exactly happened in this run and why did it fail?" | Workflow workspace, Run lens + step run panel |
| Maintain | "Let me change it safely, in bulk or by hand." | Definition mode (YAML), edits never touch past runs |

One owner, no auth (backend has none). Observer vs author is not modelled yet; every action is available.

## UX principles (new)

1. **One canvas, many lenses.** The DAG canvas is the persistent spine of a workflow. Build mode shows configuration state; selecting a run paints the same canvas with that run's evidence (Run lens). No separate "run grid" screen.
2. **Readiness is always visible.** A single readiness indicator in the workspace header counts blocking issues. Every issue deep-links to the exact entity and field. Actions that would fail (Activate, Run) explain why before you click.
3. **Edit in place, save continuously.** No save buttons for configuration. Field-level autosave with visible state (`Saving…`, `Saved`, `Couldn't save · Retry`). Backend returns the full aggregate after each mutation; the UI reconciles to it.
4. **Evidence first when something failed.** Failed runs open on the first failed step with the human error, then technical detail, then inputs/transcript.
5. **Every drag has a non-drag path.** Connections, moves and step creation are all reachable from keyboard and forms.
6. **Live by default.** Running work updates without refresh; the user's current selection, scroll and focus are never disrupted by an update.
7. **Operational calm.** Status uses one consistent vocabulary and color scale across list, canvas, timeline and panels.

## Information architecture

```
/                               Home: attention inbox, running now, upcoming, recent runs
/workflows/:id                  Workspace, Build mode (canvas + contextual panel)
/workflows/:id?step=:stepId     … with a step selected
/workflows/:id/runs             Workspace, Runs mode (run history list + timeline)
/workflows/:id/runs/:runId      Workspace, Run lens (canvas painted) + step run panel
/workflows/:id/runs/:runId?step=:stepRunId&view=graph|timeline
/workflows/:id/definition       Workspace, Definition mode (YAML)
```

Persistent app shell: left sidebar (workflow list with live status dots, search, "New"), top command palette (⌘K / Ctrl+K) for navigation and actions ("Run Weekly digest", "Go to Research step", "Activate"). URL holds all shareable UI state (mode, selection, run, view).

Workspace layout: header (name, status, readiness, primary action, mode switch) · canvas (center) · contextual panel (right, resizable, collapsible) · run strip (bottom: last N runs as status chips, click to enter the Run lens).

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Build | Vite + React 19 + TypeScript strict, pnpm | requested; fast dev server already wired in `nix run .#web` on :5173 |
| Contract | `protoc-gen-es` v2 (`buf generate`, config exists in `proto/buf.gen.yaml`) → `frontend/src/gen`, committed | typed messages + service descriptors, no extra plugin |
| Transport | `@connectrpc/connect-web` `createGrpcWebTransport` | backend speaks gRPC-Web natively; supports server streaming and `grpc-status-details-bin` decoding (`ConnectError.findDetails`) |
| Server state | TanStack Query + `@connectrpc/connect-query` | typed hooks per RPC, cache keys derived from descriptors |
| Routing | TanStack Router (file-based, typed search params) | URL is state; typed `?step=`/`?view=` |
| Canvas | `@xyflow/react` (React Flow) + `elkjs` for "Tidy up" | mature DAG editing, custom nodes/edges, a11y hooks |
| UI primitives | Radix UI primitives + Tailwind CSS v4, own component layer in `shared/ui` (shadcn-style, copied not installed) | accessible, themeable, no heavy kit |
| Code editor | Monaco + `monaco-yaml` (schema from `/schemas/workflow.json`) | YAML validation, hover docs, diff view for conflicts |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-sanitize` | agent output is untrusted |
| Cron preview | `croner` (browser, tz-aware) | preview next occurrences before saving; server stays authoritative |
| Tests | Vitest + Testing Library; `createRouterTransport` in-memory fake services; Playwright e2e against `GLYPH_STEP_RUNNER=fake nix run .#web`; axe for a11y | typed fakes instead of HTTP mocks |
| Boundaries | `eslint-plugin-boundaries` (or dependency-cruiser) | enforce feature rules like the backend architecture test |

## Frontend architecture

```
frontend/
├── index.html  vite.config.ts  tsconfig.json  package.json  playwright.config.ts
├── src/
│   ├── main.tsx
│   ├── gen/                      # generated from proto (committed, never edited)
│   ├── app/                      # providers, router tree, shell layout, error boundary
│   ├── routes/                   # TanStack Router file routes, thin: compose features
│   ├── features/
│   │   ├── home/                 # overview
│   │   ├── library/              # sidebar list, create/import dialog
│   │   ├── canvas/               # React Flow graph (build + run lens)
│   │   ├── editor/               # step editor, workflow settings, values, readiness, lifecycle
│   │   ├── schedule/
│   │   ├── runs/                 # run sheet, history, run lens panels, transcript, outputs
│   │   ├── definition/           # YAML mode, import
│   │   ├── catalog/              # model picker, tools
│   │   └── live/                 # WatchWorkflow subscription + invalidation
│   └── shared/
│       ├── api/                  # transport, error decoding, query client, enum labels
│       ├── ui/                   # design system components + tokens
│       └── lib/                  # time formatting, ids, hooks with no domain knowledge
└── e2e/
```

Rules (lint-enforced): `shared/*` imports nothing from `features/*`; features import other features only through their `index.ts`; only `shared/api` constructs the transport; components never call `fetch` directly; `gen/` is read-only.

## Spec index

| # | Spec | Delivers |
|---|---|---|
| 0014 | frontend-foundation | Vite project, tooling, codegen, transport, router, query, design tokens + primitives, app shell skeleton, test harness, flake/dev proxy |
| 0015 | data-layer-and-live-sync | query keys, aggregate-reconciling mutations, error model, autosave hook, `WatchWorkflow` live sync |
| 0016 | home-and-library | sidebar list, Home overview, command palette, create/import |
| 0017 | canvas | React Flow canvas: nodes, ports, edges, move, connect, delete, keyboard, tidy up, run lens rendering |
| 0018 | step-and-workflow-editing | step editor, prompt editor with variables, input source picker, model/tools, output; workflow settings, values, readiness, lifecycle |
| 0019 | schedule | schedule composer with preview, schedule values, pause/resume UX |
| 0020 | runs-and-evidence | run sheet, run strip + history, Run lens, step run panel (live transcript, outputs), timeline view, stop/retry/delete |
| 0021 | definition-yaml | Monaco YAML mode, dry-run lint, apply with fingerprint, conflict diff, export, import |
| 0022 | production-build-and-release | nginx frontend image + split deploy flakes (built), CSP, e2e + axe + bundle budget in `.#check`, acceptance audit |

## Parallelism

- Wave 0: 0014 (solo).
- Wave 1: 0015 ‖ design-system work inside 0014 finishing ‖ 0022 task 1 (backend static serving, independent).
- Wave 2: 0016 ‖ 0017 ‖ 0021 ‖ catalog picker from 0018 (all need only 0015).
- Wave 3: 0018 (needs canvas selection from 0017) ‖ 0020 run sheet + history (needs 0015 only).
- Wave 4: 0019 (lives inside the workflow settings panel from 0018) ‖ 0020 Run lens (needs 0017 lens hooks).
- Wave 5: rest of 0022.

Hotspots: `routes/` tree and `app/shell`; each feature exports its panels, routes stay thin. `shared/ui` changes go through one owner per wave.

## Definition of done

- Every acceptance criterion in `../glyph/features.md` ("Acceptance criteria", 14 items) demonstrated by a Playwright test against the fake runner.
- Every RPC in `proto/glyph/v1` used by at least one screen, or listed as intentionally unused (e.g. `GetSchemaUrl`).
- `nix run .#web` serves the frontend on :5173 against the backend; production image serves the built SPA from the backend on :3000.
- Keyboard-only walkthrough of create → configure → connect → activate → run → inspect passes; axe reports no serious violations.
- Lint boundaries, typecheck, unit and e2e green in `nix run .#check`.

## Non-goals

- Authentication, roles, multi-user presence.
- Undo/redo history (backend has no undo; destructive actions confirm instead).
- Mobile editing. Phone widths get a read-only operations view (Home, run status, step evidence); the canvas editor targets ≥ 1024px.
- i18n (English copy; backend messages are shown verbatim).
- Cross-workflow live stream: backend only streams per workflow; Home polls (see 0016). A `WatchAll` RPC is a possible later backend addition.

## Risks / assumptions

- Backend messages are user-facing copy and are shown verbatim; the frontend adds no parallel wording for validator issues.
- Every workflow mutation returns the full aggregate; the UI never patches cached workflows by hand except for optimistic canvas moves.
- `DuplicateStep` copies only some fields (backend parity with Rails); the UI says "Duplicated without model, tools and output settings."
- gRPC-Web streaming through the Vite dev proxy must not buffer; verified in 0014.
