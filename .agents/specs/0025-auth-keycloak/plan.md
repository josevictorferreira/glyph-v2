# 0025 — Users and auth with Keycloak (plan)

## Goal

Every request to Glyph is made by a signed-in Keycloak user, and each user sees only their own workflows, runs, chats and settings. Keycloak owns everything about the user (credentials, profile, sessions, password reset, account page). Glyph stores one thing: the user's id (`sub`) on the rows they own.

When the session can no longer be refreshed, the browser goes to the Keycloak login and comes back to the page the user was on.

Not a Rails port: `../glyph` had no auth. Reference implementation is `../valoris` (Rails verifier, `oidc-client-ts` frontend, Keycloakify theme, homelab wiring).

## Depends on

0012 (deploy), 0015 (frontend data layer), 0022 (nginx image, CSP), 0024 (chat tables and the loopback agent API; task 2.6 waits for it).

## Decisions

Each is a default I picked from the request and from valoris. The ones marked **confirm** change the amount of work if reversed.

| # | Decision | Why / alternative |
|---|---|---|
| D1 | **Per-user isolation.** `owner_id` on `workflows`, `chats`, `app_settings`. Everything else (steps, inputs, runs, step runs, schedules, texts, chat messages) is owned through its parent. Another user's id answers `NOT_FOUND`, same as a missing row. **confirm** | "Store only the userId of the workflows and other data needed." Alternative: one shared workspace behind a login gate (drops phase 2 almost entirely). |
| D2 | **Dedicated realm `glyph`** on `identity.josevictor.me`, public client `glyph-frontend` (authorization code + PKCE, no secret). | Same shape as the `valoris` realm; a login theme is set per realm. |
| D3 | **Who can sign in:** any user of the `glyph` realm. Self-registration off; users are created in the Keycloak admin console. No roles in Glyph. | Smallest thing that works. A role gate can be added later with one claim check. |
| D4 | **Backend is a resource server only.** It verifies the bearer JWT offline (RS256, JWKS cached 10 min, refetch once on unknown `kid`), checks `iss`, `exp`, `azp`. It never calls Keycloak's admin API and never stores names or emails. | Same checks as `valoris/backend/app/lib/keycloak/token_verifier.rb`. |
| D5 | **Frontend uses `oidc-client-ts` + `react-oidc-context`**, tokens in `localStorage`, refresh-token renewal (no iframe). | Same as valoris. `localStorage` keeps tabs signed in; the cost is that an XSS could read the token. The app CSP (`script-src 'self'`) is the mitigation. |
| D6 | **Artifact download/preview use signed URLs**, not bearer tokens. The backend already returns `download_path` / `preview_path` in `StepRun`; it appends `?exp=…&sig=…` (HMAC-SHA256, 1 h). | An `<iframe src>` or `<a href>` cannot send an `Authorization` header. Alternative (fetch + blob URL) loses the preview's own `default-src 'none'` CSP header and breaks "open in new tab". |
| D7 | **Streams are authorised when opened**, not cut when the access token expires. | Cutting at `exp` would reconnect and resync every live view every 5 minutes. A revoked session keeps an already-open stream until it drops. |
| D8 | **Auth mode is explicit and fails closed.** `GLYPH_AUTH_MODE=oidc` (default) refuses to boot without issuer, JWKS URL and client id. `GLYPH_AUTH_MODE=disabled` runs every request as the nil-UUID user; the dev flake and the e2e stack set it. | Keeps `nix run .#web` key-free without letting a missing env var silently open production. |
| D9 | **Existing rows get `owner_id = 00000000-0000-0000-0000-000000000000`** in the migration; the cutover reassigns them to your `sub` with one `UPDATE`. | Migrations run at boot, before anyone has logged in, so the real id is not known yet. The nil owner is also the `disabled`-mode user, so dev data keeps working. |
| D10 | **Theme lives in `identity/`** in this repo (Keycloakify 11, like `valoris/identity` and `homelab/themes/homelab/identity`), ships as image `ghcr.io/josevictorferreira/glyph-identity`, loaded by a new initContainer in `homelab/modules/kubenix/apps/keycloak.nix`. Login theme first, account theme second. | Same delivery path as the three existing themes. |

## Design

### Request flow

```
browser ──(1) no session → redirect──▶ Keycloak /realms/glyph  (themed login)
        ◀─(2) /auth/callback?code=… ── code + PKCE → tokens (localStorage)
        ──(3) gRPC-Web, Authorization: Bearer <access token> ──▶ nginx ──▶ backend
                                                   verify JWT (JWKS from in-cluster svc)
                                                   Principal{user_id = sub} → handler
                                                   every query: … AND owner_id = $user
```

### Keycloak realm `glyph`

- Client `glyph-frontend`: public, standard flow only, PKCE `S256` required. Redirect URIs `https://glyph.josevictor.me/auth/callback`, `http://localhost:5173/auth/callback`. Post-logout URIs and web origins: the same two origins.
- Login: registration off, forgot password on, remember me on, login theme `glyph`, account theme `glyph` (after phase 4b).
- Tokens: access token 5 min (default). SSO session idle 30 days so a returning user is refreshed silently instead of logging in again.
- `identity/realm/glyph-realm.json` is the committed export: imported by the dev Keycloak, and the checklist for creating the realm by hand in production (homelab has no realm-as-code).

### Backend

New feature `features/auth` and adapter `infrastructure/keycloak`:

| Piece | Location | Notes |
|---|---|---|
| `UserId(Uuid)` | `shared/ids.rs` | Keycloak `sub`. `UserId::nil()` is the legacy/disabled owner. |
| `Principal { user_id }`, `AuthError` | `features/auth/domain.rs` | Pure. |
| `TokenVerifier` port | `features/auth/ports.rs` | `async fn verify(&self, token: &str) -> Result<Principal, AuthError>` |
| `KeycloakVerifier` | `infrastructure/keycloak/verifier.rs` | `jsonwebtoken` + `reqwest`; JWKS cache; redacts nothing because it never logs the token. |
| `StaticVerifier` | `infrastructure/keycloak/` or `auth` | Returns the nil principal; used by `disabled` mode. |
| Auth layer | `features/auth/http.rs` | Reads `Authorization: Bearer`, calls the port, inserts `Principal` into request extensions. |
| Wiring | `app/bootstrap.rs`, `app/router.rs` | Only place naming the adapter. |

Rules:

- Public paths, no token needed: `/up`, `/grpc.health.v1.Health/*`, `/schemas/workflow.json`. Reflection requires a token.
- The layer goes on the gRPC routes **inside** `GrpcWebLayer` (`bootstrap.rs:220-242`), so a rejection is a `tonic::Status::unauthenticated` that tonic-web re-frames for browsers. Plain HTTP routes answer `401`. Both stay inside the CORS layer so preflights and errors keep their CORS headers.
- gRPC handlers read the principal from `request.extensions()` and pass `UserId` as the first argument of every application command. Workers, scheduler and recovery keep unscoped internal paths: they never take ids from a client.
- New env: `GLYPH_AUTH_MODE`, `GLYPH_OIDC_ISSUER` (public URL, compared with `iss`), `GLYPH_OIDC_JWKS_URL` (in-cluster service URL: pods in `apps` cannot resolve the public hostname, see valoris `AGENTS.md`), `GLYPH_OIDC_CLIENT_ID` (compared with `azp`).
- New dependencies: `jsonwebtoken` (JWT + JWK) and `hmac` (signed URLs). Read their current docs before use; nothing else is added.
- Signed URLs: `sig = HMAC-SHA256(key, "{path}\n{exp}")`, key = `SHA-256("glyph-artifact-url-v1" ‖ GLYPH_ENCRYPTION_KEY)`, or random per boot when no encryption key is set. The two artifact routes check `exp` and `sig` (constant-time) instead of a bearer token. Wrong or expired → `401`.
- A scheduled run belongs to the workflow's owner. Model and tool catalogs stay global.

### Data

Migration `0011_owners.sql`:

```sql
ALTER TABLE workflows ADD COLUMN owner_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE workflows ALTER COLUMN owner_id DROP DEFAULT;
CREATE INDEX index_workflows_on_owner_id_and_updated_at ON workflows (owner_id, updated_at DESC);
-- same two statements for chats (index on owner_id, updated_at DESC)
-- app_settings: add owner_id the same way, primary key becomes (owner_id, key)
```

No users table, no foreign key: the id points at Keycloak.

### Frontend

- `features/auth/`: `config.ts` (reads `window.__GLYPH_ENV__`, falls back to `VITE_OIDC_*`; `isAuthEnabled` false when unset), `user-manager.ts`, `AuthGate.tsx`, `UserMenu.tsx`, `token.ts`.
- `AuthGate` wraps the app in `__root.tsx`. Not signed in → `signinRedirect({ state: { returnTo: pathname + search + hash } })`, called from an effect, never during render (valoris lesson). `routes/auth.callback.tsx` finishes the code exchange and navigates to `returnTo`.
- Transport interceptor in `shared/api/transport.ts`:
  1. Before a call: if the access token is expired, run one shared `signinSilent()` (refresh grant) for all waiting calls.
  2. Attach `Authorization: Bearer`.
  3. On `Code.Unauthenticated` for a unary call: refresh once and retry once. This is safe under the no-retry rule because the handler never ran.
  4. If the refresh fails (refresh token or SSO session expired): `signinRedirect` with the current location as `returnTo`. After login the user lands on the same page.
- Streams (`WatchWorkflow`, chat) get the fresh token through the same interceptor when their existing backoff loop reconnects.
- `AppError` gains `{ kind: "unauthenticated" }`; screens show nothing for it because the redirect is already under way.
- `UserMenu` in the shell: name and email from the ID token, "Account" → `${authority}/account`, "Sign out" → `signoutRedirect()`.
- Runtime config without an entrypoint script: nginx answers `location = /config.js` from the template with `GLYPH_OIDC_AUTHORITY` and `GLYPH_OIDC_CLIENT_ID`; `index.html` loads it before the app. Both CSP copies get `connect-src 'self' ${GLYPH_OIDC_ORIGIN}`.
- Known edge: an unsaved autosave draft is lost if the session dies mid-edit, because the flush cannot authenticate. Accepted for now.

### Theme (`identity/`)

- Keycloakify 11 + Vite + Tailwind 4, `themeName: "glyph"`, copied from the valoris layout: `src/login/{KcPage,Template,main.css,i18n}.tsx`.
- `main.css` mirrors `frontend/src/shared/ui/tokens.css`: the `--c-*` neutrals, accent `#5b5bd6` / `#7b7bee`, 10px card radius, system font stack, 14px root. Light and dark follow `prefers-color-scheme` (the app's stored toggle lives on another origin and cannot be read).
- `Template.tsx`: canvas background, centred surface card, Glyph wordmark, "Back to Glyph" link from an env var (`GLYPH_APP_URL`). Buttons, inputs and alerts match `shared/ui/{button,input,feedback}.tsx`.
- Pages covered through `DefaultPage` + the template: login, reset password, update password, verify email, logout confirm, error, info. Storybook stories for each.
- Account theme (4b): Keycloakify Single-Page account UI with PatternFly variables mapped to the same tokens.
- `identity/Containerfile`: `alpine` + `/theme.jar`, as valoris. `identity/flake.nix` with `nix run .#build-push` (versioned tag, no `latest`: the Keycloak initContainer pins a version).

### Infra (`../homelab`, through GitOps)

- `modules/kubenix/apps/keycloak.nix`: initContainer `add-glyph-theme` copying `/theme.jar` to `/shared/glyph-theme.jar`.
- `modules/kubenix/apps/glyph.nix`:
  - backend env: `GLYPH_OIDC_ISSUER=https://identity.josevictor.me/realms/glyph`, `GLYPH_OIDC_JWKS_URL=http://keycloak.apps.svc.cluster.local:8080/realms/glyph/protocol/openid-connect/certs`, `GLYPH_OIDC_CLIENT_ID=glyph-frontend`.
  - frontend env: `GLYPH_OIDC_AUTHORITY`, `GLYPH_OIDC_CLIENT_ID`, `GLYPH_OIDC_ORIGIN=https://identity.josevictor.me`.
- `oidc.md`: add the `glyph` realm and a Glyph row.
- Keycloak picks up a new theme jar only on pod restart: delete the pod (Flux reverts `rollout restart`).

### Dev

- `nix run .#web` exports `GLYPH_AUTH_MODE=disabled` unless already set; Playwright's stack inherits it. Existing tests keep running without Keycloak.
- `nix run .#keycloak`: podman `quay.io/keycloak/keycloak:26.8.2 start-dev --import-realm` on `:8080`, importing `identity/realm/glyph-realm.json` (with a `dev` / `dev` user) and mounting the built theme jar. `GLYPH_AUTH_MODE=oidc nix run .#web` then runs the real flow locally.

## Tasks

One commit per task, `feat(0025): <task title>`, tests first. After any SQL change: `db_start && db_migrate && sqlx_prepare` from the repo root shell and commit `.sqlx/`.

### Phase 1 — backend authentication

1. **Auth domain and port**: `UserId`, `Principal`, `AuthError`, `TokenVerifier`. → verify: unit tests; `tests/architecture.rs` green.
2. **Config**: the four env vars and mode parsing. → verify: unit tests: `oidc` with a missing var is an error, `disabled` needs none.
3. **Keycloak verifier**: test RSA key pair and JWKS in `tests/fixtures/`, JWKS served by wiremock. → verify `tests/auth.rs`: valid token passes; wrong signature, wrong `iss`, wrong `azp`, expired, `alg=none`, HS256 are rejected; unknown `kid` triggers exactly one refetch; the token never appears in captured logs.
4. **Auth layer + wiring**: layer on gRPC routes inside `GrpcWebLayer` and on HTTP routes; `disabled` mode uses `StaticVerifier`; test helpers mint tokens for users A and B. → verify: `tests/contract.rs` asserts every declared RPC answers `UNAUTHENTICATED` without a token, over native gRPC and gRPC-Web; `/up`, health and the schema stay public.

### Phase 2 — ownership

1. **Migration `0011_owners.sql`** → verify `tests/schema.rs`: columns `NOT NULL`, existing rows get the nil owner, settings key is unique per owner.
2. **Workflows scoped by owner**: create/import set the owner; list filters; every by-id editor, definition and schedule RPC scopes its load. → verify `tests/workflows.rs`, `tests/definition.rs`: user B gets `NOT_FOUND` on each RPC against A's workflow and an empty list.
3. **Runs and live scoped by owner**: start/cancel/get/list runs and step runs, `WatchWorkflow`. → verify `tests/runs.rs`, `tests/live.rs`: B gets `NOT_FOUND`; a scheduled dispatch still runs A's workflow (`tests/scheduling.rs`).
4. **Chats and settings scoped by owner** → verify: B cannot list, read or post to A's chat; each user reads their own `chat_model_id`.
5. **Signed artifact URLs** → verify: path from `GetRun` downloads without a bearer token; tampered `sig`, tampered path and past `exp` answer `401`; bare path answers `401`.
6. **Agent API acts as the chat owner** (after 0024's agent routes exist): the turn job puts a random per-turn token in Pi's allow-listed env; `/agent/v1/*` resolves it to the chat owner and rejects anything else. → verify: a turn for A's chat cannot read B's workflow; a call without the token answers `401`.

### Phase 3 — frontend

1. **Auth config, user manager, runtime `config.js`**; add `oidc-client-ts`, `react-oidc-context`. → verify: unit tests for config fallback and `isAuthEnabled`.
2. **`AuthGate` + `/auth/callback`** → verify: component tests: unauthenticated render calls `signinRedirect` once with `returnTo`; callback navigates to `returnTo`; auth disabled renders children.
3. **Transport interceptor** → verify with `fakeTransport`: header attached; expired token refreshes once for N concurrent calls; `Unauthenticated` retries once; failed refresh redirects with the current location.
4. **`unauthenticated` error kind + `UserMenu`** → verify: `errors.test.ts`; menu shows token claims and both actions.
5. **nginx template and CSP** → verify: built image serves `/config.js` with the env values; `connect-src` contains the identity origin; `e2e` suite green in `disabled` mode.

### Phase 4 — theme

1. **4a. Login theme**: scaffold `identity/`, template, CSS tokens, stories, Containerfile, flake. → verify: `npm run build-keycloak-theme` produces the jar; Storybook pages reviewed side by side with the app in light and dark; dev Keycloak shows the themed login.
2. **4b. Account theme** → verify: account console themed in the dev Keycloak; password change works.
3. **Dev Keycloak app + realm export** (`nix run .#keycloak`) → verify: full local loop: login, land on the deep link opened first, refresh after 5 min, sign out. Deleting the Keycloak session, then acting in the app, returns to login and back to the same page.

### Phase 5 — infra and cutover

1. **Homelab changes** (keycloak initContainer, glyph env, `oidc.md`) → verify: `kubectl exec keycloak-0 -- ls /opt/keycloak/providers/` lists `glyph-theme.jar`; JWKS URL answers 200 from the glyph pod.
2. **Runbook `cutover.md`** in this spec folder, executed only when asked:
   1. Push `glyph-identity`, merge homelab, restart Keycloak.
   2. Create realm `glyph` from the checklist, create your user, select the themes.
   3. Deploy frontend and backend together (`nix run .#deploy` in each).
   4. Log in, read your `sub` from the account page, then `UPDATE workflows|chats|app_settings SET owner_id = '<sub>' WHERE owner_id = '00000000-0000-0000-0000-000000000000'`.
   5. Check: schedules still dispatch; an old run's artifact downloads.
3. **Docs**: root `AGENTS.md` (auth rules under the safety section, new commands), `backend/README.md` env table, `frontend/AGENTS.md`.

## Acceptance

- Without a token every RPC answers `UNAUTHENTICATED`; with user B's token, A's workflows, runs, chats, streams and artifacts are unreachable.
- Opening `https://glyph.josevictor.me/workflows/<id>/runs/<run>` signed out shows the Glyph-themed Keycloak login and returns to that exact URL.
- With the refresh token expired, the next action redirects to login and returns to the same page.
- The database holds no user data other than `owner_id` values.
- `nix run .#check` and the e2e suite are green with auth disabled; `tests/auth.rs` covers the real verifier.

## Out of scope

Sharing workflows between users, teams/organisations, roles and admin screens, an `actor_id` on audit events, social/external identity providers, email theme, service-account (machine) access, realm-as-code in homelab, cutting open streams on logout.
