// RareUI-inspired display-b tests (rareui.com) — reimplemented on the Glyph design system.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatCounterParts } from "./animated-counter";
import { Faq, type FaqItem } from "./faq";
import { StepPlayer } from "./step-player";
import { clampSeek, generateWaveform, VoiceNote } from "./voice-note";

afterEach(() => {
  vi.useRealTimers();
});

describe("StepPlayer", () => {
  it("advances step on duration elapse with fake timers and fires onComplete at end", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    const onComplete = vi.fn();

    render(
      <StepPlayer
        steps={3}
        duration={1000}
        defaultPlaying
        onValueChange={onValueChange}
        onComplete={onComplete}
      />,
    );

    expect(screen.getByRole("button", { name: "Step 1" })).toHaveAttribute("aria-current", "step");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onValueChange).toHaveBeenLastCalledWith(1);
    expect(screen.getByRole("button", { name: "Step 2" })).toHaveAttribute("aria-current", "step");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onValueChange).toHaveBeenLastCalledWith(2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
  });

  it("pauses and stops advancing", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();

    render(<StepPlayer steps={3} duration={1000} defaultPlaying onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("wraps around when loop is true", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    const onComplete = vi.fn();

    render(
      <StepPlayer
        steps={2}
        duration={500}
        defaultPlaying
        loop
        onValueChange={onValueChange}
        onComplete={onComplete}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onValueChange).toHaveBeenLastCalledWith(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("jumps to clicked dot when seekable", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<StepPlayer steps={4} onValueChange={onValueChange} />);

    await user.click(screen.getByRole("button", { name: "Step 3" }));
    expect(onValueChange).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "Step 3" })).toHaveAttribute("aria-current", "step");
  });
});

describe("formatCounterParts", () => {
  it("formats grouping separators", () => {
    expect(formatCounterParts(1234567)).toEqual({
      digits: ["1", "2", "3", "4", "5", "6", "7"],
      marks: [null, ",", null, null, ",", null, null],
    });
  });

  it("formats padStart with leading zeros", () => {
    expect(formatCounterParts(42, { padStart: 5 })).toEqual({
      digits: ["0", "0", "0", "4", "2"],
      marks: [null, null, ",", null, null],
    });
  });

  it("formats decimals with custom separators", () => {
    expect(
      formatCounterParts(1234.5, {
        decimals: 2,
        separator: ".",
        decimalSeparator: ",",
      }),
    ).toEqual({
      digits: ["1", "2", "3", "4", "5", "0"],
      marks: [null, ".", null, null, ",", null],
    });
  });

  it("formats zero", () => {
    expect(formatCounterParts(0)).toEqual({
      digits: ["0"],
      marks: [null],
    });
  });

  it("formats negative numbers with leading minus mark", () => {
    expect(formatCounterParts(-1234.5, { decimals: 1 })).toEqual({
      digits: ["1", "2", "3", "4", "5"],
      marks: ["-", ",", null, null, "."],
    });
  });
});

describe("VoiceNote", () => {
  it("generateWaveform is deterministic and bounded in [0, 1]", () => {
    const a = generateWaveform(36, 7);
    const b = generateWaveform(36, 7);
    const c = generateWaveform(36, 99);

    expect(a).toHaveLength(36);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("clampSeek clamps within [0, duration]", () => {
    expect(clampSeek(-5, 20)).toBe(0);
    expect(clampSeek(10, 20)).toBe(10);
    expect(clampSeek(30, 20)).toBe(20);
    expect(clampSeek(Number.NaN, 20)).toBe(0);
  });

  it("toggles play, advances progress with fake timers, cycles speed, and rewinds on end", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();

    render(<VoiceNote duration={10} onEnded={onEnded} />);

    const playBtn = screen.getByRole("button", { name: "Play" });
    fireEvent.click(playBtn);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("0:02 / 0:10")).toBeInTheDocument();

    // Cycle speed: 1× -> 1.5× -> 2× -> 1×
    const speedBtn = screen.getByRole("button", { name: /Playback speed/i });
    expect(speedBtn).toHaveTextContent("1×");
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent("1.5×");
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent("2×");

    // At 2× speed, remaining 8s takes 4000ms
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onEnded).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("0:00 / 0:10")).toBeInTheDocument();

    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent("1×");
  });

  it("respects keyboard seeks made while playing instead of overwriting them", () => {
    vi.useFakeTimers();

    render(<VoiceNote duration={10} />);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("0:02 / 0:10")).toBeInTheDocument();

    // Seek +5s while playing (ArrowRight on the waveform slider).
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(screen.getByText("0:07 / 0:10")).toBeInTheDocument();

    // The remaining 3s must elapse from the seek position (7 + 3 = 10), not from 2s.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("0:00 / 0:10")).toBeInTheDocument();
  });
});

describe("Faq", () => {
  const items: FaqItem[] = [
    { id: "q1", question: "First question?", answer: "First answer." },
    { id: "q2", question: "Second question?", answer: "Second answer." },
    { id: "q3", question: "Third question?", answer: "Third answer." },
  ];

  it("enforces single-open behavior and updates aria-expanded", async () => {
    const user = userEvent.setup();
    render(<Faq items={items} />);

    const q1 = screen.getByRole("button", { name: "First question?" });
    const q2 = screen.getByRole("button", { name: "Second question?" });

    expect(q1).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("First answer.")).not.toBeInTheDocument();

    await user.click(q1);
    expect(q1).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("First answer.")).toBeInTheDocument();

    await user.click(q2);
    expect(q1).toHaveAttribute("aria-expanded", "false");
    expect(q2).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Second answer.")).toBeInTheDocument();

    await user.click(q2);
    expect(q2).toHaveAttribute("aria-expanded", "false");
  });

  it("supports controlled value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Faq items={items} value="q1" onValueChange={onValueChange} />);

    expect(screen.getByText("First answer.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Second question?" }));
    expect(onValueChange).toHaveBeenCalledWith("q2");
    // Still shows q1 because value is controlled
    expect(screen.getByText("First answer.")).toBeInTheDocument();
  });

  it("moves focus between questions with ArrowDown and ArrowUp", async () => {
    const user = userEvent.setup();
    render(<Faq items={items} />);

    const q1 = screen.getByRole("button", { name: "First question?" });
    const q2 = screen.getByRole("button", { name: "Second question?" });
    const q3 = screen.getByRole("button", { name: "Third question?" });

    q1.focus();
    expect(q1).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(q2).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(q3).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(q1).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(q3).toHaveFocus();
  });
});
