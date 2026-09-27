import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { WorkflowSchema, WorkflowInputSchema, StepSchema, StepInputSchema, ConnectionSchema } from "@/gen/glyph/v1/workflow_pb";
import { IssueSchema, StepKind, IssueEntityType } from "@/gen/glyph/v1/common_pb";
import { RunSnapshotSchema, SnapshotStepSchema, SnapshotConnectionSchema, StepRunSummarySchema } from "@/gen/glyph/v1/run_pb";
import { StepRunStatus } from "@/gen/glyph/v1/common_pb";
import { buildEdges, buildNodes, issuesForStep, lensEdges, lensNodes, modelShortName, firstLine } from "./mapping";

function workflowFixture() {
  const topic = create(WorkflowInputSchema, { id: "wi-1", name: "topic", position: 0 });
  const researchNotes = create(StepInputSchema, { id: "in-notes", name: "notes", required: true, position: 0 });
  const topicIn = create(StepInputSchema, {
    id: "in-topic",
    name: "subject",
    required: false,
    position: 1,
    workflowInputId: "wi-1",
  });
  const research = create(StepSchema, {
    id: "s-research",
    kind: StepKind.PI,
    name: "Research",
    description: "Find competitor moves",
    canvasX: 10,
    canvasY: 20,
    inputs: [topicIn],
    outputName: "findings",
  });
  const digest = create(StepSchema, {
    id: "s-digest",
    kind: StepKind.PI,
    name: "",
    prompt: "Write a digest\nfrom the notes.",
    modelId: "openai/gpt-5",
    canvasX: 400,
    canvasY: 20,
    inputs: [researchNotes],
  });
  const connection = create(ConnectionSchema, {
    id: "c-1",
    sourceStepId: "s-research",
    sourceOutputName: "findings",
    destinationStepId: "s-digest",
    destinationInputId: "in-notes",
  });
  const workflow = create(WorkflowSchema, {
    steps: [research, digest],
    connections: [connection],
    inputs: [topic],
  });
  return { workflow, research, digest, connection };
}

describe("buildNodes / buildEdges", () => {
  it("maps steps to nodes at their canvas positions with typed data", () => {
    const { workflow, research } = workflowFixture();
    const nodes = buildNodes(workflow, []);
    expect(nodes).toHaveLength(2);
    const r = nodes.find((n) => n.id === "s-research")!;
    expect(r.type).toBe("step");
    expect(r.position).toEqual({ x: 10, y: 20 });
    expect(r.data.name).toBe("Research");
    expect(r.data.purpose).toBe("Find competitor moves");
    expect(r.data.outputName).toBe("findings");
    expect(research.inputs).toHaveLength(1);
  });

  it("falls back to the first prompt line when there is no description", () => {
    const { workflow } = workflowFixture();
    const digest = buildNodes(workflow, []).find((n) => n.id === "s-digest")!;
    expect(digest.data.purpose).toBe("Write a digest");
    expect(digest.data.model).toBe("gpt-5");
  });

  it("orders input ports by position and shows workflow-value chips", () => {
    const { workflow } = workflowFixture();
    const r = buildNodes(workflow, []).find((n) => n.id === "s-research")!;
    expect(r.data.inputs).toEqual([
      {
        handleId: "in-topic",
        name: "subject",
        required: false,
        valueChip: "← topic",
        connected: false,
      },
    ]);
    const d = buildNodes(workflow, []).find((n) => n.id === "s-digest")!;
    expect(d.data.inputs[0]).toMatchObject({ handleId: "in-notes", connected: true, valueChip: null });
  });

  it("attributes step and input issues to the card", () => {
    const { workflow, digest } = workflowFixture();
    const issues = [
      create(IssueSchema, { entityType: IssueEntityType.WORKFLOW_STEP, entityId: "s-digest", message: "prompt is required" }),
      create(IssueSchema, { entityType: IssueEntityType.STEP_INPUT, entityId: "in-notes", message: "source is required" }),
      create(IssueSchema, { entityType: IssueEntityType.WORKFLOW, entityId: "wf", message: "unrelated" }),
    ];
    const d = buildNodes(workflow, issues).find((n) => n.id === "s-digest")!;
    expect(d.data.issueCount).toBe(2);
    expect(issuesForStep(issues, digest).map((i) => i.message)).toEqual([
      "prompt is required",
      "source is required",
    ]);
  });

  it("maps connections to edges with output/input handles", () => {
    const { workflow, connection } = workflowFixture();
    const [edge] = buildEdges(workflow.connections);
    expect(edge).toMatchObject({
      id: connection.id,
      source: "s-research",
      target: "s-digest",
      sourceHandle: "out",
      targetHandle: "in-notes",
    });
  });
});

describe("lensNodes / lensEdges", () => {
  function snapshotFixture() {
    const snapshot = create(RunSnapshotSchema, {
      steps: [
        create(SnapshotStepSchema, {
          id: "ss-1",
          kind: StepKind.PI,
          name: "Research",
          canvasX: 0,
          canvasY: 0,
          inputs: [],
        }),
        create(SnapshotStepSchema, {
          id: "ss-2",
          kind: StepKind.PI,
          name: "Digest",
          canvasX: 300,
          canvasY: 0,
          inputs: [],
        }),
      ],
      connections: [
        create(SnapshotConnectionSchema, {
          sourceStepId: "ss-1",
          destinationStepId: "ss-2",
          destinationInputId: "in-1",
        }),
      ],
    });
    const stepRuns = [
      create(StepRunSummarySchema, {
        id: "sr-1",
        snapshotStepId: "ss-1",
        status: StepRunStatus.SUCCEEDED,
        elapsedMs: 1200n,
      }),
      create(StepRunSummarySchema, {
        id: "sr-2",
        snapshotStepId: "ss-2",
        status: StepRunStatus.FAILED,
        humanError: "boom happened\nand more",
        elapsedMs: 5n,
      }),
    ];
    return { snapshot, stepRuns };
  }

  it("paints nodes from step run status and converts bigint elapsed", () => {
    const { snapshot, stepRuns } = snapshotFixture();
    const nodes = lensNodes(snapshot, stepRuns, "sr-2");
    const ok = nodes.find((n) => n.id === "ss-1")!;
    const failed = nodes.find((n) => n.id === "ss-2")!;
    expect(ok.data.status).toBe(StepRunStatus.SUCCEEDED);
    expect(ok.data.elapsedMs).toBe(1200);
    expect(failed.data.status).toBe(StepRunStatus.FAILED);
    expect(failed.data.error).toBe("boom happened");
    expect(failed.data.firstFailed).toBe(true);
    expect(ok.data.firstFailed).toBe(false);
  });

  it("defaults missing step runs to queued", () => {
    const { snapshot } = snapshotFixture();
    const nodes = lensNodes(snapshot, []);
    expect(nodes.every((n) => n.data.status === StepRunStatus.QUEUED)).toBe(true);
  });

  it("styles edges by source status", () => {
    const { snapshot, stepRuns } = snapshotFixture();
    const edge = lensEdges(snapshot, stepRuns)[0]!;
    expect(edge.className).toBe("glyph-edge-succeeded");
    const pending = lensEdges(snapshot, [stepRuns[1]!])[0]!;
    expect(pending.className).toBe("glyph-edge-pending");
  });
});

describe("helpers", () => {
  it("shortens provider-qualified model ids", () => {
    expect(modelShortName("openai/gpt-5")).toBe("gpt-5");
    expect(modelShortName("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(modelShortName(undefined)).toBeNull();
  });

  it("firstLine trims", () => {
    expect(firstLine("  a\n b")).toBe("a");
    expect(firstLine(null)).toBe("");
  });
});
