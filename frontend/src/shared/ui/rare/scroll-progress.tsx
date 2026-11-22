// RareUI-inspired ScrollProgress (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/cn";

export interface ScrollProgressSection {
  id: string;
  label: string;
}

export interface ScrollMetricsInput {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 0–1 progress of a scroller; guards non-scrollable (zero-range) content. */
export function scrollMetrics({ scrollTop, scrollHeight, clientHeight }: ScrollMetricsInput): {
  progress: number;
  percent: number;
} {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return { progress: 0, percent: 0 };
  const progress = Math.min(Math.max(scrollTop / range, 0), 1);
  return { progress, percent: Math.round(progress * 100) };
}

/** Id of the last section whose top passed `offset` px below the scroller top. */
export function activeSection(
  ids: string[],
  tops: number[],
  scrollTop: number,
  offset: number,
): string | null {
  let active: string | null = null;
  for (let i = 0; i < ids.length; i++) {
    const top = tops[i];
    if (top !== undefined && top <= scrollTop + offset) active = ids[i] ?? null;
  }
  return active;
}

export interface ScrollProgressProps {
  sections?: ScrollProgressSection[];
  containerRef?: RefObject<HTMLElement | null>;
  offset?: number;
  className?: string;
}

export function ScrollProgress({
  sections = [],
  containerRef,
  offset = 120,
  className,
}: ScrollProgressProps) {
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef?.current;
    const target: HTMLElement | Window = el ?? window;
    const measure = () => {
      const scrollTop = el ? el.scrollTop : window.scrollY;
      const scrollHeight = el ? el.scrollHeight : document.documentElement.scrollHeight;
      const clientHeight = el ? el.clientHeight : window.innerHeight;
      setPercent(scrollMetrics({ scrollTop, scrollHeight, clientHeight }).percent);
      const ids = sections.map((s) => s.id);
      const tops = ids.map((id) => document.getElementById(id)?.offsetTop ?? 0);
      setActiveId(activeSection(ids, tops, scrollTop, offset));
    };
    measure();
    target.addEventListener("scroll", measure, { passive: true });
    return () => target.removeEventListener("scroll", measure);
  }, [sections, offset, containerRef]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    const container = containerRef?.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - offset, behavior: "smooth" });
    } else if (el && container === undefined) {
      // window case: offset from the document top
      window.scrollTo({ top: el.offsetTop - offset, behavior: "smooth" });
    }
    setOpen(false);
  };

  const activeLabel =
    sections.find((s) => s.id === activeId)?.label ??
    (percent > 0 ? `${percent}%` : "Top");

  return (
    <div ref={rootRef} className={cn("relative inline-flex flex-col items-center", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-2 text-xs text-ink shadow-sm transition-colors hover:bg-surface-2",
        )}
      >
        <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-surface-3">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="max-w-28 truncate font-medium">{activeLabel}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 150 }}>
          <ChevronDown size={12} />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && sections.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 150 }}
            className="absolute top-9 z-10 flex min-w-40 flex-col gap-0.5 rounded-card border border-border bg-surface p-1.5 shadow-lg"
          >
            <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium text-ink-subtle">
              <span>Progress</span>
              <span className="text-ink-muted">{percent}%</span>
            </div>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => scrollTo(s.id)}
                className={cn(
                  "rounded-md px-2 py-1 text-left text-xs transition-colors",
                  s.id === activeId
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                {s.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
