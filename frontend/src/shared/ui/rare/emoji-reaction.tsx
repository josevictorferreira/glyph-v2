// RareUI-inspired EmojiReaction (rareui.com) — reimplemented on the Glyph design system.
// Tapback-style trigger: a round button that pops a bar of emoji options with a
// spring stagger; picking (or holding) an emoji fires onReact and floats a few
// copies of it up. Hold-repeat scheduling lives in a pure, testable function.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

const REPEAT_INTERVAL_MS = 333; // ~3 repeats/s
const FLOAT_LIFETIME_MS = 450;
const FLOAT_COUNT = 3;

/**
 * Pure repeat scheduler: `start` fires one pick immediately then repeats on a
 * fixed interval through the injected timer functions; `stop` cancels. Exposed
 * for tests so hold timing can be verified without real timers.
 */
export function createRepeatScheduler(
  pick: () => void,
  intervalMs: number,
  schedule: (fn: () => void, ms: number) => number = window.setInterval.bind(window),
  cancel: (id: number) => void = window.clearInterval.bind(window),
): { start: () => void; stop: () => void } {
  let id: number | null = null;
  return {
    start: () => {
      if (id !== null) return;
      pick();
      id = schedule(pick, intervalMs);
    },
    stop: () => {
      if (id === null) return;
      cancel(id);
      id = null;
    },
  };
}

const sizeClasses = {
  sm: { trigger: "h-8 w-8 text-sm", emoji: "h-8 w-8 text-base", bar: "p-1" },
  md: { trigger: "h-10 w-10 text-base", emoji: "h-9 w-9 text-lg", bar: "p-1.5" },
  lg: { trigger: "h-12 w-12 text-lg", emoji: "h-10 w-10 text-xl", bar: "p-2" },
} as const;

export interface EmojiReactionProps {
  /** Native emoji characters (no emoji package dependency). */
  emojis?: string[];
  onReact?: (emoji: string) => void;
  size?: "sm" | "md" | "lg";
  align?: "left" | "center" | "right";
  className?: string;
}

let floaterSeq = 0;

export function EmojiReaction({
  emojis = ["👍", "❤️", "😂", "😮", "🙏"],
  onReact,
  size = "md",
  align = "center",
  className,
}: EmojiReactionProps) {
  const [open, setOpen] = useState(false);
  const [floaters, setFloaters] = useState<{ id: number; emoji: string; drift: number }[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const classes = sizeClasses[size];

  // Outside click and Escape close the bar.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const spawnFloaters = useCallback(
    (emoji: string) => {
      if (reduced) return;
      const batch = Array.from({ length: FLOAT_COUNT }, () => ({
        id: ++floaterSeq,
        emoji,
        drift: Math.round((Math.random() - 0.5) * 36),
      }));
      setFloaters((prev) => [...prev, ...batch]);
      const ids = new Set(batch.map((f) => f.id));
      window.setTimeout(
        () => setFloaters((prev) => prev.filter((f) => !ids.has(f.id))),
        FLOAT_LIFETIME_MS + 100,
      );
    },
    [reduced],
  );

  const pick = useCallback(
    (emoji: string, closeBar: boolean) => {
      onReact?.(emoji);
      spawnFloaters(emoji);
      if (closeBar) setOpen(false);
    },
    [onReact, spawnFloaters],
  );

  // Pointer path: pointerdown prevents the compatibility click, fires the
  // first pick immediately and repeats while held; releasing stops the
  // repeat and closes the bar. The click handler remains as the keyboard
  // path (Enter/Space activate buttons without pointer events).
  const emojiButtons = useMemo(
    () =>
      emojis.map((emoji, i) => (
        <motion.button
          key={emoji}
          type="button"
          aria-label={`React with ${emoji}`}
          className={cn(
            "flex items-center justify-center rounded-full transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
            classes.emoji,
          )}
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.3, opacity: 0, transition: { duration: 0.12 } }}
          transition={{
            type: "spring",
            stiffness: 500,
            damping: 26,
            delay: reduced ? 0 : i * 0.04,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            const repeat = createRepeatScheduler(() => pick(emoji, false), REPEAT_INTERVAL_MS);
            const stop = () => {
              repeat.stop();
              window.removeEventListener("pointerup", stop);
              window.removeEventListener("pointercancel", stop);
              setOpen(false);
            };
            window.addEventListener("pointerup", stop);
            window.addEventListener("pointercancel", stop);
            repeat.start();
          }}
          onClick={() => pick(emoji, true)}
        >
          {emoji}
        </motion.button>
      )),
    [emojis, classes.emoji, pick, reduced],
  );

  return (
    <div ref={rootRef} className={cn("relative inline-flex flex-col gap-2", className)}>
      <div
        className={cn(
          "flex",
          align === "left" && "justify-start",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
        )}
      >
        <AnimatePresence>
          {open && (
            <motion.div
              role="toolbar"
              aria-label="Emoji reactions"
              className={cn(
                "absolute bottom-full z-10 mb-2 flex items-center rounded-full border border-border",
                "bg-surface shadow-lg",
                classes.bar,
              )}
              initial={{ scale: 0.6, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.6, opacity: 0, y: 8, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              {emojiButtons}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.button
          type="button"
          aria-label={open ? "Close emoji reactions" : "React with emoji"}
          aria-expanded={open}
          className={cn(
            "flex items-center justify-center rounded-full border border-border bg-surface",
            "text-ink transition-colors hover:bg-surface-2",
            classes.trigger,
          )}
          initial={false}
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 26 }}
          onClick={() => setOpen((o) => !o)}
        >
          <motion.svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            initial={false}
            animate={reduced ? { opacity: 1 } : { opacity: [0.55, 1, 0.55] }}
            transition={{ duration: 2.4, repeat: reduced ? 0 : Infinity, ease: "easeInOut" }}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" x2="9.01" y1="9" y2="9" />
            <line x1="15" x2="15.01" y1="9" y2="9" />
          </motion.svg>
        </motion.button>
      </div>
      {/* Floated copies of the picked emoji. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
        <AnimatePresence>
          {floaters.map((f) => (
            <motion.span
              key={f.id}
              className="absolute text-lg"
              initial={{ opacity: 0, y: 0, x: 0, scale: 0.6 }}
              animate={{ opacity: [0, 1, 0], y: -48, x: f.drift, scale: [0.6, 1.15, 1] }}
              exit={{ opacity: 0 }}
              transition={{ duration: FLOAT_LIFETIME_MS / 1000, ease: "easeOut" }}
            >
              {f.emoji}
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
