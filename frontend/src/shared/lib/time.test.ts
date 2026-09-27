import { describe, expect, it } from "vitest";
import { formatDuration, formatExact, formatRelative } from "./time";

describe("formatDuration", () => {
  it("formats compact human durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(3_400)).toBe("3s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(formatDuration(47 * 3_600_000 + 2 * 60_000)).toBe("1d 23h");
  });

  it("handles missing and negative values", () => {
    expect(formatDuration(undefined)).toBe("–");
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(-5)).toBe("–");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-27T12:00:00Z");

  it("formats past and future relative to now", () => {
    expect(formatRelative(new Date("2026-09-27T11:59:40Z"), now)).toMatch(/seconds? ago/);
    expect(formatRelative(new Date("2026-09-27T11:30:00Z"), now)).toMatch(/30 minutes? ago/);
    expect(formatRelative(new Date("2026-09-27T10:00:00Z"), now)).toMatch(/2 hours? ago/);
    expect(formatRelative(new Date("2026-09-26T12:00:00Z"), now)).toMatch(/yesterday|1 day ago/);
    expect(formatRelative(new Date("2026-09-27T13:00:00Z"), now)).toMatch(/in 1 hour|in an hour/);
  });

  it("accepts ISO strings", () => {
    expect(formatRelative("2026-09-27T11:00:00Z", now)).toMatch(/1 hour ago|an hour ago/);
  });
});

describe("formatExact", () => {
  it("includes date and time", () => {
    const out = formatExact(new Date("2026-09-27T15:04:05Z"));
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}/); // some clock time (timezone-agnostic)
  });
});
