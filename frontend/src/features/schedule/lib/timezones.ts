// Timezone options (spec 0019): every IANA zone, recently used on top.
import type { ComboboxItem } from "@/shared/ui";
import { isValidTimezone } from "./preview";

const RECENT_KEY = "glyph.schedule.recentTimezones";
const RECENT_MAX = 3;

function supportedTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? [];
}

export function recentTimezones(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((z): z is string => typeof z === "string");
  } catch {
    return [];
  }
}

export function rememberTimezone(timezone: string): void {
  try {
    const next = [timezone, ...recentTimezones().filter((z) => z !== timezone)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode / disabled storage: recents are a nicety, not a feature.
  }
}

export function timezoneItems(current?: string): ComboboxItem[] {
  const recent = recentTimezones();
  const zones = supportedTimezones();
  const listed = new Set([...zones, ...recent]);
  const items: ComboboxItem[] = [];
  // "UTC" and other special zones are absent from supportedValuesOf; keep
  // the saved selection visible (and selectable) regardless.
  if (current && !listed.has(current) && isValidTimezone(current)) {
    items.push({ value: current, label: current, group: "Current" });
  }
  items.push(...recent.map((value) => ({ value, label: value, group: "Recent" })));
  items.push(
    ...zones
      .filter((z) => !recent.includes(z))
      .map((value) => ({ value, label: value, group: "All timezones" })),
  );
  return items;
}
