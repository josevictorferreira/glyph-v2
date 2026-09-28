// Problems list (spec 0021): definition errors (with and without a line)
// merged with post-apply readiness issues, shown under the editor. Clicking a
// located problem jumps the editor to its line.
import type { ExternalError } from "./YamlEditor";

export interface ProblemRow {
  key: string;
  kind: "yaml" | "readiness";
  line?: number;
  message: string;
}

/** DefinitionError[] → rows; located first, stable otherwise. */
export function yamlProblems(errors: ExternalError[]): ProblemRow[] {
  return errors.map((error, i) => ({
    key: `yaml-${i}-${error.message}`,
    kind: "yaml" as const,
    line: typeof error.line === "number" && error.line > 0 ? error.line : undefined,
    message: error.message,
  }));
}

/** Post-apply readiness issues (no lines). */
export function readinessProblems(issues: { message: string }[]): ProblemRow[] {
  return issues.map((issue, i) => ({
    key: `readiness-${i}-${issue.message}`,
    kind: "readiness" as const,
    message: issue.message,
  }));
}

export function ProblemsList({
  rows,
  onJump,
}: {
  rows: ProblemRow[];
  onJump?: (line: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <ul
      data-testid="definition-problems"
      aria-label="Problems"
      className="space-y-0.5 overflow-y-auto p-1.5 text-xs"
    >
      {rows.map((row) =>
        row.line && onJump ? (
          <li key={row.key}>
            <button
              type="button"
              data-testid="definition-problem"
              className="flex w-full items-baseline gap-1.5 rounded px-1.5 py-1 text-left font-mono text-danger hover:bg-surface-2"
              onClick={() => onJump(row.line!)}
            >
              <span className="shrink-0 text-ink-subtle">Line {row.line}:</span>{" "}
              <span>{row.message}</span>
            </button>
          </li>
        ) : (
          <li
            key={row.key}
            data-testid="definition-problem"
            className="flex items-baseline gap-1.5 px-1.5 py-1 font-mono text-danger"
          >
            <span className={row.kind === "readiness" ? "text-warning" : "text-ink-subtle"}>
              {row.kind === "readiness" ? "Readiness:" : "Definition:"}
            </span>{" "}
            <span>{row.message}</span>
          </li>
        ),
      )}
    </ul>
  );
}
