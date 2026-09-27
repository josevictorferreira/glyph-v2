// Issue → editor mapping tests (spec 0018): the readiness deep links and
// tab dots must follow the backend validator's field names exactly.
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { IssueEntityType, IssueSchema } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { groupIssues, issueField, issueStepId, issueTarget, stepTabIssues } from "./issues";

const issue = (entityType: IssueEntityType, entityId: string, field: string): Issue =>
  create(IssueSchema, { entityType, entityId, field, message: "m" });

const workflow = create(WorkflowSchema, {
  summary: { id: "wf" },
  inputs: [{ id: "in-1", name: "topic", required: true, askAtRunTime: true }],
  steps: [
    { id: "s1", name: "Research", inputs: [{ id: "si-1", name: "topic", required: true, position: 0 }] },
    { id: "s2", name: "Design", inputs: [] },
  ],
  connections: [
    { id: "c1", sourceStepId: "s1", destinationStepId: "s2", destinationInputId: "si-2" },
  ],
}) as Workflow;

describe("issueTarget", () => {
  it("maps step fields to their editor tab", () => {
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_STEP, "s1", "prompt"))).toBe("instructions");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_STEP, "s1", "output_name"))).toBe("output");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_STEP, "s1", "expected_output"))).toBe("output");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_STEP, "s1", "model_id"))).toBe("model");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_STEP, "s1", "name"))).toBe("settings");
  });

  it("maps non-step entities to their panel section", () => {
    expect(issueTarget(issue(IssueEntityType.WORKFLOW, "wf", "name"))).toBe("details");
    expect(issueTarget(issue(IssueEntityType.STEP_INPUT, "si-1", "source"))).toBe("inputs");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_INPUT, "in-1", "value"))).toBe("values");
    expect(issueTarget(issue(IssueEntityType.WORKFLOW_SCHEDULE, "sc", "cron_expression"))).toBe("schedule");
  });
});

describe("issueStepId", () => {
  it("resolves the issue's step, the input owner, or the connection destination", () => {
    expect(issueStepId(issue(IssueEntityType.WORKFLOW_STEP, "s1", "prompt"), workflow)).toBe("s1");
    expect(issueStepId(issue(IssueEntityType.STEP_INPUT, "si-1", "source"), workflow)).toBe("s1");
    expect(issueStepId(issue(IssueEntityType.WORKFLOW_CONNECTION, "c1", "cycle"), workflow)).toBe("s2");
    expect(issueStepId(issue(IssueEntityType.WORKFLOW, "wf", "name"), workflow)).toBeUndefined();
  });
});

describe("issueField", () => {
  it("targets workflow input rows by entity id", () => {
    expect(issueField(issue(IssueEntityType.WORKFLOW_INPUT, "in-1", "value"))).toBe("value-in-1");
    expect(issueField(issue(IssueEntityType.WORKFLOW_STEP, "s1", "prompt"))).toBe("prompt");
  });
});

describe("groupIssues", () => {
  it("groups by entity with workflow-aware labels", () => {
    const groups = groupIssues(
      [
        issue(IssueEntityType.WORKFLOW, "wf", "name"),
        issue(IssueEntityType.WORKFLOW_STEP, "s1", "prompt"),
        issue(IssueEntityType.WORKFLOW_STEP, "s1", "model_id"),
        issue(IssueEntityType.WORKFLOW_INPUT, "in-1", "value"),
      ],
      workflow,
    );
    expect(groups.map((g) => g.label)).toEqual(["Workflow", "Research", "Value topic"]);
    expect(groups[1]!.issues).toHaveLength(2);
  });
});

describe("stepTabIssues", () => {
  const issues = [
    issue(IssueEntityType.WORKFLOW_STEP, "s1", "prompt"),
    issue(IssueEntityType.WORKFLOW_STEP, "s2", "output_name"),
    issue(IssueEntityType.STEP_INPUT, "si-1", "source"),
    issue(IssueEntityType.WORKFLOW, "wf", "name"),
  ];

  it("counts only this step's issues for the tab's fields", () => {
    const s1 = workflow.steps[0]!;
    expect(stepTabIssues(issues, s1, "instructions")).toHaveLength(1);
    expect(stepTabIssues(issues, s1, "output")).toHaveLength(0);
    expect(stepTabIssues(issues, s1, "inputs")).toHaveLength(1);
    expect(stepTabIssues(issues, workflow.steps[1]!, "output")).toHaveLength(1);
  });
});
