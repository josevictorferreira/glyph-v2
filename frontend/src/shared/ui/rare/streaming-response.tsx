// RareUI-inspired StreamingResponse (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Markdown } from "@/shared/ui";
import { Check, Copy, RotateCw } from "@/shared/ui/icons";

/** A planned reveal step: chunk of text and the pause that follows it (ms). */
export interface Burst {
  text: string;
  pause: number;
}

export const WORDS_PER_SECOND = 8;
const BURST_WORDS = { min: 2, max: 5 } as const;
const PAUSES = { word: 60, comma: 180, period: 320 } as const;

/**
 * Pure planner: the next burst to reveal from `text` starting at `index`.
 * Bursts are 2–5 words; the pause after a burst is longer when it ends at a
 * sentence/period or clause/comma boundary.
 */
export function planNextBurst(text: string, index: number): Burst {
  const rest = text.slice(index);
  const leading = /^\s+/.exec(rest)?.[0] ?? "";
  const body = rest.slice(leading.length);
  const count =
    BURST_WORDS.min + Math.floor(Math.random() * (BURST_WORDS.max - BURST_WORDS.min + 1));
  let end = 0;
  for (let i = 0; i < count; i++) {
    const m = /\S+/.exec(body.slice(end));
    if (!m || m.index !== 0) break;
    end += m.index + m[0].length;
  }
  if (end === 0) end = /\s|\b/.exec(body)?.index ?? body.length;
  const text2 = body.slice(0, end);
  const after = body.slice(end);
  const nextChar = after[0] ?? "";
  let pause: number = PAUSES.word;
  if (nextChar === "." || nextChar === "!" || nextChar === "?") pause = PAUSES.period;
  else if (/[,;:—–]/.test(nextChar)) pause = PAUSES.comma;
  // Duration targets `speed` words/sec with catch-up when behind schedule.
  return { text: leading + text2, pause };
}

/** Pure: pause (ms) after a burst of `words` words at the given pace,
 *  shrunk by up to 85% when the reveal is `behindMs` behind schedule so
 *  bursts never pile up. */
export function burstDelay(words: number, speed: number, behindMs: number): number {
  const ideal = (words / Math.max(speed, 0.1)) * 1000;
  const catchUp = Math.min(Math.max(behindMs, 0), ideal * 0.85);
  return Math.max(60, Math.round(ideal - catchUp));
}

function ThumbsUpIcon({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) {
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
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

function ThumbsDownIcon({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) {
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
      <path d="M17 14V2" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
    </svg>
  );
}

export interface StreamingResponseProps {
  text: string;
  status: "streaming" | "done" | "stopped";
  /** Average words per second; the reveal catches up when behind. */
  speed?: number;
  /** Color new words land in before settling; also the gliding dot. */
  ink?: string;
  actions?: boolean;
  onRetry?: () => void;
  onFeedback?: (v: "up" | "down" | null) => void;
  defaultFeedback?: "up" | "down" | null;
  onCopy?: (text: string) => void;
  className?: string;
}

export function StreamingResponse({
  text,
  status,
  speed = WORDS_PER_SECOND,
  ink = "var(--c-accent)",
  actions = true,
  onRetry,
  onFeedback,
  defaultFeedback = null,
  onCopy,
  className,
}: StreamingResponseProps) {
  const [shown, setShown] = useState(() => (status === "streaming" ? 0 : text.length));
  const [fresh, setFresh] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(defaultFeedback);
  const [copied, setCopied] = useState(false);
  const reduced = useReducedMotion();
  const startRef = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Typing loop: uneven bursts with punctuation pauses; freeze when not streaming.
  useEffect(() => {
    if (status !== "streaming" || shown >= text.length) return;
    const burst = planNextBurst(text, shown);
    const words = burst.text.trim() ? burst.text.trim().split(/\s+/).length : 1;
    const now = performance.now();
    startRef.current ??= now;
    // Schedule lag: positive when fewer words are shown than the pace allows.
    const shownWords = text
      .slice(0, shown)
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const lag = now - startRef.current - (shownWords / Math.max(speed, 0.1)) * 1000;
    const wait = burstDelay(words, speed, lag) + (reduced ? PAUSES.word : burst.pause);
    timer.current = window.setTimeout(() => {
      setShown((s) => Math.min(s + burst.text.length, text.length));
      setFresh(true);
    }, wait);
    return () => window.clearTimeout(timer.current);
  }, [status, shown, text, speed, reduced]);

  // Replaced text (e.g. a retry): clamp shown length during render.
  const effectiveShown = Math.min(shown, text.length);

  // New ink fades to normal shortly after the burst lands.
  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => setFresh(false), 260);
    return () => window.clearTimeout(t);
  }, [fresh]);

  const copy = () => {
    const shownText = text.slice(0, effectiveShown);
    onCopy?.(shownText);
    void navigator.clipboard?.writeText(shownText).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const toggleFeedback = (v: "up" | "down") => {
    const next = feedback === v ? null : v;
    setFeedback(next);
    onFeedback?.(next);
  };

  const finished = status !== "streaming";
  const done = effectiveShown >= text.length;
  const visible = text.slice(0, effectiveShown);

  return (
    <div className={cn("w-full max-w-[560px]", className)} data-testid="streaming-response">
      <div className="relative">
        <div
          className={cn(
            "transition-[color] duration-300",
            fresh && !reduced ? "[&_.glyph-prose_*]:!text-[color:var(--fresh-ink)]" : "",
          )}
          style={{ ...(fresh && !reduced ? ({ "--fresh-ink": ink } as React.CSSProperties) : {}) }}
        >
          <Markdown text={visible} />
          {status === "streaming" && !done && (
            <motion.span
              className="ml-0.5 inline-block size-[0.42em] translate-y-[-0.1em] rounded-full align-middle"
              style={{ background: ink }}
              animate={reduced ? undefined : { opacity: [1, 0.3, 1] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {finished && done && actions && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-2.5 flex items-center gap-1"
            data-testid="streaming-actions"
          >
            <button
              type="button"
              onClick={copy}
              aria-label="Copy shown text"
              title="Copy"
              className={cn(
                "grid size-7 place-items-center rounded-md text-ink-muted",
                "hover:bg-surface-2 hover:text-ink",
              )}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button
              type="button"
              onClick={() => toggleFeedback("up")}
              aria-label="Good response"
              aria-pressed={feedback === "up"}
              title="Good response"
              className={cn(
                "grid size-7 place-items-center rounded-md",
                feedback === "up" ? "text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              <ThumbsUpIcon size={14} />
            </button>
            <button
              type="button"
              onClick={() => toggleFeedback("down")}
              aria-label="Bad response"
              aria-pressed={feedback === "down"}
              title="Bad response"
              className={cn(
                "grid size-7 place-items-center rounded-md",
                feedback === "down"
                  ? "text-accent"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              <ThumbsDownIcon size={14} />
            </button>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                aria-label="Retry"
                title="Retry"
                className={cn(
                  "grid size-7 place-items-center rounded-md text-ink-muted",
                  "hover:bg-surface-2 hover:text-ink",
                )}
              >
                <RotateCw size={14} />
              </button>
            )}
            {status === "stopped" && (
              <span className="ml-1 text-xs text-ink-subtle">Stopped</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
