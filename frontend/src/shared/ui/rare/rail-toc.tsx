// RareUI-inspired RailToc (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface RailTocItem {
  id: string;
  label: string;
  depth?: number;
}

/** Index of the last item whose top passed `offset` px below the scroller top;
 *  -1 when nothing has passed yet. */
export function activeFromScroll(tops: number[], scrollTop: number, offset: number): number {
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top !== undefined && top <= scrollTop + offset) active = i;
  }
  return active;
}

export interface RailTocProps {
  items: RailTocItem[];
  containerRef?: RefObject<HTMLElement | null>;
  offset?: number;
  indent?: number;
  title?: string;
  className?: string;
}

function PaperPlane({ size = 14 }: { size?: number }) {
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
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  );
}

export function RailToc({
  items,
  containerRef,
  offset = 96,
  indent = 14,
  title = "On this page",
  className,
}: RailTocProps) {
  const [active, setActive] = useState(0);
  const rowHeight = 30;
  const railWidth = 26;
  const railHeight = Math.max(items.length * rowHeight, rowHeight);
  // Gently bent rail: slight curve to the right and back.
  const railPath = `M 4 2 C ${railWidth} 8, ${railWidth - 6} ${railHeight - 10}, 4 ${railHeight - 2}`;
  // Point on the rail's cubic bezier at t in [0,1].
  const railPoint = (t: number) => {
    const p0 = { x: 4, y: 2 };
    const p1 = { x: railWidth, y: 8 };
    const p2 = { x: railWidth - 6, y: railHeight - 10 };
    const p3 = { x: 4, y: railHeight - 2 };
    const u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    return { x, y };
  };

  useEffect(() => {
    const el = containerRef?.current;
    const target: HTMLElement | Window = el ?? window;
    const onScroll = () => {
      const scrollTop = el ? el.scrollTop : window.scrollY;
      const tops = items.map((item) => document.getElementById(item.id)?.offsetTop ?? 0);
      const next = activeFromScroll(tops, scrollTop, offset);
      if (next >= 0) setActive(next);
    };
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [items, offset, containerRef]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const container = containerRef?.current;
    if (container) container.scrollTo({ top: el.offsetTop - offset, behavior: "smooth" });
    else window.scrollTo({ top: el.offsetTop - offset, behavior: "smooth" });
  };

  return (
    <nav className={cn("flex flex-col", className)} aria-label={title}>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
        {title}
      </div>
      <div className="relative flex" style={{ minHeight: railHeight }}>
        <svg
          aria-hidden
          width={railWidth}
          height={railHeight}
          className="shrink-0 overflow-visible"
        >
          <path
            d={railPath}
            fill="none"
            stroke="var(--c-border-strong)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <motion.div
          aria-hidden
          className="absolute left-0 text-accent"
          style={{ width: railWidth, display: "flex", justifyContent: "center" }}
          animate={{
            x: railPoint(items.length > 1 ? active / (items.length - 1) : 0).x - 12,
            y: railPoint(items.length > 1 ? active / (items.length - 1) : 0).y - 7,
          }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
        >
          <PaperPlane />
        </motion.div>
        <ul className="flex flex-col">
          {items.map((item, i) => {
            const isActive = i === active;
            const depth = item.depth ?? 0;
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollTo(item.id);
                  }}
                  aria-current={isActive ? "true" : undefined}
                  data-toc-depth={depth}
                  style={{ paddingLeft: depth * indent }}
                  className={cn(
                    "flex h-[30px] items-center text-sm transition-colors",
                    isActive
                      ? "font-medium text-accent"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
