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
pnpm e2e          # Playwright suite (starts the full stack via nix run .#web)
```

The full stack: `cd .. && nix run .#web` (Postgres + backend on :3000, this dev server on :5173). `GLYPH_STEP_RUNNER=fake` avoids provider keys.

On NixOS the Playwright-downloaded browser cannot run (missing system libs); point it at nixpkgs chromium instead:

```sh
PLAYWRIGHT_CHROMIUM_PATH="$(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium" pnpm e2e
```

The suite manages its own stack and refuses to run while :3000/:5173 are busy
(`nix run .#web` would kill whatever holds them). To run it against a stack you
started yourself, opt in — it must run the fake runner and the e2e mock:

```sh
GLYPH_STEP_RUNNER=fake VELOX_BASE_URL=http://localhost:9899/v1 nix run .#web &
node e2e/mock-velox.mjs &
E2E_REUSE_SERVER=1 pnpm e2e   # + PLAYWRIGHT_CHROMIUM_PATH on NixOS
```

## Environment

| Variable            | Default            | Purpose                                     |
| ------------------- | ------------------ | ------------------------------------------- |
| `VITE_API_BASE_URL` | `""` (same origin) | Backend base URL; the Vite proxy covers dev |

## Production image, CSP, budget, axe

- `frontend/Containerfile` builds the SPA (node 22 + pnpm) and serves it from
  `nginxinc/nginx-unprivileged:1.28`; `frontend/nginx/default.conf.template`
  is envsubst'd at start (`GLYPH_BACKEND_URL`). The nginx config serves the
  **Content-Security-Policy** on every document the frontend serves
  (`default-src 'self'; script-src 'self'; …`, see the template); proxied
  locations (backend artifact preview) never add a CSP header so the backend's
  stricter `default-src 'none'` preview policy reaches the browser untouched.
  `public/theme-init.js` is the pre-paint theme bootstrap kept as an external
  file precisely so `script-src 'self'` needs no hashes or 'unsafe-inline'.
- **Bundle budget**: `pnpm build` runs `scripts/bundle-size.mjs` (postbuild):
  the entry chunk must stay ≤ 850 KB gzip and every chunk under
  `dist/assets|workers/`. Monaco lives in lazy chunks loaded only by the
  definition/import routes; keep it that way.
- **axe**: `e2e/a11y.spec.ts` scans Home, workspace Build, Definition mode and
  a run's Evidence view with `@axe-core/playwright` and fails on any
  serious/critical violation. Both run in `nix run .#check` (which exports
  `PLAYWRIGHT_CHROMIUM_PATH` from nixpkgs chromium on any platform — needed on
  NixOS, harmless elsewhere unless overridden).

## Layout (enforced by ESLint boundaries)

- `src/gen` — generated protobuf code (read-only)
- `src/app` — providers, router, shell: the only place that names the transport
- `src/routes` — thin route components delegating to features
- `src/features/*` — one folder per feature; import from other features **only** through its `index.ts`
- `src/shared` — `api` (transport + enum helpers), `ui` (primitives, tokens), `lib`
- `test` — unit-test harness (fake gRPC transport, `renderWithApp`)
- `e2e` — Playwright specs

`/dev/ui` renders every primitive against the current theme tokens (dev-only showcase).
