// RareUI-inspired WebSearch (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/shared/ui";

export interface WebSource {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  favicon?: ReactNode;
}

/** Pure: domain of a URL, without a leading "www." (falls back to the URL). */
export function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? url;
  }
}

/** Pure: search-pill label for the current status and source count. */
export function searchLabel(
  status: "searching" | "done",
  sources: number,
  label?: string,
): string {
  if (label) return label;
  if (status === "searching") return "Searching the web";
  return `Searched ${sources} ${sources === 1 ? "site" : "sites"}`;
}

/** Pure: character delay (ms) for the answer typewriter — 1/speed baseline,
 *  shrinking toward 12ms as backlog grows so text never lags behind. */
export function typeDelay(speed: number, backlogChars: number): number {
  const base = 1000 / Math.max(speed, 1);
  const shrink = Math.min(backlogChars / 120, 1);
  return Math.max(12, Math.round(base * (1 - shrink * 0.85)));
}

function GlobeIcon({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function ProgressRing({ progress, className }: { progress: number; className?: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={cn("text-accent", className)}
      width={18}
      height={18}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
    >
      <circle cx="9" cy="9" r={r} stroke="currentColor" strokeWidth="1.5" className="opacity-20" />
      <circle
        cx="9"
        cy="9"
        r={r}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(Math.max(progress, 0), 1))}
        transform="rotate(-90 9 9)"
        style={{ transition: "stroke-dashoffset 300ms ease-out" }}
      />
    </svg>
  );
}

function FaviconTile({ source, className }: { source: WebSource; className?: string }) {
  if (source.favicon) {
    return <span className={cn("grid size-5 shrink-0 place-items-center", className)}>{source.favicon}</span>;
  }
  const domain = domainOf(source.url);
  const letter = (domain[0] ?? "?").toUpperCase();
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded bg-surface-3 text-[10px] font-semibold text-ink",
        className,
      )}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export interface WebSearchProps {
  sources: WebSource[];
  status: "searching" | "done";
  query?: string;
  label?: string;
  /** 0–1; defaults to steps per loaded source. */
  progress?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function WebSearch({
  sources,
  status,
  query,
  label,
  progress,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
}: WebSearchProps) {
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(defaultOpen);
  const open = controlled ? openProp : openState;
  const reduced = useReducedMotion();

  const setOpen = (v: boolean) => {
    if (!controlled) setOpenState(v);
    onOpenChange?.(v);
  };

  const ring = progress ?? (sources.length > 0 ? sources.length / 8 : 0.15);
  const text = searchLabel(status, sources.length, label);

  return (
    <div className={cn("w-full max-w-[560px]", className)} data-testid="web-search">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2.5 rounded-full border border-border bg-surface px-3 py-1.5 text-left shadow-sm",
          "outline-none transition-colors hover:border-border-strong hover:bg-surface-2",
        )}
      >
        <span className="relative grid size-[18px] shrink-0 place-items-center text-ink-muted">
          <GlobeIcon size={18} />
        </span>
        <span className="flex items-center gap-2 overflow-hidden">
          {query && (
            <span className="max-w-56 truncate text-xs text-ink-subtle">“{query}”</span>
          )}
          {status === "searching" ? (
            <span className="relative overflow-hidden text-xs text-ink-muted">
              <motion.span
                className="block"
                animate={reduced ? undefined : { x: ["0%", "100%", "-100%", "0%"] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", times: [0, 0.45, 0.5, 1] }}
              >
                {text}
              </motion.span>
            </span>
          ) : (
            <span className="block truncate text-xs text-ink-muted">{text}</span>
          )}
        </span>
        <span className="ml-auto grid shrink-0 place-items-center">
          {status === "searching" ? (
            <ProgressRing progress={ring} />
          ) : (
            <motion.span
              animate={reduced ? undefined : { rotate: open ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="text-ink-subtle"
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </motion.span>
          )}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="sources"
            initial={reduced ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="mt-2 flex flex-col gap-2"
          >
            {sources.map((source, i) => (
              <SourceCard key={source.id} source={source} index={i} reduced={!!reduced} />
            ))}
            {sources.length === 0 && (
              <div className="rounded-card border border-dashed border-border px-3 py-4 text-center text-xs text-ink-subtle">
                {status === "searching" ? "Searching…" : "No sources"}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SourceCard({ source, index, reduced }: { source: WebSource; index: number; reduced: boolean }) {
  const [hovered, setHovered] = useState(false);
  const domain = domainOf(source.url);
  return (
    <motion.a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{
        opacity: 1,
        y: 0,
        // Fan out on hover: the row lifts while siblings sink back.
        scale: hovered ? 1.02 : 1,
      }}
      transition={{
        opacity: { duration: 0.2, delay: reduced ? 0 : Math.min(index * 0.04, 0.2) },
        y: { type: "spring", stiffness: 400, damping: 30, delay: reduced ? 0 : Math.min(index * 0.04, 0.2) },
        scale: { duration: 0.15 },
      }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className={cn(
        "flex items-start gap-3 rounded-card border bg-surface p-3 shadow-sm outline-none",
        hovered ? "border-border-strong shadow-md" : "border-border",
      )}
    >
      <FaviconTile source={source} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{source.title}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-subtle">{domain}</span>
        {source.snippet && (
          <span className="mt-1 block line-clamp-2 text-xs text-ink-muted">{source.snippet}</span>
        )}
      </span>
    </motion.a>
  );
}

export interface WebSearchAnswerProps {
  play: boolean;
  /** Characters per second; speeds up on backlog. */
  speed?: number;
  onComplete?: () => void;
  children: string;
  className?: string;
}

export function WebSearchAnswer({
  play,
  speed = 40,
  onComplete,
  children,
  className,
}: WebSearchAnswerProps) {
  const [shown, setShown] = useState(0);
  const doneRef = useRef(false);
  const effectiveShown = play ? Math.min(shown, children.length) : children.length;

  useEffect(() => {
    if (!play) {
      doneRef.current = false;
      return;
    }
    if (effectiveShown >= children.length) {
      if (!doneRef.current) {
        doneRef.current = true;
        onComplete?.();
      }
      return;
    }
    const delay = typeDelay(speed, children.length - effectiveShown);
    const t = window.setTimeout(() => {
      const step = children.length - effectiveShown > 60 ? 3 : 1; // catch up on long backlog
      setShown((s) => Math.min(s + step, children.length));
    }, delay);
    return () => window.clearTimeout(t);
  }, [play, effectiveShown, children.length, speed, onComplete]);

  return (
    <span className={cn("text-sm text-ink", className)} data-testid="web-search-answer">
      {children.slice(0, effectiveShown)}
      {play && effectiveShown < children.length && (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-accent" aria-hidden />
      )}
    </span>
  );
}

export interface WebSearchCitationProps {
  source: WebSource;
  index: number;
}

export function WebSearchCitation({ source, index }: WebSearchCitationProps) {
  const domain = domainOf(source.url);
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "mx-px inline-grid size-[18px] translate-y-[-1px] place-items-center rounded border border-border",
            "bg-surface text-[10px] font-semibold text-ink-muted transition-colors",
            "hover:border-accent hover:bg-accent-soft hover:text-accent",
          )}
          aria-label={`Source ${index + 1}: ${source.title}`}
        >
          {index + 1}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" data-testid="citation-preview">
        <div className="flex items-center gap-2">
          <FaviconTile source={source} />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-subtle">{domain}</span>
        </div>
        <div className="mt-1.5 line-clamp-2 text-sm font-medium text-ink">{source.title}</div>
        {source.snippet && (
          <div className="mt-1 line-clamp-2 text-xs text-ink-muted">{source.snippet}</div>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
