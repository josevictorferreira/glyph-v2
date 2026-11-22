// RareUI-inspired OtpInput (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type OtpStatus = "idle" | "success" | "error";
export type OtpInputType = "numbers" | "letters" | "both";
export type OtpInputSize = "sm" | "md" | "lg";

export interface OtpInputProps {
  length?: number;
  size?: OtpInputSize;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  type?: OtpInputType;
  status?: OtpStatus;
  mask?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  slotClassName?: string;
}

export function filterCode(raw: string, type: OtpInputType, length: number): string {
  const maxLen = Math.max(0, Math.trunc(length));
  let pattern: RegExp;
  if (type === "numbers") {
    pattern = /[0-9]/g;
  } else if (type === "letters") {
    pattern = /[a-zA-Z]/g;
  } else {
    pattern = /[a-zA-Z0-9]/g;
  }
  const matches = raw.match(pattern);
  return matches ? matches.join("").slice(0, maxLen) : "";
}

const SIZE_CLASSES: Record<OtpInputSize, string> = {
  sm: "h-10 w-10 text-sm",
  md: "h-12 w-12 text-base",
  lg: "h-14 w-14 text-lg",
};

export function OtpInput({
  length = 6,
  size = "md",
  value,
  defaultValue = "",
  onChange,
  onComplete,
  type = "numbers",
  status = "idle",
  mask = false,
  disabled = false,
  autoFocus = false,
  className,
  slotClassName,
}: OtpInputProps) {
  const reducedMotion = useReducedMotion();
  const caretLayoutId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(() =>
    filterCode(defaultValue, type, length),
  );
  const code = isControlled ? filterCode(value, type, length) : internalValue;

  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.min(code.length, length - 1));
  const [prevStatus, setPrevStatus] = useState<OtpStatus>(status);
  const [editedSinceStatus, setEditedSinceStatus] = useState(false);
  const [errorShakeKey, setErrorShakeKey] = useState(0);

  if (status !== prevStatus) {
    setPrevStatus(status);
    setEditedSinceStatus(false);
    if (status === "error") {
      setErrorShakeKey((k) => k + 1);
    }
  }

  const effectiveStatus: OtpStatus = editedSinceStatus ? "idle" : status;

  const updateCode = useCallback(
    (nextRaw: string) => {
      const next = filterCode(nextRaw, type, length);
      setEditedSinceStatus(true);
      if (!isControlled) {
        setInternalValue(next);
      }
      if (next !== code) {
        onChange?.(next);
        if (next.length === length) {
          onComplete?.(next);
        }
      }
      setActiveIndex(Math.min(next.length, Math.max(0, length - 1)));
    },
    [code, isControlled, length, onChange, onComplete, type],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    updateCode(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setActiveIndex((idx) => Math.max(0, idx - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setActiveIndex((idx) => Math.min(Math.min(code.length, length - 1), idx + 1));
    } else if (e.key === "Backspace") {
      if (code.length === 0) return;
      e.preventDefault();
      if (activeIndex < code.length) {
        const next = code.slice(0, activeIndex) + code.slice(activeIndex + 1);
        setEditedSinceStatus(true);
        if (!isControlled) setInternalValue(next);
        onChange?.(next);
        setActiveIndex(Math.max(0, activeIndex - 1));
      } else {
        const next = code.slice(0, -1);
        setEditedSinceStatus(true);
        if (!isControlled) setInternalValue(next);
        onChange?.(next);
        setActiveIndex(Math.max(0, next.length - 1));
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    const next = filterCode(pasted, type, length);
    setEditedSinceStatus(true);
    if (!isControlled) {
      setInternalValue(next);
    }
    onChange?.(next);
    if (next.length === length) {
      onComplete?.(next);
    }
    setActiveIndex(Math.min(next.length, Math.max(0, length - 1)));
  };

  const inputMode = type === "numbers" ? "numeric" : "text";

  return (
    <motion.div
      key={errorShakeKey}
      data-slot="otp-input"
      data-status={effectiveStatus}
      animate={
        effectiveStatus === "error" && !reducedMotion
          ? { x: [0, -6, 6, -4, 4, 0] }
          : undefined
      }
      transition={{ duration: 0.32 }}
      onClick={() => {
        if (!disabled) inputRef.current?.focus();
      }}
      className={cn(
        "relative inline-flex items-center gap-2",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode={inputMode}
        autoComplete="one-time-code"
        aria-label="One-time code"
        value={code}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => {
          setFocused(true);
          setActiveIndex(Math.min(code.length, Math.max(0, length - 1)));
        }}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={length}
        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />

      {Array.from({ length }, (_, i) => {
        const char = code[i] ?? "";
        const displayChar = char ? (mask ? "•" : char) : "";
        const isActive = focused && i === activeIndex;

        return (
          <div
            key={i}
            data-slot="otp-slot"
            data-active={isActive ? "true" : undefined}
            className={cn(
              "relative flex items-center justify-center overflow-hidden rounded-md border bg-surface font-mono font-semibold text-ink transition-colors",
              SIZE_CLASSES[size],
              effectiveStatus === "idle" &&
                (isActive ? "border-accent ring-2 ring-accent/25" : "border-border"),
              effectiveStatus === "error" && "border-status-failed ring-2 ring-status-failed/25",
              effectiveStatus === "success" && "border-status-succeeded",
              slotClassName,
            )}
          >
            {effectiveStatus === "success" && (
              <motion.span
                aria-hidden="true"
                initial={reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{
                  duration: reducedMotion ? 0 : 0.2,
                  delay: reducedMotion ? 0 : i * 0.05,
                }}
                className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-status-succeeded"
              />
            )}

            <AnimatePresence mode="popLayout" initial={false}>
              {displayChar ? (
                <motion.span
                  key={`${i}-${displayChar}`}
                  initial={reducedMotion ? { opacity: 1 } : { y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={reducedMotion ? { opacity: 0 } : { y: -8, opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.15 }}
                  className="select-none"
                >
                  {displayChar}
                </motion.span>
              ) : null}
            </AnimatePresence>

            {isActive && !char && (
              <motion.span
                layoutId={caretLayoutId}
                aria-hidden="true"
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 500, damping: 35 }
                }
                className="pointer-events-none h-5 w-0.5 animate-pulse rounded-full bg-accent"
              />
            )}
          </div>
        );
      })}
    </motion.div>
  );
}
