// useAutosaveField tests (spec 0015): debounce, flush on blur, dirty-vs-
// remote, error + retry, grouped values, beforeunload warning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAutosaveField, combineAutosaveStatuses } from "./autosave";

describe("useAutosaveField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial: string, save: (v: string) => Promise<void>) {
    const state = { upstream: initial };
    const rendered = renderHook(
      ({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) =>
        useAutosaveField({ value, save: onSave }),
      { initialProps: { value: state.upstream, onSave: save } },
    );
    return {
      state,
      rendered,
      rerender(value = state.upstream, onSave = save) {
        rendered.rerender({ value, onSave });
      },
    };
  }

  it("debounces edits into one save with the final value", async () => {
    const saves: string[] = [];
    const save = (v: string) =>
      new Promise<void>((resolve) => {
        saves.push(v);
        resolve();
      });
    const { rendered } = setup("a", save);
    act(() => rendered.result.current.setValue("ab"));
    act(() => rendered.result.current.setValue("abc"));
    expect(saves).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(saves).toEqual(["abc"]);
    expect(rendered.result.current.status).toBe("saved");
  });

  it("flushes on blur without waiting for the debounce", async () => {
    const saves: string[] = [];
    const { rendered } = setup("a", (v) => {
      saves.push(v);
      return Promise.resolve();
    });
    act(() => rendered.result.current.setValue("ab"));
    await act(async () => {
      await rendered.result.current.onBlur();
    });
    expect(saves).toEqual(["ab"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the draft when a remote change arrives while dirty; takeRemote adopts it", async () => {
    const { rendered, rerender, state } = setup("a", () => Promise.resolve());
    act(() => rendered.result.current.setValue("local"));
    // upstream changes elsewhere
    state.upstream = "remote";
    rerender("remote");
    expect(rendered.result.current.value).toBe("local");
    expect(rendered.result.current.remoteUpdated).toBe(true);
    act(() => rendered.result.current.takeRemote());
    expect(rendered.result.current.value).toBe("remote");
    expect(rendered.result.current.remoteUpdated).toBe(false);
  });

  it("replaces the value when clean and unfocused", async () => {
    const { rendered, rerender } = setup("a", () => Promise.resolve());
    rerender("server");
    expect(rendered.result.current.value).toBe("server");
    expect(rendered.result.current.remoteUpdated).toBe(false);
  });

  it("freezes the current value while focused (no clobber, no save)", async () => {
    const saves: string[] = [];
    const { rendered, rerender } = setup("a", (v) => {
      saves.push(v);
      return Promise.resolve();
    });
    act(() => rendered.result.current.onFocus());
    rerender("server");
    expect(rendered.result.current.value).toBe("a");
    expect(rendered.result.current.remoteUpdated).toBe(true);
    await act(async () => {
      await rendered.result.current.onBlur(); // release: remote flows in, nothing saved
    });
    rerender("server");
    expect(rendered.result.current.value).toBe("server");
    expect(saves).toEqual([]); // frozen ≠ edited: never writes back
  });

  it("surfaces errors and retries", async () => {
    let fail = true;
    const saves: string[] = [];
    const { rendered } = setup("a", (v) => {
      saves.push(v);
      if (fail) return Promise.reject(new Error("boom"));
      return Promise.resolve();
    });
    act(() => rendered.result.current.setValue("ab"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(rendered.result.current.status).toBe("error");
    expect(rendered.result.current.error).toBeInstanceOf(Error);
    // retry succeeds
    fail = false;
    await act(async () => {
      await rendered.result.current.retry();
    });
    expect(saves).toEqual(["ab", "ab"]);
    expect(rendered.result.current.status).toBe("saved");
  });

  it("saves grouped object values together", async () => {
    const saves: { name: string; format: number }[] = [];
    // Stable refs: the hook re-runs its flush effect when save/equals change
    // identity every render — same discipline real callers follow.
    const save = (v: { name: string; format: number }) => {
      saves.push(v);
      return Promise.resolve();
    };
    const equals = (a: { name: string; format: number }, b: { name: string; format: number }) =>
      a.name === b.name && a.format === b.format;
    const rendered = renderHook(
      ({ value }: { value: { name: string; format: number } }) =>
        useAutosaveField({ value, save, equals }),
      { initialProps: { value: { name: "out", format: 0 } } },
    );
    act(() => rendered.result.current.setValue({ name: "result", format: 0 }));
    act(() => rendered.result.current.setValue({ name: "result", format: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(saves).toEqual([{ name: "result", format: 2 }]);
  });

  it("warns on beforeunload while dirty or failed", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { rendered } = setup("a", () => Promise.resolve());
    act(() => rendered.result.current.setValue("ab"));
    const kinds = addSpy.mock.calls.filter(([k]) => k === "beforeunload");
    expect(kinds).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    addSpy.mockRestore();
  });

  it("flushes pending saves on unmount", async () => {
    const saves: string[] = [];
    const { rendered } = setup("a", (v) => {
      saves.push(v);
      return Promise.resolve();
    });
    act(() => rendered.result.current.setValue("ab"));
    rendered.unmount();
    expect(saves).toEqual(["ab"]);
  });
});

describe("combineAutosaveStatuses", () => {
  it("ranks error > saving > dirty > saved > idle", () => {
    expect(combineAutosaveStatuses(["idle", "saved"])).toBe("saved");
    expect(combineAutosaveStatuses(["saved", "dirty"])).toBe("dirty");
    expect(combineAutosaveStatuses(["saving", "dirty"])).toBe("saving");
    expect(combineAutosaveStatuses(["error", "saving"])).toBe("error");
    expect(combineAutosaveStatuses(["idle", "idle"])).toBe("idle");
    expect(combineAutosaveStatuses([])).toBe("idle");
  });
});
