// Next-occurrence preview (spec 0019): croner in the chosen IANA timezone —
// the same engine the Rust backend uses — so the preview matches the
// server's next_run_at.
import { Cron } from "croner";

/** The viewer's own IANA timezone (for the "your time" line). */
export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Next `count` occurrences strictly after `from` (UTC instants). Invalid → []. */
export function nextOccurrences(
  cron: string,
  timeZone: string,
  count = 5,
  from: Date = new Date(),
): Date[] {
  if (!isValidTimezone(timeZone)) return [];
  try {
    // nextRuns(n, from) enumerates strictly after the seed — the backend's
    // find_next_occurrence(local, false) — regardless of the wall clock.
    return new Cron(cron, { timezone: timeZone }).nextRuns(count, from);
  } catch {
    return [];
  }
}

/** "Mon, Sep 28, 09:00" style wall-clock in the given zone. */
export function formatInZone(
  date: Date,
  timeZone: string,
  locale: string | undefined = undefined,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
