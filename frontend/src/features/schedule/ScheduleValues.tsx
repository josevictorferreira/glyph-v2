// Scheduled values (spec 0019): stored values scheduled runs use for asked
// or required-but-empty workflow inputs — one autosaved SetScheduleValue
// field per row, flagged with the validator message while missing.
import { useCallback } from "react";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow, WorkflowInput } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import { Badge, Input, SaveIndicator } from "@/shared/ui";

export function ScheduledValues({ workflow }: { workflow: Workflow }) {
  const schedule = workflow.schedule;
  const inputs = workflow.inputs.filter((input) => input.askAtRunTime || (input.required && !input.value));
  if (!schedule || inputs.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2" data-testid="schedule-values">
      <p className="text-xs text-ink-subtle">Scheduled runs use these stored values.</p>
      {inputs.map((input) => (
        <ScheduleValueRow
          key={input.id}
          workflowId={workflow.summary?.id ?? ""}
          input={input}
          stored={schedule.values.find((v) => v.workflowInputId === input.id)?.value ?? ""}
        />
      ))}
    </div>
  );
}

function ScheduleValueRow({
  workflowId,
  input,
  stored,
}: {
  workflowId: string;
  input: WorkflowInput;
  stored: string;
}) {
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.setScheduleValue, {
    onAppError: appErrorToast,
  });
  const save = useCallback(
    (value: string) =>
      mutateAsync({ workflowId, workflowInputId: input.id, value }).then(() => undefined),
    [mutateAsync, workflowId, input.id],
  );
  const field = useAutosaveField({ value: stored, save });
  const missing = input.required && !input.value && !field.value.trim();

  return (
    <div className="flex flex-col gap-1" data-editor-field={`schedule-value-${input.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {input.name}
          {input.required && <Badge tone="neutral">Required</Badge>}
        </span>
        <SaveIndicator status={field.status} onRetry={field.retry} />
      </div>
      <Input
        aria-label={`Value for scheduled runs: ${input.name}`}
        placeholder="Value for scheduled runs"
        value={field.value}
        onChange={(e) => field.setValue(e.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      {missing && (
        <p className="text-xs text-status-failed" role="alert">
          The schedule needs a value for the required workflow input “{input.name}”.
        </p>
      )}
    </div>
  );
}
