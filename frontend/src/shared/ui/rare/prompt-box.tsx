// RareUI-inspired PromptBox (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Stop } from "@/shared/ui/icons";

export interface PromptEffort {
  id: string;
  label: string;
  color?: string;
}

export interface PromptBoxProps {
  onSubmit: (prompt: string, effort: PromptEffort) => void;
  efforts?: PromptEffort[];
  status?: "idle" | "streaming";
  onStop?: () => void;
  placeholder?: string | string[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

const DEFAULT_EFFORTS: PromptEffort[] = [
  { id: "quick", label: "Quick" },
  { id: "think", label: "Think" },
  { id: "deep", label: "Think deeply" },
];

const STEP_MS = 650;

export function effortFromHoldMs(
  ms: number,
  efforts: readonly PromptEffort[],
  stepMs = STEP_MS,
): number {
  if (efforts.length <= 1) return 0;
  const clampedMs = Math.max(0, ms);
  const safeStep = Math.max(1, stepMs);
  return Math.min(efforts.length - 1, Math.floor(clampedMs / safeStep));
}

function ArrowUpIcon({ size = 16 }: { size?: number }) {
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
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function PromptBox({
  onSubmit,
  efforts = DEFAULT_EFFORTS,
  status = "idle",
  onStop,
  placeholder = "Ask anything…",
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  disabled = false,
  className,
}: PromptBoxProps) {
  const reducedMotion = useReducedMotion();
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const text = isControlled ? controlledValue : uncontrolledValue;

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const placeholders = Array.isArray(placeholder) ? placeholder : [placeholder];
  const activePlaceholder = placeholders[placeholderIdx % Math.max(1, placeholders.length)] ?? "";

  useEffect(() => {
    if (placeholders.length <= 1 || text.length > 0) return;
    const id = window.setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % placeholders.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, [placeholders.length, text.length]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text]);

  const [charging, setCharging] = useState(false);
  const [holdMs, setHoldMs] = useState(0);
  const [lastEffort, setLastEffort] = useState<PromptEffort>(
    efforts[0] ?? { id: "quick", label: "Quick" },
  );
  const [risingWords, setRisingWords] = useState<{ id: number; text: string } | null>(null);

  const chargeStartRef = useRef<number | null>(null);
  const chargeSourceRef = useRef<"pointer" | "keyboard" | null>(null);
  const rafRef = useRef<number | null>(null);
  const handledPointerSubmitRef = useRef(false);
  const risingIdRef = useRef(0);

  const canCharge = efforts.length > 1;
  const currentEffortIdx = effortFromHoldMs(holdMs, efforts, STEP_MS);
  const currentEffort = efforts[currentEffortIdx] ?? efforts[0] ?? { id: "quick", label: "Quick" };
  const canSend = !disabled && status === "idle" && text.trim().length > 0;

  const stopCharging = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    chargeStartRef.current = null;
    chargeSourceRef.current = null;
    setCharging(false);
    setHoldMs(0);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const startCharging = useCallback(
    (source: "pointer" | "keyboard") => {
      if (!canSend) return;
      if (!canCharge) return;
      chargeStartRef.current = performance.now();
      chargeSourceRef.current = source;
      setCharging(true);
      setHoldMs(0);

      const tick = () => {
        if (chargeStartRef.current === null) return;
        setHoldMs(performance.now() - chargeStartRef.current);
        rafRef.current = window.requestAnimationFrame(tick);
      };
      rafRef.current = window.requestAnimationFrame(tick);
    },
    [canCharge, canSend],
  );

  const commitSubmit = useCallback(
    (effortIdx: number) => {
      const trimmed = text.trim();
      if (!trimmed || disabled || status === "streaming") return;
      const chosen = efforts[effortIdx] ?? efforts[0] ?? { id: "quick", label: "Quick" };
      setLastEffort(chosen);
      risingIdRef.current += 1;
      setRisingWords({ id: risingIdRef.current, text: trimmed });
      setText("");
      onSubmit(trimmed, chosen);
    },
    [disabled, efforts, onSubmit, setText, status, text],
  );

  useEffect(() => {
    if (!risingWords) return;
    const id = window.setTimeout(() => setRisingWords(null), 450);
    return () => window.clearTimeout(id);
  }, [risingWords]);

  const finishChargingAndSubmit = useCallback(() => {
    const elapsed =
      chargeStartRef.current !== null ? performance.now() - chargeStartRef.current : 0;
    const idx = effortFromHoldMs(elapsed, efforts, STEP_MS);
    stopCharging();
    commitSubmit(idx);
  }, [commitSubmit, efforts, stopCharging]);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !canSend) return;
    handledPointerSubmitRef.current = false;
    if (canCharge) {
      startCharging("pointer");
    }
  };

  const handlePointerUp = () => {
    if (!charging || chargeSourceRef.current !== "pointer") return;
    handledPointerSubmitRef.current = true;
    finishChargingAndSubmit();
  };

  const handlePointerLeaveOrCancel = () => {
    if (charging && chargeSourceRef.current === "pointer") {
      handledPointerSubmitRef.current = true;
      stopCharging();
    }
  };

  const handleSendClick = () => {
    if (handledPointerSubmitRef.current) {
      handledPointerSubmitRef.current = false;
      return;
    }
    if (!canSend) return;
    commitSubmit(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && charging) {
      e.preventDefault();
      stopCharging();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!canSend) return;
      if (!canCharge) {
        commitSubmit(0);
        return;
      }
      if (!e.repeat && !charging) {
        startCharging("keyboard");
      }
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && charging && chargeSourceRef.current === "keyboard") {
      e.preventDefault();
      finishChargingAndSubmit();
    }
  };

  const maxChargeMs = Math.max(1, (efforts.length - 1) * STEP_MS);
  const fillRatio = charging ? Math.min(1, holdMs / maxChargeMs) : 0;
  const activeColor = currentEffort.color ?? "var(--c-accent)";
  const stopRingColor = lastEffort.color ?? "var(--c-accent)";

  return (
    <div
      className={cn(
        "relative w-full max-w-[560px] rounded-card border border-border bg-surface p-3 shadow-sm transition-colors focus-within:border-border-strong",
        disabled && "opacity-60",
        className,
      )}
    >
      <AnimatePresence>
        {risingWords && !reducedMotion && (
          <motion.div
            key={risingWords.id}
            initial={{ opacity: 0.9, y: 0 }}
            animate={{ opacity: 0, y: -28 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.38, ease: "easeOut" }}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-3 top-3 truncate text-sm text-ink-muted"
          >
            {risingWords.text}
          </motion.div>
        )}
      </AnimatePresence>

      <textarea
        ref={textareaRef}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={activePlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        aria-label="Prompt input"
        className="max-h-48 w-full resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-ink placeholder:text-ink-subtle focus:outline-none"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {canCharge && (
            <div className="flex items-center gap-1.5" aria-label="Effort level">
              <div className="flex items-center gap-1">
                {efforts.map((effort, idx) => {
                  const lit = charging ? idx <= currentEffortIdx : idx === 0 && canSend;
                  return (
                    <span
                      key={effort.id}
                      className={cn(
                        "h-1.5 w-4 rounded-full transition-colors duration-150",
                        lit ? "bg-accent" : "bg-surface-3",
                      )}
                      style={
                        lit && effort.color ? { backgroundColor: effort.color } : undefined
                      }
                    />
                  );
                })}
              </div>
              <span className="text-xs font-medium text-ink-muted">
                {charging ? currentEffort.label : efforts[0]?.label}
              </span>
            </div>
          )}
        </div>

        {status === "streaming" ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-ink transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            style={{ boxShadow: `0 0 0 2px ${stopRingColor}` }}
          >
            <Stop size={14} />
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeaveOrCancel}
            onPointerCancel={handlePointerLeaveOrCancel}
            onClick={handleSendClick}
            aria-label={charging ? `Send (${currentEffort.label})` : "Send"}
            className={cn(
              "relative inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              canSend
                ? "bg-accent text-on-accent hover:bg-accent-hover"
                : "cursor-not-allowed bg-surface-2 text-ink-subtle",
            )}
          >
            {charging && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 transition-[height] duration-75"
                style={{
                  height: `${Math.round(fillRatio * 100)}%`,
                  backgroundColor: activeColor,
                  filter: "brightness(1.2)",
                }}
              />
            )}
            <span className="relative z-10">
              <ArrowUpIcon size={15} />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
