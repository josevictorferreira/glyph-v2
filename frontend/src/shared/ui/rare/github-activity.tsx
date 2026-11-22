// RareUI-inspired GitHubActivity (rareui.com) — reimplemented on the Glyph design system.
import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { ChevronDown } from "@/shared/ui/icons";

export type Contribution = { date: string; count: number };
export type RepoContribution = { name: string; count: number };

export interface GitHubActivityProps {
  contributions?: Contribution[];
  repos?: RepoContribution[];
  year?: number;
  accent?: string | string[];
  cellSize?: number;
  months?: number;
  label?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DEFAULT_REPOS: RepoContribution[] = [
  { name: "glyph-v2/backend", count: 184 },
  { name: "glyph-v2/frontend", count: 142 },
  { name: "glyph-v2/proto", count: 68 },
  { name: "glyph-v2/infra", count: 34 },
];

function buildDefaultContributions(year: number): Contribution[] {
  // Deterministic ~26 weeks x 7 days (182 days) fixture
  const totalDays = 26 * 7;
  const end = new Date(Date.UTC(year, 11, 31));
  const result: Contribution[] = [];

  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    // Deterministic pseudo-random pattern
    const seed = (i * 37 + year * 13) % 29;
    const count = seed < 9 ? 0 : seed < 16 ? 2 : seed < 22 ? 5 : seed < 26 ? 8 : 12;
    result.push({ date: iso, count });
  }
  return result;
}

function resolveScale(accent?: string | string[]): [string, string, string, string] {
  if (Array.isArray(accent) && accent.length > 0) {
    const c0 = accent[0] ?? "var(--c-succeeded)";
    const c1 = accent[1] ?? c0;
    const c2 = accent[2] ?? c1;
    const c3 = accent[3] ?? c2;
    return [c0, c1, c2, c3];
  }
  const base = typeof accent === "string" && accent.trim() ? accent : "var(--c-succeeded)";
  return [
    `color-mix(in srgb, ${base} 28%, transparent)`,
    `color-mix(in srgb, ${base} 52%, transparent)`,
    `color-mix(in srgb, ${base} 76%, transparent)`,
    base,
  ];
}

function getLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0;
  const ratio = count / maxCount;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function GitHubActivity({
  contributions,
  repos,
  year = new Date().getFullYear(),
  accent,
  cellSize = 11,
  months = 12,
  label = "Contributions",
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
}: GitHubActivityProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const reducedMotion = useReducedMotion();

  const setOpen = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };

  const items = useMemo(() => {
    const raw = contributions ?? buildDefaultContributions(year);
    if (months >= 12 || raw.length === 0) return raw;
    const maxDays = Math.max(7, Math.round((months / 12) * 365));
    return raw.slice(-maxDays);
  }, [contributions, months, year]);

  const sortedRepos = useMemo(() => {
    const list = repos ?? DEFAULT_REPOS;
    return [...list].sort((a, b) => b.count - a.count);
  }, [repos]);

  const scale = useMemo(() => resolveScale(accent), [accent]);

  const { weeks, totalCount, maxCount, monthLabels } = useMemo(() => {
    const total = items.reduce((sum, item) => sum + item.count, 0);
    const max = items.reduce((m, item) => Math.max(m, item.count), 0);

    const cols: (Contribution | null)[][] = [];
    if (items.length > 0) {
      const firstDate = new Date(`${items[0]?.date ?? `${year}-01-01`}T00:00:00Z`);
      const startDay = Number.isNaN(firstDate.getTime()) ? 0 : firstDate.getUTCDay();
      let currentCol: (Contribution | null)[] = Array.from({ length: startDay }, () => null);

      for (const item of items) {
        currentCol.push(item);
        if (currentCol.length === 7) {
          cols.push(currentCol);
          currentCol = [];
        }
      }
      if (currentCol.length > 0) {
        while (currentCol.length < 7) currentCol.push(null);
        cols.push(currentCol);
      }
    }

    const labels: { colIndex: number; text: string }[] = [];
    let lastMonth = -1;
    let lastLabelCol = -3;
    cols.forEach((col, colIndex) => {
      const firstValid = col.find((c) => c !== null);
      if (!firstValid) return;
      const d = new Date(`${firstValid.date}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return;
      const m = d.getUTCMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        if (colIndex - lastLabelCol >= 2) {
          labels.push({ colIndex, text: MONTH_NAMES[m] ?? "" });
          lastLabelCol = colIndex;
        }
      }
    });

    return { weeks: cols, totalCount: total, maxCount: max, monthLabels: labels };
  }, [items, year]);

  const maxRepoCount = sortedRepos[0]?.count ?? 1;
  const gap = 3;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card border border-border bg-surface p-3.5 text-ink",
        className,
      )}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{label}</span>
          <span className="text-xs text-ink-muted">
            {totalCount.toLocaleString()} in {year}
          </span>
        </div>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-label={isOpen ? "Hide repository breakdown" : "Show repository breakdown"}
          onClick={() => setOpen(!isOpen)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span>Repos</span>
          <motion.span
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.2 }}
            className="inline-flex"
          >
            <ChevronDown size={14} />
          </motion.span>
        </button>
      </div>

      {/* Heatmap */}
      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          {/* Month labels */}
          <div
            className="relative h-4 text-[10px] text-ink-subtle"
            style={{ marginLeft: 20, width: weeks.length * (cellSize + gap) }}
          >
            {monthLabels.map((m) => (
              <span
                key={`${m.colIndex}-${m.text}`}
                style={{ left: m.colIndex * (cellSize + gap) }}
                className="absolute top-0 leading-none"
              >
                {m.text}
              </span>
            ))}
          </div>

          <div className="flex items-start gap-1.5">
            {/* Weekday labels (M / W / F) */}
            <div
              className="grid shrink-0 text-[10px] text-ink-subtle"
              style={{
                gridTemplateRows: `repeat(7, ${cellSize}px)`,
                gap: `${gap}px`,
                width: 14,
              }}
            >
              <span />
              <span className="flex items-center leading-none">M</span>
              <span />
              <span className="flex items-center leading-none">W</span>
              <span />
              <span className="flex items-center leading-none">F</span>
              <span />
            </div>

            {/* Grid columns */}
            <div className="flex" style={{ gap: `${gap}px` }} role="grid" aria-label={label}>
              {weeks.map((col, colIdx) => (
                <div
                  key={colIdx}
                  className="grid"
                  style={{
                    gridTemplateRows: `repeat(7, ${cellSize}px)`,
                    gap: `${gap}px`,
                  }}
                >
                  {col.map((cell, rowIdx) => {
                    if (!cell) {
                      return (
                        <span
                          key={`empty-${colIdx}-${rowIdx}`}
                          style={{ width: cellSize, height: cellSize }}
                          aria-hidden="true"
                        />
                      );
                    }
                    const level = getLevel(cell.count, maxCount);
                    const bg = level === 0 ? undefined : scale[level - 1];
                    const tooltip = `${cell.count} ${cell.count === 1 ? "contribution" : "contributions"} · ${cell.date}`;
                    return (
                      <span
                        key={cell.date}
                        role="gridcell"
                        title={tooltip}
                        aria-label={tooltip}
                        data-level={level}
                        style={{
                          width: cellSize,
                          height: cellSize,
                          backgroundColor: bg,
                        }}
                        className={cn(
                          "rounded-[2px] border border-border/60 transition-transform hover:scale-110",
                          level === 0 && "bg-surface-2",
                        )}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-subtle">
        <span>Less</span>
        <span
          className="inline-block rounded-[2px] border border-border/60 bg-surface-2"
          style={{ width: 9, height: 9 }}
        />
        {scale.map((color, idx) => (
          <span
            key={idx}
            className="inline-block rounded-[2px] border border-border/60"
            style={{ width: 9, height: 9, backgroundColor: color }}
          />
        ))}
        <span>More</span>
      </div>

      {/* Expandable repo breakdown panel OVER the grid */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
            className="absolute inset-x-0 bottom-0 z-10 overflow-hidden border-t border-border bg-surface/95 backdrop-blur-sm"
          >
            <div className="p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">Top repositories</span>
                <span className="text-[11px] text-ink-subtle">{sortedRepos.length} active</span>
              </div>
              <ul className="flex flex-col gap-2">
                {sortedRepos.map((repo) => {
                  const pct = maxRepoCount > 0 ? Math.round((repo.count / maxRepoCount) * 100) : 0;
                  return (
                    <li key={repo.name} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate font-mono text-ink">{repo.name}</span>
                        <span className="shrink-0 tabular-nums text-ink-muted">{repo.count}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: scale[3],
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
