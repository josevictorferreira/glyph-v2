// Shared texts (spec 0023): pure helpers mirroring the backend domain
// (backend/src/features/workflows/domain/shared_text.rs) — the token scan,
// preview rendering, usage counts and the "Make shared" key suggestion.
import type { Step, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { VARIABLE_PATTERN, variableTokens } from "./variables";

/** Variable tokens a shared-text body uses, first-use order. */
export function textTokens(body: string): string[] {
  return variableTokens(body);
}

/**
 * Replace only the named tokens; every other `{{token}}` stays verbatim for
 * run time (backend `render`). Values may themselves contain `{{tokens}}` —
 * those are left for run-time interpolation.
 */
export function renderPreview(
  body: string,
  vars: Map<string, string> | Record<string, string>,
): string {
  const table = vars instanceof Map ? vars : new Map(Object.entries(vars));
  return body.replace(VARIABLE_PATTERN, (token, name: string) => table.get(name.trim()) ?? token);
}

/** Whether any of the step's text fields references the shared text. */
export function stepUsesText(step: Step, textId: string): boolean {
  return (
    step.promptRef?.textId === textId ||
    step.contextRef?.textId === textId ||
    step.expectRef?.textId === textId
  );
}

/** Steps whose prompt, context or expect references the text. */
export function stepsUsingText(workflow: Workflow, textId: string): Step[] {
  return workflow.steps.filter((s) => stepUsesText(s, textId));
}

/** How many steps use the text (the panel's "Used by N steps"). */
export function usedByCount(workflow: Workflow, textId: string): number {
  return stepsUsingText(workflow, textId).length;
}

/** The string form of a TextField (also the vars-form key suffix). */
export type TextFieldKey = "prompt" | "context" | "expect";

/** "Generate — GLM 5.3" + prompt → "generate_glm_5_3_prompt". */
export function suggestTextKey(stepName: string, field: TextFieldKey): string {
  const base = stepName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base ? `${base}_${field}` : field;
}
