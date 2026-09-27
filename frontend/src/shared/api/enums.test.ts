import { describe, expect, it, vi } from "vitest";
import * as enums from "./enums";
import {
  IssueEntityType,
  IssueSeverity,
  OutputFileFormat,
  RunStatus,
  RunTrigger,
  StepKind,
  StepRunStatus,
  WorkflowStatus,
} from "@/gen/glyph/v1/common_pb";
import { InputSourceKind, ToolState } from "@/gen/glyph/v1/run_pb";
import { IntervalUnit } from "@/gen/glyph/v1/workflow_pb";
import { EventType } from "@/gen/glyph/v1/live_pb";

// Exhaustiveness: iterate every enum member from the generated code and check
// each describe() maps it (only UNSPECIFIED falls back to "Unknown").
const cases: [string, Record<string, string | number>, (value: never) => enums.EnumView][] = [
  ["WorkflowStatus", WorkflowStatus, enums.describeWorkflowStatus as never],
  ["RunStatus", RunStatus, enums.describeRunStatus as never],
  ["StepRunStatus", StepRunStatus, enums.describeStepRunStatus as never],
  ["StepKind", StepKind, enums.describeStepKind as never],
  ["OutputFileFormat", OutputFileFormat, enums.describeOutputFileFormat as never],
  ["RunTrigger", RunTrigger, enums.describeRunTrigger as never],
  ["IssueSeverity", IssueSeverity, enums.describeIssueSeverity as never],
  ["IssueEntityType", IssueEntityType, enums.describeIssueEntityType as never],
  ["InputSourceKind", InputSourceKind, enums.describeInputSourceKind as never],
  ["ToolState", ToolState, enums.describeToolState as never],
  ["IntervalUnit", IntervalUnit, enums.describeIntervalUnit as never],
  ["EventType", EventType, enums.describeEventType as never],
];

describe("enum maps are exhaustive", () => {
  it.each(cases)("%s", (_name, protoEnum, describe) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [key, value] of Object.entries(protoEnum)) {
      if (typeof value !== "number") continue;
      const view = describe(value as never);
      expect(view.label.length).toBeGreaterThan(0);
      if (value === 0 || key.endsWith("UNSPECIFIED")) {
        expect(view.label).toBe("Unknown");
      } else {
        expect(view.label).not.toBe("Unknown");
      }
    }
  });

  it("warns once for unknown values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(enums.describeWorkflowStatus(999 as WorkflowStatus).label).toBe("Unknown");
    expect(enums.describeWorkflowStatus(999 as WorkflowStatus).label).toBe("Unknown");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
