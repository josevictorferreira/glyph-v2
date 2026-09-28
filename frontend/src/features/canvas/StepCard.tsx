/**
 * Step card node (spec 0017 §Build rendering): compact card — kind icon,
 * name (or "Untitled step"), one-line purpose, model short name, tool icons,
 * readiness badge, allow-failure marker. Never the full prompt.
 *
 * Lens mode paints the same card by step-run status: running pulse with live
 * elapsed, failed error line, skipped/cancelled muted.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { StepKind, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import { formatDuration, useNow } from "@/shared/lib/time";
import type { StepNode } from "./lib/mapping";
import { cn } from "@/shared/lib/cn";

const LENS_CLASS: Record<StepRunStatus, string> = {
  [StepRunStatus.UNSPECIFIED]: "",
  [StepRunStatus.QUEUED]: "glyph-node-queued",
  [StepRunStatus.RUNNING]: "glyph-node-running",
  [StepRunStatus.SUCCEEDED]: "glyph-node-succeeded",
  [StepRunStatus.FAILED]: "glyph-node-failed",
  [StepRunStatus.SKIPPED]: "glyph-node-skipped",
  [StepRunStatus.CANCELLED]: "glyph-node-cancelled",
};

function toolGlyph(key: string): string {
  const known: Record<string, string> = {
    bash: "$_",
    read: "Rd",
    write: "Wr",
    grep: "Gr",
    web: "Wb",
  };
  return known[key] ?? key.slice(0, 2);
}

export const StepCard = memo(function StepCard({ data, selected }: NodeProps<StepNode>) {
  const running = data.status === StepRunStatus.RUNNING;
  const now = useNow(running ? 1000 : 0);
  const elapsed = running
    ? data.startedAtMs != null
      ? now.getTime() - data.startedAtMs
      : (data.elapsedMs ?? 0)
    : data.elapsedMs;
  const lens = data.status !== undefined;
  const untitled = data.name.trim().length === 0;
  const stepLabel = describeStepKindShort(data.kind);

  return (
    <div
      data-testid={`step-card-${data.stepId}`}
      data-step-id={data.stepId}
      data-status={data.status}
      className={cn(
        "glyph-node",
        "w-60 rounded-card border bg-surface text-left shadow-sm",
        lens && LENS_CLASS[data.status ?? StepRunStatus.UNSPECIFIED],
        data.firstFailed && "glyph-node-first-failed",
        selected && "glyph-node-selected",
      )}
    >
      {/* Input handles: one per step input, ordered by position (top→bottom). */}
      <div className="flex flex-col gap-1 pt-2">
        {data.inputs.map((input) => (
          <div
            key={input.handleId}
            className="relative flex items-center gap-1 pl-1 text-[11px] leading-4"
          >
            <Handle
              id={input.handleId}
              type="target"
              position={Position.Left}
              className={cn("glyph-handle", input.required && "glyph-handle-required")}
              isConnectable={!lens}
            />
            <span className={cn("truncate", input.connected ? "text-ink" : "text-ink-subtle")}>
              {input.name}
            </span>
            {input.required && !input.connected && <span className="text-status-failed">*</span>}
            {input.valueChip && (
              <span
                data-testid={`input-chip-${input.handleId}`}
                className="ml-auto mr-6 shrink-0 rounded bg-accent-soft px-1 text-[10px] text-accent"
                title="Fed by a workflow value"
              >
                {input.valueChip}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex h-4 items-center rounded px-1 text-[10px] font-semibold uppercase tracking-wide",
              data.kind === StepKind.PI
                ? "bg-accent-soft text-accent"
                : "bg-surface-3 text-ink-muted",
            )}
            aria-label={stepLabel}
          >
            {stepLabel}
          </span>
          <span
            className={cn("truncate text-xs font-medium", untitled && "text-ink-subtle italic")}
          >
            {untitled ? "Untitled step" : data.name}
          </span>
          {data.issueCount > 0 && (
            <span
              data-testid={`step-issues-${data.stepId}`}
              className="ml-auto inline-flex h-4 items-center gap-0.5 rounded bg-status-failed/10 px-1 text-[10px] font-semibold text-status-failed"
              title={data.issueTitle ?? `${data.issueCount} readiness issue(s)`}
            >
              {data.issueCount}
            </span>
          )}
        </div>

        {data.purpose && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-ink-muted">{data.purpose}</p>
        )}

        {running && (
          <p
            data-testid={`step-elapsed-${data.stepId}`}
            className="mt-1 text-[11px] tabular-nums text-status-running"
          >
            {formatDuration(elapsed)}
          </p>
        )}
        {data.status === StepRunStatus.FAILED && data.error && (
          <p
            data-testid={`step-error-${data.stepId}`}
            className="mt-1 line-clamp-2 text-[11px] text-status-failed"
          >
            {data.error}
          </p>
        )}
        {data.status === StepRunStatus.SKIPPED && (
          <p className="mt-1 text-[11px] text-ink-subtle">Did not run</p>
        )}

        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-subtle">
          {data.model && (
            <span className="rounded bg-surface-2 px-1 py-px font-mono" title="Model">
              {data.model}
            </span>
          )}
          {data.tools.length > 0 && (
            <span className="flex items-center gap-0.5" data-testid={`step-tools-${data.stepId}`}>
              {data.tools.map((tool) => (
                <span key={tool} className="rounded border border-border px-0.5" title={tool}>
                  {toolGlyph(tool)}
                </span>
              ))}
            </span>
          )}
          {data.allowFailure && (
            <span className="rounded border border-border px-1" title="Failure is allowed">
              can fail
            </span>
          )}
          {data.outputName && (
            <span className="ml-auto truncate font-mono">→ {data.outputName}</span>
          )}
        </div>
      </div>

      {/* Single output handle (right), labeled with the output name. */}
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="glyph-handle glyph-handle-source"
        isConnectable={!lens}
      />
    </div>
  );
});

function describeStepKindShort(kind: StepKind): string {
  return kind === StepKind.HELPER ? "helper" : "Pi";
}

export type { StepNode };
