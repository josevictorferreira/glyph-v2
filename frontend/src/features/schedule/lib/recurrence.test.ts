// Recurrence mapping tests (spec 0019): the builder ↔ cron table mirrors the
// backend's schedule_calculator tests; the parser only claims shapes it can
// re-serialize losslessly.
import { describe, expect, it } from "vitest";
import { IntervalUnit } from "@/gen/glyph/v1/workflow_pb";
import {
  WEEKDAYS,
  cronFor,
  isConfigured,
  parseCron,
  recurrenceFromCron,
  recurrenceToRequest,
  type Recurrence,
} from "./recurrence";

const r = {
  interval: (every: number, unit: "minutes" | "hours"): Recurrence => ({
    kind: "interval",
    every,
    unit,
  }),
  daily: (hour: number, minute: number): Recurrence => ({ kind: "daily", hour, minute }),
  weekly: (weekday: number, hour: number, minute: number): Recurrence => ({
    kind: "weekly",
    weekday,
    hour,
    minute,
  }),
  monthly: (day: number, hour: number, minute: number): Recurrence => ({
    kind: "monthly",
    day,
    hour,
    minute,
  }),
  cron: (expression: string): Recurrence => ({ kind: "cron", expression }),
};

describe("cronFor (mirrors backend cron_for)", () => {
  it("serializes builder shapes", () => {
    expect(cronFor(r.interval(15, "minutes"))).toBe("*/15 * * * *");
    expect(cronFor(r.interval(6, "hours"))).toBe("7 */6 * * *");
    expect(cronFor(r.daily(9, 30))).toBe("30 9 * * *");
    expect(cronFor(r.weekly(1, 9, 0))).toBe("0 9 * * 1");
    expect(cronFor(r.monthly(3, 8, 0))).toBe("0 8 3 * *");
  });

  it("rejects out-of-range shapes", () => {
    expect(cronFor(r.interval(0, "minutes"))).toBeNull();
    expect(cronFor(r.interval(60, "minutes"))).toBeNull();
    expect(cronFor(r.interval(0, "hours"))).toBeNull();
    expect(cronFor(r.interval(24, "hours"))).toBeNull();
    expect(cronFor(r.monthly(0, 9, 0))).toBeNull();
    expect(cronFor(r.monthly(32, 9, 0))).toBeNull();
  });

  it("rejects invalid cron expressions", () => {
    expect(cronFor(r.cron("not a cron"))).toBeNull();
    expect(cronFor(r.cron("0 9 * *"))).toBeNull();
    // The contract is 5 fields; croner would happily take 6.
    expect(cronFor(r.cron("0 7 */3 * * *"))).toBeNull();
    expect(cronFor(r.cron(""))).toBeNull();
    expect(cronFor(r.cron("  0 9 * * 1  "))).toBe("0 9 * * 1");
  });
});

describe("parseCron", () => {
  it("accepts 5-field expressions and trims", () => {
    expect(parseCron(" 0 9 * * 1 ")).toBe("0 9 * * 1");
  });

  it("rejects everything else", () => {
    expect(parseCron("99 * * * *")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    expect(parseCron("@daily")).toBeNull();
  });
});

describe("recurrenceFromCron (composer defaults)", () => {
  it("recognizes every builder shape it serializes", () => {
    for (const shape of [
      r.interval(15, "minutes"),
      r.interval(6, "hours"),
      r.daily(9, 30),
      r.weekly(1, 9, 0),
      r.monthly(3, 8, 0),
    ]) {
      expect(recurrenceFromCron(cronFor(shape)!)).toEqual(shape);
    }
  });

  it("falls back to cron mode for anything it cannot rebuild losslessly", () => {
    expect(recurrenceFromCron("30 */3 * * *")).toEqual(r.cron("30 */3 * * *"));
    expect(recurrenceFromCron("0 9 * * 1-5")).toEqual(r.cron("0 9 * * 1-5"));
    expect(recurrenceFromCron("0 0,12 * * *")).toEqual(r.cron("0 0,12 * * *"));
    expect(recurrenceFromCron("0 9 * * sun")).toEqual(r.cron("0 9 * * sun"));
  });

  it("returns null for invalid cron", () => {
    expect(recurrenceFromCron("nope")).toBeNull();
  });
});

describe("recurrenceToRequest", () => {
  it("builds the SaveSchedule oneof per pattern", () => {
    expect(recurrenceToRequest("none", r.daily(9, 0))).toEqual({
      case: "none",
      value: expect.objectContaining({ $typeName: "glyph.v1.ScheduleNone" }),
    });
    expect(recurrenceToRequest("interval", r.interval(15, "minutes"))).toEqual({
      case: "interval",
      value: expect.objectContaining({ every: 15, unit: IntervalUnit.MINUTES }),
    });
    expect(recurrenceToRequest("interval", r.interval(6, "hours"))).toEqual({
      case: "interval",
      value: expect.objectContaining({ every: 6, unit: IntervalUnit.HOURS }),
    });
    expect(recurrenceToRequest("daily", r.daily(9, 30))).toEqual({
      case: "daily",
      value: expect.objectContaining({ hour: 9, minute: 30 }),
    });
    expect(recurrenceToRequest("weekly", r.weekly(1, 9, 0))).toEqual({
      case: "weekly",
      value: expect.objectContaining({ weekday: 1, hour: 9, minute: 0 }),
    });
    expect(recurrenceToRequest("monthly", r.monthly(3, 8, 0))).toEqual({
      case: "monthly",
      value: expect.objectContaining({ day: 3, hour: 8, minute: 0 }),
    });
    expect(recurrenceToRequest("cron", r.cron(" 0 9 * * 1 "))).toEqual({
      case: "cron",
      value: expect.objectContaining({ expression: "0 9 * * 1" }),
    });
  });

  it("refuses a pattern/shape mismatch", () => {
    expect(() => recurrenceToRequest("daily", r.weekly(1, 9, 0))).toThrow(/does not match/);
  });
});

describe("WEEKDAYS / isConfigured", () => {
  it("indexes weekdays proto-style (0 = Sunday)", () => {
    expect(WEEKDAYS[0]).toBe("Sunday");
    expect(WEEKDAYS[6]).toBe("Saturday");
  });

  it("requires both cron and timezone for a configured schedule", () => {
    expect(isConfigured(undefined)).toBe(false);
    expect(isConfigured({} as never)).toBe(false);
    expect(isConfigured({ cronExpression: "0 9 * * *" } as never)).toBe(false);
    expect(isConfigured({ cronExpression: "0 9 * * *", timezone: "UTC" } as never)).toBe(true);
  });
});
