// RareUI-inspired StepPlayer (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type StepPlayerStep = {
  label?: string;
  duration?: number;
};

export interface StepPlayerProps {
  steps: number | StepPlayerStep[];
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  playing?: boolean;
  defaultPlaying?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  duration?: number;
  loop?: boolean;
  onComplete?: () => void;
  size?: number;
  showControl?: boolean;
  controlPosition?: "left" | "right";
  seekable?: boolean;
  className?: string;
}

function normalizeSteps(steps: number | StepPlayerStep[]): StepPlayerStep[] {
  if (typeof steps === "number") {
    const count = Math.max(0, Math.floor(steps));
    return Array.from({ length: count }, () => ({}));
  }
  return steps;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

export function StepPlayer({
  steps,
  value,
  defaultValue = 0,
  onValueChange,
  playing,
  defaultPlaying = false,
  onPlayingChange,
  duration = 3000,
  loop = false,
  onComplete,
  size = 44,
  showControl = true,
  controlPosition = "left",
  seekable = true,
  className,
}: StepPlayerProps) {
  const reducedMotion = useReducedMotion();
  const normalizedSteps = useMemo(() => normalizeSteps(steps), [steps]);
  const count = normalizedSteps.length;

  const [internalValue, setInternalValue] = useState(() => clampIndex(defaultValue, count));
  const isValueControlled = value !== undefined;
  const activeIndex = clampIndex(isValueControlled ? value : internalValue, count);

  const [internalPlaying, setInternalPlaying] = useState(defaultPlaying);
  const isPlayingControlled = playing !== undefined;
  const isPlaying = isPlayingControlled ? playing : internalPlaying;

  const [completed, setCompleted] = useState(false);
  const [progressState, setProgressState] = useState<{ step: number; value: number }>({
    step: activeIndex,
    value: 0,
  });
  const progress = progressState.step === activeIndex ? progressState.value : 0;

  const onValueChangeRef = useRef(onValueChange);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onValueChangeRef.current = onValueChange;
    onPlayingChangeRef.current = onPlayingChange;
    onCompleteRef.current = onComplete;
  });

  const setActiveIndex = useCallback(
    (next: number) => {
      const clamped = clampIndex(next, count);
      if (!isValueControlled) {
        setInternalValue(clamped);
      }
      onValueChangeRef.current?.(clamped);
    },
    [count, isValueControlled],
  );

  const setPlayingState = useCallback(
    (next: boolean) => {
      if (!isPlayingControlled) {
        setInternalPlaying(next);
      }
      onPlayingChangeRef.current?.(next);
    },
    [isPlayingControlled],
  );

  const currentStep = normalizedSteps[activeIndex];
  const stepDuration = currentStep?.duration ?? duration;

  // Advance timer while playing
  useEffect(() => {
    if (!isPlaying || count === 0 || stepDuration <= 0) return;

    const tickMs = 50;
    let elapsed = progress * stepDuration;

    const id = window.setInterval(() => {
      elapsed += tickMs;
      if (elapsed >= stepDuration) {
        window.clearInterval(id);
        if (activeIndex < count - 1) {
          setProgressState({ step: activeIndex + 1, value: 0 });
          setActiveIndex(activeIndex + 1);
        } else if (loop) {
          setProgressState({ step: 0, value: 0 });
          setActiveIndex(0);
        } else {
          setProgressState({ step: activeIndex, value: 1 });
          setCompleted(true);
          setPlayingState(false);
          onCompleteRef.current?.();
        }
      } else {
        setProgressState({ step: activeIndex, value: Math.min(1, elapsed / stepDuration) });
      }
    }, tickMs);

    return () => window.clearInterval(id);
    // Intentionally omit `progress` so interval isn't recreated every tick;
    // it restarts cleanly on play/pause/step/duration/loop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, activeIndex, count, stepDuration, loop, setActiveIndex, setPlayingState]);

  const handleControlClick = () => {
    if (count === 0) return;
    if (completed && !loop) {
      setCompleted(false);
      setProgressState({ step: 0, value: 0 });
      setActiveIndex(0);
      setPlayingState(true);
      return;
    }
    setPlayingState(!isPlaying);
  };

  const handleDotClick = (index: number) => {
    if (!seekable) return;
    setCompleted(false);
    setProgressState({ step: index, value: 0 });
    setActiveIndex(index);
  };

  const hasLabels = normalizedSteps.some((s) => Boolean(s.label));
  const dotSize = Math.max(8, Math.round(size * 0.22));
  const pillWidth = Math.max(28, Math.round(size * 0.95));
  const iconSize = Math.max(14, Math.round(size * 0.4));

  const controlButton = showControl ? (
    <button
      type="button"
      onClick={handleControlClick}
      aria-label={completed && !loop ? "Replay" : isPlaying ? "Pause" : "Play"}
      style={{ width: size, height: size }}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        "border border-border bg-surface-2 text-ink transition-colors",
        "hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      {/* Fixed-size box; icons overlap absolutely for a true crossfade. */}
      <span
        aria-hidden="true"
        className="relative inline-flex items-center justify-center"
        style={{ width: iconSize, height: iconSize }}
      >
        <AnimatePresence initial={false}>
          {completed && !loop ? (
            <motion.svg
              key="replay"
              className="absolute inset-0 m-auto"
              width={iconSize}
              height={iconSize}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.6, rotate: -45 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, scale: 0.6 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </motion.svg>
          ) : isPlaying ? (
            <motion.svg
              key="pause"
              className="absolute inset-0 m-auto"
              width={iconSize}
              height={iconSize}
              viewBox="0 0 24 24"
              fill="currentColor"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reducedMotion ? undefined : { opacity: 0, scale: 0.6 }}
              transition={{ duration: reducedMotion ? 0 : 0.16 }}
            >
              <rect x="6" y="4" width="4" height="16" rx="1.2" />
              <rect x="14" y="4" width="4" height="16" rx="1.2" />
            </motion.svg>
          ) : (
            <motion.svg
              key="play"
              className="absolute inset-0 m-auto"
              width={iconSize}
              height={iconSize}
              viewBox="0 0 24 24"
              fill="currentColor"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reducedMotion ? undefined : { opacity: 0, scale: 0.6 }}
              transition={{ duration: reducedMotion ? 0 : 0.16 }}
            >
              <path d="M7 4.5 19.5 12 7 19.5z" />
            </motion.svg>
          )}
        </AnimatePresence>
      </span>
    </button>
  ) : null;

  const track = (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="Steps"
        style={{ height: size }}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3.5"
      >
        {normalizedSteps.map((step, index) => {
          const isActive = index === activeIndex;
          const isPast = index < activeIndex;
          return (
            <motion.button
              key={index}
              type="button"
              layout={!reducedMotion}
              onClick={() => handleDotClick(index)}
              disabled={!seekable}
              aria-label={step.label ?? `Step ${index + 1}`}
              aria-current={isActive ? "step" : undefined}
              style={{
                height: dotSize,
                width: isActive ? pillWidth : dotSize,
              }}
              transition={
                reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32 }
              }
              className={cn(
                "relative overflow-hidden rounded-full transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                seekable ? "cursor-pointer" : "cursor-default",
                isActive || isPast ? "bg-surface-3" : "bg-border-strong/60",
              )}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                  className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-75 ease-linear"
                />
              )}
              {isPast && (
                <span aria-hidden="true" className="absolute inset-0 rounded-full bg-accent/60" />
              )}
            </motion.button>
          );
        })}
      </div>

      {hasLabels && (
        <div className="flex items-center justify-center gap-3 px-2">
          {normalizedSteps.map((step, index) => {
            const isActive = index === activeIndex;
            return (
              <span
                key={index}
                className={cn(
                  "text-xs transition-colors",
                  isActive ? "font-medium text-ink" : "text-ink-subtle",
                )}
              >
                {step.label ?? `Step ${index + 1}`}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className={cn("inline-flex items-start gap-2.5", className)}>
      {controlPosition === "left" && controlButton}
      {track}
      {controlPosition === "right" && controlButton}
    </div>
  );
}
