// Step editor tabs (spec 0018): Instructions, Model & tools, Output and
// Settings. Each tab autosaves one grouped RPC payload and shows the
// validator messages for its fields inline (backend copy verbatim).
import { useCallback } from "react";
import { IssueEntityType, OutputFileFormat, StepKind } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Step, Workflow } from "@/gen/glyph/v1/workflow_pb";
import {
  findModel,
  modelCapabilities,
  ModelPicker,
  ToolChecklist,
  useModels,
} from "@/features/catalog";
import { useIssues, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast, toAppError } from "@/shared/api/errors";
import { useAutosaveField, type AutosaveField } from "@/shared/lib/autosave";
import { cn } from "@/shared/lib/cn";
import { Disclosure, Field, Input, SaveIndicator, Switch, Textarea, toast } from "@/shared/ui";
import type { EditorFocus } from "./chrome";
import { useEditorFocusField } from "./chrome";
import { availableVariables } from "./lib/variables";
import { PromptEditor } from "./PromptEditor";
import { useStepDetailsField } from "./step-details";

export interface StepTabProps {
  workflowId: string;
  workflow: Workflow;
  step: Step;
  focus: EditorFocus | null;
}

/** Validator messages for one field of this step. */
function useStepFieldIssues(workflowId: string, stepId: string) {
  const index = useIssues(workflowId);
  return (field: string) =>
    index.at(IssueEntityType.WORKFLOW_STEP, stepId, field).map((i) => i.message);
}

/** Save state + the server's reason when a save failed. */
function SaveState<T>({ field }: { field: AutosaveField<T> }) {
  return (
    <div className="flex items-center justify-end gap-2">
      {field.status === "error" && (
        <p className="text-xs text-status-failed" role="alert">
          {appErrorToast(toAppError(field.error))}
        </p>
      )}
      <SaveIndicator status={field.status} onRetry={field.retry} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

interface PromptValue {
  prompt: string;
  additionalContext: string;
}

export function InstructionsTab({ workflowId, workflow, step, focus }: StepTabProps) {
  useEditorFocusField(focus, "instructions");
  const issuesAt = useStepFieldIssues(workflowId, step.id);
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateStepPrompt);
  const save = useCallback(
    (next: PromptValue) =>
      mutateAsync({
        workflowId,
        stepId: step.id,
        prompt: next.prompt || undefined,
        additionalContext: next.additionalContext || undefined,
      }).then(() => undefined),
    [mutateAsync, workflowId, step.id],
  );
  const field = useAutosaveField<PromptValue>({
    value: { prompt: step.prompt ?? "", additionalContext: step.additionalContext ?? "" },
    save,
    equals: (a, b) => a.prompt === b.prompt && a.additionalContext === b.additionalContext,
  });
  const variables = availableVariables(step, workflow);

  return (
    <>
      <PromptEditor
        label="Prompt"
        field="prompt"
        value={field.value.prompt}
        onChange={(prompt) => field.setValue({ ...field.value, prompt })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        variables={variables}
        errors={issuesAt("prompt")}
        placeholder="What should the agent do? Type {{ to insert a variable."
        rows={8}
      />
      <Disclosure title="Additional context" defaultOpen={!!step.additionalContext}>
        <div className="py-2">
          <PromptEditor
            label="Additional context"
            field="additional_context"
            value={field.value.additionalContext}
            onChange={(additionalContext) => field.setValue({ ...field.value, additionalContext })}
            onFocus={field.onFocus}
            onBlur={field.onBlur}
            variables={variables}
            errors={issuesAt("additional_context")}
            placeholder="Background the agent should know."
            rows={4}
            chips={false}
          />
        </div>
      </Disclosure>
      <SaveState field={field} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Model & tools
// ---------------------------------------------------------------------------

interface ModelValue {
  modelId: string;
  temperature: number | undefined;
}

export function ModelTab({ workflowId, step, focus }: StepTabProps) {
  useEditorFocusField(focus, "model");
  const issuesAt = useStepFieldIssues(workflowId, step.id);
  const { data } = useModels(true);
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateStepModel);
  const toggleTool = useWorkflowMutation(WorkflowService.method.toggleStepTool, {
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });
  const save = useCallback(
    (next: ModelValue) =>
      mutateAsync({
        workflowId,
        stepId: step.id,
        modelId: next.modelId,
        temperature: next.temperature,
      }).then(() => undefined),
    [mutateAsync, workflowId, step.id],
  );
  const field = useAutosaveField<ModelValue>({
    value: { modelId: step.modelId ?? "", temperature: step.temperature },
    save,
    equals: (a, b) => a.modelId === b.modelId && a.temperature === b.temperature,
  });
  const supportsTemperature = (modelId: string) =>
    modelCapabilities(findModel(data?.models ?? [], modelId)).includes("temperature");

  return (
    <>
      <Field label="Model">
        <ModelPicker
          field="model_id"
          value={field.value.modelId}
          onChange={(modelId) =>
            field.setValue({
              modelId,
              // A model without the capability cannot keep the setting.
              temperature: supportsTemperature(modelId) ? field.value.temperature : undefined,
            })
          }
        />
      </Field>
      <FieldIssues messages={issuesAt("model_id")} />

      {supportsTemperature(field.value.modelId) && (
        <Field
          label="Temperature"
          hint="0 is focused, 2 is creative. Leave empty for the model default."
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              aria-label="Temperature slider"
              min={0}
              max={2}
              step={0.1}
              value={field.value.temperature ?? 1}
              onChange={(e) =>
                field.setValue({ ...field.value, temperature: Number(e.target.value) })
              }
              onBlur={field.onBlur}
              className="flex-1 accent-[var(--color-accent)]"
            />
            <Input
              aria-label="Temperature"
              data-editor-field="model_settings"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={field.value.temperature ?? ""}
              onChange={(e) =>
                field.setValue({
                  ...field.value,
                  temperature: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              onFocus={field.onFocus}
              onBlur={field.onBlur}
              className="w-20"
            />
          </div>
        </Field>
      )}
      <FieldIssues messages={issuesAt("model_settings")} />
      <SaveState field={field} />

      <Field label="Tools" hint="Tools run inside an isolated working directory for each step run.">
        <div data-editor-field="enabled_tool_ids" tabIndex={-1}>
          <ToolChecklist
            enabledKeys={step.enabledToolKeys}
            disabled={toggleTool.isPending}
            onToggle={(toolKey) => toggleTool.mutate({ workflowId, stepId: step.id, toolKey })}
          />
        </div>
      </Field>
      <FieldIssues messages={issuesAt("enabled_tool_ids")} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface OutputValue {
  outputName: string;
  outputDescription: string;
  expectedOutput: string;
  format: OutputFileFormat;
}

const FORMATS: ReadonlyArray<{ value: OutputFileFormat; label: string; hint: string }> = [
  {
    value: OutputFileFormat.FREE_TEXT_MARKDOWN,
    label: "Markdown",
    hint: "Free text, rendered as Markdown.",
  },
  {
    value: OutputFileFormat.HTML,
    label: "HTML",
    hint: "A single HTML page, previewed in a sandbox.",
  },
  { value: OutputFileFormat.JSON, label: "JSON", hint: "Structured data, validated as JSON." },
  { value: OutputFileFormat.ZIP, label: "ZIP", hint: "A bundle of files, offered as a download." },
];

export function OutputTab({ workflowId, workflow, step, focus }: StepTabProps) {
  useEditorFocusField(focus, "output");
  const issuesAt = useStepFieldIssues(workflowId, step.id);
  const isPi = step.kind === StepKind.PI;
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateStepOutput);
  const save = useCallback(
    (next: OutputValue) =>
      mutateAsync({
        workflowId,
        stepId: step.id,
        outputName: next.outputName,
        outputDescription: next.outputDescription || undefined,
        expectedOutput: next.expectedOutput || undefined,
        outputFileFormat: next.format,
      }).then(() => undefined),
    [mutateAsync, workflowId, step.id],
  );
  const field = useAutosaveField<OutputValue>({
    value: {
      outputName: step.outputName ?? "",
      outputDescription: step.outputDescription ?? "",
      expectedOutput: step.expectedOutput ?? "",
      format: step.outputFileFormat || OutputFileFormat.FREE_TEXT_MARKDOWN,
    },
    save,
    equals: (a, b) =>
      a.outputName === b.outputName &&
      a.outputDescription === b.outputDescription &&
      a.expectedOutput === b.expectedOutput &&
      a.format === b.format,
  });
  const set = (patch: Partial<OutputValue>) => field.setValue({ ...field.value, ...patch });

  const downstream = workflow.connections.filter((c) => c.sourceStepId === step.id).length;
  const renaming = downstream > 0 && field.value.outputName.trim() !== (step.outputName ?? "");
  const nameIssues = issuesAt("output_name");

  return (
    <>
      <Input
        label="Output name"
        data-editor-field="output_name"
        placeholder={step.name}
        hint={
          renaming
            ? `Updates ${downstream} ${downstream === 1 ? "connection" : "connections"}.`
            : "Downstream steps receive the output under this name."
        }
        error={nameIssues.length > 0 ? nameIssues.join(" ") : undefined}
        value={field.value.outputName}
        onChange={(e) => set({ outputName: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />

      {isPi && (
        <Field label="Format">
          <div
            role="radiogroup"
            aria-label="Output format"
            className="flex flex-col gap-1.5"
            data-editor-field="output_file_format"
            tabIndex={-1}
          >
            <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="radio"
                  aria-checked={field.value.format === f.value}
                  onClick={() => set({ format: f.value })}
                  className={cn(
                    "flex-1 rounded px-2 py-1 text-xs font-medium text-ink-muted",
                    field.value.format === f.value && "bg-surface text-ink shadow-sm",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-subtle">
              {FORMATS.find((f) => f.value === field.value.format)?.hint}
            </p>
          </div>
        </Field>
      )}

      {isPi && (
        <Textarea
          label="Expected output"
          data-editor-field="expected_output"
          hint="Required. Tells the agent what a finished result looks like."
          error={issuesAt("expected_output").join(" ") || undefined}
          value={field.value.expectedOutput}
          onChange={(e) => set({ expectedOutput: e.target.value })}
          onFocus={field.onFocus}
          onBlur={field.onBlur}
          rows={3}
        />
      )}

      <Textarea
        label="Output description"
        data-editor-field="output_description"
        hint="Shown to downstream steps and in run evidence."
        value={field.value.outputDescription}
        onChange={(e) => set({ outputDescription: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        rows={2}
      />
      <SaveState field={field} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsTab({ workflowId, step, focus }: StepTabProps) {
  useEditorFocusField(focus, "settings");
  const issuesAt = useStepFieldIssues(workflowId, step.id);
  const field = useStepDetailsField(workflowId, step);

  return (
    <>
      <FieldIssues messages={issuesAt("name")} />
      <Textarea
        label="Description"
        data-editor-field="description"
        hint="Notes for whoever maintains this step."
        value={field.value.description}
        onChange={(e) => field.setValue({ ...field.value, description: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        rows={3}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`allow-failure-${step.id}`}
            className="text-[0.8125rem] font-medium text-ink-muted"
          >
            Allow failure
          </label>
          <p className="text-xs text-ink-subtle">
            Downstream steps run without this input if it fails.
          </p>
        </div>
        <Switch
          id={`allow-failure-${step.id}`}
          aria-label="Allow failure"
          checked={field.value.allowFailure}
          onCheckedChange={(allowFailure) => field.setValue({ ...field.value, allowFailure })}
        />
      </div>
      <SaveState field={field} />
    </>
  );
}

function FieldIssues({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="-mt-2 flex flex-col gap-0.5">
      {messages.map((m) => (
        <p key={m} className="text-xs text-status-failed" role="alert">
          {m}
        </p>
      ))}
    </div>
  );
}
