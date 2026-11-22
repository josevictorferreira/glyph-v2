// RareUI-inspired ai-kit-inputs tests (rareui.com) — reimplemented on the Glyph design system.
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@test/render";
import { PromptBox, effortFromHoldMs, type PromptEffort } from "./prompt-box";
import { StreamingResponse, planNextBurst } from "./streaming-response";
import { ModelPicker, type PickerModel } from "./model-picker";
import { WebSearch, WebSearchCitation, type WebSource } from "./web-search";

const EFFORTS: PromptEffort[] = [
  { id: "quick", label: "Quick" },
  { id: "think", label: "Think" },
  { id: "deep", label: "Think deeply" },
];

const MODELS: PickerModel[] = [
  { id: "sonnet", name: "Claude Sonnet", provider: "Anthropic", speed: 4, intelligence: 5 },
  { id: "haiku", name: "Claude Haiku", provider: "Anthropic", speed: 5, intelligence: 3 },
  { id: "gpt4o", name: "GPT-4o", provider: "OpenAI", speed: 4, intelligence: 4 },
];

const SOURCES: WebSource[] = [
  {
    id: "1",
    title: "Glyph Docs",
    url: "https://docs.glyph.dev/runs",
    snippet: "Immutable run snapshots.",
  },
  {
    id: "2",
    title: "Motion React",
    url: "https://motion.dev/docs",
    snippet: "Layout animations.",
  },
];

describe("PromptBox", () => {
  it("computes effortFromHoldMs thresholds and disables charging for single effort", () => {
    expect(effortFromHoldMs(0, EFFORTS)).toBe(0);
    expect(effortFromHoldMs(649, EFFORTS)).toBe(0);
    expect(effortFromHoldMs(650, EFFORTS)).toBe(1);
    expect(effortFromHoldMs(1299, EFFORTS)).toBe(1);
    expect(effortFromHoldMs(1300, EFFORTS)).toBe(2);
    expect(effortFromHoldMs(5000, EFFORTS)).toBe(2);

    expect(effortFromHoldMs(2000, [{ id: "only", label: "Only" }])).toBe(0);
    expect(effortFromHoldMs(2000, [])).toBe(0);
  });

  it("sends at the first effort level on tap", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithApp(<PromptBox onSubmit={onSubmit} efforts={EFFORTS} />);

    const input = screen.getByRole("textbox", { name: "Prompt input" });
    await user.type(input, "Build a DAG");
    await user.click(screen.getByRole("button", { name: /Send/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Build a DAG", EFFORTS[0]);
  });

  it("blocks sending and shows stop button while streaming", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    renderWithApp(
      <PromptBox
        onSubmit={onSubmit}
        onStop={onStop}
        status="streaming"
        defaultValue="Draft prompt"
      />,
    );

    expect(screen.queryByRole("button", { name: /Send/i })).not.toBeInTheDocument();
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    expect(stopBtn).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Prompt input" });
    await user.type(input, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(stopBtn);
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe("StreamingResponse", () => {
  it("plans bursts with pauses at commas and periods", () => {
    const commaText = "Hello, world";
    const commaBurst = planNextBurst(commaText, 0);
    expect(commaBurst.text.length).toBeGreaterThan(0);
    expect(commaBurst.pause).toBeGreaterThanOrEqual(60);

    const periodText = "Hello. World";
    const periodBurst = planNextBurst(periodText, 0);
    expect(periodBurst.text.length).toBeGreaterThan(0);
    expect(periodBurst.pause).toBeGreaterThanOrEqual(60);
  });

  it("shows actions bar when done and toggles feedback", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const onRetry = vi.fn();
    renderWithApp(
      <StreamingResponse
        text="Completed response."
        status="done"
        onFeedback={onFeedback}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByTestId("streaming-actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy shown text" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    const upBtn = screen.getByRole("button", { name: "Good response" });
    await user.click(upBtn);
    expect(onFeedback).toHaveBeenLastCalledWith("up");
    expect(upBtn).toHaveAttribute("aria-pressed", "true");

    await user.click(upBtn);
    expect(onFeedback).toHaveBeenLastCalledWith(null);
    expect(upBtn).toHaveAttribute("aria-pressed", "false");
  });
});

describe("ModelPicker", () => {
  it("opens, filters, navigates with arrows, selects with Enter, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithApp(<ModelPicker models={MODELS} onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: /Claude Sonnet/i });
    await user.click(trigger);

    const search = screen.getByRole("textbox", { name: "Search models" });
    expect(search).toBeInTheDocument();

    await user.type(search, "Claude");
    expect(screen.getByRole("option", { name: /Claude Sonnet/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Claude Haiku/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT-4o/i })).not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("haiku");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Claude Haiku/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});

describe("WebSearch", () => {
  it("renders pill label per status, expands sources, and renders citation chip", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithApp(<WebSearch sources={SOURCES} status="searching" />);
    expect(screen.getByRole("button", { name: /Searching the web/i })).toBeInTheDocument();

    rerender(<WebSearch sources={SOURCES} status="done" />);
    const pill = screen.getByRole("button", { name: /Searched 2 sites/i });
    expect(pill).toBeInTheDocument();

    await user.click(pill);
    expect(screen.getByText("Glyph Docs")).toBeInTheDocument();
    expect(screen.getByText("docs.glyph.dev")).toBeInTheDocument();
    expect(screen.getByText("Motion React")).toBeInTheDocument();

    renderWithApp(<WebSearchCitation source={SOURCES[0]!} index={0} />);
    expect(screen.getByRole("button", { name: /Source 1: Glyph Docs/i })).toHaveTextContent("1");
  });
});
