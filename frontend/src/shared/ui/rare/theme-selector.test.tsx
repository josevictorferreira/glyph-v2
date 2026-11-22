// RareUI-inspired ThemeSelector tests.
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@test/render";
import { ThemeSelector, DEFAULT_THEMES } from "@/shared/ui/rare/theme-selector";

describe("ThemeSelector", () => {
  it("renders one swatch per default theme with labels", () => {
    renderWithApp(<ThemeSelector />);
    for (const theme of DEFAULT_THEMES) {
      expect(screen.getByRole("radio", { name: theme.label })).toBeInTheDocument();
    }
  });

  it("falls back to the first theme when nothing is selected", () => {
    renderWithApp(<ThemeSelector />);
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "false");
  });

  it("selection ring follows the controlled value", () => {
    const { rerender } = renderWithApp(<ThemeSelector value="dark" />);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    rerender(
      <>
        <ThemeSelector value="light" />
      </>,
    );
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  });

  it("fires onChange with the picked value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithApp(<ThemeSelector onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("disabled blocks interaction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithApp(<ThemeSelector disabled onChange={onChange} />);
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark).toBeDisabled();
    await user.click(dark);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts custom themes and hides labels when labels={false}", () => {
    const themes = [
      {
        value: "solar",
        label: "Solar",
        colors: { sidebar: "#111", panel: "#222", border: "#333", strong: "#444", muted: "#555", tile: "#666" },
      },
    ];
    renderWithApp(<ThemeSelector themes={themes} labels={false} />);
    expect(screen.getByRole("radio", { name: "Solar" })).toBeInTheDocument();
    expect(screen.queryByText("Solar")).not.toBeInTheDocument();
  });
});
