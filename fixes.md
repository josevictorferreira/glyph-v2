# Adversarial UX Test — Glyph (2026-09-30)

**Method:** hostile-persona session against `nix run .#web` (backend :3000, Vite :5173), headless Chromium 153 via CDP, 49 screenshots captured to `.agents/ux-audit-2026-09-30/`. Real workflows created, runs executed (one full "Design POC Tournament" duplicate + run + failure triage), schedules created and removed, mobile + dark-mode passes, WCAG contrast/target-size probes on both themes.

---

## The Persona

**"Dona Célia" Fontoura** — 58. Art director at a mid-size agency, now tasked with running the "Design POC Tournament" because "the young man who set it up left". Uses WhatsApp, Excel (printouts), and Canva. Her words: *"Se eu precisar ler duas vezes, está errado."* One job: **run the tournament weekly, see who won, and fix it when it breaks.** Gives up when: jargon, dead ends, anything that looks frozen, being asked to interpret two contradictory signals at once.

---

## Célia's Review of Glyph

**Overall: Maybe — if the dead ends get fixed.** The happy path genuinely works; the unhappy paths lie to her.

**THE GOOD (grudging admission):**

- The canvas is the workflow. She duplicated "Design POC Tournament", hit **Run now**, and *watched the boxes change color by themselves*. "Okay. That is nice." (`08`, `12`)
- When a step failed, it said **"The selected model or provider could not complete the step."** — a sentence for humans — and hid the scary text behind "Technical detail". (`14`, `15`)
- Leaving the YAML editor with unsaved changes asked **"Discard unapplied changes?"** before throwing her work away. (`22`)
- The schedule dialog shows the **next 5 run times** in *her* timezone and refuses absurd input ("The recurrence is out of range."). (`25`, `26`)
- Empty states talk to her: "No workflows match.", "This workflow has not run. Start one to see its evidence here." (`48`)
- Starting a run without the required brief was blocked with "Provide a value for this run." — not a stack trace. (`11`)

**THE BAD (legitimate UX issues):**

- "Needs attention" means two different things. **Home** lists 3 workflows needing attention; the **sidebar filter with the same name says "No workflows match."** She thinks the app is broken. It is. (`48`, see ticket 1)
- A wrong/stale URL shows a **pulsing gray skeleton and "Connecting…" forever**. No "not found", no way back except the sidebar. She will call someone. (`16`, ticket 2)
- After removing the schedule, the header says **"Needs attention"** *and* **"Ready"** at the same time, and the readiness sheet says "Everything is ready" — then offers **Activate** on a workflow that is already Active. She clicked it, it fixed itself. She has no idea why. (`38`–`40`, ticket 3)
- The retried run now says **"Duration 14h 05m"** for a retry that took one second. The evidence — the thing this app promises is immutable truth — is wrong. (`43`, `47`, ticket 4)
- On her phone the menu drawer **stays open covering the screen** after she picks a workflow. (`31`, ticket 6)
- Tiny text in the status pills ("Ready", "Needs attention") is **low-contrast gray-green on white** — and she has bifocals. (`32`, ticket 7)
- The filter chips are 20 px tall. Her finger covers three of them. (ticket 8)

**THE UGLY (showstoppers):**

- **Console fills with unhandled errors** on the YAML editor (`Missing requestHandler or method: doValidation`, `findLinks`). Nothing she can see — until support asks her for the console and the app looks negligent. (ticket 5)
- **You cannot add a step with the keyboard.** The "+ Step" menu items are plain `div`s. (`44`–`45`, ticket 9)

**SPECIFIC COMPLAINTS:**

1. Home → "Fix": *"Fix WHAT? WHERE?"* — it dumps her on the Build tab, not the broken step. (`41`)
2. Sidebar: 100 of 330 workflows, silently. *"Where are the others? Am I missing one?"* (ticket 10)
3. Every browser tab says **"Glyph"**. Six tabs, no idea which is which.
4. "Delete" on a run confirmation doesn't look dangerous — same gray as "Cancel". (`18`)

**VERDICT:** *"Quando funciona, é bonito. Quando quebra, ele mente para a minha cara."* (When it works it's pretty. When it breaks, it lies to my face.)

---

## Pragmatism Filter (Step 4 — mandatory)

| # | Complaint | Verdict | Reasoning |
|---|---|---|---|
| 1 | "Needs attention" filter empty vs Home | **RED** | Two definitions of the same concept in `Sidebar.tsx` vs `summaries.ts`; any user hits it |
| 2 | Skeleton forever on bad workflow id | **RED** | 404 handled by API, never by UI; `Workspace.tsx` has no error branch |
| 3 | Needs-attention + Ready contradiction | **RED** | Stale workflow status vs live validation; recovery path exists but is undiscoverable |
| 4 | 14h duration after 1s retry | **RED** | Evidence integrity — this product's core promise |
| 5 | Monaco worker rejections | **RED** | Real errors on every YAML editor mount |
| 6 | Mobile drawer doesn't close | **RED** | Any mobile user; one-line fix |
| 7 | Badge contrast (light + dark) | **RED** | WCAG AA fail, measured 3.22–4.15:1 |
| 8 | Sub-24px targets | **RED** | WCAG 2.2 target size; measured 16–21px |
| 9 | Keyboard-inaccessible canvas menus | **RED** | `div` onClick menu items; also no skip link (161 focusables before main) |
| 10 | Silent 100-item cap in sidebar | **GREEN** | Real gap once >100 workflows; show count + search-first |
| 11 | "Fix" doesn't deep-link to failed step | **YELLOW** | Friction, not breakage; readiness deep-link infra already exists |
| 12 | Static `document.title`, no h1 on workspace | **YELLOW** | Tab/SR navigation suffers; cheap fix |
| 13 | Delete confirm not styled destructive | **YELLOW** | Confirm exists (good); visual weight missing |
| 14 | Clipboard failure silently swallowed | **YELLOW** | `catch {}` in `CopyButton`; user thinks it copied |
| 15 | React Flow attribution warning every load | **YELLOW** | Licensing/console hygiene |
| 16 | Runs stuck "Running · 14h" after backend restart | **YELLOW** | Backend reconciliation gap; UI could flag "stalled" |
| 17 | e2e residue in dev DB (82 items) | **WHITE** | Test-env artifact, not product — but motivates GREEN 10 |
| 18 | "DAG", "cron", "helper step" jargon | **WHITE** | Target user is a builder; canvas already mitigates |
| 19 | "I don't want YAML" | **WHITE** | YAML is optional (Duplicate/Blank paths exist) |

---

## Tickets (max 10 — RED + GREEN only)

### 1. [RED] Sidebar "Needs attention" filter shows nothing while Home shows attention workflows
> *"Your left panel calls me a liar, your right panel calls me a liar — one of them is wrong."*

- **Objective:** `frontend/src/features/library/Sidebar.tsx:24` sends `status = WorkflowStatus.NEEDS_ATTENTION` to `ListWorkflows` (server `WHERE status = $2`). But `needsAttention()` in `frontend/src/features/library/summaries.ts:75` (used by Home) = `status === NEEDS_ATTENTION || lastRunStatus === FAILED`. DB state at test time: 0 rows `needs_attention`, 10 rows active+last_run_failed → Home lists 10, sidebar filter lists 0.
- **Fix:** one definition, two places. Either the server filter also matches `last_run_status = 'failed'` (proto change), or the sidebar fetches like Home and filters client-side with `needsAttention()`.
- **Verify:** with 10 failed-active workflows: chip shows them; count matches Home's attention section.

### 2. [RED] Missing/deleted workflow id = infinite skeleton, no not-found state
> *"It's been 'Connecting…' for a minute. Is it my internet? Is it dead? Who knows!"*

- **Objective:** `GET /workflows/00000000-…` → backend correctly returns `NOT_FOUND`, but `WorkspaceHeader.tsx:36` renders a pulse block whenever `data?.workflow` is falsy and `Workspace.tsx:83` renders `<Skeleton/>` for `isLoading || !data?.workflow` — the query error is never read; `retry: 1` (`app/providers.tsx:16`) even retries the 404. Result: pulsing header + "Connecting…" + "No runs yet" forever (screenshot `16`).
- **Fix:** branch on `isError`/`error.code === NotFound` → "Workflow not found" state with a link Home. Consider `throwOnError` + the existing route error component (`app/route-error.tsx` already exists — wire it).
- **Verify:** navigate to a random-UUID URL → friendly not-found within 1s, link back to Home.

### 3. [RED] Contradictory "Needs attention" + "Ready" and undiscoverable recovery
> *"It says attention! It says ready! Which one do I trust?!"*

- **Objective:** removing the schedule while a required run-value exists flags the workflow `needs_attention` (event `WorkflowNeedsAttention`); but with the schedule now gone, `validator::check_schedule` returns early → 0 issues → header shows **both** the stale `Needs attention` badge and the **Ready** pill; the readiness sheet then says "Everything is ready" with an **Activate** button — on an *Active* workflow (screenshots `38`, `39`). Only clicking Activate (resume path, `workflow.rs:851`) clears the badge. Nothing tells the user this.
- **Fix:** (a) readiness pill should reflect blocking issues *for the current status* — if status is `needs_attention` and issues are empty, show "Ready — reactivate" and make that one button the obvious action; (b) or auto-`resume()` when an active workflow's revalidation comes back clean.
- **Verify:** repro = schedule removal with required value → header shows a single consistent state and one obvious "Reactivate" action.

### 4. [RED] Step retry reports run duration including the dead time between finish and retry
> *"Fourteen HOURS? I pressed the button this morning! This thing is supposed to be my proof!"*

- **Objective:** retried a step on a terminal run from yesterday (1s execution). Run header now shows **"Duration 14h 05m"**, timeline axis `0s — 14h 05m` (screenshots `43`, `47`). Elapsed is computed start→latest-end (`run.elapsed_until(now)` in `runs/application/mod.rs:316/558`), so wall-clock time between the original failure and the retry counts as "work".
- **Fix:** track active execution intervals (pause on finalize, resume on retry) and sum them; or at minimum label it "elapsed since start".
- **Verify:** retry a day-old failed run → duration reflects actual execution time; timeline axis matches step bars.

### 5. [RED] Monaco YAML editor throws unhandled worker rejections on every mount
> Console: `Error: Missing requestHandler or method: doValidation` / `findLinks` (also surfaced in the Vite terminal log).

- **Objective:** opening "From YAML" (new workflow) or the Definition tab raises repeated unhandled promise rejections from `monaco-yaml`'s worker bridge (`editor.api` `$fmr`). Schema validation *appears* to work app-side, but link/validation requests hit a worker without the foreign module handlers. Relevant wiring: `frontend/src/features/definition/monaco-loader.ts` (`getWorker` labels) and `vite.config.ts` alias for the editor worker.
- **Fix:** ensure the YAML worker is created for `yaml`-labeled models (verify `monaco.editor.createModel(..., 'yaml')` label vs the `fileMatch` schema binding), or pin monaco-yaml/monaco versions whose worker APIs match; at minimum catch and downgrade to a warning.
- **Verify:** open Definition tab → console clean over 10s; squiggles/links still function.

### 6. [RED] Mobile drawer stays open after navigating to a workflow
> *"I tapped the workflow and it's still THERE, covering everything."*

- **Objective:** `app/shell.tsx:30-45` — drawer closes only on backdrop click; sidebar links navigate but never `setDrawerOpen(false)`. Measured: drawer (224px) still covers main after navigation (screenshot `31`).
- **Fix:** close the drawer on route change (`useEffect` on `router state.location`) or pass an `onNavigate` through the sidebar links.
- **Verify:** 390px viewport → tap any workflow → drawer closes, workflow visible.

### 7. [RED] Status badges fail WCAG AA contrast in both themes
> *"That green-on-white 'Ready'? I need my glasses AND good luck."*

- **Objective:** measured — light theme "Ready" badge **3.22:1**, "Needs attention" **3.92:1** at **9.625px** (`--c-succeeded: #146c35` / `--c-failed: #cf2424` on 10% alpha backgrounds, `tokens.css:70-71`, `badge.tsx` `text-[0.6875rem]`); dark theme canvas step chips ("Pi", "← feature_brief") **4.15:1** at 10px. AA needs 4.5:1 at this size.
- **Fix:** darken text tokens used on 10% tints (e.g. `#0f5a2b`/`#b81e1e` light) or raise tint alpha; audit with the same probe.
- **Verify:** automated contrast pass (the repo already runs axe in e2e — add badge selectors to the audited pages).

### 8. [RED] Interactive targets below the 24×24 minimum
> *"My thumb pressed 'Draft' when I wanted 'All'."*

- **Objective:** measured — sidebar filter chips **h20px**, readiness pill **h21px**, "Fail fast" row **h16px** (47 elements under 11px font nearby compounds it). WCAG 2.2 Target Size (Minimum) wants 24px.
- **Fix:** bump chip/pill paddings (they have horizontal room); ensure hit areas, not just visual glyphs, reach 24px.
- **Verify:** pointer-area probe on filter group + header pills ≥ 24px.

### 9. [RED] Canvas "+ Step"/context menus are mouse-only; no skip link
> *" support asked me to 'use the menu' — with the keyboard there IS no menu."*

- **Objective:** `WorkflowCanvas.tsx` `MenuItem` (toolbar `canvas-add-menu` and the pane/node context menu) renders a plain `div` with `onClick` — no `role`, no `tabindex`, no keyboard activation (the StepEditor dropdown is fine — it uses the `menu.tsx` primitive with `role=menuitem`). Additionally there is no skip-to-content link; keyboard users tab through ~160 focusables (sidebar) before reaching main.
- **Fix:** reuse the shared Dropdown/menu primitive for canvas menus; add a visually-hidden skip link to `<main>` in `app/shell.tsx`.
- **Verify:** Tab to "+ Step" → Enter opens → arrows navigate → Enter adds a Pi step (e2e already covers keyboard canvas ops elsewhere — extend to the toolbar).

### 10. [GREEN] Library silently truncates at 100 — surface the cap + bulk cleanup
> *"You're hiding two thirds of my workflows. And let me throw the junk away in one go."*

- **Objective:** sidebar requests `limit: 100` (`Sidebar.tsx:39`); DB had 330 → 100 shown, zero indication. The command palette fetches its own list (also capped). No multi-select/bulk archive exists to prune residue.
- **Fix (phased):** (a) show "Showing 100 of 330 — search to narrow" when the cap is hit (server returns a total or the client compares `length === limit`); (b) later: multi-select + bulk delete/pause for library hygiene.
- **Verify:** seed >100 workflows → cap visible; search narrows below 100.

---

## YELLOW catch-all (one ticket's worth of notes)

- **"Fix" on Home attention cards** lands on Build (`Home.tsx:207-214`); deep-link to the failed step already exists in readiness infrastructure — route `Fix` to the failing step or last failed run.
- **`document.title` static "Glyph"**; no `h1` on workspace pages (Home has one). Set title to workflow name + tab (Build/Runs/Definition).
- **Delete-run confirm** buttons styled like Cancel (`18`); use the danger variant used elsewhere ("Remove the schedule?" dialog already does).
- **`CopyButton` swallows clipboard failure silently** (`feedback.tsx:93` `catch {}`) — show "Copy failed" toast; also no toast on success (label swap only) — fine.
- **React Flow attribution hidden** while unsubscribed (`proOptions: hideAttribution`) — console warns on every load; subscribe or show the attribution.
- **Backend restart leaves runs "Running · 14h"** in Home/sidebar with no stalled indicator; a reconciliation pass or a "stalled" display state would preserve trust.
- **Dev DB cold start**: 82 e2e-named workflows make the first impression look like a landfill (motivates ticket 10; consider a `nix run .#reset`-adjacent "demo dataset only" mode for demos).

## WHITE (persona noise — no action)

"I don't want YAML in my life" (YAML is one of three creation paths); "cron is wizard language" (the schedule composer already translates it to human sentences + preview); "why does it say DAG" (it doesn't — good).

---

## What was tested and found solid (regression anchors)

- Duplicate → lands on the new workflow; copy keeps schedule but pauses dispatch (dialog says so).
- Run-now modal: required-input gating, `⌘Enter`, start navigates to live run; step cards update status in real time via live stream.
- Failed-step evidence: human error first, technical detail collapsed, transcript shows partial streaming output before failure — genuinely good debugging UX.
- Definition tab: EDITED/CLEAN state, dirty-guard on navigation, invalid YAML blocked ("The document must be a map with name and steps."), Download/Copy work.
- Schedule composer: occurrence preview in viewer timezone, out-of-range validation, nested remove confirm with explicit consequences, stored-value prompts ("The schedule needs a value for the required workflow input “feature_brief”.").
- Run delete + step delete + schedule remove all confirm; step delete counts affected connections.
- Command palette (⌘K): fuzzy search, theme switch, per-workflow navigation; `/` focuses sidebar search.
- Empty states everywhere ("No workflows match.", "No runs yet" + CTA), keyboard roving list in sidebar, `prefers-reduced-motion` respected, focus-visible outlines present, landmarks (`main/header/nav`) present, zero JS errors outside the Monaco worker issue.

**Not tested:** real provider runs (Velox live model calls did happen during the Pi-runner run; Omniroute was 503), file drag-drop onto the YAML editor, `]` panel collapse shortcut, run Stop mid-flight, production image/NGINX paths, i18n beyond en-US.
