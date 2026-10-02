// Workflow panel (spec 0018): the contextual panel shown while nothing is
// selected. Details autosave through UpdateWorkflow; the values table
// (WorkflowValues), the shared texts section (spec 0023) and the schedule
// section (spec 0019) render below. Hovering a shared text highlights the
// steps that use it on the canvas.
import { useCallback, useState } from "react";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { SharedText, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { ScheduleCard, ScheduleComposer, ScheduledValues } from "@/features/schedule";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast, toAppError } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import {
  Badge,
  Button,
  Disclosure,
  Field,
  IconButton,
  Input,
  SaveIndicator,
  Switch,
  Textarea,
  Trash,
  toast,
} from "@/shared/ui";
import type { EditorFocus } from "./chrome";
import { useEditorChrome, useEditorFocusField } from "./chrome";
import { usedByCount } from "./lib/shared-texts";
import { PromptEditor } from "./PromptEditor";
import { NAME_PATTERN, NAME_RULE } from "./WorkflowValues";
import { WorkflowValues } from "./WorkflowValues";

interface WorkflowDetailsValue {
  description: string;
  failFast: boolean;
}

export function WorkflowPanel({
  workflow,
  focus,
  onHighlightText,
}: {
  workflow: Workflow;
  focus: EditorFocus | null;
  /** Hovered shared text (spec 0023): its steps glow on the canvas. */
  onHighlightText: (textId: string | null) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="workflow-panel">
      <DetailsSection workflow={workflow} focus={focus} />
      <ValuesSection workflow={workflow} focus={focus} />
      <SharedTextsSection workflow={workflow} onHighlightText={onHighlightText} />
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

// ---------------------------------------------------------------------------
// Shared texts (spec 0023)
// ---------------------------------------------------------------------------

interface SharedTextFields {
  key: string;
  description: string;
  body: string;
}

const sameTextFields = (a: SharedTextFields, b: SharedTextFields) =>
  a.key === b.key && a.description === b.description && a.body === b.body;

function SharedTextsSection({
  workflow,
  onHighlightText,
}: {
  workflow: Workflow;
  onHighlightText: (textId: string | null) => void;
}) {
  return (
    <Disclosure title="Shared texts" right={<Badge tone="muted">{workflow.texts.length}</Badge>}>
      <div className="flex flex-col gap-2 py-2">
        {workflow.texts.length === 0 && (
          <p className="text-xs text-ink-subtle">
            No shared texts yet. Steps can share a prompt once one exists.
          </p>
        )}
        {workflow.texts.map((text) => (
          <SharedTextRow
            key={text.id}
            workflow={workflow}
            text={text}
            onHighlightText={onHighlightText}
          />
        ))}
        <AddTextForm workflowId={workflow.summary?.id ?? ""} />
      </div>
    </Disclosure>
  );
}

function SharedTextRow({
  workflow,
  text,
  onHighlightText,
}: {
  workflow: Workflow;
  text: SharedText;
  onHighlightText: (textId: string | null) => void;
}) {
  const workflowId = workflow.summary?.id ?? "";
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateSharedText);
  const remove = useWorkflowMutation(WorkflowService.method.removeSharedText, {
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });
  const save = useCallback(
    (next: SharedTextFields) =>
      NAME_PATTERN.test(next.key.trim())
        ? mutateAsync({
            workflowId,
            textId: text.id,
            key: next.key,
            description: next.description || undefined,
            body: next.body,
          }).then(() => undefined)
        : Promise.reject(new Error(NAME_RULE)),
    [mutateAsync, workflowId, text.id],
  );
  const field = useAutosaveField<SharedTextFields>({
    value: { key: text.key, description: text.description ?? "", body: text.body },
    save,
    equals: sameTextFields,
  });
  const set = (patch: Partial<SharedTextFields>) => field.setValue({ ...field.value, ...patch });
  const keyError =
    field.value.key.trim() && !NAME_PATTERN.test(field.value.key.trim()) ? NAME_RULE : undefined;
  const saveError =
    field.status === "error" && !keyError ? appErrorToast(toAppError(field.error)) : undefined;
  const usedBy = usedByCount(workflow, text.id);
  const removeTitle =
    usedBy > 0
      ? `“${text.key}” is used by ${usedBy} ${usedBy === 1 ? "step" : "steps"}. Detach them first.`
      : `Remove shared text “${text.key}”`;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-testid={`shared-text-${text.id}`}
      onMouseEnter={() => onHighlightText(text.id)}
      onMouseLeave={() => onHighlightText(null)}
    >
      <div className="flex items-start gap-2">
        <Input
          aria-label="Text key"
          data-testid={`shared-text-key-${text.id}`}
          mono
          value={field.value.key}
          error={keyError}
          onChange={(e) => set({ key: e.target.value })}
          onFocus={field.onFocus}
          onBlur={field.onBlur}
        />
        <IconButton
          label={`Remove text ${text.key}`}
          title={removeTitle}
          size="sm"
          disabled={usedBy > 0}
          data-testid={`remove-text-${text.id}`}
          onClick={() => remove.mutate({ workflowId, textId: text.id })}
        >
          <Trash className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone="muted">
          {usedBy === 0 ? "Unused" : `Used by ${usedBy} ${usedBy === 1 ? "step" : "steps"}`}
        </Badge>
        <SaveIndicator status={field.status} onRetry={field.retry} className="ml-auto" />
      </div>
      <PromptEditor
        label="Body"
        field={`shared-text-${text.id}`}
        value={field.value.body}
        onChange={(body) => set({ body })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        variables={workflow.inputs.map((input) => ({ name: input.name, source: "value" as const }))}
        placeholder="The text every linked step shares. Type {{ to insert a variable."
        rows={4}
      />
      <Input
        label="Description"
        value={field.value.description}
        onChange={(e) => set({ description: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      {saveError && (
        <p className="text-xs text-status-failed" role="alert">
          {saveError}
        </p>
      )}
    </div>
  );
}

function AddTextForm({ workflowId }: { workflowId: string }) {
  const [key, setKey] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useWorkflowMutation(WorkflowService.method.addSharedText, {
    onSucceeded: () => {
      setKey("");
      setBody("");
      setError(null);
    },
    onAppError: (e) => setError(appErrorToast(e)),
  });
  const keyError = key.trim() && !NAME_PATTERN.test(key.trim()) ? NAME_RULE : undefined;

  return (
    <form
      className="flex flex-col gap-2 border-t border-border pt-3"
      aria-label="Add shared text"
      onSubmit={(e) => {
        e.preventDefault();
        if (keyError) return;
        add.mutate({ workflowId, key, body });
      }}
    >
      <div className="flex items-start gap-2">
        <Input
          aria-label="New text key"
          placeholder="Text key"
          mono
          value={key}
          error={keyError}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <Textarea
        aria-label="New text body"
        placeholder="Body"
        mono
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={add.isPending}>
          Add text
        </Button>
      </div>
    </form>
  );
}
