import { describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { RunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { WorkflowSummarySchema } from "@/gen/glyph/v1/workflow_pb";
import type { WorkflowSummary } from "@/gen/glyph/v1/workflow_pb";
import { needsAttention, secondaryLine, sortWorkflows } from "./summaries";

const NOW = new Date("2026-01-15T12:00:00Z");

const ts = (iso: string) =>
  create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });

type SummaryInit = MessageInitShape<typeof WorkflowSummarySchema>;
const wf = (overrides: SummaryInit = {}): WorkflowSummary =>
  create(WorkflowSummarySchema, {
    id: "w",
    name: "W",
    status: WorkflowStatus.DRAFT,
    updatedAt: ts("2026-01-15T11:00:00Z"),
    ...overrides,
  });

describe("secondaryLine", () => {
  it("shows running with elapsed time", () => {
    const line = secondaryLine(
      wf({
        status: WorkflowStatus.ACTIVE,
        lastRunStatus: RunStatus.RUNNING,
        lastRunAt: ts("2026-01-15T11:58:00Z"),
      }),
      NOW,
    );
    expect(line.text).toBe("Running · 2 minutes ago");
    expect(line.dot).toBe("accent");
  });

  it("shows failed with relative time", () => {
    expect(
      secondaryLine(
        wf({
          status: WorkflowStatus.NEEDS_ATTENTION,
          lastRunStatus: RunStatus.FAILED,
          lastRunAt: ts("2026-01-15T11:48:00Z"),
        }),
        NOW,
      ).text,
    ).toBe("Needs attention");
    expect(
      secondaryLine(
        wf({ lastRunStatus: RunStatus.FAILED, lastRunAt: ts("2026-01-15T11:48:00Z") }),
        NOW,
      ).text,
    ).toBe("Failed 12 minutes ago");
  });

  it("shows next run when scheduled", () => {
    const line = secondaryLine(
      wf({ status: WorkflowStatus.ACTIVE, nextRunAt: ts("2026-01-15T13:00:00Z") }),
      NOW,
    );
    expect(line.text).toBe("Next in 1 hour");
  });

  it("shows Draft for drafts and Updated otherwise", () => {
    expect(secondaryLine(wf(), NOW).text).toBe("Draft");
    expect(secondaryLine(wf({ status: WorkflowStatus.PAUSED }), NOW).text).toBe(
      "Updated 1 hour ago",
    );
  });
});

describe("sortWorkflows", () => {
  it("orders needs attention, then running, then updated_at", () => {
    const plain = wf({ id: "plain", name: "Plain" });
    const running = wf({
      id: "running",
      status: WorkflowStatus.ACTIVE,
      lastRunStatus: RunStatus.RUNNING,
      lastRunAt: ts("2026-01-15T11:00:00Z"),
      updatedAt: ts("2026-01-15T10:00:00Z"),
    });
    const attention = wf({
      id: "attention",
      status: WorkflowStatus.NEEDS_ATTENTION,
      updatedAt: ts("2026-01-15T09:00:00Z"),
    });
    expect(sortWorkflows([plain, running, attention]).map((w) => w.id)).toEqual([
      "attention",
      "running",
      "plain",
    ]);
  });

  it("falls back to updated_at within the same rank", () => {
    const older = wf({ id: "older", updatedAt: ts("2026-01-14T00:00:00Z") });
    const newer = wf({ id: "newer", updatedAt: ts("2026-01-15T00:00:00Z") });
    expect(sortWorkflows([older, newer]).map((w) => w.id)).toEqual(["newer", "older"]);
  });
});

describe("needsAttention", () => {
  it("flags NEEDS_ATTENTION status and failed last runs", () => {
    expect(needsAttention(wf({ status: WorkflowStatus.NEEDS_ATTENTION }))).toBe(true);
    expect(needsAttention(wf({ lastRunStatus: RunStatus.FAILED }))).toBe(true);
    expect(needsAttention(wf({ lastRunStatus: RunStatus.SUCCEEDED }))).toBe(false);
  });
});
