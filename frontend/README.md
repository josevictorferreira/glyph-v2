# glyph web client

React + TypeScript SPA (Vite) that talks to the backend over gRPC-Web (binary proto). The API surface is generated from `../proto` into `src/gen` (committed — never edit by hand).

## Commands

```sh
pnpm install      # deps (node_modules)
pnpm gen          # regenerate src/gen from ../proto (buf + protoc-gen-es)
pnpm dev          # Vite dev server on :5173, proxies API calls to :3000
pnpm build        # production bundle (tsc -b && vite build)
pnpm lint         # ESLint (incl. architecture boundaries)
pnpm typecheck    # tsc --noEmit
pnpm test         # Vitest unit tests (jsdom)
pnpm e2e          # Playwright smoke (starts the full stack via nix run .#web)
```

The full stack: `cd .. && nix run .#web` (Postgres + backend on :3000, this dev server on :5173). `GLYPH_STEP_RUNNER=fake` avoids provider keys.

On NixOS the Playwright-downloaded browser cannot run (missing system libs); point it at nixpkgs chromium instead:

```sh
PLAYWRIGHT_CHROMIUM_PATH="$(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium" pnpm e2e
```

## Environment

| Variable            | Default            | Purpose                                     |
| ------------------- | ------------------ | ------------------------------------------- |
| `VITE_API_BASE_URL` | `""` (same origin) | Backend base URL; the Vite proxy covers dev |

## Layout (enforced by ESLint boundaries)

- `src/gen` — generated protobuf code (read-only)
- `src/app` — providers, router, shell: the only place that names the transport
- `src/routes` — thin route components delegating to features
- `src/features/*` — one folder per feature; import from other features **only** through its `index.ts`
- `src/shared` — `api` (transport + enum helpers), `ui` (primitives, tokens), `lib`
- `test` — unit-test harness (fake gRPC transport, `renderWithApp`)
- `e2e` — Playwright specs

`/dev/ui` renders every primitive against the current theme tokens (dev-only showcase).
