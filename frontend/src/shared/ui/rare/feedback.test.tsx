// RareUI-inspired feedback tests (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@test/render";
import {
  rareToast,
  RareToaster,
  rareToastStore,
  toastReducer,
  type RareToastState,
} from "@/shared/ui/rare/toast";
import { createRepeatScheduler, EmojiReaction } from "@/shared/ui/rare/emoji-reaction";
import { badgeLabel, NotificationBell } from "@/shared/ui/rare/notification-bell";

// The toast store is module-global: reset between tests.
afterEach(() => {
  for (const t of rareToastStore.getState()) rareToastStore.dismiss(t.id);
});

describe("toastReducer", () => {
  const base = { title: "Hello", tone: "neutral" } as const;

  it("adds a toast", () => {
    const next = toastReducer([], { type: "add", toast: { id: 1, ...base } });
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe(1);
    expect(next[0]!.rev).toBe(0);
  });

  it("updates by id instead of stacking", () => {
    const next = toastReducer([{ id: 1, ...base, rev: 0 }], {
      type: "add",
      toast: { id: 1, title: "Updated", tone: "success" },
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.title).toBe("Updated");
    expect(next[0]!.tone).toBe("success");
    expect(next[0]!.rev).toBe(1);
  });

  it("dismisses and swipes away by id", () => {
    const one: RareToastState = [
      { id: 1, ...base, rev: 0 },
      { id: 2, ...base, rev: 0 },
    ];
    expect(toastReducer(one, { type: "dismiss", id: 1 })).toHaveLength(1);
    expect(toastReducer(one, { type: "swipe", id: 2 })).toHaveLength(1);
  });

  it("caps the stack at maxVisible, keeping the newest", () => {
    const seeded: RareToastState = [1, 2].map((id) => ({ id, ...base, rev: 0 }));
    const next = toastReducer(seeded, { type: "add", toast: { id: 3, ...base }, cap: 2 });
    expect(next.map((t) => t.id)).toEqual([2, 3]);
  });

  it("morphs loading → success in place (same id, tone + rev change)", () => {
    let state: RareToastState = toastReducer([], {
      type: "add",
      toast: { id: "p", title: "Loading…", tone: "loading" },
    });
    state = toastReducer(state, {
      type: "update",
      id: "p",
      patch: { title: "Done", tone: "success" },
    });
    expect(state).toHaveLength(1);
    expect(state[0]!.tone).toBe("success");
    expect(state[0]!.title).toBe("Done");
    expect(state[0]!.rev).toBe(1);
  });

  it("morphs loading → error in place", () => {
    let state: RareToastState = toastReducer([], {
      type: "add",
      toast: { id: "p", title: "Loading…", tone: "loading" },
    });
    state = toastReducer(state, {
      type: "update",
      id: "p",
      patch: { title: "Failed", tone: "danger" },
    });
    expect(state).toHaveLength(1);
    expect(state[0]!.tone).toBe("danger");
  });
});

describe("rareToast store", () => {
  it("fires through the store listener", () => {
    const seen: string[] = [];
    const unsub = rareToastStore.subscribe((state) => seen.push(state.map((t) => String(t.id)).join(",")));
    const id = rareToast("Ping");
    expect(rareToastStore.getState().map((t) => t.id)).toContain(id);
    expect(seen.length).toBeGreaterThan(0);
    unsub();
  });

  it("promise morphs loading → success and resolves", async () => {
    const p = rareToast.promise(Promise.resolve("data"), {
      loading: "Working…",
      success: (d) => `Got ${d}`,
      error: "Nope",
    });
    const loading = rareToastStore.getState().find((t) => t.tone === "loading");
    expect(loading?.title).toBe("Working…");
    await expect(p).resolves.toBe("data");
    const done = rareToastStore.getState().find((t) => t.id === loading?.id);
    expect(done?.tone).toBe("success");
    expect(done?.title).toBe("Got data");
  });

  it("promise morphs loading → error and rethrows", async () => {
    const p = rareToast.promise(Promise.reject(new Error("boom")), {
      loading: "Working…",
      success: "Ok",
      error: (e) => `Err ${(e as Error).message}`,
    });
    await expect(p).rejects.toThrow("boom");
    const failed = rareToastStore.getState().find((t) => t.tone === "danger");
    expect(failed?.title).toBe("Err boom");
  });
});

describe("<RareToaster>", () => {
  it("renders a toast and closes it via the action button", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderWithApp(
      <div>
        <button
          type="button"
          onClick={() =>
            rareToast("Run failed", { action: { label: "View run", onClick: onAction } })
          }
        >
          fire
        </button>
        <RareToaster position="bottom-right" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "fire" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View run" }));
    expect(onAction).toHaveBeenCalledOnce();
    // Card unmounts; jsdom keeps exit-animating nodes momentarily, but the
    // store no longer holds the toast.
    expect(rareToastStore.getState()).toHaveLength(0);
  });

  it("updating by id keeps a single toast", async () => {
    const user = userEvent.setup();
    renderWithApp(
      <div>
        <button type="button" onClick={() => rareToast("v1", { id: "same" })}>
          first
        </button>
        <button type="button" onClick={() => rareToast("v2", { id: "same" })}>
          second
        </button>
        <RareToaster position="top-right" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "first" }));
    await user.click(screen.getByRole("button", { name: "second" }));
    const statuses = await screen.findAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(rareToastStore.getState()).toHaveLength(1);
  });
});

describe("<EmojiReaction>", () => {
  it("opens the bar on trigger click, picks fire onReact and close", async () => {
    const user = userEvent.setup();
    const onReact = vi.fn();
    renderWithApp(<EmojiReaction onReact={onReact} />);
    await user.click(screen.getByRole("button", { name: "React with emoji" }));
    expect(screen.getByRole("toolbar", { name: "Emoji reactions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "React with 👍" }));
    expect(onReact).toHaveBeenCalledWith("👍");
    // The bar exits with an animation; wait for it to leave the DOM.
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithApp(<EmojiReaction />);
    await user.click(screen.getByRole("button", { name: "React with emoji" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });

  it("closes on outside click", async () => {
    const user = userEvent.setup();
    renderWithApp(
      <div>
        <EmojiReaction />
        <button type="button">elsewhere</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "React with emoji" }));
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });
});

describe("createRepeatScheduler", () => {
  it("fires immediately, repeats on the interval, and stops", () => {
    vi.useFakeTimers();
    try {
      const pick = vi.fn();
      const schedule = vi.fn((fn: () => void, ms: number) => {
        expect(ms).toBe(333);
        return setInterval(fn, ms) as unknown as number;
      });
      const cancel = vi.fn((id: number) => clearInterval(id));
      const s = createRepeatScheduler(pick, 333, schedule, cancel);
      s.start();
      expect(pick).toHaveBeenCalledTimes(1); // immediate
      vi.advanceTimersByTime(999); // 3 intervals
      expect(pick).toHaveBeenCalledTimes(4);
      s.stop();
      vi.advanceTimersByTime(2000);
      expect(pick).toHaveBeenCalledTimes(4); // no more repeats
      // start/stop are idempotent
      s.stop();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("badgeLabel", () => {
  it.each([
    [0, 99, null],
    [5, 99, "5"],
    [100, 99, "99+"],
    [99.7, 99, "99"], // fractional above max → floored to 99, not above max
    [2.9, 99, "2"], // fractional floored
    [-1, 99, null], // negative floored → hidden
    [-0.5, 99, null],
  ])("badgeLabel(%s, %s) → %s", (count, max, expected) => {
    expect(badgeLabel(count, max)).toBe(expected);
  });
});

describe("<NotificationBell>", () => {
  it("hides the badge at 0 and shows the count otherwise", () => {
    const { unmount } = renderWithApp(<NotificationBell count={0} />);
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    unmount();
    renderWithApp(<NotificationBell count={5} />);
    expect(screen.getByRole("button", { name: "Notifications, 5 unread" })).toBeInTheDocument();
  });

  it("shows 99+ above max", () => {
    renderWithApp(<NotificationBell count={100} />);
    expect(screen.getByRole("button", { name: "Notifications, 99+ unread" })).toBeInTheDocument();
  });

  it("renders the dot variant without digits", () => {
    const { container } = renderWithApp(<NotificationBell count={7} variant="dot" />);
    const badge = container.querySelector('[data-badge-variant="dot"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Notifications, 7 unread" })).toBeInTheDocument();
  });

  it("fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithApp(<NotificationBell count={1} onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("marks the swing (data-swung) after a count increase", async () => {
    const user = userEvent.setup();
    function Bell() {
      const [count, setCount] = useState(2);
      return (
        <div>
          <NotificationBell count={count} />
          <button type="button" onClick={() => setCount(5)}>
            bump
          </button>
        </div>
      );
    }
    renderWithApp(<Bell />);
    expect(screen.queryByText("2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "bump" }));
    // The swung badge is a new span (keyed by generation); wait for it.
    await waitFor(() => {
      const swung = document.querySelector("[data-swung]");
      expect(swung).not.toBeNull();
      expect(swung?.textContent).toBe("5");
    });
  });
});
