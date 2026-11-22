// RareUI-inspired Display-A Tests (rareui.com) — reimplemented on the Glyph design system.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder } from "./folder";
import { CodeBlock, deriveCodeTheme, tokenizeCode } from "./code-block";
import { GravityLetters, stepParticles, type GlyphParticle } from "./gravity-letters";
import { GitHubActivity } from "./github-activity";

describe("Folder", () => {
  it("toggles aria-pressed on click", async () => {
    const user = userEvent.setup();
    render(<Folder />);
    const button = screen.getByRole("button", { name: "Open folder" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("aria-label", "Close folder");

    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});

describe("CodeBlock", () => {
  it("tokenizes typescript comments, strings, keywords, numbers, and plain text", () => {
    const lines = tokenizeCode('// hi\nconst x = "ok" + 42;', "typescript");
    expect(lines[0]).toEqual([{ type: "comment", value: "// hi" }]);
    expect(lines[1]).toEqual([
      { type: "keyword", value: "const" },
      { type: "plain", value: " x = " },
      { type: "string", value: '"ok"' },
      { type: "plain", value: " + " },
      { type: "number", value: "42" },
      { type: "plain", value: ";" },
    ]);
  });

  it("tokenizes json, bash, yaml, and falls back to plain for unknown languages", () => {
    const jsonLines = tokenizeCode('{"ok": true, "n": 7}', "json");
    expect(jsonLines[0]?.some((t) => t.type === "string" && t.value === '"ok"')).toBe(true);
    expect(jsonLines[0]?.some((t) => t.type === "keyword" && t.value === "true")).toBe(true);
    expect(jsonLines[0]?.some((t) => t.type === "number" && t.value === "7")).toBe(true);

    const bashLines = tokenizeCode('# run\npnpm test 1', "bash");
    expect(bashLines[0]).toEqual([{ type: "comment", value: "# run" }]);
    expect(bashLines[1]?.some((t) => t.type === "keyword" && t.value === "pnpm")).toBe(true);
    expect(bashLines[1]?.some((t) => t.type === "number" && t.value === "1")).toBe(true);

    const yamlLines = tokenizeCode("# cfg\nenabled: yes\nretries: 3", "yaml");
    expect(yamlLines[0]).toEqual([{ type: "comment", value: "# cfg" }]);
    expect(yamlLines[1]?.some((t) => t.type === "keyword" && t.value === "yes")).toBe(true);
    expect(yamlLines[2]?.some((t) => t.type === "number" && t.value === "3")).toBe(true);

    const unknownLines = tokenizeCode("const x = 1;", "brainfuck");
    expect(unknownLines[0]).toEqual([{ type: "plain", value: "const x = 1;" }]);
  });

  it("deriveCodeTheme returns valid hexes and distinct shades", () => {
    const hexRe = /^#[0-9a-f]{6}$/i;
    for (const mode of ["dark", "light"] as const) {
      const theme = deriveCodeTheme("#5B5BD6", mode);
      const colors = [
        theme.background,
        theme.headerBg,
        theme.border,
        theme.text,
        theme.muted,
        theme.highlightBg,
        theme.tokens.comment,
        theme.tokens.string,
        theme.tokens.keyword,
        theme.tokens.number,
      ];
      for (const c of colors) {
        expect(c).toMatch(hexRe);
      }
      expect(new Set(colors).size).toBe(colors.length);
    }
  });

  it("renders highlighted lines with tinted row attribute", () => {
    const { container } = render(
      <CodeBlock code={"line 1\nline 2\nline 3"} highlightLines={[2]} showLineNumbers />,
    );
    const line1 = container.querySelector('[data-line="1"]');
    const line2 = container.querySelector('[data-line="2"]');
    expect(line1).not.toHaveAttribute("data-highlighted");
    expect(line2).toHaveAttribute("data-highlighted", "true");
  });
});

describe("GravityLetters", () => {
  const makeParticle = (overrides: Partial<GlyphParticle> = {}): GlyphParticle => ({
    id: 1,
    char: "A",
    x: 100,
    y: 20,
    vx: 0,
    vy: 0,
    angle: 0,
    vAngle: 0,
    radius: 12,
    opacity: 1,
    ...overrides,
  });

  it("stepParticles accelerates downward with gravity, bounces on floor, and settles", () => {
    const bounds = { width: 300, height: 200 };
    let particles = [makeParticle({ y: 20, vy: 0 })];

    // Falls with gravity
    particles = stepParticles(particles, 0.04, 1800, bounds);
    expect(particles[0]!.vy).toBeGreaterThan(0);
    expect(particles[0]!.y).toBeGreaterThan(20);

    // Hits floor and bounces upward
    particles = [makeParticle({ y: 190, vy: 200 })];
    particles = stepParticles(particles, 0.02, 1800, bounds);
    expect(particles[0]!.y).toBe(bounds.height - 12);
    expect(particles[0]!.vy).toBeLessThan(0);

    // Settles when vertical speed is small at the floor
    particles = [makeParticle({ y: bounds.height - 12, vy: 5 })];
    particles = stepParticles(particles, 0.001, 100, bounds);
    expect(particles[0]!.vy).toBe(0);
  });

  it("renders safely in jsdom when canvas 2d context is null", () => {
    render(<GravityLetters type="both" />);
    expect(
      screen.getByLabelText("Interactive gravity letters field. Click or hold to drop glyphs."),
    ).toBeInTheDocument();
  });
});

describe("GitHubActivity", () => {
  it("renders grid cells from fixture and ranks repos highest first", () => {
    render(
      <GitHubActivity
        defaultOpen
        repos={[
          { name: "repo-low", count: 10 },
          { name: "repo-high", count: 90 },
          { name: "repo-mid", count: 40 },
        ]}
      />,
    );

    const cells = screen.getAllByRole("gridcell");
    expect(cells.length).toBe(26 * 7);

    const items = screen.getAllByRole("listitem");
    expect(items.map((el) => el.textContent)).toEqual([
      "repo-high90",
      "repo-mid40",
      "repo-low10",
    ]);
  });

  it("supports uncontrolled defaultOpen and controlled open/onOpenChange", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    const { rerender } = render(<GitHubActivity open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByText("Top repositories")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show repository breakdown" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(<GitHubActivity open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("Top repositories")).toBeInTheDocument();
  });
});
