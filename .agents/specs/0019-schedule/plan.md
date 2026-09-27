# 0019 — Schedule composer

## Goal

Let authors define when a workflow runs in plain language, see exactly when it will run next before saving, supply values for asked inputs on scheduled runs, and understand why a schedule is not dispatching.

## Depends on

0018 (workflow panel section).

## Design

### Summary (in workflow panel and header tooltip)

- No schedule: "Runs only when you start it." + "Add schedule".
- Enabled + active: human description, "Next: Mon 09:00 (in 3h)" from `Schedule.next_run_at`, last dispatched.
- Draft: "Schedule saved. It starts after you activate the workflow." (backend stores it disabled while draft.)
- Paused: "Paused. No scheduled runs until you resume."
- Needs attention: "Not dispatching: fix the issues first." + link to readiness.

### Composer (Sheet)

- Pattern picker (segmented): Every N minutes/hours · Daily · Weekly · Monthly · Custom cron.
  - Interval: number + unit (minutes 1–59, hours 1–23).
  - Daily: time picker (24h, 5-minute steps, free entry).
  - Weekly: weekday chips (single weekday; backend supports one) + time.
  - Monthly: day 1–31 (+ note: months without that day are skipped) + time.
  - Custom: cron input with field helper labels (min hour day month weekday) and parse errors inline.
- Timezone: searchable Combobox of `Intl.supportedValuesOf("timeZone")`, default browser timezone, recently used on top.
- Enabled switch (hidden for drafts with the explanation above).
- **Preview**: next 5 occurrences computed client-side with `croner` in the chosen timezone, shown in that timezone and the viewer's local time when they differ. Cron equivalent shown in small mono text for the builder patterns (same mapping as backend, e.g. hours interval `7 */N * * *`, so preview matches).
- Save → `SaveSchedule{recurrence oneof, timezone, enabled}`; Remove → `SaveSchedule{none}` with confirm.
- After save, the server `next_run_at` is shown; if it disagrees with the preview's first occurrence, display the server value (authoritative).

### Scheduled values

Below the recurrence: for each workflow input that is required and has no stored value (or is asked at run time), a field "Value for scheduled runs" → `SetScheduleValue` (autosave). Missing required ones are flagged with the validator message.

## Tasks

1. Builder ↔ proto oneof mapping and cron-equivalent function mirroring backend → verify: unit tests for each pattern and bounds.
2. Preview with `croner` + timezone display → verify: tests including DST transitions (America/Sao_Paulo, Europe/London) and day-31 months.
3. Composer sheet + save/remove + server reconciliation → verify: e2e set weekly schedule on active workflow shows next run.
4. Summaries by workflow status → verify: component tests for all five states.
5. Scheduled values section → verify: e2e required asked input without value blocks activation until a schedule value is set.

## Acceptance

- Features acceptance 7 (schedule) and 8 (see next run) demonstrated.
- Preview matches server `next_run_at` for every builder pattern in tests with fixed clocks.

## Out of scope

Multiple schedules per workflow, catch-up runs (backend does not support them).
