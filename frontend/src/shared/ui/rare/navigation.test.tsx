// RareUI-inspired navigation component tests.
import { describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BounceSidebar, selectableItems } from "@/shared/ui/rare/bounce-sidebar";
import { HookSidebar, activeIndexFromHash } from "@/shared/ui/rare/hook-sidebar";
import { ProximitySidebar, proximityStyle } from "@/shared/ui/rare/proximity-sidebar";
import { ScrollProgress, activeSection, scrollMetrics } from "@/shared/ui/rare/scroll-progress";
import { RailToc, activeFromScroll } from "@/shared/ui/rare/rail-toc";
import { GooeyNav } from "@/shared/ui/rare/gooey-nav";

describe("BounceSidebar", () => {
  it("maps selectable indices, skipping headings", () => {
    const items = [
      { label: "Group", heading: true },
      "A",
      "B",
      { label: "Other", heading: true },
      "C",
    ] as const;
    const selectable = selectableItems([...items]);
    expect(selectable.map((s) => s.label)).toEqual(["A", "B", "C"]);
    // Raw-array positions: A=1, B=2, C=4 (headings at 0 and 3 skipped).
    expect(selectable.map((s) => s.index)).toEqual([1, 2, 4]);
  });

  it("fires onChange and marks aria-current", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BounceSidebar items={["A", "B", "C"]} onChange={onChange} />);
    const b = screen.getByRole("button", { name: "B" });
    expect(b).not.toHaveAttribute("aria-current");
    await user.click(b);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("moves the marker under controlled value", () => {
    const { rerender } = render(<BounceSidebar items={["A", "B", "C"]} value={0} />);
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-current", "true");
    rerender(<BounceSidebar items={["A", "B", "C"]} value={2} />);
    expect(screen.getByRole("button", { name: "C" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "A" })).not.toHaveAttribute("aria-current");
  });

  it("renders href items as anchors", () => {
    render(<BounceSidebar items={[{ label: "Docs", href: "#docs" }]} />);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "#docs");
  });
});

describe("HookSidebar", () => {
  it("activeIndexFromHash matches hrefs and falls back to 0", () => {
    const items = ["One", { label: "Two", href: "#two" }, { label: "Three", href: "#three" }];
    expect(activeIndexFromHash(items, "#two")).toBe(1);
    expect(activeIndexFromHash(items, "#three")).toBe(2);
    expect(activeIndexFromHash(items, "#nope")).toBe(0);
    expect(activeIndexFromHash(items, "")).toBe(0);
  });

  it("renders links for href items", () => {
    render(<HookSidebar label="Guide" items={[{ label: "Intro", href: "#intro" }]} />);
    const nav = screen.getByRole("navigation", { name: "Guide" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Intro" })).toHaveAttribute("href", "#intro");
  });

  it("clicking an item calls onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HookSidebar items={["A", "B"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith(1);
  });
});

describe("ProximitySidebar", () => {
  it("proximityStyle is monotonic and clamped", () => {
    expect(proximityStyle(0, 100)).toEqual({ scale: 1, opacity: 1 });
    expect(proximityStyle(50, 100)).toEqual({ scale: 0.5, opacity: 0.5 });
    expect(proximityStyle(100, 100)).toEqual({ scale: 0, opacity: 0 });
    // Clamped beyond max distance and below zero.
    expect(proximityStyle(500, 100)).toEqual({ scale: 0, opacity: 0 });
    expect(proximityStyle(-10, 100)).toEqual({ scale: 1, opacity: 1 });
    // Monotonic decrease in scale with distance.
    for (let d = 0; d < 100; d += 10) {
      expect(proximityStyle(d, 100).scale).toBeGreaterThanOrEqual(
        proximityStyle(d + 10, 100).scale,
      );
    }
  });

  it("renders section dashes without crashing (jsdom: offsets are 0)", () => {
    const { container } = render(
      <ProximitySidebar
        sections={[
          { id: "s1", label: "One", kind: "title" },
          { id: "s2", label: "Two", kind: "body" },
        ]}
      />,
    );
    expect(container.querySelector('[data-section="s1"]')).not.toBeNull();
    expect(container.querySelector('[data-section="s2"]')).not.toBeNull();
    // All offsets are 0 in jsdom, so the last section is active and shows its label.
    expect(screen.getByText("Two")).toBeInTheDocument();
  });
});

describe("ScrollProgress", () => {
  it("scrollMetrics computes 0/50/100% and guards zero range", () => {
    expect(scrollMetrics({ scrollTop: 0, scrollHeight: 200, clientHeight: 100 })).toEqual({
      progress: 0,
      percent: 0,
    });
    expect(scrollMetrics({ scrollTop: 50, scrollHeight: 200, clientHeight: 100 })).toEqual({
      progress: 0.5,
      percent: 50,
    });
    expect(scrollMetrics({ scrollTop: 100, scrollHeight: 200, clientHeight: 100 })).toEqual({
      progress: 1,
      percent: 100,
    });
    expect(scrollMetrics({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toEqual({
      progress: 0,
      percent: 0,
    });
  });

  it("activeSection picks the last id that passed the offset", () => {
    const ids = ["a", "b", "c"];
    const tops = [0, 200, 400];
    expect(activeSection(ids, tops, 0, 120)).toBe("a");
    expect(activeSection(ids, tops, 100, 120)).toBe("b"); // 200 <= 100+120
    expect(activeSection(ids, tops, 300, 120)).toBe("c"); // 400 <= 300+120
    expect(activeSection(ids, tops, 900, 120)).toBe("c");
  });

  it("renders the pill and expands the section menu on click", async () => {
    const user = userEvent.setup();
    render(
      <ScrollProgress
        sections={[{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]}
      />,
    );
    // jsdom tops are 0, so the last section ("Beta") is active in the pill.
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Beta" }));
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
  });
});

describe("RailToc", () => {
  it("activeFromScroll returns the last passed index or -1", () => {
    expect(activeFromScroll([0, 200, 400], 0, 96)).toBe(0);
    expect(activeFromScroll([0, 200, 400], 150, 96)).toBe(1);
    expect(activeFromScroll([0, 200, 400], 999, 96)).toBe(2);
  });

  it("renders items with depth indents and active class from scroll math", () => {
    render(
      <RailToc
        title="Contents"
        items={[
          { id: "h1", label: "Top", depth: 0 },
          { id: "h2", label: "Nested", depth: 2 },
        ]}
      />,
    );
    const top = screen.getByRole("link", { name: "Top" });
    const nested = screen.getByRole("link", { name: "Nested" });
    expect(top).toHaveAttribute("data-toc-depth", "0");
    expect(nested).toHaveAttribute("data-toc-depth", "2");
    expect(nested.style.paddingLeft).toBe("28px");
    // jsdom offsets are 0, so every section has passed: the last one is active.
    expect(nested).toHaveAttribute("aria-current", "true");
    expect(top).not.toHaveAttribute("aria-current");
  });

  it("accepts a containerRef without crashing", () => {
    function Harness() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <RailToc containerRef={ref} items={[{ id: "x", label: "X" }]} />
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
  });
});

describe("GooeyNav", () => {
  it("changes value on click and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GooeyNav items={["A", "B", "C"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("respects defaultValue", () => {
    render(<GooeyNav items={["A", "B"]} defaultValue={1} />);
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "A" })).not.toHaveAttribute("aria-current");
  });

  it("renders all sizes", () => {
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      const { unmount } = render(<GooeyNav size={size} items={["A"]} />);
      expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
      unmount();
    }
  });

  it("marks the controlled active item", () => {
    const { rerender } = render(<GooeyNav items={["A", "B"]} value={0} />);
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-current", "page");
    rerender(<GooeyNav items={["A", "B"]} value={1} />);
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-current", "page");
  });
});
