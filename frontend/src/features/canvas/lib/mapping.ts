/**
 * Mapping `Workflow` (build mode) or `RunSnapshot` + step runs (lens mode) to
 * React Flow nodes/edges. Pure functions; the canvas components render them.
 */
import type { Edge, Node } from "@xyflow/react";
import type { Issue, StepKind } from "@/gen/glyph/v1/common_pb";
import type {
  Workflow,
  WorkflowInput,
  Connection,
  Step,
} from "@/gen/glyph/v1/workflow_pb";
import type { RunSnapshot, StepRunSummary } from "@/gen/glyph/v1/run_pb";
import { StepRunStatus } from "@/gen/glyph/v1/common_pb";
import { tsToMs } from "@/shared/lib/time";

export type InputPort = {
  /** Handle id: the StepInput id (build) or snapshot input id (lens). */
  handleId: string;
  name: string;
  required: boolean;
  /** Workflow-input chip label ("← topic") when fed by a workflow value. */
  valueChip: string | null;
  connected: boolean;
};

export type StepNodeData = {
  stepId: string;
  kind: StepKind;
  name: string;
  purpose: string;
  model: string | null;
  tools: string[];
  allowFailure: boolean;
  inputs: InputPort[];
  outputName: string;
  /** Build: readiness badge count (issues for this step or its inputs). */
  issueCount: number;
  /** Build: joined issue messages for the badge tooltip. */
  issueTitle?: string;
  /** Build: step.configured. */
  configured: boolean;
  /** Lens: painted by run status. */
  status?: StepRunSummary["status"];
  /** Lens: elapsed ms so far (running steps tick live in the card). */
  elapsedMs?: number | null;
  /** Lens: wall-clock start of the running step, for live ticking. */
  startedAtMs?: number | null;
  /** Lens: first line of the human error. */
  error?: string | null;
  /** Lens: true for the first failed step run. */
  firstFailed?: boolean;
};

export type StepNode = Node<StepNodeData, "step">;
export type StepEdge = Edge;

export const OUTPUT_HANDLE = "out";

const DEFAULT_OUTPUT = "output";

export function firstLine(text: string | null | undefined): string {
  return (text ?? "").split("\n", 1)[0]?.trim() ?? "";
}

/** "openai/gpt-5" → "gpt-5"; bare ids stay. */
export function modelShortName(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const parts = modelId.split("/");
  return parts[parts.length - 1] || modelId;
}

/** Structural input shape shared by StepInput and SnapshotStepInput. */
type PortInput = {
  id: string;
  name: string;
  required: boolean;
  position: number;
  workflowInputId?: string;
};

type ValueInput = Pick<WorkflowInput, "id" | "name">;

function inputPorts(
  inputs: readonly PortInput[],
  connectedInputIds: Set<string>,
  workflowInputs: readonly ValueInput[],
): InputPort[] {
  const byId = new Map(workflowInputs.map((i) => [i.id, i]));
  return [...inputs]
    .sort((a, b) => a.position - b.position)
    .map((input) => {
      const source = input.workflowInputId ? byId.get(input.workflowInputId) : undefined;
      return {
        handleId: input.id,
        name: input.name,
        required: input.required,
        valueChip: source ? `← ${source.name}` : null,
        connected: connectedInputIds.has(input.id),
      };
    });
}

function stepPurpose(step: { description?: string; prompt?: string }): string {
  return step.description?.trim() || firstLine(step.prompt);
}

/** Issues that belong to a step card: the step itself and its inputs. */
export function issuesForStep(issues: readonly Issue[], step: Step): Issue[] {
  const inputIds = new Set(step.inputs.map((i) => i.id));
  return issues.filter(
    (issue) =>
      (issue.entityType === 2 && issue.entityId === step.id) || // WORKFLOW_STEP
      (issue.entityType === 3 && inputIds.has(issue.entityId)), // STEP_INPUT
  );
}

export function buildNodes(workflow: Workflow, issues: readonly Issue[]): StepNode[] {
  const connectedInputIds = new Set<string>();
  for (const c of workflow.connections) connectedInputIds.add(c.destinationInputId);
  return workflow.steps.map((step) => {
    const stepIssues = issuesForStep(issues, step);
    return {
      id: step.id,
      type: "step" as const,
      position: { x: step.canvasX, y: step.canvasY },
      data: {
        stepId: step.id,
        kind: step.kind,
        name: step.name,
        purpose: stepPurpose(step),
        model: modelShortName(step.modelId),
        tools: [...step.enabledToolKeys],
        allowFailure: step.allowFailure,
        inputs: inputPorts(step.inputs, connectedInputIds, workflow.inputs),
        outputName: step.outputName || DEFAULT_OUTPUT,
        issueCount: stepIssues.length,
        issueTitle: stepIssues.map((i) => i.message).join("\n") || undefined,
        configured: step.configured,
      },
    };
  });
}

export function buildEdges(connections: readonly Connection[]): StepEdge[] {
  return connections.map((c) => ({
    id: c.id,
    source: c.sourceStepId,
    target: c.destinationStepId,
    sourceHandle: OUTPUT_HANDLE,
    targetHandle: c.destinationInputId,
  }));
}

export function lensNodes(
  snapshot: RunSnapshot,
  stepRuns: readonly StepRunSummary[],
  firstFailedStepRunId?: string,
): StepNode[] {
  const runsByStep = new Map(stepRuns.map((r) => [r.snapshotStepId, r]));
  const connectedInputIds = new Set(snapshot.connections.map((c) => c.destinationInputId));
  const workflowInputs = snapshot.inputs.map((i) => ({ id: i.id, name: i.name }));
  return snapshot.steps.map((step) => {
    const run = runsByStep.get(step.id);
    const error = run?.humanError ? firstLine(run.humanError) : null;
    return {
      id: step.id,
      type: "step" as const,
      position: { x: step.canvasX, y: step.canvasY },
      data: {
        stepId: step.id,
        kind: step.kind,
        name: step.name,
        purpose: stepPurpose(step),
        model: modelShortName(step.modelId),
        tools: step.enabledTools.map((t) => t.key ?? ""),
        allowFailure: step.allowFailure,
        inputs: inputPorts(step.inputs, connectedInputIds, workflowInputs),
        outputName: step.outputName || DEFAULT_OUTPUT,
        issueCount: 0,
        configured: true,
        status: run?.status ?? StepRunStatus.QUEUED,
        elapsedMs: run?.elapsedMs == null ? null : Number(run.elapsedMs),
        startedAtMs: tsToMs(run?.startedAt),
        error,
        firstFailed: run ? run.id === firstFailedStepRunId : false,
      },
    };
  });
}

/** Source status drives edge paint: succeeded solid, failed red, pending dashed. */
export function lensEdges(snapshot: RunSnapshot, stepRuns: readonly StepRunSummary[]): StepEdge[] {
  const statusByStep = new Map(stepRuns.map((r) => [r.snapshotStepId, r.status]));
  return snapshot.connections.map((c) => {
    const status = statusByStep.get(c.sourceStepId) ?? StepRunStatus.QUEUED;
    const className =
      status === StepRunStatus.SUCCEEDED
        ? "glyph-edge-succeeded"
        : status === StepRunStatus.FAILED
          ? "glyph-edge-failed"
          : status === StepRunStatus.CANCELLED
            ? "glyph-edge-cancelled"
            : "glyph-edge-pending";
    return {
      id: `${c.sourceStepId}:${c.destinationStepId}:${c.destinationInputId}`,
      source: c.sourceStepId,
      target: c.destinationStepId,
      sourceHandle: OUTPUT_HANDLE,
      targetHandle: c.destinationInputId,
      className,
    };
  });
}
