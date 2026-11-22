// RareUI-inspired ProximitySidebar (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { cn } from "@/shared/lib/cn";

export interface ProximitySection {
  id: string;
  label: string;
  kind?: "title" | "subtitle" | "section" | "body";
  level?: number;
}

/** Width of the dash for a section, by kind/level (title widest, body thin). */
export function dashWidth(section: ProximitySection): number {
  if (section.kind) {
    switch (section.kind) {
      case "title":
        return 28;
      case "subtitle":
        return 22;
      case "section":
        return 16;
      default:
        return 10;
    }
  }
  const level = section.level ?? 3;
  return Math.max(30 - (level - 1) * 6, 8);
}

/** Distance-based expansion: 1 at distance 0, easing to 0 at maxDist; clamped. */
export function proximityStyle(distance: number, maxDist = 80): { scale: number; opacity: number } {
  const t = Math.min(Math.max(distance / maxDist, 0), 1);
  return { scale: 1 - t, opacity: 1 - t };
}

export interface ProximitySidebarProps {
  sections: ProximitySection[];
  side?: "left" | "right";
  /** Ratio (0–1) of the container height at which a section counts as active. */
  activeOffset?: number;
  containerRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/** Index of the section whose document offset is closest to the
 *  `activeOffset` fraction of the container's visible height. */
export function activeFromOffsets(
  tops: number[],
  scrollTop: number,
  containerHeight: number,
  activeOffset = 0.4,
): number {
  const anchor = scrollTop + containerHeight * activeOffset;
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top !== undefined && top <= anchor) active = i;
  }
  return active;
}

export function ProximitySidebar({
  sections,
  side = "left",
  activeOffset = 0.4,
  containerRef,
  className,
}: ProximitySidebarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scales, setScales] = useState<number[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = containerRef?.current;
    const target: HTMLElement | Window = el ?? window;
    const onScroll = () => {
      const tops = sections.map((s) => {
        const node = document.getElementById(s.id);
        return node ? node.offsetTop : 0;
      });
      const scrollTop = el ? el.scrollTop : window.scrollY;
      const height = el ? el.clientHeight : window.innerHeight;
      setActive(activeFromOffsets(tops, scrollTop, height, activeOffset));
    };
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [sections, activeOffset, containerRef]);

  return (
    <div
      ref={rootRef}
      onMouseMove={(e) => {
        const root = rootRef.current;
        if (!root) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const py = e.clientY - rect.top;
        const nextScales = sections.map((_, i) => {
          const row = root.children[i];
          if (!row) return 0;
          const rowRect = (row as HTMLElement).getBoundingClientRect();
          const center = rowRect.top - rect.top + rowRect.height / 2;
          return proximityStyle(Math.abs(py - center)).scale;
        });
        setScales(nextScales);
      }}
      onMouseLeave={() => setScales(null)}
      className={cn(
        "group relative flex flex-col justify-center gap-1.5 py-4",
        side === "left" ? "items-start" : "items-end",
        className,
      )}
    >
      {sections.map((section, i) => {
        const isActive = i === active;
        const baseWidth = dashWidth(section);
        const scale = scales?.[i] ?? 0;
        let style: CSSProperties = { width: scales ? baseWidth + scale * 70 : baseWidth };
        const showLabel = isActive || (scales !== null && scale > 0.25);
        if (isActive) style = { ...style, backgroundColor: "var(--c-accent)" };
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            data-section={section.id}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "flex h-3 items-center gap-1.5 rounded-full transition-[width,background-color] duration-200",
              side === "left" ? "flex-row" : "flex-row-reverse",
              isActive ? "bg-accent" : "bg-surface-3 hover:bg-border-strong",
              scales === null ? "opacity-60" : "opacity-100",
            )}
          >
            <span
              aria-hidden
              className="h-1 shrink-0 rounded-full bg-current"
              style={{ ...style, color: isActive ? "var(--c-accent)" : undefined }}
            />
            {showLabel && (
              <span className="whitespace-nowrap text-xs text-ink-muted">{section.label}</span>
            )}
          </a>
        );
      })}
    </div>
  );
}
