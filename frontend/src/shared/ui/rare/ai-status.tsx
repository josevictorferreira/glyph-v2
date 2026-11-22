// RareUI-inspired AiStatus (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type AiStatusState = "thinking" | "researching" | "analyzing" | "writing" | "done" | "error";

/** Default label per state; unknown string states fall back to the state itself. */
export function defaultLabel(state: AiStatusState | string): string {
  const known: Record<AiStatusState, string> = {
    thinking: "Thinking…",
    researching: "Researching",
    analyzing: "Analyzing",
    writing: "Writing",
    done: "Done",
    error: "Something went wrong",
  };
  return known[state as AiStatusState] ?? state;
}

/** "12s" / "1m 05s" — elapsed seconds formatted for the trailing counter. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toString().padStart(2, "0")}s`;
}

const TERMINAL_STATES: readonly string[] = ["done", "error"];
const isTerminal = (state: string) => TERMINAL_STATES.includes(state);

const ICON = 18;

interface IconProps {
  /** Animate; false (terminal state or reduced motion) renders a static pose. */
  animate: boolean;
}

/** thinking: a small dot orbiting a core. */
function IconThinking({ animate }: IconProps) {
  return (
    <span className="relative inline-block shrink-0" style={{ width: ICON, height: ICON }}>
      <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/40" />
      <motion.span
        className="absolute inset-0"
        initial={false}
        animate={animate ? { rotate: 360 } : { rotate: 215 }}
        transition={animate ? { duration: 1.4, ease: "linear", repeat: Infinity } : { duration: 0 }}
      >
        <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" />
      </motion.span>
    </span>
  );
}

/** researching: pulsing radar rings from a center dot. */
function IconResearching({ animate }: IconProps) {
  const ring = (delay: number) => ({
    initial: false,
    animate: animate ? { scale: [0.3, 1], opacity: [0.7, 0] } : { scale: 0.85, opacity: 0.35 },
    transition: animate
      ? { duration: 1.8, repeat: Infinity, ease: "easeOut" as const, delay, times: [0, 1] }
      : { duration: 0 },
  });
  return (
    <span className="relative inline-block shrink-0" style={{ width: ICON, height: ICON }}>
      {[0, 0.6].map((delay) => (
        <motion.span
          key={delay}
          className="absolute inset-0 rounded-full border border-accent"
          {...ring(delay)}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
    </span>
  );
}

/** analyzing: three bars scanning up and down out of phase. */
function IconAnalyzing({ animate }: IconProps) {
  return (
    <span
      className="inline-flex shrink-0 items-end justify-center gap-[2px]"
      style={{ width: ICON, height: ICON }}
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[2.5px] rounded-full bg-accent"
          style={{ height: ICON }}
          initial={false}
          animate={animate ? { scaleY: [0.3, 1, 0.45, 0.9, 0.3] } : { scaleY: 0.7 - i * 0.12 }}
          transition={
            animate
              ? { duration: 1.6, repeat: Infinity, ease: "easeInOut", delay: i * 0.18 }
              : { duration: 0 }
          }
        />
      ))}
    </span>
  );
}

/** writing: a blinking caret. */
function IconWriting({ animate }: IconProps) {
  return (
    <motion.span
      className="inline-block shrink-0 rounded-[1px] bg-accent"
      style={{ width: 2, height: ICON - 2 }}
      initial={false}
      animate={animate ? { opacity: [1, 1, 0, 0] } : { opacity: 1 }}
      transition={
        animate
          ? { duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1], ease: "linear" }
          : { duration: 0 }
      }
    />
  );
}

/** done: a check that pops in. */
function IconDone() {
  return (
    <motion.svg
      width={ICON}
      height={ICON}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-status-succeeded"
      initial={false}
      animate={{ scale: [0.4, 1.15, 1], opacity: [0, 1, 1] }}
      transition={{ duration: 0.45, ease: "easeOut", times: [0, 0.7, 1] }}
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </motion.svg>
  );
}

/** error: an alert triangle that shakes once. */
function IconError() {
  return (
    <motion.svg
      width={ICON}
      height={ICON}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-status-failed"
      initial={false}
      animate={{ x: [0, -3, 3, -2, 2, 0] }}
      transition={{ duration: 0.4, ease: "easeInOut" }}
    >
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </motion.svg>
  );
}

const labelTone: Record<string, string> = {
  done: "text-status-succeeded",
  error: "text-status-failed",
};

export interface AiStatusProps {
  state: AiStatusState | (string & {});
  label?: string;
  detail?: string;
  /** Tick an internal elapsed-seconds counter while in an active state. */
  timer?: boolean;
  /** Seconds; replaces the internal count when provided. */
  elapsed?: number;
  shimmer?: boolean;
  className?: string;
}

/** Inline line showing what an AI is doing, with a per-state animated mini-icon. */
export function AiStatus({
  state,
  label,
  detail,
  timer = false,
  elapsed,
  shimmer = true,
  className,
}: AiStatusProps) {
  const reduced = useReducedMotion() ?? false;
  const active = !isTerminal(state);
  const animate = active && !reduced;
  const [count, setCount] = useState(0);
  const shownElapsed = elapsed ?? count;

  useEffect(() => {
    if (!timer || !active || elapsed !== undefined) return;
    const id = window.setInterval(() => setCount((c) => c + 1), 1000);
    return () => window.clearInterval(id);
  }, [timer, active, elapsed]);

  const text = label ?? defaultLabel(state);
  const tone = labelTone[state];
  const shimmerOn = shimmer && active && !reduced;

  const icon = (() => {
    switch (state) {
      case "thinking":
        return <IconThinking animate={animate} />;
      case "researching":
        return <IconResearching animate={animate} />;
      case "analyzing":
        return <IconAnalyzing animate={animate} />;
      case "writing":
        return <IconWriting animate={animate} />;
      case "done":
        return <IconDone />;
      case "error":
        return <IconError />;
      default:
        return <IconThinking animate={animate} />;
    }
  })();

  return (
    <span
      data-testid="ai-status"
      data-state={state}
      data-shimmer={shimmerOn ? "true" : "false"}
      className={cn("inline-flex max-w-full items-center gap-2 text-sm", className)}
    >
      {icon}
      <span className="inline-flex min-w-0 items-baseline gap-1.5">
        {shimmerOn ? (
          <motion.span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--c-ink-subtle) 0%, var(--c-ink) 50%, var(--c-ink-subtle) 100%)",
              backgroundSize: "200% 100%",
            }}
            initial={false}
            animate={{ backgroundPosition: ["0% 0%", "200% 0%"] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "linear" }}
          >
            {text}
          </motion.span>
        ) : (
          <span className={cn("truncate", tone ?? "text-ink-muted")}>{text}</span>
        )}
        {detail && (
          <>
            <span className="text-ink-subtle">·</span>
            <span className="truncate text-ink-subtle">{detail}</span>
          </>
        )}
        {(timer || elapsed !== undefined) && (
          <span className="shrink-0 tabular-nums text-ink-subtle" data-testid="ai-status-elapsed">
            {formatElapsed(shownElapsed)}
          </span>
        )}
      </span>
    </span>
  );
}
