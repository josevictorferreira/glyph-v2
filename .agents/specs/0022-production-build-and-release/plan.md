# 0022 — Production build, serving, release, acceptance audit

## Goal

Ship the SPA with the backend as one origin and one image, harden it (CSP, caching, error reporting), and prove the product acceptance criteria end to end.

## Depends on

0014 for task 1; everything for the audit.

## Design

### Backend static serving (small backend change)

- New config `GLYPH_STATIC_DIR` (optional). When set, the router adds a fallback service: `tower_http::services::ServeDir` with `index.html` fallback for SPA routes. Order: explicit backend HTTP routes (`/up`, `/schemas/...`, download, preview) and gRPC paths first; everything else → static/SPA.
- Headers: hashed assets under `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`; `index.html` → `no-cache`.
- CSP on SPA responses: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:` (Monaco workers). Preview route keeps its own stricter CSP.
- Tests: SPA deep link `/workflows/<id>/runs/<id>` returns index.html; download route still reaches the handler; unknown `/assets/x.js` → 404 (not index.html).

### Nix

- `frontend` derivation: `stdenv.mkDerivation` with `pnpm.fetchDeps` / `pnpm.configHook` (hash pinned), `pnpm build` → `$out` = `dist/`.
- `image` includes the frontend output and sets `GLYPH_STATIC_DIR=${frontend}`.
- `nix build .#frontend` exposed; `nix run .#web` unchanged (dev server on :5173).

### Build settings

- Vite: `build.target: es2022`, manual chunks for `monaco`, `@xyflow/react`, `elkjs` (web worker); source maps uploaded? No external service: emit hidden source maps kept out of the image.
- Bundle budget: main chunk ≤ 250 KB gzip; enforced by a size check in `.#check`.

### Quality gates in `nix run .#check`

- Unit tests, lint, typecheck, codegen drift (from 0014).
- Playwright e2e: boots Postgres + backend with `GLYPH_STEP_RUNNER=fake` and the built SPA via `GLYPH_STATIC_DIR` (tests the production path), runs the suite headless (Chromium from nixpkgs `playwright-driver.browsers`).
- axe checks on Home, workspace Build, Run lens, YAML mode: zero serious/critical violations.

### Error reporting

Top-level error boundary with "Reload" and copyable diagnostics (route, build hash, error). Console-only logging; no third-party telemetry.

### Acceptance audit

`.agents/specs/0022-production-build-and-release/acceptance.md`: each of the 14 acceptance criteria from `../glyph/features.md` → Playwright test name(s) → pass date. Plus the RPC coverage table (every RPC → screen or "intentionally unused").

## Tasks

1. Backend `GLYPH_STATIC_DIR` + SPA fallback + headers + tests → verify: backend integration tests above; architecture test still green (static serving lives in `app/router.rs`).
2. Nix `frontend` derivation + image wiring → verify: `nix build .#image`, `podman run` → `:3000` serves the app and gRPC-Web works same-origin.
3. Vite build config, chunking, bundle budget → verify: size check fails when budget exceeded.
4. Production-path e2e + axe in `.#check` → verify: green from clean clone.
5. Error boundary + diagnostics → verify: component test.
6. Acceptance audit + RPC coverage → verify: every row has a passing test.
7. Docs: root README + `frontend/README.md` + `frontend/AGENTS.md` (conventions from 0015, boundaries, testing) → verify: a new contributor runs `nix run .#web` and the e2e suite from the README alone.

## Acceptance

- `nix build .#image` produces one image serving API and UI on :3000.
- `nix run .#check` green including e2e and a11y.
- `acceptance.md` complete.

## Out of scope

CDN hosting, telemetry services, `nix run .#deploy` changes beyond image contents (deploy only when explicitly asked).
