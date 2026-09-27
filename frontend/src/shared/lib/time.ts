import { useEffect, useState } from "react";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

/** protobuf v2 Timestamp → epoch ms (no toMillis on the WKT shape). */
export function tsToMs(ts: Timestamp | undefined): number | undefined {
  if (!ts) return undefined;
  return Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6);
}

/** protobuf v2 Timestamp → Date, undefined-preserving. */
export function tsToDate(ts: Timestamp | undefined): Date | undefined {
  const ms = tsToMs(ts);
  return ms === undefined ? undefined : new Date(ms);
}

/** Relative formatting ("3m ago", "in 2h") via Intl. */
export function formatRelative(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const div = (ms: number) => Math.round(diff / ms);
  if (abs < 45_000) return rtf.format(div(1000), "second");
  if (abs < 45 * 60_000) return rtf.format(div(60_000), "minute");
  if (abs < 22 * 3_600_000) return rtf.format(div(3_600_000), "hour");
  if (abs < 26 * 86_400_000) return rtf.format(div(86_400_000), "day");
  return rtf.format(div(30 * 86_400_000), "month");
}

/** Exact wall-clock time for tooltips ("Sep 27, 2026, 15:04"). */
export function formatExact(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

/** Compact duration from milliseconds: "3s", "2m 14s", "1h 03m", "2d 4h". */
export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return "–";
  if (ms < 0) return "–";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Ticking clock for live components (RelativeTime, live Durations). */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
