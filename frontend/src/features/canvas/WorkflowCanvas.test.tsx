import { beforeAll, describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import {
  WorkflowSchema,
  WorkflowSummarySchema,
  WorkflowInputSchema,
  StepSchema,
  StepInputSchema,
  ConnectionSchema,
} from "@/gen/glyph/v1/workflow_pb";
import { IssueSchema, IssueEntityType, StepKind, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import type {
  Workflow,
  AddStepRequest,
  MoveStepRequest,
  DuplicateStepRequest,
  DeleteStepRequest,
  CreateConnectionRequest,
} from "@/gen/glyph/v1/workflow_pb";
import {
  RunSnapshotSchema,
  SnapshotStepSchema,
  SnapshotStepInputSchema,
  SnapshotConnectionSchema,
  StepRunSummarySchema,
} from "@/gen/glyph/v1/run_pb";
import type { RunSnapshot, StepRunSummary } from "@/gen/glyph/v1/run_pb";
import { tidyUp } from "./lib/layout";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { useWorkflow } from "@/features/workflows";
import { renderWithApp } from "@test/render";
import type { FakeServices } from "@test/fakeTransport";

vi.mock("./lib/layout", () => ({ tidyUp: vi.fn() }));

// jsdom reports 0×0 for every element; React Flow only renders edges once
// nodes are measured. Give cards a plausible size for this file only.
beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    get: () => 240,
    configurable: true,
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    get: () => 88,
    configurable: true,
  });
});

/* ── fixture ─────────────────────────────────────────────────────────────── */

let clock = 1;
const bump = { seconds: BigInt(clock++), nanos: 0 };
const ts = (s: number) => create(TimestampSchema, { seconds: BigInt(s), nanos: 0 });

function makeWorkflow(): Workflow {
  return create(WorkflowSchema, {
    summary: create(WorkflowSummarySchema, { id: "wf-1", name: "Tournament", updatedAt: bump }),
    inputs: [create(WorkflowInputSchema, { id: "wi-1", name: "topic", position: 0 })],
    steps: [
      create(StepSchema, {
        id: "s-research",
        kind: StepKind.PI,
        name: "Research",
        description: "Find competitor moves",
        modelId: "openai/gpt-5",
        enabledToolKeys: ["read", "bash"],
        canvasX: 40,
        canvasY: 60,
        inputs: [
          create(StepInputSchema, {
            id: "in-topic",
            name: "subject",
            required: false,
            position: 0,
            workflowInputId: "wi-1",
          }),
        ],
        outputName: "findings",
      }),
      create(StepSchema, {
        id: "s-digest",
        kind: StepKind.PI,
        name: "",
        prompt: "Write a digest\nSecond line",
        allowFailure: true,
        canvasX: 400,
        canvasY: 60,
        inputs: [
          create(StepInputSchema, { id: "in-notes", name: "notes", required: true, position: 0 }),
          create(StepInputSchema, { id: "in-style", name: "style", required: true, position: 1 }),
        ],
      }),
    ],
    connections: [
      create(ConnectionSchema, {
        id: "c-1",
        sourceStepId: "s-research",
        destinationStepId: "s-digest",
        destinationInputId: "in-notes",
      }),
    ],
  });
}

const issueForPrompt = (stepId: string): Issue =>
  create(IssueSchema, {
    entityType: IssueEntityType.WORKFLOW_STEP,
    entityId: stepId,
    field: "prompt",
    message: "prompt is required",
  });

/** Harness mirroring the route: workflow from the query cache. */
function Harness(props: {
  onSelectStep?: (id: string | null) => void;
  onOpenStep?: (id: string) => void;
  selectedStepId?: string | null;
}) {
  const { data } = useWorkflow("wf-1");
  if (!data?.workflow) return <div data-testid="loading" />;
  return (
    <div className="h-[600px] w-[800px]">
      <WorkflowCanvas
        mode="build"
        workflow={data.workflow}
        issues={data.issues}
        selectedStepId={props.selectedStepId}
        onSelectStep={props.onSelectStep}
        onOpenStep={props.onOpenStep}
      />
    </div>
  );
}

interface Recorded {
  addStep: AddStepRequest[];
  moveStep: MoveStepRequest[];
  duplicateStep: DuplicateStepRequest[];
  deleteStep: DeleteStepRequest[];
  createConnection: CreateConnectionRequest[];
}

function clone(wf: Workflow): Workflow {
  return create(WorkflowSchema, {
    summary: wf.summary,
    inputs: wf.inputs.map((i) => create(WorkflowInputSchema, { ...i })),
    steps: wf.steps.map((s) =>
      create(StepSchema, { ...s, inputs: s.inputs.map((i) => create(StepInputSchema, { ...i })) }),
    ),
    connections: wf.connections.map((c) => create(ConnectionSchema, { ...c })),
  });
}

/** Fake services that mutate an in-memory workflow like the server would. */
function makeServices(
  wf: Workflow,
  issues: Issue[] = [],
): { services: FakeServices; recorded: Recorded } {
  const recorded: Recorded = {
    addStep: [],
    moveStep: [],
    duplicateStep: [],
    deleteStep: [],
    createConnection: [],
  };
  const touch = () => {
    wf.summary!.updatedAt = ts(clock++);
  };
  const respond = () => ({ workflow: clone(wf), issues: [...issues] });
  return {
    recorded,
    services: {
      workflow: {
        getWorkflow: () => respond(),
        addStep: (req: AddStepRequest) => {
          recorded.addStep.push(req);
          wf.steps.push(
            create(StepSchema, {
              id: `new-${req.kind}`,
              kind: req.kind,
              canvasX: req.canvasX ?? 0,
              canvasY: req.canvasY ?? 0,
              inputs: [],
            }),
          );
          touch();
          return { ...respond(), newStepId: `new-${req.kind}` };
        },
        moveStep: (req: MoveStepRequest) => {
          recorded.moveStep.push(req);
          const step = wf.steps.find((s) => s.id === req.stepId);
          if (step) {
            step.canvasX = req.canvasX ?? 0;
            step.canvasY = req.canvasY ?? 0;
          }
          touch();
          return respond();
        },
        duplicateStep: (req: DuplicateStepRequest) => {
          recorded.duplicateStep.push(req);
          return { ...respond(), newStepId: "dup-1" };
        },
        deleteStep: (req: DeleteStepRequest) => {
          recorded.deleteStep.push(req);
          wf.steps = wf.steps.filter((s) => s.id !== req.stepId);
          wf.connections = wf.connections.filter(
            (c) => c.sourceStepId !== req.stepId && c.destinationStepId !== req.stepId,
          );
          touch();
          return respond();
        },
        createConnection: (req: CreateConnectionRequest) => {
          recorded.createConnection.push(req);
          return { ...respond(), connectionId: "c-new" };
        },
      },
    },
  };
}

function setupBuild(issues: Issue[] = []) {
  const wf = makeWorkflow();
  const { services, recorded } = makeServices(wf, issues);
  const result = renderWithApp(<Harness />, { services });
  return { ...result, wf, recorded };
}

function nodeOf(testId: string): HTMLElement {
  return screen.getByTestId(testId).closest(".react-flow__node") as HTMLElement;
}

async function nodeOfAsync(testId: string): Promise<HTMLElement> {
  return (await screen.findByTestId(testId)).closest(".react-flow__node") as HTMLElement;
}

/* ── build mode ──────────────────────────────────────────────────────────── */

describe("WorkflowCanvas (build)", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(tidyUp).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders step cards with model, tools, allow-failure and issue badge", async () => {
    setupBuild([issueForPrompt("s-digest")]);
    const research = await screen.findByTestId("step-card-s-research");
    expect(within(research).getByText("Research")).toBeInTheDocument();
    expect(within(research).getByText("Find competitor moves")).toBeInTheDocument();
    expect(within(research).getByText("gpt-5")).toBeInTheDocument();
    expect(within(research).getByTestId("step-tools-s-research")).toHaveTextContent("Rd");

    const digest = screen.getByTestId("step-card-s-digest");
    expect(within(digest).getByText("Untitled step")).toBeInTheDocument();
    expect(within(digest).getByText("Write a digest")).toBeInTheDocument();
    expect(within(digest).getByText("can fail")).toBeInTheDocument();
    const badge = within(digest).getByTestId("step-issues-s-digest");
    expect(badge).toHaveTextContent("1");
    expect(badge).toHaveAttribute("title", "prompt is required");
  });

  it("renders the workflow-value chip and the required marker", async () => {
    setupBuild();
    expect(await screen.findByTestId("input-chip-in-topic")).toHaveTextContent("← topic");
    // Connected required input: no marker. Unconnected required input: `*`.
    expect(screen.getByText("notes").parentElement).not.toHaveTextContent("*");
    expect(screen.getByText("style").parentElement).toHaveTextContent("*");
  });

  it("selects a card on click", async () => {
    const onSelectStep = vi.fn();
    const wf = makeWorkflow();
    const { services } = makeServices(wf);
    renderWithApp(<Harness onSelectStep={onSelectStep} />, { services });
    const node = await nodeOfAsync("step-card-s-research");
    fireEvent.click(node);
    await waitFor(() => expect(onSelectStep).toHaveBeenCalledWith("s-research"));
  });

  it("applies external selection and moves with arrow keys (debounced MoveStep)", async () => {
    const wf = makeWorkflow();
    const { services, recorded } = makeServices(wf);
    renderWithApp(<Harness selectedStepId="s-research" />, { services });
    await screen.findByTestId("step-card-s-research");
    expect(nodeOf("step-card-s-research").classList).toContain("selected");
    const canvas = screen.getByTestId("canvas");
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitFor(
      () =>
        expect(recorded.moveStep).toEqual(
          expect.arrayContaining([expect.objectContaining({ stepId: "s-research", canvasX: 60 })]),
        ),
      { timeout: 2000 },
    );
  });

  it("adds a step from the empty state", async () => {
    const wf = create(WorkflowSchema, {
      summary: create(WorkflowSummarySchema, { id: "wf-1", name: "Empty", updatedAt: bump }),
    });
    const { services, recorded } = makeServices(wf);
    renderWithApp(<Harness />, { services });
    await userEvent.click(await screen.findByTestId("canvas-empty-add"));
    await waitFor(() =>
      expect(recorded.addStep).toEqual([
        expect.objectContaining({
          workflowId: "wf-1",
          kind: StepKind.PI,
          canvasX: expect.any(Number),
        }),
      ]),
    );
  });

  it("adds a helper step with Shift+A", async () => {
    const { recorded } = setupBuild();
    await screen.findByTestId("step-card-s-research");
    const canvas = screen.getByTestId("canvas");
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
    await waitFor(() =>
      expect(recorded.addStep).toEqual([expect.objectContaining({ kind: StepKind.HELPER })]),
    );
  });

  it("opens the context menu on a node and duplicates", async () => {
    const { recorded } = setupBuild();
    (await nodeOfAsync("step-card-s-research")).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    const menu = await screen.findByTestId("canvas-context-menu");
    await userEvent.click(within(menu).getByText("Duplicate step"));
    await waitFor(() =>
      expect(recorded.duplicateStep).toEqual([
        expect.objectContaining({ workflowId: "wf-1", stepId: "s-research" }),
      ]),
    );
  });

  it("delete from the context menu confirms with the connection count", async () => {
    const confirm = vi.mocked(window.confirm);
    const { recorded } = setupBuild();
    (await nodeOfAsync("step-card-s-research")).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    const menu = await screen.findByTestId("canvas-context-menu");
    await userEvent.click(within(menu).getByText("Delete step"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("removes 1 connection"));
    await waitFor(() =>
      expect(recorded.deleteStep).toEqual([expect.objectContaining({ stepId: "s-research" })]),
    );
  });

  it("tidies up via elk layout and undoes via the toast", async () => {
    vi.mocked(tidyUp).mockResolvedValue([
      { stepId: "s-research", x: 0, y: 0 },
      { stepId: "s-digest", x: 300, y: 0 },
    ]);
    const { recorded } = setupBuild();
    await screen.findByTestId("canvas-toolbar");
    await userEvent.click(screen.getByTestId("canvas-tidy"));
    await waitFor(() => expect(recorded.moveStep.length).toBe(2));
    expect(recorded.moveStep).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "s-research", canvasX: 0, canvasY: 0 }),
        expect.objectContaining({ stepId: "s-digest", canvasX: 300 }),
      ]),
    );
    const undo = await screen.findByRole("button", { name: "Undo" });
    await userEvent.click(undo);
    await waitFor(() => expect(recorded.moveStep.length).toBe(4));
    expect(recorded.moveStep[2]).toMatchObject({ stepId: "s-research", canvasX: 40, canvasY: 60 });
  });
});

/* ── lens mode ───────────────────────────────────────────────────────────── */

function snapshotFixture(): { snapshot: RunSnapshot; stepRuns: StepRunSummary[] } {
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
        canvasX: 400,
        canvasY: 0,
        inputs: [
          create(SnapshotStepInputSchema, { id: "i1", name: "notes", required: true, position: 0 }),
        ],
      }),
      create(SnapshotStepSchema, {
        id: "ss-3",
        kind: StepKind.PI,
        name: "Skipped",
        canvasX: 800,
        canvasY: 0,
        inputs: [
          create(SnapshotStepInputSchema, { id: "i2", name: "draft", required: true, position: 0 }),
        ],
      }),
    ],
    connections: [
      create(SnapshotConnectionSchema, {
        sourceStepId: "ss-1",
        destinationStepId: "ss-2",
        destinationInputId: "i1",
      }),
      create(SnapshotConnectionSchema, {
        sourceStepId: "ss-2",
        destinationStepId: "ss-3",
        destinationInputId: "i2",
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
      humanError: "boom happened\nmore",
    }),
    create(StepRunSummarySchema, {
      id: "sr-3",
      snapshotStepId: "ss-3",
      status: StepRunStatus.SKIPPED,
    }),
  ];
  return { snapshot, stepRuns };
}

describe("WorkflowCanvas (lens)", () => {
  it("paints cards by status: error line, skipped copy, first-failed ring", async () => {
    const { snapshot, stepRuns } = snapshotFixture();
    renderWithApp(
      <div className="h-[600px] w-[800px]">
        <WorkflowCanvas
          mode="lens"
          snapshot={snapshot}
          stepRuns={stepRuns}
          firstFailedStepRunId="sr-2"
        />
      </div>,
    );
    expect(await screen.findByTestId("step-card-ss-1")).toBeInTheDocument();
    expect(screen.getByTestId("step-error-ss-2")).toHaveTextContent("boom happened");
    expect(screen.getByTestId("step-card-ss-3")).toHaveTextContent("Did not run");
    expect(screen.getByTestId("step-card-ss-2").className).toContain("glyph-node-first-failed");
    expect(screen.getByTestId("step-card-ss-1").className).toContain("glyph-node-succeeded");
  });

  it("styles edges by source status", async () => {
    const { snapshot, stepRuns } = snapshotFixture();
    const { container } = renderWithApp(
      <div className="h-[600px] w-[800px]">
        <WorkflowCanvas mode="lens" snapshot={snapshot} stepRuns={stepRuns} />
      </div>,
    );
    await screen.findByTestId("step-card-ss-1");
    expect(container.querySelector(".glyph-edge-succeeded")).not.toBeNull();
    expect(container.querySelector(".glyph-edge-failed")).not.toBeNull();
  });
});
