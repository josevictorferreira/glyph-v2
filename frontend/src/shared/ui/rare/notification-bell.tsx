// RareUI-inspired NotificationBell (rareui.com) — reimplemented on the Glyph design system.
// iOS-style round bell button with a count badge ("99+" above max, fractional
// and negative counts floored). A count increase keys a bell swing + badge pop
// animation off the previous count, not off re-renders.

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type NotificationBellVariant = "count" | "dot";
export type NotificationBellColor = "red" | "orange" | "green" | "blue" | "violet";

const bellColorVar: Record<NotificationBellColor, string> = {
  red: "var(--c-failed)",
  orange: "var(--c-attention)",
  green: "var(--c-succeeded)",
  blue: "var(--c-accent)",
  violet: "#8B5CF6", // violet has no design token — literal fallback
};

/** Badge label: 0 → null (hidden), above max → "99+", others → integer count. */
export function badgeLabel(count: number, max: number): string | null {
  const n = Math.floor(count);
  if (n <= 0) return null;
  return n > max ? `${max}+` : String(n);
}

export const formatBadgeCount = badgeLabel;

export interface NotificationBellProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className"> {
  count?: number;
  max?: number;
  variant?: NotificationBellVariant;
  /** Button size in px; bell, badge and digits scale from it. */
  size?: number;
  color?: NotificationBellColor;
  onClick?: () => void;
  className?: string;
}

export function NotificationBell({
  count = 0,
  max = 99,
  variant = "count",
  size = 44,
  color = "red",
  onClick,
  className,
  ...props
}: NotificationBellProps) {
  const label = badgeLabel(count, max);
  const colorVar = bellColorVar[color];
  const reduced = useReducedMotion() ?? false;

  // Key the swing off the count value change (not re-renders): bump a
  // generation whenever count strictly increases.
  const [gen, setGen] = useState(0);
  const prevCount = useRef(count);
  const swung = gen > 0;
  useEffect(() => {
    if (count > prevCount.current) setGen((g) => g + 1);
    prevCount.current = count;
  }, [count]);

  const scale = size / 44;
  const badgeSize = Math.max(16, Math.round(19 * scale));
  const fontSize = Math.max(9, Math.round(10 * scale));
  const dotSize = Math.max(8, Math.round(10 * scale));

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        label ? `Notifications, ${label} unread` : "Notifications"
      }
      className={cn(
        "relative flex items-center justify-center rounded-full border border-border bg-surface",
        "text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
      style={{ width: size, height: size }}
      {...props}
    >
      <motion.span
        key={gen}
        className="flex"
        initial={false}
        animate={
          !swung || reduced
            ? { rotate: 0 }
            : { rotate: [0, 14, -14, 10, -10, 6, -6, 0] }
        }
        transition={swung && !reduced ? { duration: 0.9, ease: "easeInOut" } : { duration: 0 }}
      >
        <svg
          width={16 * scale}
          height={16 * scale}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </motion.span>
      <AnimatePresence>
        {label && (
          <motion.span
            key={gen}
            data-swung={swung ? "" : undefined}
            data-badge-variant={variant}
            className={cn(
              "absolute -right-1 -top-1 flex items-center justify-center rounded-full",
              "font-semibold leading-none text-white",
              variant === "dot" ? "" : "min-w-fit px-1",
            )}
            style={{
              width: variant === "dot" ? dotSize : badgeSize,
              height: variant === "dot" ? dotSize : badgeSize,
              background: colorVar,
              fontSize: variant === "dot" ? 0 : fontSize,
            }}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
          >
            {variant === "count" && label}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
