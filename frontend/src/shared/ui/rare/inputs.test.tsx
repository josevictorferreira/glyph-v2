// RareUI-inspired Inputs test suite — reimplemented on the Glyph design system.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DurationPicker, clampDuration } from "./duration-picker";
import { OtpInput, filterCode } from "./otp-input";
import { PasswordInput, passwordStrength } from "./password-input";
import { ThemeSelector } from "./theme-selector";
import { DeleteButton } from "./delete-button";
import { TaskList, type Task } from "./task-list";

describe("DurationPicker", () => {
  it("clamps negative, over-max, and rolls over minutes", () => {
    expect(clampDuration({ hours: -3, minutes: -10 }, 24, 60)).toEqual({
      hours: 0,
      minutes: 0,
    });
    expect(clampDuration({ hours: 30, minutes: 15 }, 24, 60)).toEqual({
      hours: 24,
      minutes: 15,
    });
    expect(clampDuration({ hours: 0, minutes: 99 }, 24, 60)).toEqual({
      hours: 1,
      minutes: 39,
    });
    expect(clampDuration({ hours: 24, minutes: 99 }, 24, 60)).toEqual({
      hours: 24,
      minutes: 39,
    });
  });

  it("enters edit mode, types values, and confirms", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onChange = vi.fn();

    render(
      <DurationPicker
        defaultValue={{ hours: 1, minutes: 15 }}
        onChange={onChange}
        onConfirm={onConfirm}
      />,
    );

    const root = document.querySelector('[data-slot="duration-picker"]')!;
    expect(root).toHaveAttribute("data-editing", "false");

    await user.click(screen.getByRole("button"));
    expect(root).toHaveAttribute("data-editing", "true");

    const hoursInput = screen.getByLabelText("Hr.");
    const minutesInput = screen.getByLabelText("Min.");

    await user.clear(hoursInput);
    await user.type(hoursInput, "3");
    await user.clear(minutesInput);
    await user.type(minutesInput, "45");

    await user.click(screen.getByRole("button", { name: "Confirm duration" }));
    expect(onConfirm).toHaveBeenCalledWith({ hours: 3, minutes: 45 });
    expect(root).toHaveAttribute("data-editing", "false");
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
  });

  it("restores last confirmed value on Escape", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <DurationPicker defaultValue={{ hours: 2, minutes: 20 }} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole("button"));
    const hoursInput = screen.getByLabelText("Hr.");
    await user.clear(hoursInput);
    await user.type(hoursInput, "9");
    await user.keyboard("{Escape}");

    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="duration-picker"]')).toHaveAttribute(
      "data-editing",
      "false",
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });
});

describe("OtpInput", () => {
  it("filters codes by type and truncates to length", () => {
    expect(filterCode("a1b2c3d4", "numbers", 4)).toBe("1234");
    expect(filterCode("a1b2c3d4", "letters", 3)).toBe("abc");
    expect(filterCode("a1-b2!c3", "both", 5)).toBe("a1b2c");
    expect(filterCode("12345678", "numbers", 6)).toBe("123456");
  });

  it("types into slots, fires onChange and onComplete, and steps back on Backspace", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onComplete = vi.fn();

    render(<OtpInput length={4} onChange={onChange} onComplete={onComplete} />);
    const input = screen.getByLabelText("One-time code");

    await user.type(input, "12a34");
    expect(onChange).toHaveBeenLastCalledWith("1234");
    expect(onComplete).toHaveBeenCalledWith("1234");

    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith("123");
  });

  it("pastes a full code and resets error status on edit", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();

    render(<OtpInput length={4} status="error" onComplete={onComplete} />);
    const root = document.querySelector('[data-slot="otp-input"]')!;
    expect(root).toHaveAttribute("data-status", "error");

    const input = screen.getByLabelText("One-time code");
    await user.click(input);
    await user.paste("9876");

    expect(onComplete).toHaveBeenCalledWith("9876");
    expect(root).toHaveAttribute("data-status", "idle");
  });
});

describe("PasswordInput", () => {
  it("scores password strength accurately", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("a")).toBe(1);
    expect(passwordStrength("abcdefgh")).toBe(1);
    expect(passwordStrength("Abcdefgh")).toBe(2);
    expect(passwordStrength("Abcdefg1")).toBe(3);
    expect(passwordStrength("Abcdefg1!")).toBe(4);
    expect(passwordStrength("Abcdefghijkl1!")).toBe(4);
  });

  it("toggles visibility and updates strength meter labels", async () => {
    const user = userEvent.setup();
    render(<PasswordInput placeholder="Password" />);

    const input = screen.getByPlaceholderText("Password");
    expect(input).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");

    await user.type(input, "a");
    expect(screen.getByText("Weak")).toBeInTheDocument();

    await user.type(input, "Bcdefg1!");
    expect(screen.getByText("Strong")).toBeInTheDocument();
  });
});

describe("ThemeSelector", () => {
  it("renders default swatches, moves selection ring, and respects disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(<ThemeSelector value="light" onChange={onChange} />);
    const lightRadio = screen.getByRole("radio", { name: "Light" });
    const darkRadio = screen.getByRole("radio", { name: "Dark" });

    expect(lightRadio).toHaveAttribute("aria-checked", "true");
    expect(darkRadio).toHaveAttribute("aria-checked", "false");
    expect(lightRadio.querySelector('[data-slot="theme-selection-ring"]')).toBeInTheDocument();

    await user.click(darkRadio);
    expect(onChange).toHaveBeenCalledWith("dark");

    rerender(<ThemeSelector value="dark" onChange={onChange} />);
    expect(darkRadio).toHaveAttribute("aria-checked", "true");
    expect(darkRadio.querySelector('[data-slot="theme-selection-ring"]')).toBeInTheDocument();

    onChange.mockClear();
    rerender(<ThemeSelector value="dark" onChange={onChange} disabled />);
    await user.click(lightRadio);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("DeleteButton", () => {
  it("expands on click and handles confirm, cancel, and Escape", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(<DeleteButton onConfirm={onConfirm} onCancel={onCancel} />);

    const trigger = screen.getByRole("button", { name: "Delete" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("TaskList", () => {
  it("toggles tasks, reorders pending before done, and restores on uncheck", async () => {
    const user = userEvent.setup();
    const onTasksChange = vi.fn();
    const initial: Task[] = [
      { id: "1", label: "First", done: false },
      { id: "2", label: "Second", done: false },
      { id: "3", label: "Third", done: false },
    ];

    render(<TaskList defaultTasks={initial} onTasksChange={onTasksChange} />);

    await user.click(screen.getByRole("checkbox", { name: "First" }));
    expect(onTasksChange).toHaveBeenLastCalledWith([
      { id: "2", label: "Second", done: false },
      { id: "3", label: "Third", done: false },
      { id: "1", label: "First", done: true },
    ]);

    const checkboxesAfterCheck = screen.getAllByRole("checkbox");
    expect(checkboxesAfterCheck.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Second",
      "Third",
      "First",
    ]);

    await user.click(screen.getByRole("checkbox", { name: "First" }));
    expect(onTasksChange).toHaveBeenLastCalledWith([
      { id: "2", label: "Second", done: false },
      { id: "3", label: "Third", done: false },
      { id: "1", label: "First", done: false },
    ]);
  });
});
