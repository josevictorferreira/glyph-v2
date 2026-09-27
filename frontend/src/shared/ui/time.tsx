import { formatDuration, formatExact, formatRelative, useNow } from "@/shared/lib/time";
import { cn } from "@/shared/lib/cn";

/** Live-updating relative time; exact time on hover (native tooltip). */
export function RelativeTime({
  date,
  className,
  tickMs = 30_000,
}: {
  date: Date | string;
  className?: string;
  tickMs?: number;
}) {
  const now = useNow(tickMs);
  const d = typeof date === "string" ? new Date(date) : date;
  return (
    <time dateTime={d.toISOString()} title={formatExact(d)} className={className}>
      {formatRelative(d, now)}
    </time>
  );
}

/** Duration from ms, optionally ticking while the entity is live. */
export function Duration({
  ms,
  live = false,
  from,
  to,
  className,
}: {
  ms?: number | null;
  live?: boolean;
  /** Compute a live duration from timestamps instead of a stored ms. */
  from?: Date | string | null;
  to?: Date | string | null;
  className?: string;
}) {
  const now = useNow(1000);
  let value = ms ?? null;
  if (from) {
    const end = to ? new Date(to) : live ? now : now;
    value = end.getTime() - new Date(from).getTime();
  }
  return <span className={cn("tabular-nums", className)}>{formatDuration(value)}</span>;
}
