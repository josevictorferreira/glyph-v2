// Inputs tab (spec 0018): one row per step input with a source picker that
// maps to CreateConnection / MapStepInput / RemoveConnection, inline
// confirmation before replacing an existing source, "+ New workflow value…",
// and add/remove input rows.
import { useState } from "react";
import { IssueEntityType, StepKind } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Step, StepInput, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { wouldCreateCycle } from "@/features/canvas";
import { useIssues, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast, type AppError } from "@/shared/api/errors";
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  Dialog,
  DialogContent,
  DialogFooter,
  IconButton,
  Input,
  Trash,
  type ComboboxItem,
} from "@/shared/ui";
import type { StepTabProps } from "./StepTabs";
import { useEditorFocusField } from "./chrome";

const NONE = "none";
const NEW_VALUE = "new-value";

/** The picker value describing an input's current source. */
export function currentSource(workflow: Workflow, input: StepInput): string {
  const connection = workflow.connections.find((c) => c.destinationInputId === input.id);
  if (connection) return `step:${connection.sourceStepId}`;
  if (input.workflowInputId) return `value:${input.workflowInputId}`;
  return NONE;
}

/** Source picker options: not connected, upstream step outputs, workflow values. */
export function sourceItems(workflow: Workflow, step: Step): ComboboxItem[] {
  const edges = workflow.connections.map((c) => ({
    source: c.sourceStepId,
    target: c.destinationStepId,
  }));
  return [
    { value: NONE, label: "Not connected", group: "Source" },
    ...workflow.steps
      .filter((s) => s.id !== step.id)
      .map((s) => {
        const cycle = wouldCreateCycle(edges, s.id, step.id);
        const unnamed = !s.outputName;
        return {
          value: `step:${s.id}`,
          label: `Output of ${s.name}`,
          group: "Steps",
          disabled: cycle || unnamed,
          hint: cycle ? "Would create a cycle" : unnamed ? "No named output yet" : s.outputName,
        };
      }),
    ...workflow.inputs.map((i) => ({
      value: `value:${i.id}`,
      label: `Workflow value ${i.name}`,
      group: "Workflow values",
    })),
    { value: NEW_VALUE, label: "+ New workflow value…", group: "Workflow values" },
  ];
}

export function InputsTab({ workflowId, workflow, step, focus }: StepTabProps) {
  useEditorFocusField(focus, "inputs");
  const isHelper = step.kind === StepKind.HELPER;
  return (
    <>
      {isHelper && (
        <p className="text-xs text-ink-subtle">
          Collects its inputs into one structured output; no model is called.
        </p>
      )}
      {step.inputs.length === 0 && <p className="text-xs text-ink-subtle">No inputs yet.</p>}
      {step.inputs.map((input) => (
        <InputRow
          key={input.id}
          workflowId={workflowId}
          workflow={workflow}
          step={step}
          input={input}
        />
      ))}
      <AddInputRow workflowId={workflowId} step={step} />
    </>
  );
}

type Pending = { kind: "replace"; choice: string; label: string } | { kind: "new-value" };

function InputRow({
  workflowId,
  workflow,
  step,
  input,
}: {
  workflowId: string;
  workflow: Workflow;
  step: Step;
  input: StepInput;
}) {
  const issues = useIssues(workflowId).forEntity(IssueEntityType.STEP_INPUT, input.id);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const onAppError = (e: AppError) => setError(appErrorToast(e));
  const onSucceeded = () => {
    setError(null);
    setPending(null);
  };

  const createConnection = useWorkflowMutation(WorkflowService.method.createConnection, {
    onSucceeded,
    onAppError,
  });
  const mapInput = useWorkflowMutation(WorkflowService.method.mapStepInput, {
    onSucceeded,
    onAppError,
  });
  const removeConnection = useWorkflowMutation(WorkflowService.method.removeConnection, {
    onAppError,
  });
  const removeInput = useWorkflowMutation(WorkflowService.method.removeStepInput, {
    onSucceeded: () => setRemoveOpen(false),
    onAppError,
  });
  const busy = createConnection.isPending || mapInput.isPending || removeConnection.isPending;

  const items = sourceItems(workflow, step);
  const current = currentSource(workflow, input);
  const connection = workflow.connections.find((c) => c.destinationInputId === input.id);
  const fed = current !== NONE;

  const apply = async (choice: string) => {
    setError(null);
    if (choice.startsWith("step:")) {
      createConnection.mutate({
        workflowId,
        sourceStepId: choice.slice(5),
        destinationInputId: input.id,
        replaceExisting: fed,
      });
      return;
    }
    // Workflow value or clear: drop the incoming connection first (MapStepInput leaves it).
    if (connection) {
      try {
        await removeConnection.mutateAsync({ workflowId, connectionId: connection.id });
      } catch {
        return; // onAppError already showed why
      }
    }
    if (choice === NONE) {
      if (input.workflowInputId) mapInput.mutate({ workflowId, inputId: input.id });
      else onSucceeded();
      return;
    }
    mapInput.mutate({ workflowId, inputId: input.id, workflowInputId: choice.slice(6) });
  };

  const choose = (choice: string) => {
    if (choice === current) return;
    if (choice === NEW_VALUE) {
      setPending({ kind: "new-value" });
      return;
    }
    if (fed && choice !== NONE) {
      setPending({
        kind: "replace",
        choice,
        label: items.find((i) => i.value === choice)?.label ?? "",
      });
      return;
    }
    void apply(choice);
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border p-2"
      data-testid={`step-input-${input.name}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-mono text-sm text-ink">{input.name}</span>
        {input.required ? (
          <Badge tone="neutral">Required</Badge>
        ) : (
          <Badge tone="muted">Optional</Badge>
        )}
        <IconButton
          label={`Remove input ${input.name}`}
          size="sm"
          onClick={() =>
            fed ? setRemoveOpen(true) : removeInput.mutate({ workflowId, inputId: input.id })
          }
        >
          <Trash className="size-3.5" />
        </IconButton>
      </div>
      <Combobox
        ariaLabel={`Source for ${input.name}`}
        triggerProps={{ "data-editor-field": `source-${input.id}` }}
        items={items}
        value={current}
        onValueChange={choose}
        disabled={busy}
        searchPlaceholder="Search sources…"
      />
      {pending?.kind === "replace" && (
        <div
          className="flex items-center gap-2 rounded bg-surface-2 p-2 text-xs"
          role="group"
          aria-label="Confirm replace"
        >
          <span className="flex-1 text-ink">Replace the current source with {pending.label}?</span>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => void apply(pending.choice)}
          >
            Replace
          </Button>
        </div>
      )}
      {pending?.kind === "new-value" && (
        <NewValueForm
          workflowId={workflowId}
          input={input}
          onCancel={() => setPending(null)}
          onCreated={(id) => void apply(`value:${id}`)}
        />
      )}
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
      {issues.map((issue) => (
        <p key={issue.message} className="text-xs text-status-failed" role="alert">
          {issue.message}
        </p>
      ))}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent
          title={`Remove input “${input.name}”?`}
          description="This also removes its connection."
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={removeInput.isPending}
              onClick={() => removeInput.mutate({ workflowId, inputId: input.id })}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "+ New workflow value…": an asked-at-run-time value named after the input. */
function NewValueForm({
  workflowId,
  input,
  onCancel,
  onCreated,
}: {
  workflowId: string;
  input: StepInput;
  onCancel: () => void;
  onCreated: (workflowInputId: string) => void;
}) {
  const [name, setName] = useState(input.name);
  const [error, setError] = useState<string | null>(null);
  const add = useWorkflowMutation(WorkflowService.method.addWorkflowInput, {
    onSucceeded: (res) => onCreated(res.newInputId),
    onAppError: (e) => setError(appErrorToast(e)),
  });
  const submit = () =>
    add.mutate({ workflowId, name: name.trim(), required: input.required, askAtRunTime: true });

  return (
    <form
      className="flex flex-col gap-1.5 rounded bg-surface-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2">
        <Input
          label="New workflow value"
          hint="Asked at run time. Change it under Workflow values."
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1"
        />
      </div>
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={add.isPending}>
          Create and use
        </Button>
      </div>
    </form>
  );
}

function AddInputRow({ workflowId, step }: { workflowId: string; step: Step }) {
  const [name, setName] = useState("");
  const [required, setRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const add = useWorkflowMutation(WorkflowService.method.addStepInput, {
    onSucceeded: () => {
      setName("");
      setError(null);
    },
    onAppError: (e) => setError(appErrorToast(e)),
  });
  const id = `new-input-required-${step.id}`;

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ workflowId, stepId: step.id, name, required });
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="New input name"
          placeholder="Input name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-muted">
          <Checkbox id={id} checked={required} onCheckedChange={setRequired} />
          <label htmlFor={id}>Required</label>
        </span>
        <Button type="submit" size="sm" loading={add.isPending}>
          Add input
        </Button>
      </div>
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
