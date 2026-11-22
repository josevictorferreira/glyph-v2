# Adversarial UX QA Report — Glyph Chat

**Target:** `https://glyph.josevictor.me/chat/836bb0bc-1b5f-418b-9980-ed20ea7b29b7`  
**Viewports tested:** Desktop (`1440×900`, light & dark) and Mobile (`390×844`)  
**Console / Page / Network errors:** `0` console errors, `0` page errors, `0` HTTP `>= 400` responses.

---

## Step 1: Persona

**"Big Mick" McAllister** — 58-year-old operations manager who runs his team out of WhatsApp and paper notebooks. Thick fingers, zero patience for developer UIs, hates tiny text and hidden buttons. *"If I can't type a message and see what I'm doing in 10 seconds, I'm closing the tab."*

---

## Step 3: The Rant (In Character)

**Big Mick's Review of Glyph Chat**

**Overall:** No. I'd close this tab in 15 seconds.

**THE GOOD (grudging admission):**
- The page loaded fast and didn't crash.
- Dark mode toggle works.

**THE BAD (legitimate UX issues):**
- Why is the typing box the size of a postage stamp?! I've got a 27-inch monitor and the box where I'm supposed to type is **163 pixels wide** floating in the middle of nowhere!
- When I type more than two lines, the box doesn't grow — it turns into a tiny peephole with a scrollbar.
- On my phone, once I open a chat, there's **no Back button** to get back to my list of chats. I'm trapped!
- I tried to delete an old "Untitled" chat on my phone and couldn't even find the delete button because it only shows up if you hover a mouse over it.

**THE UGLY (showstoppers):**
- I hit Send by accident on an empty box and nothing happened — the button looks clickable the whole time.
- If my internet hiccups when I hit Send, it wipes out everything I just typed and doesn't even tell me it failed.

**VERDICT:** *"Why did you give me a 163-pixel-wide keyhole to type into on a full-screen monitor?"*

---

## Step 4: Pragmatism Filter

| # | Finding | Severity | Rationale |
|---|---------|----------|-----------|
| 1 | Composer `<form>` shrink-wraps to `252px` (`textarea` is `163px` wide) on desktop & mobile | **RED** | Any user immediately sees a broken, squished square box instead of a full-width rectangular composer. |
| 2 | Textarea stays `51px` tall (`rows={2}`, `resize-none`) when typing multiline prompts | **RED** | Multiline prompts immediately clip and scroll inside a 2-line box (`scrollHeight: 154px` vs `height: 51px`). |
| 3 | Mobile (`< md`) conversation view has no Back button to return to the chat list | **RED** | Mobile users are stranded in `/chat/$chatId` with no in-app navigation back to `/chat`. |
| 4 | Rename & Delete buttons are `hidden group-hover:flex` (`0×0` until hover) | **RED** | Completely inaccessible on touchscreens and keyboard-only navigation; also no delete confirmation and no navigation away when deleting the active chat. |
| 5 | `Composer` clears `textarea.value` before `send.mutate` succeeds and has no `onError` / `isPending` handling | **RED** | Network/server errors silently destroy the user's unsent message with zero feedback. |
| 6 | `Send` button is enabled when textarea is empty or whitespace-only | **YELLOW** | Minor polish, but disabling `Send` when empty/whitespace prevents dead clicks and clarifies state. |
| 7 | Inline rename `<input>` ignores `Escape` to cancel | **YELLOW** | Standard keyboard expectation for inline edit fields. |
| 8 | Empty conversation state is a tiny `12px` left-aligned line (`text-xs text-ink-subtle`) | **GREEN** | Adding centered empty-state hierarchy + clickable starter prompts improves first-run onboarding. |
| 9 | No visible "Thinking…" / running indicator in the message list while `running === true` | **GREEN** | Users only see `Send` turn into `Stop`; a subtle status indicator in the thread makes active turns obvious. |
| 10 | Textarea lacks explicit `focus-visible` / `focus:border-accent` ring | **YELLOW** | Improves keyboard focus visibility and matches design-system inputs. |

---

## Step 5: Fixes Needed (Actionable)

### 1. [RED] Fix Composer width & rectangular shape (`frontend/src/features/chat/Composer.tsx`)
- **Observed (Playwright):** `form` is `252px` wide (`left: 818, right: 1070` on `1440px` desktop; `left: 69, right: 321` on `390px` mobile) and `textarea` is `163px × 51px`.
- **Root cause:** `Composer.tsx` lines 22 and 44 use `mx-auto flex max-w-3xl ...` directly inside `Conversation.tsx`'s `flex-col` container without `w-full`. In CSS Flexbox, `margin-left: auto; margin-right: auto` overrides `align-self: stretch`, shrink-wrapping the form to `min-content`. The `border-t border-border` is also on the shrunk form instead of a full-width footer wrapper.
- **Fix:**
  - Wrap the composer (and `composer-missing-model`) in a full-width footer container `<div className="shrink-0 border-t border-border px-4 py-3">` and give the inner `<form>` `mx-auto flex w-full max-w-3xl items-end gap-2`.
  - Add `focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30` to the `<textarea>`.

### 2. [RED] Auto-grow the Composer textarea (`frontend/src/features/chat/Composer.tsx`)
- **Observed (Playwright):** Typing 8 lines keeps `textarea` at `51px` height while `scrollHeight` is `154px`.
- **Fix:**
  - Auto-resize height on `onInput` (reset `height = "auto"`, set `height = Math.min(el.scrollHeight, 200) + "px"`, `overflow-y: auto` above `200px`), and reset height back to default after submit.

### 3. [RED] Preserve draft & surface errors on Send (`frontend/src/features/chat/Composer.tsx`)
- **Root cause:** `submit()` clears `textarea.value = ""` synchronously before `send.mutate` resolves, and ignores `send.isPending` / `send.isError`.
- **Fix:**
  - Track controlled `text` state (or clear only in `onSuccess`), disable `Send` while `send.isPending` or `text.trim().length === 0`, and render an inline `role="alert"` error banner using `toAppError(send.error).message` if `send.isError`.

### 4. [RED] Add mobile Back button in Conversation header (`frontend/src/features/chat/Conversation.tsx`)
- **Root cause:** On `< md` viewports, `ChatPage.tsx` hides the sidebar when `chatId` is set, and `Conversation.tsx` line 32 only renders the title.
- **Fix:**
  - Add a `<Link to="/chat" aria-label="Back to conversations" className="mr-2 inline-flex items-center md:hidden ...">` in the `Conversation` header.

### 5. [RED] Make Rename & Delete accessible on touch/keyboard + handle active-chat deletion (`frontend/src/features/chat/ChatPage.tsx`)
- **Root cause:** Line 112 uses `hidden group-hover:flex`, making Rename/Delete `0×0` (`display: none`) on touchscreens and keyboard focus. Deleting the currently open chat also leaves the user on a stale `/chat/$chatId` URL.
- **Fix:**
  - Show actions on `group-hover:flex group-focus-within:flex` and always visible on touch/mobile (`flex md:hidden md:group-hover:flex md:group-focus-within:flex`).
  - Add `onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}` to the rename `<input>`.
  - When `remove.mutate({ chatId: chat.id })` succeeds and `chat.id === chatId`, navigate to `/chat`.
  - Add a lightweight inline confirm (or two-step delete) so a single tap doesn't permanently wipe a conversation.

### 6. [GREEN] Improve empty conversation state & running indicator (`frontend/src/features/chat/Conversation.tsx`)
- **Fix:**
  - Center the empty state inside `max-w-3xl` with a clear heading and 2–3 clickable starter prompt chips that populate/submit the composer.
  - Show a subtle `"Agent is thinking…"` status row at the bottom of `<ol>` when `running` is true.
