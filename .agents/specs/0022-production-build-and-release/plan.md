# 0022 — Production build, serving, release, acceptance audit

## Goal

Two production images (backend binary + nginx frontend), the frontend hardened with a CSP, quality gates (e2e + axe + bundle budget) in `nix run .#check`, and the epic's acceptance audit written from passing tests.

## Depends on

0014 for tooling; every screen spec (0015–0021) for the audit.

## Design

### Serving (already built — this spec follows reality, not the reverse)

The app ships as **two services**, both deployed from their own directory flake (`cd backend && nix run .#deploy`, `cd frontend && nix run .#deploy`; never run unless asked):

- `backend/Containerfile` — the Rust binary image (root flake `.#image` mirrors it via `dockerTools`).
- `frontend/Containerfile` — build stage (node 22, pnpm) → `nginxinc/nginx-unprivileged:1.28`. The frontend is the user-facing origin: it serves `dist/` and reverse-proxies `/(glyph\.v1\.|grpc\.)`, `/schemas/`, `/up` and artifact download/preview to `GLYPH_BACKEND_URL` (envsubst at start). gRPC-Web passes through with `accept-encoding: identity`, buffering off and long read timeouts (mirrors the Vite dev proxy); `/assets/` are `immutable` with real 404s; `index.html` is `no-cache`; unknown paths fall back to `index.html`.

The earlier design (backend `GLYPH_STATIC_DIR` + one image) was dropped for the split: it matches the deployment flow the rest of the fleet uses and keeps the backend image frontend-free. No backend change is needed in this spec.

### CSP (this spec's work)

One policy, served by nginx on the document (SPA fallback included, so it lands on every route):

```
default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self' data:;
  connect-src 'self';
  worker-src 'self' blob:;
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none'
```

`worker-src blob:` for Monaco's workers, `'unsafe-inline'` in `style-src` for component style attributes. The backend's artifact preview keeps its own stricter `default-src 'none'` CSP (already shipped; nginx must not override it — the frontend policy is added with `add_header` only on locations the frontend serves, and the preview location adds no CSP header of its own).

### Quality gates in `nix run .#check`

Appended after today's gates (buf, backend fmt/clippy/deny/test, frontend gen/lint/typecheck/vitest):

- `pnpm build` — the production build must compile; it also produces the sizes for the budget below.
- Bundle budget: `frontend/scripts/bundle-size.mjs` fails if the main entry chunk exceeds **850 KB gzip** (measured baseline: 819 KB; Monaco lives in lazy chunks that only the definition/import routes load) or if any chunk appears outside `dist/assets/` and `dist/workers/`.
- `pnpm e2e` — the Playwright suite against the dev stack with the fake runner (`GLYPH_STEP_RUNNER=fake` + mock Velox, already wired in `playwright.config.ts`; the port guard refuses to run over a hand-started dev stack unless `E2E_REUSE_SERVER=1`). On NixOS the check exports `PLAYWRIGHT_CHROMIUM_PATH` from nixpkgs chromium, since the Playwright-downloaded browser cannot run.
- axe (`@axe-core/playwright`) is part of the e2e suite (`e2e/a11y.spec.ts`): Home, workspace Build, Definition mode and a run's Evidence view must report **zero serious/critical violations**.

### Error boundary

Root route `errorComponent`: app-styled page with a Reload button and copyable diagnostics (path, error message, stack). Component test renders it. No third-party telemetry.

### Acceptance audit

`.agents/specs/0022-production-build-and-release/acceptance.md`:

- each of the 14 acceptance criteria from `../glyph/features.md` → the Playwright test(s) that demonstrate it (all must exist and pass; the audit only records the mapping);
- RPC coverage table: every method in `proto/glyph/v1/*.proto` → the screen/hook that calls it, or "intentionally unused" with the reason;
- keyboard-only walkthrough: the dedicated keyboard tests (canvas: select/nudge/duplicate/menu; dialogs; toasts) plus the axe scan on the four audited views.

## Tasks

1. CSP in `frontend/nginx/default.conf.template` → verify: build the image with podman, load it, `curl -I` shows the header on `/` and SPA deep links, app boots in the browser, backend preview still carries its stricter CSP.
2. `@axe-core/playwright` + `e2e/a11y.spec.ts` on the four views → verify: suite green; a deliberately injected violation fails the check (smoke, then removed).
3. `frontend/scripts/bundle-size.mjs` (gzip, entry-chunk cap 850 KB, assets stay under `/assets|workers/`) wired into `.#check` together with `pnpm build` and `pnpm e2e` (chromium path exported) → verify: `nix run .#check` green from clean ports; budget script fails on an oversized fixture.
4. Error boundary + diagnostics → verify: component test.
5. Acceptance audit + RPC coverage table → verify: every criterion row names a passing test; every proto method appears exactly once.
6. Docs: root README (check now runs e2e; browsers on NixOS) and `frontend/README.md` (CSP location, budget, axe) → verify: instructions run as written.

## Acceptance

- `nix run .#check` green end to end, including build, budget, e2e and axe.
- Frontend image serves the CSP on every document response.
- `acceptance.md` complete: 14/14 criteria mapped to passing tests, full RPC coverage table, keyboard walkthrough recorded.

## Out of scope

CDN hosting, telemetry, production-path e2e against the nginx image (podman-in-check is too heavy; the image is smoke-tested in task 1), deploy automation changes.
