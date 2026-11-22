// RareUI-inspired BounceSidebar (rareui.com) — reimplemented on the Glyph design system.
import { useId, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type BounceSidebarItem =
  | string
  | { label: string; href?: string }
  | { label: string; heading: true };

interface HeadingItem {
  label: string;
  heading: true;
}

export function isHeading(item: BounceSidebarItem): item is HeadingItem {
  return typeof item !== "string" && "heading" in item;
}

export interface SelectableItem {
  /** Position of this item in the raw `items` array. */
  index: number;
  label: string;
  href?: string;
}

/** Selectable entries in order; `{ heading: true }` group labels are skipped.
 *  Selectable indices (used by `value`/`onChange`) are positions in this list. */
export function selectableItems(items: BounceSidebarItem[]): SelectableItem[] {
  const out: SelectableItem[] = [];
  items.forEach((item, index) => {
    if (isHeading(item)) return;
    if (typeof item === "string") out.push({ index, label: item });
    else out.push({ index, label: item.label, href: item.href });
  });
  return out;
}

export interface BounceSidebarProps {
  items: BounceSidebarItem[];
  value?: number;
  defaultValue?: number;
  onChange?: (index: number) => void;
  dotColor?: string;
  className?: string;
}

/** Stiff, under-damped spring so the dot visibly bounces between rows. */
const BOUNCE = { type: "spring", stiffness: 700, damping: 16 } as const;

export function BounceSidebar({
  items,
  value,
  defaultValue = 0,
  onChange,
  dotColor = "var(--c-accent)",
  className,
}: BounceSidebarProps) {
  const markerId = useId();
  const [inner, setInner] = useState(defaultValue);
  const selectable = selectableItems(items);
  const active = Math.min(Math.max(value ?? inner, 0), Math.max(selectable.length - 1, 0));

  const select = (index: number) => {
    if (value === undefined) setInner(index);
    onChange?.(index);
  };

  const selectableIndices = items.reduce<Array<number | null>>((acc, item) => {
    if (isHeading(item)) {
      acc.push(null);
    } else {
      const next = acc.filter((v) => v !== null).length;
      acc.push(next);
    }
    return acc;
  }, []);

  return (
    <ul className={cn("flex flex-col gap-0.5", className)}>
      {items.map((item, i) => {
        if (isHeading(item)) {
          return (
            <li
              key={`${item.label}-${i}`}
              className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle"
            >
              {item.label}
            </li>
          );
        }
        const index = selectableIndices[i] ?? 0;
        const isActive = index === active;
        const label = typeof item === "string" ? item : item.label;
        const href = typeof item === "string" ? undefined : item.href;
        const shared = {
          "aria-current": isActive ? ("true" as const) : undefined,
          onClick: () => select(index),
          className: cn(
            "block w-full rounded-md px-5 py-1.5 text-left text-sm transition-colors",
            isActive
              ? "bg-accent-soft font-medium text-accent"
              : "text-ink-muted hover:bg-surface-2 hover:text-ink",
          ),
        };
        return (
          <li key={`${label}-${i}`} className="relative">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 flex w-5 items-center justify-center"
            >
              {isActive && (
                <motion.span
                  layoutId={markerId}
                  transition={BOUNCE}
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
              )}
            </span>
            {href ? (
              <a href={href} {...shared}>
                {label}
              </a>
            ) : (
              <button type="button" {...shared}>
                {label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
