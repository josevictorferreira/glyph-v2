// Issue → editor deep-link mapping (spec 0018): which tab/section of the
// contextual panel an issue belongs to, and which entity labels group it.
// Pure functions, unit-tested; the readiness panel and tab issue-dots use
// the same mapping so both stay in sync with the backend's field names
// (backend/src/features/workflows/domain/validator.rs).
import { IssueEntityType, type Issue } from "@/gen/glyph/v1/common_pb";
import type { Step, Workflow } from "@/gen/glyph/v1/workflow_pb";
import type { EditorFocusTarget, StepEditorTab } from "./chrome";

/** Validator field names, by editor tab. */
const STEP_TAB_FIELDS: Partial<Record<StepEditorTab, readonly string[]>> = {
  instructions: ["prompt", "additional_context"],
  output: ["output_name", "output_description", "expected_output", "output_file_format"],
  model: ["model_id", "model_settings", "enabled_tool_ids"],
  settings: ["name", "description", "allow_failure"],
};

const STEP_FIELD_TABS = Object.entries(STEP_TAB_FIELDS).flatMap(([tab, fields]) =>
  (fields ?? []).map((field) => [field, tab] as const),
) as ReadonlyArray<readonly [string, StepEditorTab]>;

/** Issues pointing at one step tab (the red tab dots). */
export function stepTabIssues(issues: readonly Issue[], step: Step, tab: StepEditorTab): Issue[] {
  if (tab === "inputs") {
    return issues.filter(
      (i) =>
        i.entityType === IssueEntityType.STEP_INPUT &&
        step.inputs.some((inp) => inp.id === i.entityId),
    );
  }
  const fields = STEP_TAB_FIELDS[tab] ?? [];
  return issues.filter(
    (i) =>
      i.entityType === IssueEntityType.WORKFLOW_STEP &&
      i.entityId === step.id &&
      fields.includes(i.field),
  );
}

/** Which contextual-panel target an issue points at. */
export function issueTarget(issue: Issue): EditorFocusTarget {
  switch (issue.entityType) {
    case IssueEntityType.WORKFLOW:
      return "details";
    case IssueEntityType.WORKFLOW_STEP:
      return STEP_FIELD_TABS.find(([field]) => field === issue.field)?.[1] ?? "settings";
    case IssueEntityType.STEP_INPUT:
    case IssueEntityType.WORKFLOW_CONNECTION:
      return "inputs";
    case IssueEntityType.WORKFLOW_INPUT:
      return "values";
    case IssueEntityType.WORKFLOW_SCHEDULE:
      return "schedule";
    default:
      return "details";
  }
}

/** The step a deep link should select (issue's own step or the input's owner). */
export function issueStepId(issue: Issue, workflow: Workflow | undefined): string | undefined {
  if (!workflow) return undefined;
  switch (issue.entityType) {
    case IssueEntityType.WORKFLOW_STEP:
      return workflow.steps.some((s) => s.id === issue.entityId) ? issue.entityId : undefined;
    case IssueEntityType.STEP_INPUT:
      return workflow.steps.find((s) => s.inputs.some((i) => i.id === issue.entityId))?.id;
    case IssueEntityType.WORKFLOW_CONNECTION: {
      const conn = workflow.connections.find((c) => c.id === issue.entityId);
      return conn?.destinationStepId;
    }
    default:
      return undefined;
  }
}

/** The data-editor-field value a deep link should focus, if any. */
export function issueField(issue: Issue): string | undefined {
  switch (issue.entityType) {
    case IssueEntityType.WORKFLOW_INPUT:
      return `value-${issue.entityId}`;
    case IssueEntityType.STEP_INPUT:
      return `source-${issue.entityId}`;
    default:
      return issue.field;
  }
}

export interface IssueGroup {
  key: string;
  label: string;
  issues: Issue[];
}

/** Issues grouped by entity with workflow-aware labels. */
export function groupIssues(
  issues: readonly Issue[],
  workflow: Workflow | undefined,
): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  const stepName = (id: string) => workflow?.steps.find((s) => s.id === id)?.name ?? "step";
  for (const issue of issues) {
    const key = `${issue.entityType}/${issue.entityId}`;
    if (!groups.has(key)) {
      let label: string;
      switch (issue.entityType) {
        case IssueEntityType.WORKFLOW_STEP:
          label = stepName(issue.entityId);
          break;
        case IssueEntityType.STEP_INPUT: {
          const step = workflow?.steps.find((s) => s.inputs.some((i) => i.id === issue.entityId));
          const input = step?.inputs.find((i) => i.id === issue.entityId);
          label = input ? `${input.name} on ${step?.name ?? "step"}` : "Input";
          break;
        }
        case IssueEntityType.WORKFLOW_INPUT: {
          const input = workflow?.inputs.find((i) => i.id === issue.entityId);
          label = input ? `Value ${input.name}` : "Workflow value";
          break;
        }
        case IssueEntityType.WORKFLOW_CONNECTION: {
          const conn = workflow?.connections.find((c) => c.id === issue.entityId);
          label = conn
            ? `${stepName(conn.sourceStepId)} → ${stepName(conn.destinationStepId)}`
            : "Connection";
          break;
        }
        case IssueEntityType.WORKFLOW_SCHEDULE:
          label = "Schedule";
          break;
        default:
          label = "Workflow";
      }
      groups.set(key, { key, label, issues: [] });
    }
    groups.get(key)!.issues.push(issue);
  }
  return [...groups.values()];
}
