// RareUI-inspired HookSidebar (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useId, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type HookSidebarItem = string | { label: string; href?: string };

function itemLabel(item: HookSidebarItem): string {
  return typeof item === "string" ? item : item.label;
}

function itemHref(item: HookSidebarItem): string | undefined {
  return typeof item === "string" ? undefined : item.href;
}

/** Index (into `items`) of the entry whose href matches the current hash
 *  (`#section`). Non-href items and non-matching hashes fall back to 0. */
export function activeIndexFromHash(items: HookSidebarItem[], hash: string): number {
  if (hash.startsWith("#")) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined && itemHref(item) === hash) return i;
    }
  }
  return 0;
}

export interface HookSidebarProps {
  items: HookSidebarItem[];
  /** Group title above the list; also the nav's accessible name. */
  label?: string;
  value?: number;
  defaultValue?: number;
  onChange?: (index: number) => void;
  color?: string;
  dashed?: boolean;
  className?: string;
}

export function HookSidebar({
  items,
  label,
  value,
  defaultValue = 0,
  onChange,
  color = "var(--c-accent)",
  dashed = true,
  className,
}: HookSidebarProps) {
  const hookId = useId();
  const hasHrefs = items.some((item) => itemHref(item) !== undefined);
  const [inner, setInner] = useState(defaultValue);
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash,
  );

  useEffect(() => {
    if (!hasHrefs) return;
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [hasHrefs]);

  const active = hasHrefs ? activeIndexFromHash(items, hash) : (value ?? inner);

  const select = (index: number) => {
    if (!hasHrefs && value === undefined) setInner(index);
    onChange?.(index);
  };

  return (
    <nav className={cn("flex flex-col", className)} aria-label={label}>
      {label && (
        <div className="mb-2 pl-5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          {label}
        </div>
      )}
      <ul className="relative flex flex-col">
        {/* The rail: vertical line hugging the left edge of every item row. */}
        <span
          aria-hidden
          className={cn(
            "absolute top-1 bottom-1 left-1.5 w-0",
            dashed ? "border-l border-dashed border-border-strong" : "border-l border-border-strong",
          )}
        />
        {items.map((item, i) => {
          const isActive = i === active;
          const label2 = itemLabel(item);
          const href = itemHref(item);
          const content = (
            <>
              {/* The hook: accent segment on the rail for the active row. */}
              {isActive && (
                <motion.span
                  layoutId={hookId}
                  aria-hidden
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  className="absolute top-0 left-0 h-full w-[3px] rounded-full"
                  style={{ backgroundColor: color }}
                />
              )}
              <span
                className={cn(
                  "block px-3 py-1.5 text-sm transition-colors",
                  isActive
                    ? "font-medium text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                {label2}
              </span>
            </>
          );
          const base = cn("relative flex items-stretch", !href && "w-full text-left");
          return (
            <li key={`${label2}-${i}`} className="flex">
              {href ? (
                <a
                  href={href}
                  onClick={() => select(i)}
                  className={cn(base, "hover:bg-surface-2")}
                  aria-current={isActive ? ("true" as const) : undefined}
                >
                  {content}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => select(i)}
                  className={base}
                  aria-current={isActive ? ("true" as const) : undefined}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
