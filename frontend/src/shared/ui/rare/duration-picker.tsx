// RareUI-inspired DurationPicker (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Check } from "@/shared/ui/icons";

export type DurationValue = {
  hours: number;
  minutes: number;
};

export interface DurationPickerProps {
  value?: DurationValue;
  defaultValue?: DurationValue;
  onChange?: (value: DurationValue) => void;
  onConfirm?: (value: DurationValue) => void;
  onEditingChange?: (editing: boolean) => void;
  defaultEditing?: boolean;
  maxHours?: number;
  maxMinutes?: number;
  hoursLabel?: string;
  minutesLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function clampDuration(
  value: DurationValue,
  maxHours = 24,
  maxMinutes = 60,
): DurationValue {
  const safeMaxHours = Math.max(0, Number.isFinite(maxHours) ? Math.trunc(maxHours) : 24);
  const safeMaxMinutes = Math.max(0, Number.isFinite(maxMinutes) ? Math.trunc(maxMinutes) : 60);

  let hours = Number.isFinite(value.hours) ? Math.trunc(value.hours) : 0;
  let minutes = Number.isFinite(value.minutes) ? Math.trunc(value.minutes) : 0;

  if (hours < 0) hours = 0;
  if (minutes < 0) minutes = 0;

  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes = minutes % 60;
  }

  hours = Math.min(hours, safeMaxHours);
  minutes = Math.min(minutes, safeMaxMinutes);

  return { hours, minutes };
}

function parseDraft(raw: string): number {
  if (raw.trim() === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function DurationPicker({
  value,
  defaultValue = { hours: 0, minutes: 0 },
  onChange,
  onConfirm,
  onEditingChange,
  defaultEditing = false,
  maxHours = 24,
  maxMinutes = 60,
  hoursLabel = "Hr.",
  minutesLabel = "Min.",
  disabled = false,
  className,
}: DurationPickerProps) {
  const reducedMotion = useReducedMotion();
  const isControlled = value !== undefined;

  const [internalValue, setInternalValue] = useState<DurationValue>(() =>
    clampDuration(defaultValue, maxHours, maxMinutes),
  );
  const currentValue = isControlled
    ? clampDuration(value, maxHours, maxMinutes)
    : internalValue;

  const [editing, setEditing] = useState(defaultEditing);
  const [hoursDraft, setHoursDraft] = useState(String(currentValue.hours));
  const [minutesDraft, setMinutesDraft] = useState(String(currentValue.minutes));
  const [shakeHours, setShakeHours] = useState(0);
  const [shakeMinutes, setShakeMinutes] = useState(0);

  const lastConfirmedRef = useRef<DurationValue>(currentValue);
  const hoursInputRef = useRef<HTMLInputElement>(null);

  const setEditingState = useCallback(
    (next: boolean) => {
      setEditing(next);
      onEditingChange?.(next);
    },
    [onEditingChange],
  );

  const commitValue = useCallback(
    (next: DurationValue) => {
      if (!isControlled) {
        setInternalValue(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const enterEdit = () => {
    if (disabled) return;
    lastConfirmedRef.current = currentValue;
    setHoursDraft(String(currentValue.hours));
    setMinutesDraft(String(currentValue.minutes));
    setEditingState(true);
    requestAnimationFrame(() => {
      hoursInputRef.current?.focus();
      hoursInputRef.current?.select();
    });
  };

  const cancelEdit = useCallback(() => {
    const restored = lastConfirmedRef.current;
    if (!isControlled) {
      setInternalValue(restored);
    }
    if (restored.hours !== currentValue.hours || restored.minutes !== currentValue.minutes) {
      onChange?.(restored);
    }
    setHoursDraft(String(restored.hours));
    setMinutesDraft(String(restored.minutes));
    setEditingState(false);
  }, [currentValue.hours, currentValue.minutes, isControlled, onChange, setEditingState]);

  const clampAndShakeIfNeeded = useCallback(
    (rawH: string, rawM: string): DurationValue => {
      const rawHours = parseDraft(rawH);
      const rawMinutes = parseDraft(rawM);
      const clamped = clampDuration({ hours: rawHours, minutes: rawMinutes }, maxHours, maxMinutes);

      if (rawHours < 0 || rawHours > maxHours) {
        setShakeHours((c) => c + 1);
      }
      if (rawMinutes < 0 || rawMinutes > maxMinutes) {
        setShakeMinutes((c) => c + 1);
      }

      setHoursDraft(String(clamped.hours));
      setMinutesDraft(String(clamped.minutes));
      commitValue(clamped);
      return clamped;
    },
    [commitValue, maxHours, maxMinutes],
  );

  const confirmEdit = useCallback(() => {
    const clamped = clampAndShakeIfNeeded(hoursDraft, minutesDraft);
    lastConfirmedRef.current = clamped;
    onConfirm?.(clamped);
    setEditingState(false);
  }, [clampAndShakeIfNeeded, hoursDraft, minutesDraft, onConfirm, setEditingState]);

  const handleHoursChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setHoursDraft(raw);
    const clamped = clampDuration(
      { hours: parseDraft(raw), minutes: parseDraft(minutesDraft) },
      maxHours,
      maxMinutes,
    );
    commitValue(clamped);
  };

  const handleMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setMinutesDraft(raw);
    const clamped = clampDuration(
      { hours: parseDraft(hoursDraft), minutes: parseDraft(raw) },
      maxHours,
      maxMinutes,
    );
    commitValue(clamped);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const spring = reducedMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 28 };

  return (
    <div
      data-slot="duration-picker"
      data-editing={editing ? "true" : "false"}
      data-disabled={disabled ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface p-1 text-sm text-ink",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {!editing ? (
        <button
          type="button"
          data-slot="duration-picker-toggle"
          disabled={disabled}
          onClick={enterEdit}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-sm font-medium text-ink transition-colors",
            "hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            "disabled:cursor-not-allowed",
          )}
        >
          <motion.span
            layout
            transition={spring}
            data-slot="duration-picker-segment"
            className="inline-flex items-baseline gap-1 rounded bg-surface-2 px-1.5 py-0.5 tabular-nums"
          >
            <span>{currentValue.hours}</span>
            <span className="text-xs text-ink-muted">{hoursLabel}</span>
          </motion.span>
          <motion.span
            layout
            transition={spring}
            data-slot="duration-picker-segment"
            className="inline-flex items-baseline gap-1 rounded bg-surface-2 px-1.5 py-0.5 tabular-nums"
          >
            <span>{currentValue.minutes}</span>
            <span className="text-xs text-ink-muted">{minutesLabel}</span>
          </motion.span>
        </button>
      ) : (
        <div className="inline-flex items-center gap-1.5">
          <motion.div
            key={`h-${shakeHours}`}
            data-slot="duration-picker-segment"
            animate={
              shakeHours > 0 && !reducedMotion ? { x: [0, -4, 4, -3, 3, 0] } : undefined
            }
            transition={{ duration: 0.28 }}
            className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5"
          >
            <input
              ref={hoursInputRef}
              type="number"
              data-slot="duration-picker-input"
              aria-label={hoursLabel}
              value={hoursDraft}
              onChange={handleHoursChange}
              onBlur={() => clampAndShakeIfNeeded(hoursDraft, minutesDraft)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="h-6 w-11 rounded border border-border bg-surface px-1 text-center text-sm tabular-nums text-ink focus-visible:border-accent focus-visible:outline-none"
            />
            <button
              type="button"
              data-slot="duration-picker-toggle"
              onClick={cancelEdit}
              tabIndex={-1}
              className="text-xs text-ink-muted hover:text-ink"
            >
              {hoursLabel}
            </button>
          </motion.div>

          <motion.div
            key={`m-${shakeMinutes}`}
            data-slot="duration-picker-segment"
            animate={
              shakeMinutes > 0 && !reducedMotion ? { x: [0, -4, 4, -3, 3, 0] } : undefined
            }
            transition={{ duration: 0.28 }}
            className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5"
          >
            <input
              type="number"
              data-slot="duration-picker-input"
              aria-label={minutesLabel}
              value={minutesDraft}
              onChange={handleMinutesChange}
              onBlur={() => clampAndShakeIfNeeded(hoursDraft, minutesDraft)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="h-6 w-11 rounded border border-border bg-surface px-1 text-center text-sm tabular-nums text-ink focus-visible:border-accent focus-visible:outline-none"
            />
            <button
              type="button"
              data-slot="duration-picker-toggle"
              onClick={cancelEdit}
              tabIndex={-1}
              className="text-xs text-ink-muted hover:text-ink"
            >
              {minutesLabel}
            </button>
          </motion.div>

          <button
            type="button"
            aria-label="Confirm duration"
            onClick={confirmEdit}
            disabled={disabled}
            className="inline-flex h-6 w-6 items-center justify-center rounded bg-accent text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Check size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
