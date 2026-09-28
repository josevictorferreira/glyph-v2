// Preview tests (spec 0019): croner in the chosen timezone with fixed clocks,
// including DST transitions (Europe/London, America/Sao_Paulo) and months
// without day 31.
import { describe, expect, it } from "vitest";
import { formatInZone, isValidTimezone, nextOccurrences, viewerTimezone } from "./preview";

const at = (iso: string) => new Date(iso);
const isos = (dates: Date[]) => dates.map((d) => d.toISOString());

describe("nextOccurrences", () => {
  it("enumerates strictly after the seed date", () => {
    expect(isos(nextOccurrences("0 9 * * *", "UTC", 2, at("2026-09-28T09:00:00Z")))).toEqual([
      "2026-09-29T09:00:00.000Z",
      "2026-09-30T09:00:00.000Z",
    ]);
  });

  it("crosses the London spring-forward boundary (GMT → BST)", () => {
    // 2026-03-29 01:00 GMT the clocks jump to 02:00 BST; 09:00 local stays 09:00 local.
    expect(
      isos(nextOccurrences("0 9 * * *", "Europe/London", 4, at("2026-03-27T00:00:00Z"))),
    ).toEqual([
      "2026-03-27T09:00:00.000Z",
      "2026-03-28T09:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
    ]);
  });

  it("crosses the London fall-back boundary (BST → GMT)", () => {
    expect(
      isos(nextOccurrences("0 9 * * *", "Europe/London", 4, at("2026-10-23T00:00:00Z"))),
    ).toEqual([
      "2026-10-23T08:00:00.000Z",
      "2026-10-24T08:00:00.000Z",
      "2026-10-25T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
  });

  it("uses the America/Sao_Paulo fixed -03:00 offset", () => {
    expect(
      isos(nextOccurrences("0 9 * * *", "America/Sao_Paulo", 3, at("2026-10-01T00:00:00Z"))),
    ).toEqual(["2026-10-01T12:00:00.000Z", "2026-10-02T12:00:00.000Z", "2026-10-03T12:00:00.000Z"]);
  });

  it("skips months without day 31 and keeps the local time across DST", () => {
    expect(
      isos(nextOccurrences("0 9 31 * *", "Europe/London", 5, at("2026-09-01T00:00:00Z"))),
    ).toEqual([
      "2026-10-31T09:00:00.000Z", // GMT
      "2026-12-31T09:00:00.000Z", // no Nov 31
      "2027-01-31T09:00:00.000Z",
      "2027-03-31T08:00:00.000Z", // BST; no Feb 31
      "2027-05-31T08:00:00.000Z", // no Apr 31
    ]);
  });

  it("returns [] for invalid cron or timezone", () => {
    expect(nextOccurrences("not a cron", "UTC", 5, at("2026-01-01T00:00:00Z"))).toEqual([]);
    expect(nextOccurrences("0 9 * * *", "Not/AZone", 5, at("2026-01-01T00:00:00Z"))).toEqual([]);
  });
});

describe("timezone and formatting helpers", () => {
  it("validates IANA timezones", () => {
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("formats wall-clock in the zone", () => {
    expect(formatInZone(at("2026-10-25T09:00:00Z"), "Europe/London", "en-US")).toBe(
      "Sun, Oct 25, 09:00",
    );
    expect(formatInZone(at("2026-10-25T09:00:00Z"), "America/Sao_Paulo", "en-US")).toBe(
      "Sun, Oct 25, 06:00",
    );
  });

  it("always returns some viewer timezone", () => {
    expect(viewerTimezone().length).toBeGreaterThan(0);
  });
});
