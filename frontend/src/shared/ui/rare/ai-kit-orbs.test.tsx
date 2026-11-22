// Tests for the RareUI-inspired AI kit components (fluid-orb, matrix-orb,
// grid-reveal, ai-status).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deriveOrbPalette, hexToRgb, mixHex, FluidOrb } from "./fluid-orb";
import { dotLayout, matrixEnvelope, MatrixOrb } from "./matrix-orb";
import { cellFinish, initialCells, paceProgress, splitLargest, GridReveal } from "./grid-reveal";
import { formatElapsed, AiStatus } from "./ai-status";
import { renderWithApp } from "@test/render";

describe("hexToRgb / mixHex / deriveOrbPalette", () => {
  it("parses 3- and 6-digit hex", () => {
    expect(hexToRgb("#5B5BD6")).toEqual({ r: 91, g: 91, b: 214 });
    expect(hexToRgb("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb("red")).toBeNull();
  });

  it("mixes linearly and clamps", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 2)).toBe("#ffffff");
    expect(mixHex("#323232", "#646464", 0.5)).toBe("#4b4b4b");
  });

  it("derives a palette whose band is near-white and shade darker than tint", () => {
    const p = deriveOrbPalette("#5B5BD6");
    const brightness = (hex: string) => {
      const c = hexToRgb(hex)!;
      return (c.r + c.g + c.b) / 3;
    };
    expect(brightness(p.band)).toBeGreaterThan(240);
    expect(brightness(p.tint)).toBeGreaterThan(brightness(p.glow));
    expect(brightness(p.glow)).toBeGreaterThan(brightness(p.shade));
    expect(brightness(p.base)).toBeGreaterThan(brightness(p.glow));
  });
});

describe("matrixEnvelope", () => {
  it("stays within 0–1 across states and sampled times", () => {
    for (const state of ["idle", "listening", "thinking"] as const) {
      for (let t = 0; t < 20; t += 0.05) {
        const v = matrixEnvelope(state, t);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("breathes slowly for idle and faster for thinking", () => {
    // idle: nearly-flat over a short window; thinking: moves more.
    const swing = (state: "idle" | "thinking", from: number, to: number) => {
      let min = 1;
      let max = 0;
      for (let t = from; t <= to; t += 0.02) {
        const v = matrixEnvelope(state, t);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return max - min;
    };
    expect(swing("idle", 0, 1)).toBeLessThan(swing("thinking", 0, 1));
  });
});

describe("dotLayout", () => {
  it("places every dot inside the unit disc, count preserved", () => {
    const dots = dotLayout(15);
    expect(dots).toHaveLength(15);
    for (const d of dots) expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(1);
  });
});

describe("splitLargest", () => {
  it("splits the largest cell and preserves total area", () => {
    const start = initialCells();
    const next = splitLargest(start, () => 0);
    expect(next).toHaveLength(5);
    const area = (cells: { w: number; h: number }[]) =>
      cells.reduce((sum, c) => sum + c.w * c.h, 0);
    expect(area(next)).toBeCloseTo(area(start));
  });

  it("always splits a square cell along a random direction", () => {
    const start = initialCells();
    const vertical = splitLargest(start, () => 0.1); // random < 0.5 → vertical
    const horizontal = splitLargest(start, () => 0.9);
    const verticalHalves = vertical.filter((c) => c.w === 0.25 && c.h === 0.5);
    const horizontalHalves = horizontal.filter((c) => c.w === 0.5 && c.h === 0.25);
    expect(verticalHalves).toHaveLength(2);
    expect(horizontalHalves).toHaveLength(2);
  });

  it("splits along the longer axis for non-square largest cells", () => {
    // Force a landscape largest cell: 1×0.5 strip on top of a 1×0.5 square.
    const cells = [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];
    const next = splitLargest(cells, () => 0);
    const halves = next.filter((c) => c.w === 0.5 && c.h === 0.5 && c.y === 0);
    expect(halves).toHaveLength(2);
  });

  it("keeps every cell axis-aligned within the unit square across many splits", () => {
    let cells = initialCells();
    for (let i = 0; i < 60; i++) cells = splitLargest(cells, () => 0.5);
    expect(cells.length).toBeGreaterThan(16);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1.000001);
      expect(c.y + c.h).toBeLessThanOrEqual(1.000001);
    }
  });
});

describe("paceProgress / cellFinish", () => {
  it("paces monotonically and holds at 0.72", () => {
    let prev = -1;
    for (let ms = 0; ms <= 60000; ms += 500) {
      const p = paceProgress(ms, 6000);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(0.72);
      prev = p;
    }
    expect(paceProgress(600000, 6000)).toBeCloseTo(0.72, 2);
  });

  it("sharpens cells as progress grows", () => {
    const cell = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(cellFinish(cell, 0)).toBeLessThan(cellFinish(cell, 0.5));
    expect(cellFinish(cell, 1)).toBe(1);
  });
});

describe("FluidOrb", () => {
  it("renders the fallback without crashing when canvas is unsupported", () => {
    const { unmount } = renderWithApp(<FluidOrb size={64} />);
    const orb = screen.getByTestId("fluid-orb");
    expect(orb).toBeInTheDocument();
    // jsdom has no 2D canvas: the radial-gradient fallback div must show.
    expect(orb.querySelector("canvas")).toBeNull();
    unmount();
  });
});

describe("MatrixOrb", () => {
  it("renders caption labels per state", () => {
    const { unmount } = renderWithApp(
      <MatrixOrb state="thinking" labels={{ idle: "Idle", thinking: "Thinking…" }} />,
    );
    expect(screen.getByTestId("matrix-orb-caption")).toHaveTextContent("Thinking…");
    unmount();
  });

  it("renders the requested dot count", () => {
    const { unmount } = renderWithApp(<MatrixOrb state="idle" dots={8} />);
    const orb = screen.getByTestId("matrix-orb");
    // ring + 8 dots
    expect(orb.querySelectorAll("circle")).toHaveLength(9);
    unmount();
  });
});

describe("GridReveal", () => {
  it("starts with 4 generating cells and shows the progress pill", () => {
    const { unmount } = renderWithApp(<GridReveal src={null} alt="gen" />);
    expect(screen.getByTestId("grid-reveal-pill")).toHaveTextContent("Generating… 0%");
    expect(screen.getByTestId("grid-reveal").querySelectorAll("div").length).toBeGreaterThan(3);
    unmount();
  });

  it("renders the image element when src is present", async () => {
    stubImage({ ok: true });
    const { unmount } = renderWithApp(<GridReveal src="data:image/gif;base64,AAAA" alt="done" />);
    const img = await screen.findByAltText("done");
    expect(img).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("grid-reveal-pill")).toBeNull());
    unmount();
  });

  it("fires onError when the image fails to load", async () => {
    stubImage({ ok: false });
    const onError = vi.fn();
    const { unmount } = renderWithApp(
      <GridReveal src="https://invalid.invalid/x.png" alt="bad" onError={onError} />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    unmount();
  });
});

/** jsdom never decodes images; stub the Image constructor to fire onload/onerror. */
function stubImage({ ok }: { ok: boolean }) {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => (ok ? this.onload?.() : this.onerror?.()));
      }
    },
  );
}

describe("AiStatus", () => {
  it.each([
    ["thinking", "Thinking…"],
    ["researching", "Researching"],
    ["analyzing", "Analyzing"],
    ["writing", "Writing"],
    ["done", "Done"],
    ["error", "Something went wrong"],
  ] as const)("defaults the %s label to %s", (state, label) => {
    const { unmount } = renderWithApp(<AiStatus state={state} />);
    expect(screen.getByTestId("ai-status")).toHaveTextContent(label);
    unmount();
  });

  it("falls back to the raw string for unknown states", () => {
    const { unmount } = renderWithApp(<AiStatus state="compiling" />);
    expect(screen.getByTestId("ai-status")).toHaveTextContent("compiling");
    unmount();
  });

  it("renders detail after a middot and formatted elapsed", () => {
    const { unmount } = renderWithApp(
      <AiStatus state="writing" detail="section 3" elapsed={125} />,
    );
    expect(screen.getByTestId("ai-status")).toHaveTextContent("Writing·section 3");
    expect(screen.getByTestId("ai-status-elapsed")).toHaveTextContent("2m 05s");
    unmount();
  });

  it("ticks the timer with fake timers", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderWithApp(<AiStatus state="thinking" timer />);
      expect(screen.getByTestId("ai-status-elapsed")).toHaveTextContent("0s");
      act(() => vi.advanceTimersByTime(3200));
      expect(screen.getByTestId("ai-status-elapsed")).toHaveTextContent("3s");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the shimmer for done/error", () => {
    const done = renderWithApp(<AiStatus state="done" />);
    expect(screen.getByTestId("ai-status").querySelector(".bg-clip-text")).toBeNull();
    done.unmount();
    const active = renderWithApp(<AiStatus state="thinking" />);
    expect(screen.getByTestId("ai-status").querySelector(".bg-clip-text")).not.toBeNull();
    active.unmount();
  });
});

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12)).toBe("12s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(125)).toBe("2m 05s");
  });
});

describe("demo: ai-kit-orbs", () => {
  it("exports interactive demo entries", async () => {
    const { aiKitOrbDemos } = await import("./demo/ai-kit-orbs");
    expect(aiKitOrbDemos.length).toBeGreaterThan(0);
    for (const entry of aiKitOrbDemos) {
      expect(entry.id).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.element).toBeDefined();
    }
  });

  it("cycles MatrixOrb states from the demo controls", async () => {
    const user = userEvent.setup();
    const { aiKitOrbDemos } = await import("./demo/ai-kit-orbs");
    const matrixEntry = aiKitOrbDemos.find((e) => e.id === "matrix-orb")!;
    const { unmount } = renderWithApp(<div>{matrixEntry.element}</div>);
    expect(screen.getByTestId("matrix-orb-caption")).toHaveTextContent("Idle");
    await user.click(screen.getByRole("button", { name: "Cycle state" }));
    expect(screen.getByTestId("matrix-orb-caption")).toHaveTextContent("Listening…");
    unmount();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
