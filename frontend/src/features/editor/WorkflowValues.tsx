// Workflow values (spec 0018): every WorkflowInput as an inline-editable row
// (name, kind, required, value/default, description, usage) autosaved via
// UpdateWorkflowInput; add via AddWorkflowInput; remove confirms and lists
// the affected steps. The name rule mirrors the backend for instant
// feedback; the backend message wins on save.
import { useCallback, useState } from "react";
import { IssueEntityType } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow, WorkflowInput } from "@/gen/glyph/v1/workflow_pb";
import { useIssues, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast, toAppError } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  IconButton,
  Input,
  SaveIndicator,
  Select,
  Textarea,
  Trash,
} from "@/shared/ui";
import { variableTokens } from "./lib/variables";

/** backend INPUT_NAME_PATTERN (shared-text keys use the same rule). */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*$/;
export const NAME_RULE =
  "Name must start with a letter and use letters, numbers, spaces or underscores";

const KIND_ITEMS = [
  { value: "asked", label: "Asked at run time" },
  { value: "constant", label: "Constant" },
];

/** Steps that map an input to this value or reference it in their prompt. */
export function stepsUsingValue(workflow: Workflow, input: WorkflowInput): string[] {
  return workflow.steps
    .filter(
      (s) =>
        s.inputs.some((i) => i.workflowInputId === input.id) ||
        [s.prompt, s.additionalContext].some((t) => t && variableTokens(t).includes(input.name)),
    )
    .map((s) => s.name);
}

interface ValueFields {
  name: string;
  description: string;
  required: boolean;
  value: string;
  askAtRunTime: boolean;
}

const sameFields = (a: ValueFields, b: ValueFields) =>
  a.name === b.name &&
  a.description === b.description &&
  a.required === b.required &&
  a.value === b.value &&
  a.askAtRunTime === b.askAtRunTime;

export function WorkflowValues({ workflow }: { workflow: Workflow }) {
  return (
    <div className="flex flex-col gap-2 py-2">
      {workflow.inputs.length === 0 && (
        <p className="text-xs text-ink-subtle">No workflow values yet.</p>
      )}
      {workflow.inputs.map((input) => (
        <ValueRow key={input.id} workflow={workflow} input={input} />
      ))}
      <AddValueForm workflowId={workflow.summary?.id ?? ""} />
    </div>
  );
}

function ValueRow({ workflow, input }: { workflow: Workflow; input: WorkflowInput }) {
  const workflowId = workflow.summary?.id ?? "";
  const issues = useIssues(workflowId).forEntity(IssueEntityType.WORKFLOW_INPUT, input.id);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateWorkflowInput);
  const remove = useWorkflowMutation(WorkflowService.method.removeWorkflowInput, {
    onSucceeded: () => setRemoveOpen(false),
  });
  const save = useCallback(
    (next: ValueFields) =>
      NAME_PATTERN.test(next.name.trim())
        ? mutateAsync({
            workflowId,
            inputId: input.id,
            name: next.name,
            description: next.description || undefined,
            required: next.required,
            value: next.value || undefined,
            askAtRunTime: next.askAtRunTime,
          }).then(() => undefined)
        : Promise.reject(new Error(NAME_RULE)),
    [mutateAsync, workflowId, input.id],
  );
  const field = useAutosaveField<ValueFields>({
    value: {
      name: input.name,
      description: input.description ?? "",
      required: input.required,
      value: input.value ?? "",
      askAtRunTime: input.askAtRunTime,
    },
    save,
    equals: sameFields,
  });
  const set = (patch: Partial<ValueFields>) => field.setValue({ ...field.value, ...patch });
  const nameError =
    field.value.name.trim() && !NAME_PATTERN.test(field.value.name.trim()) ? NAME_RULE : undefined;
  const saveError =
    field.status === "error" && !nameError ? appErrorToast(toAppError(field.error)) : undefined;
  const usedBy = stepsUsingValue(workflow, input);
  const requiredId = `value-required-${input.id}`;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-testid={`workflow-value-${input.name}`}
    >
      <div className="flex items-start gap-2">
        <Input
          aria-label="Value name"
          data-editor-field={`value-${input.id}`}
          value={field.value.name}
          error={nameError}
          onChange={(e) => set({ name: e.target.value })}
          onFocus={field.onFocus}
          onBlur={field.onBlur}
          className="font-mono"
        />
        <IconButton
          label={`Remove value ${input.name}`}
          size="sm"
          onClick={() => setRemoveOpen(true)}
        >
          <Trash className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex items-center gap-3">
        <Select
          ariaLabel={`Kind of ${input.name}`}
          items={KIND_ITEMS}
          value={field.value.askAtRunTime ? "asked" : "constant"}
          onValueChange={(kind) => set({ askAtRunTime: kind === "asked" })}
          className="w-44"
        />
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <Checkbox
            id={requiredId}
            checked={field.value.required}
            onCheckedChange={(required) => set({ required })}
          />
          <label htmlFor={requiredId}>Required</label>
        </span>
        <Badge tone="muted" className="ml-auto">
          {usedBy.length === 0
            ? "Unused"
            : `Used by ${usedBy.length} ${usedBy.length === 1 ? "step" : "steps"}`}
        </Badge>
      </div>
      <Textarea
        label={field.value.askAtRunTime ? "Default" : "Value"}
        mono
        rows={1}
        value={field.value.value}
        onChange={(e) => set({ value: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      <Input
        label="Description"
        value={field.value.description}
        onChange={(e) => set({ description: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      <div className="flex items-center justify-end gap-2">
        {saveError && (
          <p className="text-xs text-status-failed" role="alert">
            {saveError}
          </p>
        )}
        <SaveIndicator status={field.status} onRetry={field.retry} />
      </div>
      {issues.map((issue) => (
        <p key={issue.message} className="text-xs text-status-failed" role="alert">
          {issue.message}
        </p>
      ))}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent
          title={`Remove workflow value “${input.name}”?`}
          description={
            usedBy.length > 0
              ? `Used by ${usedBy.join(", ")}. Their inputs lose this source.`
              : "No step uses it."
          }
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate({ workflowId, inputId: input.id })}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddValueForm({ workflowId }: { workflowId: string }) {
  const [name, setName] = useState("");
  const [askAtRunTime, setAskAtRunTime] = useState(true);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useWorkflowMutation(WorkflowService.method.addWorkflowInput, {
    onSucceeded: () => {
      setName("");
      setValue("");
      setError(null);
    },
    onAppError: (e) => setError(appErrorToast(e)),
  });
  const nameError = name.trim() && !NAME_PATTERN.test(name.trim()) ? NAME_RULE : undefined;

  return (
    <form
      className="flex flex-col gap-2 border-t border-border pt-3"
      aria-label="Add workflow value"
      onSubmit={(e) => {
        e.preventDefault();
        if (nameError) return;
        add.mutate({
          workflowId,
          name,
          askAtRunTime,
          // A constant is required to have its value; asked values default to required.
          required: true,
          value: value || undefined,
        });
      }}
    >
      <div className="flex items-start gap-2">
        <Input
          aria-label="New value name"
          placeholder="Value name"
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          ariaLabel="New value kind"
          items={KIND_ITEMS}
          value={askAtRunTime ? "asked" : "constant"}
          onValueChange={(kind) => setAskAtRunTime(kind === "asked")}
          className="w-44 shrink-0"
        />
      </div>
      {!askAtRunTime && (
        <Input
          aria-label="New value"
          placeholder="Value"
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={add.isPending}>
          Add value
        </Button>
      </div>
    </form>
  );
}
