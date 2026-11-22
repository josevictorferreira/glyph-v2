// RareUI-inspired PasswordInput (rareui.com) — reimplemented on the Glyph design system.
import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";
import { Eye } from "@/shared/ui/icons";

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

export function passwordStrength(value: string): PasswordStrengthScore {
  if (value.length === 0) return 0;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^a-zA-Z0-9]/.test(value)) score += 1;
  return Math.max(1, Math.min(score, 4)) as PasswordStrengthScore;
}

const STRENGTH_LABELS: Record<Exclude<PasswordStrengthScore, 0>, string> = {
  1: "Weak",
  2: "Fair",
  3: "Good",
  4: "Strong",
};

const STRENGTH_COLORS: Record<Exclude<PasswordStrengthScore, 0>, string> = {
  1: "var(--c-failed)",
  2: "var(--c-attention)",
  3: "var(--c-accent)",
  4: "var(--c-succeeded)",
};

function EyeOff({ size = 16, ...props }: React.SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

export interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue"> {
  value?: string;
  defaultValue?: string;
  defaultVisible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  strength?: boolean;
  inputClassName?: string;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      value,
      defaultValue = "",
      onChange,
      defaultVisible = false,
      onVisibleChange,
      strength = true,
      placeholder,
      disabled,
      className,
      inputClassName,
      ...props
    },
    ref,
  ) {
    const isControlled = value !== undefined;
    const [internalValue, setInternalValue] = useState(defaultValue);
    const currentValue = isControlled ? value : internalValue;

    const [visible, setVisible] = useState(defaultVisible);

    const toggleVisible = () => {
      if (disabled) return;
      const next = !visible;
      setVisible(next);
      onVisibleChange?.(next);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setInternalValue(e.target.value);
      }
      onChange?.(e);
    };

    const score = passwordStrength(currentValue);
    const showMeter = strength && score > 0;

    return (
      <div className={cn("flex w-full flex-col gap-1.5", className)}>
        <div className="relative flex items-center">
          <input
            ref={ref}
            type={visible ? "text" : "password"}
            value={currentValue}
            onChange={handleChange}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(
              "h-8 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 pr-8 text-sm text-ink",
              "placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              inputClassName,
            )}
            {...props}
          />
          <button
            type="button"
            onClick={toggleVisible}
            disabled={disabled}
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className={cn(
              "absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted transition-colors",
              "hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {visible ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>

        {showMeter && (
          <div className="flex items-center gap-2">
            <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((segment) => {
                const active = segment <= score;
                return (
                  <span
                    key={segment}
                    data-slot="strength-segment"
                    data-active={active ? "true" : "false"}
                    className="h-1 rounded-full bg-surface-3 transition-colors duration-200"
                    style={
                      active
                        ? { backgroundColor: STRENGTH_COLORS[score as Exclude<PasswordStrengthScore, 0>] }
                        : undefined
                    }
                  />
                );
              })}
            </div>
            <span
              aria-live="polite"
              className="min-w-11 text-right text-xs font-medium text-ink-muted"
            >
              {STRENGTH_LABELS[score as Exclude<PasswordStrengthScore, 0>]}
            </span>
          </div>
        )}
      </div>
    );
  },
);
