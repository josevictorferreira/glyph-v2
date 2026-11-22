// RareUI-inspired AnimatedCounter (rareui.com) — reimplemented on the Glyph design system.
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface FormatCounterOptions {
  decimals?: number;
  padStart?: number;
  separator?: string;
  decimalSeparator?: string;
}

export interface CounterParts {
  digits: string[];
  marks: (string | null)[];
}

export function formatCounterParts(
  value: number,
  options: FormatCounterOptions = {},
): CounterParts {
  const decimals = Math.min(15, Math.max(0, Math.floor(options.decimals ?? 0)));
  const padStart = Math.min(24, Math.max(0, Math.floor(options.padStart ?? 0)));
  const separator = options.separator ?? ",";
  const decimalSeparator = options.decimalSeparator ?? ".";

  const safeValue = Number.isFinite(value) ? value : 0;
  const isNegative = safeValue < 0;
  const fixed = Math.abs(safeValue).toFixed(decimals);
  const [rawInt = "0", decPart] = fixed.split(".");
  const intPart = rawInt.padStart(padStart, "0");

  const digits: string[] = [];
  const marks: (string | null)[] = [];

  const intLen = intPart.length;
  for (let i = 0; i < intLen; i++) {
    const ch = intPart[i] ?? "0";
    digits.push(ch);
    if (i === 0) {
      marks.push(isNegative ? "-" : null);
    } else if (separator !== "" && (intLen - i) % 3 === 0) {
      marks.push(separator);
    } else {
      marks.push(null);
    }
  }

  if (decPart !== undefined && decPart.length > 0) {
    for (let j = 0; j < decPart.length; j++) {
      const ch = decPart[j] ?? "0";
      digits.push(ch);
      marks.push(j === 0 ? decimalSeparator : null);
    }
  }

  return { digits, marks };
}

export interface AnimatedCounterProps {
  value: number;
  decimals?: number;
  duration?: number;
  padStart?: number;
  separator?: string;
  decimalSeparator?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  className?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function DigitColumn({
  digit,
  duration,
  reducedMotion,
}: {
  digit: number;
  duration: number;
  reducedMotion: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block h-[1.2em] w-[0.65em] overflow-hidden align-baseline"
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
      }}
    >
      <motion.span
        className="flex flex-col items-center leading-[1.2em]"
        initial={false}
        animate={{ y: `${-digit * 1.2}em` }}
        transition={reducedMotion ? { duration: 0 } : { duration, ease: [0.22, 1, 0.36, 1] }}
      >
        {DIGITS.map((d) => (
          <span key={d} className="block h-[1.2em] leading-[1.2em]">
            {d}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

export function AnimatedCounter({
  value,
  decimals = 0,
  duration = 0.6,
  padStart = 0,
  separator = ",",
  decimalSeparator = ".",
  prefix,
  suffix,
  className,
}: AnimatedCounterProps) {
  const reducedMotion = Boolean(useReducedMotion());
  const { digits, marks } = formatCounterParts(value, {
    decimals,
    padStart,
    separator,
    decimalSeparator,
  });

  const clampedDecimals = Math.min(15, Math.max(0, Math.floor(decimals)));
  const intCount = digits.length - clampedDecimals;

  const formattedText = digits.map((d, i) => `${marks[i] ?? ""}${d}`).join("");

  return (
    <span
      className={cn("inline-flex items-baseline font-mono tabular-nums text-ink", className)}
      aria-label={formattedText}
    >
      {prefix && <span className="mr-0.5">{prefix}</span>}
      <span className="inline-flex items-baseline" aria-hidden="true">
        <AnimatePresence initial={false} mode="popLayout">
          {digits.map((digitChar, index) => {
            const isDecimal = index >= intCount;
            const key = isDecimal ? `dec-${index - intCount}` : `int-${intCount - 1 - index}`;
            const mark = marks[index];
            const numericDigit = Number.parseInt(digitChar, 10) || 0;

            return (
              <motion.span
                key={key}
                layout={!reducedMotion}
                initial={reducedMotion ? false : { opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, x: 8 }}
                transition={
                  reducedMotion ? { duration: 0 } : { duration: Math.min(0.25, duration * 0.5) }
                }
                className="inline-flex items-baseline"
              >
                {mark !== null && mark !== undefined && (
                  <span className="select-none text-ink-muted">{mark}</span>
                )}
                <DigitColumn
                  digit={numericDigit}
                  duration={duration}
                  reducedMotion={reducedMotion}
                />
              </motion.span>
            );
          })}
        </AnimatePresence>
      </span>
      {suffix && <span className="ml-0.5">{suffix}</span>}
    </span>
  );
}
