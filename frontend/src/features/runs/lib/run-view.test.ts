import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { StepRunStatus } from "@/gen/glyph/v1/common_pb";
import { RunSchema, StepRunSummarySchema } from "@/gen/glyph/v1/run_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import {
  elapsedMs,
  missingValues,
  needsRunSheet,
  prefillValues,
  snapshotOutdated,
  timeline,
  valuesToSend,
} from "./run-view";

const ts = (ms: number) => timestampFromMs(ms);

const workflow = create(WorkflowSchema, {
  summary: { id: "wf", updatedAt: ts(5_000) },
  inputs: [
    { id: "a", name: "topic", askAtRunTime: true, required: true },
    { id: "b", name: "tone", askAtRunTime: true, required: false, value: "friendly" },
    { id: "c", name: "style", askAtRunTime: false, required: true, value: "short" },
  ],
});

describe("run sheet helpers", () => {
  it("opens the sheet only for required asked values", () => {
    expect(needsRunSheet(workflow)).toBe(true);
    const optional = create(WorkflowSchema, { inputs: [{ name: "x", askAtRunTime: true }] });
    expect(needsRunSheet(optional)).toBe(false);
  });

  it("prefills from the stored default, else the latest run", () => {
    const last = create(RunSchema, { suppliedValues: { topic: "rust", tone: "grumpy" } });
    expect(prefillValues(workflow, last)).toEqual({
      topic: { value: "rust", fromLastRun: true },
      tone: { value: "friendly", fromLastRun: false },
    });
    expect(prefillValues(workflow, undefined).topic).toEqual({ value: "", fromLastRun: false });
  });

  it("flags blank required values and sends only filled ones", () => {
    expect(missingValues(workflow, { topic: " ", tone: "" })).toEqual(["topic"]);
    expect(valuesToSend({ topic: "rust", tone: "" })).toEqual({ topic: "rust" });
  });
});

describe("timeline", () => {
  const step = (
    id: string,
    position: number,
    q?: number,
    s?: number,
    e?: number,
    status = StepRunStatus.SUCCEEDED,
  ) =>
    create(StepRunSummarySchema, {
      id,
      stepName: id,
      position,
      status,
      queuedAt: q === undefined ? undefined : ts(q),
      startedAt: s === undefined ? undefined : ts(s),
      endedAt: e === undefined ? undefined : ts(e),
    });

  it("orders by start and places bars on one axis", () => {
    const { rows, spanMs } = timeline(
      [
        step("late", 1, 0, 600, 1000),
        step("early", 2, 0, 0, 500),
        step("skipped", 0, 0, undefined, undefined, StepRunStatus.SKIPPED),
      ],
      2_000,
    );
    expect(spanMs).toBe(1000);
    expect(rows.map((r) => r.id)).toEqual(["early", "late", "skipped"]);
    expect(rows[0]).toMatchObject({ queued: 0, start: 0, end: 50 });
    expect(rows[1]).toMatchObject({ start: 60, end: 100 });
    expect(rows[2]).toMatchObject({ start: null, end: null });
  });

  it("shows parallel steps overlapping and grows running bars to now", () => {
    const { rows } = timeline(
      [step("a", 0, 0, 0, 400), step("b", 1, 0, 100, undefined, StepRunStatus.RUNNING)],
      800,
    );
    expect(rows[1]).toMatchObject({ start: 12.5, end: 100 });
  });

  it("is empty before anything is queued", () => {
    expect(timeline([], 0).rows).toEqual([]);
  });
});

describe("elapsed and snapshot", () => {
  it("measures running work to now and prefers the stored value", () => {
    expect(
      elapsedMs({ startedAt: ts(1_000), endedAt: undefined, elapsedMs: undefined }, 4_000),
    ).toBe(3_000);
    expect(elapsedMs({ startedAt: ts(1_000), endedAt: ts(2_000), elapsedMs: 900n }, 4_000)).toBe(
      900,
    );
  });

  it("notices a workflow edited after the snapshot", () => {
    const run = create(RunSchema, { snapshot: { capturedAt: ts(1_000) } });
    expect(snapshotOutdated(run, workflow)).toBe(true);
    const fresh = create(RunSchema, { snapshot: { capturedAt: ts(9_000) } });
    expect(snapshotOutdated(fresh, workflow)).toBe(false);
  });
});
