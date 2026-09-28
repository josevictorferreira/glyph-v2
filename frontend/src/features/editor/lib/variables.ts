// Prompt variables (spec 0018): `{{name}}` tokens, parsed with the backend
// validator's regex (backend/src/features/workflows/domain/validator.rs) so
// highlighting, autocomplete and unknown-token hints agree with readiness.
import type { Step, Workflow } from "@/gen/glyph/v1/workflow_pb";

export const VARIABLE_PATTERN = /\{\{([A-Za-z0-9_ -]+)\}\}/g;

export interface TokenMatch {
  /** Trimmed variable name. */
  name: string;
  start: number;
  end: number;
}

/** Every `{{name}}` occurrence, in order (duplicates kept for highlighting). */
export function tokenMatches(text: string): TokenMatch[] {
  return [...text.matchAll(VARIABLE_PATTERN)].map((m) => ({
    name: m[1]!.trim(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Distinct variable names used in a text, in first-use order (backend `variable_tokens`). */
export function variableTokens(text: string): string[] {
  return [...new Set(tokenMatches(text).map((m) => m.name))];
}

export interface Variable {
  name: string;
  source: "input" | "value";
}

/** Variables a step's prompt may reference: its inputs, then workflow values. */
export function availableVariables(step: Step, workflow: Workflow): Variable[] {
  const seen = new Set<string>();
  const out: Variable[] = [];
  for (const v of [
    ...step.inputs.map((i) => ({ name: i.name, source: "input" as const })),
    ...workflow.inputs.map((i) => ({ name: i.name, source: "value" as const })),
  ]) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    out.push(v);
  }
  return out;
}

/**
 * An open `{{` before the caret with no closing braces yet: the partial name
 * typed so far and where the token starts. Null when not inside a token.
 */
export function openTokenAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start < 0) return null;
  const query = before.slice(start + 2);
  if (!/^[A-Za-z0-9_ -]*$/.test(query)) return null;
  return { query, start };
}

/** Replace the open token (from `start` to caret) with `{{name}}`. */
export function completeToken(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  // Swallow closing braces the user already typed right after the caret.
  const rest = text.slice(caret).replace(/^\}{1,2}/, "");
  const inserted = `{{${name}}}`;
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}
