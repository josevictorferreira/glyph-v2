// RareUI-inspired GridReveal (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface GridCell {
  /** Fractional rect within [0,1]². */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The initial 4-cell grid (2×2 quarters). */
export function initialCells(): GridCell[] {
  return [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ];
}

/** True when splitting `cell` vertically (into left/right halves). */
export function splitIsVertical(cell: GridCell): boolean {
  return cell.w >= cell.h;
}

/**
 * Split the currently-largest cell in two along its longer axis (random
 * direction when square). The bigger cell is picked deterministically.
 */
export function splitLargest(cells: GridCell[], random: () => number = Math.random): GridCell[] {
  let idx = 0;
  let maxArea = -1;
  for (let i = 0; i < cells.length; i++) {
    const area = cells[i]!.w * cells[i]!.h;
    if (area > maxArea) {
      maxArea = area;
      idx = i;
    }
  }
  const target = cells[idx];
  if (!target) return cells;
  const vertical = target.w === target.h ? random() < 0.5 : splitIsVertical(target);
  const next = cells.slice();
  next.splice(idx, 1);
  if (vertical) {
    next.push({ x: target.x, y: target.y, w: target.w / 2, h: target.h });
    next.push({ x: target.x + target.w / 2, y: target.y, w: target.w / 2, h: target.h });
  } else {
    next.push({ x: target.x, y: target.y, w: target.w, h: target.h / 2 });
    next.push({ x: target.x, y: target.y + target.h / 2, w: target.w, h: target.h / 2 });
  }
  return next;
}

/** Split until the grid holds `target` cells (used by the demo/tests). */
export function cellsFor(target: number): GridCell[] {
  let cells = initialCells();
  let guard = 0;
  while (cells.length < target && guard++ < 128) cells = splitLargest(cells);
  return cells;
}

/** Progress pacing: a decelerating ease that approaches and holds at 0.72. */
export function paceProgress(elapsedMs: number, estimatedDurationMs: number): number {
  const p = elapsedMs / Math.max(1, estimatedDurationMs);
  return 0.72 * (1 - Math.exp(-2.2 * p));
}

function cellStyle(cell: GridCell): React.CSSProperties {
  return {
    left: `${cell.x * 100}%`,
    top: `${cell.y * 100}%`,
    width: `${cell.w * 100}%`,
    height: `${cell.h * 100}%`,
  };
}

/** Cell finish (0–1): fresh splits are faded, cells sharpen as progress grows. */
export function cellFinish(cell: GridCell, progress: number): number {
  return Math.min(1, progress + (1 - Math.max(cell.w, cell.h)) * 0.85);
}

export interface GridRevealProps {
  /** Image source; `null` keeps the grid generating. */
  src: string | null;
  alt: string;
  /** 0–1; when omitted the component paces itself and holds at 0.72. */
  progress?: number;
  aspect?: number;
  /** Overlaid caption; crossfades when it changes mid-run. */
  caption?: string;
  estimatedDuration?: number;
  onRevealComplete?: () => void;
  onError?: () => void;
  className?: string;
}

/** Loading state for AI images that becomes the picture on arrival. */
export function GridReveal({
  src,
  alt,
  progress,
  aspect = 16 / 10,
  caption,
  estimatedDuration = 6000,
  onRevealComplete,
  onError,
  className,
}: GridRevealProps) {
  const reduced = useReducedMotion() ?? false;
  const [paced, setPaced] = useState(0);
  const shown = progress ?? paced;
  const targetCells = Math.min(24, 4 + Math.floor(shown * 20));
  const cells = useMemo(() => cellsFor(targetCells), [targetCells]);
  const [decodedSrc, setDecodedSrc] = useState<string | null>(null);
  const decoded = src !== null && decodedSrc === src;

  // Internal pacing when no external progress is supplied.
  useEffect(() => {
    if (progress !== undefined) return;
    const start = performance.now();
    const id = window.setInterval(() => {
      setPaced(paceProgress(performance.now() - start, estimatedDuration));
    }, 200);
    return () => window.clearInterval(id);
  }, [progress, estimatedDuration]);

  // Load the image out-of-band so the grid keeps animating until decode.
  useEffect(() => {
    if (src === null) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setDecodedSrc(src);
    };
    img.onerror = () => {
      if (!cancelled) onError?.();
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, onError]);

  useEffect(() => {
    if (decoded) onRevealComplete?.();
  }, [decoded, onRevealComplete]);

  return (
    <div
      data-testid="grid-reveal"
      className={cn(
        "relative overflow-hidden rounded-card border border-border bg-surface-2",
        className,
      )}
      style={{ aspectRatio: aspect }}
    >
      <AnimatePresence>
        {!decoded && (
          <motion.div
            key="grid"
            className="absolute inset-0 z-10"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.35 } }}
          >
            {cells.map((cell) => {
              const finish = cellFinish(cell, shown);
              return (
                <motion.div
                  key={`${cell.x.toFixed(3)}:${cell.y.toFixed(3)}`}
                  className="absolute box-border border-r border-b border-border/70"
                  style={cellStyle(cell)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.2 + 0.8 * finish }}
                />
              );
            })}
            {caption !== undefined && caption !== "" && (
              <div className="pointer-events-none absolute inset-x-0 top-2.5 z-20 flex justify-center">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={caption}
                    className="absolute rounded-full bg-surface/80 px-2.5 py-1 text-xs text-ink-muted backdrop-blur-md"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3 } }}
                    exit={{ opacity: 0, y: -4, transition: { duration: 0.3 } }}
                  >
                    {caption}
                  </motion.span>
                </AnimatePresence>
              </div>
            )}
            <div
              data-testid="grid-reveal-pill"
              className="absolute bottom-2.5 left-2.5 z-20 flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-2.5 py-1 text-xs text-ink-muted backdrop-blur-md"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full bg-accent",
                  !reduced && "animate-status-running",
                )}
              />
              Generating… {Math.round(Math.min(1, Math.max(0, shown)) * 100)}%
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {src !== null && (
        <motion.img
          src={src}
          alt={alt}
          className="absolute inset-0 h-full w-full object-cover"
          initial={reduced ? false : { opacity: 0, scale: 1.06 }}
          animate={decoded ? { opacity: 1, scale: 1 } : { opacity: 0 }}
          transition={
            decoded
              ? { duration: 0.45, scale: { type: "spring", stiffness: 120, damping: 18 } }
              : { duration: 0.15 }
          }
        />
      )}
    </div>
  );
}
