# 0014 — Frontend foundation

## Goal

A running Vite + React + TypeScript app in `frontend/` with generated contract types, a gRPC-Web transport, router, query client, design tokens, base UI primitives, the empty app shell, and a test harness. `nix run .#web` serves it on :5173 against the backend.

## Depends on

Backend (done). `proto/buf.gen.yaml` already targets `frontend/src/gen`.

## Scope

- Project scaffold: `package.json` (pnpm), `vite.config.ts`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, path alias `@/` → `src/`), ESLint (typescript-eslint, react-hooks, boundaries), Prettier.
- Codegen: `pnpm gen` = `buf generate` from `proto/` using `node_modules/.bin/protoc-gen-es`; output committed in `src/gen`.
- `shared/api/transport.ts`: `createGrpcWebTransport({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "", useBinaryFormat: true })`.
- `app/providers.tsx`: `TransportProvider` (connect-query), `QueryClientProvider`, `RouterProvider`, theme provider.
- TanStack Router with file routes for the IA in 0013 (placeholder pages).
- Design tokens + primitives (below).
- App shell skeleton: sidebar slot, header slot, main outlet, global toaster, command palette mount point (empty).
- Test harness: Vitest + jsdom + Testing Library, `test/fakeTransport.ts`, Playwright config.
- Nix/dev wiring: Vite proxy, `.#check` additions.

## Design

### Dev proxy (same-origin in dev and prod)

`vite.config.ts` proxies to `http://localhost:3000`:
- `^/glyph\.v1\.` and `^/grpc\.` (gRPC-Web service paths),
- `^/workflows/[^/]+/runs/[^/]+/step_runs/[^/]+/(download|preview)$`,
- `/schemas`, `/up`.

Same origin means download/preview links are plain relative `href`s and CORS is not involved. Streaming check: proxy must not buffer `application/grpc-web+proto` responses (set `proxyTimeout: 0`, no compression). `GLYPH_CORS_ORIGINS` stays for direct cross-origin use.

### Design tokens (`shared/ui/tokens.css`, Tailwind v4 `@theme`)

- Neutral scale, one accent, and a **status scale** shared by everything: `queued` (neutral), `running` (accent, animated), `succeeded` (green), `failed` (red), `skipped` (neutral striped), `cancelled` (neutral muted), plus workflow statuses `draft` (neutral), `active` (green), `paused` (amber), `needs-attention` (red-orange).
- Light and dark themes via `data-theme`, default follows `prefers-color-scheme`, toggle persisted in `localStorage`.
- Type: one sans for UI, one mono for prompts/outputs/YAML. Density: compact (14px base) for the workspace.
- Motion: 150ms ease-out; respects `prefers-reduced-motion`.

### Primitives (`shared/ui/`)

Button, IconButton, Input, Textarea (auto-grow), Select, Combobox, Switch, Checkbox, Tabs, Dialog, Sheet (side panel), Popover, Tooltip, DropdownMenu, ContextMenu, Toast, Badge, StatusDot, StatusBadge (maps proto enums → token + label), Kbd, EmptyState, Skeleton, ResizablePanels, Disclosure, CopyButton, RelativeTime (live-updating, exact time in tooltip), Duration.

`shared/api/enums.ts`: exhaustive `switch` maps for every proto enum → label + tone. Unspecified values render as "Unknown" and log once.

### Fake transport for tests

```ts
export function fakeTransport(impl: Partial<{ [S in Service]: Partial<ServiceImpl<S>> }>) {
  return createRouterTransport(({ service }) => { /* register provided impls, others throw Unimplemented */ });
}
export function renderWithApp(ui, { transport, route })  // wraps providers + memory router
```

### Nix

- `nix run .#web` already runs `pnpm install --frozen-lockfile && pnpm dev` when `frontend/package.json` exists. Update the banner to print `http://localhost:5173`.
- `nix run .#check` adds: `pnpm install --frozen-lockfile`, `pnpm gen && git diff --exit-code frontend/src/gen`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- `.gitignore`: `frontend/node_modules`, `frontend/dist`, `frontend/test-results`, `frontend/playwright-report`.

## Tasks

1. Scaffold Vite React-TS with pnpm, strict tsconfig, ESLint/Prettier → verify: `pnpm build` and `pnpm lint` clean.
2. `pnpm gen` + committed `src/gen` → verify: generated services import in a smoke test; `.#check` fails when proto changes without regen.
3. Transport + providers + router placeholder routes → verify: a dev page calls `CatalogService.ListTools` through the proxy and renders 4 tools; `WatchWorkflow` stream receives a HEARTBEAT through the proxy (backend with `GLYPH_LIVE_HEARTBEAT_SECONDS=2`).
4. Tokens, themes, primitives → verify: `/dev/ui` route (dev only) showcases every primitive in both themes; component tests for StatusBadge exhaustiveness.
5. App shell skeleton → verify: navigating between placeholder routes keeps the shell mounted.
6. Test harness (fake transport, render helper, Playwright config booting against a running `nix run .#web`) → verify: one unit test with fake transport, one e2e that loads `/`.
7. Boundaries lint rules from 0013 → verify: a deliberate `features/runs` → `features/canvas/internal` import fails lint.
8. Flake banner + `.#check` wiring + README frontend section → verify: `nix run .#check` green.

## Acceptance

- Fresh clone: `nix run .#web` → open `:5173`, shell renders, dev page lists tools from the real backend.
- `nix run .#check` covers frontend lint, typecheck, unit tests and codegen drift.

## Out of scope

Feature screens (0016+), production serving (0022).
