// RareUI-inspired ThemeSelector (rareui.com) — reimplemented on the Glyph design system.
import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type ThemeOption = {
  value: string;
  label: string;
  colors: {
    sidebar: string;
    panel: string;
    border: string;
    strong: string;
    muted: string;
    tile: string;
  };
};

export const DEFAULT_THEMES: ThemeOption[] = [
  {
    value: "light",
    label: "Light",
    colors: {
      sidebar: "#f6f6f7",
      panel: "#ffffff",
      border: "#e2e2e6",
      strong: "#c9c9d0",
      muted: "#5f5f6b",
      tile: "#5b5bd6",
    },
  },
  {
    value: "dark",
    label: "Dark",
    colors: {
      sidebar: "#101014",
      panel: "#17181d",
      border: "#2a2b33",
      strong: "#3a3b45",
      muted: "#a2a3af",
      tile: "#7b7bee",
    },
  },
];

export interface ThemeSelectorProps {
  themes?: ThemeOption[];
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string) => void;
  labels?: boolean;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}

export function ThemeSelector({
  themes = DEFAULT_THEMES,
  value,
  defaultValue,
  onChange,
  labels = true,
  disabled = false,
  className,
  itemClassName,
}: ThemeSelectorProps) {
  const reducedMotion = useReducedMotion();
  const ringLayoutId = useId();
  const isControlled = value !== undefined;

  const [internalValue, setInternalValue] = useState<string | null>(
    () => defaultValue ?? themes[0]?.value ?? null,
  );
  const selectedValue = isControlled ? value : internalValue;

  const handleSelect = (next: string) => {
    if (disabled) return;
    if (!isControlled) {
      setInternalValue(next);
    }
    onChange?.(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-slot="theme-selector"
      data-disabled={disabled ? "true" : undefined}
      className={cn(
        "inline-flex flex-wrap items-start gap-3",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {themes.map((theme) => {
        const isSelected = selectedValue === theme.value;
        const { colors } = theme;

        return (
          <button
            key={theme.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={theme.label}
            disabled={disabled}
            onClick={() => handleSelect(theme.value)}
            className={cn(
              "group relative flex flex-col items-center gap-1.5 rounded-lg p-1 text-left transition-opacity",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              "disabled:cursor-not-allowed",
              itemClassName,
            )}
          >
            <div className="relative rounded-md p-0.5">
              {isSelected && (
                <motion.span
                  layoutId={ringLayoutId}
                  data-slot="theme-selection-ring"
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 450, damping: 32 }
                  }
                  className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent"
                />
              )}

              <div
                className="relative flex h-14 w-22 overflow-hidden rounded-[5px] border"
                style={{
                  backgroundColor: colors.panel,
                  borderColor: colors.border,
                }}
              >
                {/* Sidebar strip */}
                <div
                  className="flex w-6 shrink-0 flex-col gap-1 border-r p-1.5"
                  style={{
                    backgroundColor: colors.sidebar,
                    borderColor: colors.border,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: colors.tile }}
                  />
                  <span
                    className="h-1 w-full rounded-full opacity-60"
                    style={{ backgroundColor: colors.muted }}
                  />
                  <span
                    className="h-1 w-3/4 rounded-full opacity-40"
                    style={{ backgroundColor: colors.muted }}
                  />
                </div>

                {/* Panel body */}
                <div className="flex flex-1 flex-col justify-between p-1.5">
                  <div className="flex items-center gap-1">
                    <span
                      className="h-2.5 w-5 rounded-sm"
                      style={{ backgroundColor: colors.tile }}
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: colors.muted }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span
                      className="h-1 w-full rounded-full"
                      style={{ backgroundColor: colors.strong }}
                    />
                    <span
                      className="h-1 w-2/3 rounded-full opacity-70"
                      style={{ backgroundColor: colors.muted }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {labels && (
              <span
                className={cn(
                  "text-xs font-medium transition-colors",
                  isSelected ? "text-ink" : "text-ink-muted group-hover:text-ink",
                )}
              >
                {theme.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
