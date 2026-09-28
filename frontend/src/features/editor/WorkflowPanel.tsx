// Workflow panel (spec 0018): the contextual panel shown while nothing is
// selected. Details autosave through UpdateWorkflow; the values table
// (WorkflowValues) and schedule section (spec 0019) render below.
import { useCallback, useState } from "react";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { ScheduleCard, ScheduleComposer, ScheduledValues } from "@/features/schedule";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import { Badge, Disclosure, Field, SaveIndicator, Switch, Textarea } from "@/shared/ui";
import type { EditorFocus } from "./chrome";
import { useEditorChrome, useEditorFocusField } from "./chrome";
import { WorkflowValues } from "./WorkflowValues";

interface WorkflowDetailsValue {
  description: string;
  failFast: boolean;
}

export function WorkflowPanel({
  workflow,
  focus,
}: {
  workflow: Workflow;
  focus: EditorFocus | null;
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="workflow-panel">
      <DetailsSection workflow={workflow} focus={focus} />
      <ValuesSection workflow={workflow} focus={focus} />
      <ScheduleSection workflow={workflow} focus={focus} />
    </div>
  );
}

function DetailsSection({ workflow, focus }: { workflow: Workflow; focus: EditorFocus | null }) {
  useEditorFocusField(focus, "details");
  const workflowId = workflow.summary?.id ?? "";
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateWorkflow, {
    onAppError: appErrorToast,
  });
  const save = useCallback(
    (next: WorkflowDetailsValue) =>
      mutateAsync({
        id: workflowId,
        name: workflow.summary?.name ?? "",
        description: next.description || undefined,
        failFast: next.failFast,
      }).then(() => undefined),
    [mutateAsync, workflowId, workflow.summary?.name],
  );
  const field = useAutosaveField<WorkflowDetailsValue>({
    value: {
      description: workflow.summary?.description ?? "",
      failFast: workflow.summary?.failFast ?? false,
    },
    save,
    equals: (a, b) => a.description === b.description && a.failFast === b.failFast,
  });

  return (
    <Disclosure title="Details" defaultOpen>
      <div className="flex flex-col gap-3 py-2">
        <Field label="Description" hint="What this workflow is for.">
          <Textarea
            aria-label="Workflow description"
            data-editor-field="description"
            value={field.value.description}
            onChange={(e) => field.setValue({ ...field.value, description: e.target.value })}
            onFocus={field.onFocus}
            onBlur={field.onBlur}
            rows={3}
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <Field label="Fail fast" hint="Stop the whole run when a step fails.">
            <Switch
              aria-label="Fail fast"
              checked={field.value.failFast}
              onCheckedChange={(failFast) => field.setValue({ ...field.value, failFast })}
            />
          </Field>
          <SaveIndicator status={field.status} onRetry={field.retry} />
        </div>
      </div>
    </Disclosure>
  );
}

function ValuesSection({ workflow, focus }: { workflow: Workflow; focus: EditorFocus | null }) {
  useEditorFocusField(focus, "values");
  return (
    <Disclosure
      title="Workflow values"
      defaultOpen={workflow.steps.length === 0}
      right={<Badge tone="muted">{workflow.inputs.length}</Badge>}
    >
      <WorkflowValues workflow={workflow} />
    </Disclosure>
  );
}

function ScheduleSection({ workflow, focus }: { workflow: Workflow; focus: EditorFocus | null }) {
  useEditorFocusField(focus, "schedule");
  const { setReadinessOpen } = useEditorChrome();
  const [composerOpen, setComposerOpen] = useState(false);
  return (
    <Disclosure title="Schedule">
      <div className="flex flex-col gap-3 py-2" data-editor-field="schedule">
        <ScheduleCard
          workflow={workflow}
          onOpenComposer={() => setComposerOpen(true)}
          onOpenReadiness={() => setReadinessOpen(true)}
        />
        <ScheduledValues workflow={workflow} />
      </div>
      <ScheduleComposer workflow={workflow} open={composerOpen} onOpenChange={setComposerOpen} />
    </Disclosure>
  );
}
