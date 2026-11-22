// RareUI-inspired GooeyNav (rareui.com) — reimplemented on the Glyph design system.
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type GooeyNavItem = string | { label: string; href?: string; icon?: ReactNode };

export type GooeySize = "xs" | "sm" | "md" | "lg";

const SIZE_STYLES: Record<GooeySize, { px: number; py: number; font: string; gap: number }> = {
  xs: { px: 1.5, py: 0.5, font: "text-[11px]", gap: 1 },
  sm: { px: 2, py: 0.75, font: "text-xs", gap: 1.5 },
  md: { px: 2.5, py: 1, font: "text-sm", gap: 2 },
  lg: { px: 3, py: 1.25, font: "text-sm", gap: 2.5 },
};

const DEFAULT_SEPARATION: Record<GooeySize, number> = { xs: 14, sm: 16, md: 20, lg: 24 };
const DEFAULT_RADIUS: Record<GooeySize, number> = { xs: 8, sm: 10, md: 12, lg: 14 };

function itemLabel(item: GooeyNavItem): string {
  return typeof item === "string" ? item : item.label;
}
function itemHref(item: GooeyNavItem): string | undefined {
  return typeof item === "string" ? undefined : item.href;
}
function itemIcon(item: GooeyNavItem): ReactNode {
  return typeof item === "string" ? undefined : item.icon;
}

export interface GooeyNavProps {
  items: GooeyNavItem[];
  value?: number;
  defaultValue?: number;
  onChange?: (index: number) => void;
  size?: GooeySize;
  activeColor?: string;
  activeLabelColor?: string;
  separation?: number;
  radius?: number;
  className?: string;
}

export function GooeyNav({
  items,
  value,
  defaultValue = 0,
  onChange,
  size = "md",
  activeColor = "var(--c-accent)",
  activeLabelColor = "var(--c-on-accent)",
  separation,
  radius,
  className,
}: GooeyNavProps) {
  const filterId = useId();
  const [inner, setInner] = useState(defaultValue);
  const active = Math.min(Math.max(value ?? inner, 0), Math.max(items.length - 1, 0));
  const gap = separation ?? DEFAULT_SEPARATION[size];
  const r = radius ?? DEFAULT_RADIUS[size];
  const s = SIZE_STYLES[size];

  const select = (index: number) => {
    if (value === undefined) setInner(index);
    onChange?.(index);
  };

  // Each non-active item sits in its own pill; the active one is a shared
  // morphing tile that lives above the gooey-filtered background layer.
  return (
    <div className={cn("relative inline-flex", className)}>
      {/* Gooey filter: blur then hard contrast threshold to melt shapes together. */}
      <svg aria-hidden className="absolute h-0 w-0">
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation={size === "xs" ? 2 : 3} result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
              result="goo"
            />
          </filter>
        </defs>
      </svg>

      {/* Background layer (gooey): inactive chips slide apart around the gap. */}
      <div
        aria-hidden
        className="flex items-center"
        style={{ gap, filter: `url(#${filterId})` }}
      >
        {items.map((item, i) => {
          const isActive = i === active;
          const icon = itemIcon(item);
          return (
            <motion.div
              key={`${itemLabel(item)}-${i}`}
              animate={{
                width: isActive ? 0 : "auto",
                opacity: isActive ? 0 : 1,
                scaleX: isActive ? 0.2 : 1,
              }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className={cn(
                "overflow-hidden rounded-[length:var(--r)] whitespace-nowrap border border-border bg-surface-2 text-ink-muted",
                s.font,
              )}
              style={{ ["--r" as string]: `${r}px`, padding: `${s.py * 4}px ${s.px * 4}px` }}
            >
              <span className={cn("flex items-center", icon && "gap-1.5")}>
                {icon}
                {itemLabel(item)}
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Foreground: the active tile morphs between slots (layout animation). */}
      <div className="pointer-events-none absolute inset-0 flex items-center" style={{ gap }}>
        {items.map((item, i) => {
          const isActive = i === active;
          const icon = itemIcon(item);
          const tile = (
            <motion.div
              layoutId={`${filterId}-tile`}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              className={cn(
                "flex items-center whitespace-nowrap font-medium",
                s.font,
                isActive ? "pointer-events-auto" : "opacity-0",
              )}
              style={{
                backgroundColor: activeColor,
                color: activeLabelColor,
                borderRadius: r,
                padding: `${s.py * 4}px ${s.px * 4}px`,
                gap: icon ? 6 : 0,
              }}
              onClick={() => select(i)}
            >
              {icon}
              {itemLabel(item)}
            </motion.div>
          );
          return (
            <div
              key={`${itemLabel(item)}-${i}`}
              className={cn("flex justify-center", !isActive && "pointer-events-none opacity-0")}
              style={{ visibility: isActive ? "visible" : "hidden" }}
            >
              {isActive ? tile : null}
            </div>
          );
        })}
      </div>

      {/* Accessible control layer: real buttons/links over the whole thing. */}
      <div className="absolute inset-0 flex items-center" style={{ gap }}>
        {items.map((item, i) => {
          const label = itemLabel(item);
          const href = itemHref(item);
          const shared = {
            onClick: () => select(i),
            "aria-current": (i === active ? ("page" as const) : undefined),
            className: cn(
              "flex items-center rounded-[length:var(--r)] px-[length:var(--px)] py-[length:var(--py)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              s.font,
            ),
          };
          return href ? (
            <a key={label} href={href} {...shared}>
              <span className="sr-only">{label}</span>
            </a>
          ) : (
            <button key={label} type="button" {...shared}>
              <span className="sr-only">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
