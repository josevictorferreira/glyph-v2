// Shared text field (spec 0023): the "Use shared text" picker for one step
// field (prompt / context / expect). While linked, the field shows the
// server-rendered preview with a Detach button and a one-row-per-token vars
// form; while not linked, the plain editor renders plus a "Make shared"
// action that extracts the text. Helper steps never render this.
import { useCallback, useState, type ReactNode } from "react";
import { TextField, WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { SharedText, Step, TextRef, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import { cn } from "@/shared/lib/cn";
import { Badge, Button, Input, SaveIndicator, Select, toast } from "@/shared/ui";
import { availableVariables, tokenMatches, type Variable } from "./lib/variables";
import { renderPreview, suggestTextKey, textTokens } from "./lib/shared-texts";

export interface SharedTextFieldProps {
  workflowId: string;
  workflow: Workflow;
  step: Step;
  /** Which field this control links (PROMPT, CONTEXT or EXPECT). */
  field: TextField;
  /** Field label used in copy ("Prompt", "Additional context", …). */
  label: string;
  /** data-editor-field of the plain editor; deep links focus the preview. */
  editorField: string;
  /** The server-rendered effective text while linked (step.prompt etc.). */
  rendered: string;
  /** The step's own draft text while not linked (drives "Make shared"). */
  own: string;
  /** The plain editor, rendered while not linked. */
  children: ReactNode;
  /** Validator messages for the field (rendered under the preview). */
  errors?: string[];
}

export function SharedTextField(props: SharedTextFieldProps) {
  const { workflowId, workflow, step, field, label, editorField, rendered, own, children } = props;
  const ref = refOf(step, field);
  const text = ref ? workflow.texts.find((t) => t.id === ref.textId) : undefined;
  const known = new Set(availableVariables(step, workflow).map((v) => v.name));
  const setRef = useWorkflowMutation(WorkflowService.method.setStepTextRef, {
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });

  return (
    <div className="flex flex-col gap-1.5">
      {ref ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.8125rem] font-medium text-ink-muted">{label}</span>
            <Badge tone="accent" title={`From shared text “${text?.key ?? ref.textId}”`}>
              {`⧉ ${text?.key ?? ref.textId}`}
            </Badge>
          </div>
          <TextPreview text={rendered} known={known} field={editorField} />
          {(props.errors ?? []).map((message) => (
            <p key={message} className="text-xs text-status-failed" role="alert">
              {message}
            </p>
          ))}
        </div>
      ) : (
        children
      )}

      <div className="flex items-center gap-2">
        <Select
          className="flex-1"
          ariaLabel={`Use shared text for ${label}`}
          items={workflow.texts.map((t) => ({ value: t.id, label: t.key }))}
          value={ref?.textId}
          placeholder="Own text"
          disabled={workflow.texts.length === 0}
          onValueChange={(textId) =>
            setRef.mutate({ workflowId, stepId: step.id, field, ref: { textId, vars: {} } })
          }
        />
        {ref && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="detach-text"
            loading={setRef.isPending}
            onClick={() => setRef.mutate({ workflowId, stepId: step.id, field })}
          >
            Detach
          </Button>
        )}
      </div>

      {ref && text && (
        <VarsForm
          workflowId={workflowId}
          workflow={workflow}
          step={step}
          field={field}
          text={text}
          vars={ref.vars}
        />
      )}

      {!ref && own.trim().length > 0 && (
        <MakeSharedForm
          workflowId={workflowId}
          stepId={step.id}
          field={field}
          suggested={suggestTextKey(step.name, fieldKeyOf(field))}
        />
      )}
    </div>
  );
}

/** The step's reference for a field. */
function refOf(step: Step, field: TextField): TextRef | undefined {
  if (field === TextField.PROMPT) return step.promptRef;
  if (field === TextField.CONTEXT) return step.contextRef;
  return step.expectRef;
}

function fieldKeyOf(field: TextField): "prompt" | "context" | "expect" {
  if (field === TextField.PROMPT) return "prompt";
  if (field === TextField.CONTEXT) return "context";
  return "expect";
}

/** Read-only rendered text with the PromptEditor's token highlighting. */
function TextPreview({ text, known, field }: { text: string; known: Set<string>; field: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of tokenMatches(text)) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark
        key={m.start}
        data-token={m.name}
        data-known={known.has(m.name)}
        className={cn(
          "rounded-sm",
          known.has(m.name)
            ? "bg-accent/15"
            : "underline decoration-status-failed decoration-wavy underline-offset-2",
        )}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <pre
      tabIndex={0}
      data-editor-field={field}
      className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed text-ink"
    >
      {parts.length > 0 ? parts : text}
    </pre>
  );
}

function sameVars(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** One row per token in the shared text's body, with its fallback hint. */
function VarsForm({
  workflowId,
  workflow,
  step,
  field,
  text,
  vars,
}: {
  workflowId: string;
  workflow: Workflow;
  step: Step;
  field: TextField;
  text: SharedText;
  vars: Record<string, string>;
}) {
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.setStepTextRef, {
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });
  const save = useCallback(
    (next: Record<string, string>) =>
      mutateAsync({
        workflowId,
        stepId: step.id,
        field,
        ref: {
          textId: text.id,
          // Empty rows are omitted from the map.
          vars: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== "")),
        },
      }).then(() => undefined),
    [mutateAsync, workflowId, step.id, field, text.id],
  );
  const fieldAutosave = useAutosaveField<Record<string, string>>({
    value: vars,
    save,
    equals: sameVars,
  });
  const tokens = textTokens(text.body);
  const variables = availableVariables(step, workflow);
  const filled = tokens.filter((t) => (fieldAutosave.value[t] ?? "") !== "");

  if (tokens.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-testid="text-vars"
    >
      {tokens.map((token) => {
        const fallback = variables.find((v) => v.name === token);
        return (
          <div key={token} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate font-mono text-xs text-ink-muted" title={token}>
              {`{{${token}}}`}
            </span>
            <Input
              aria-label={`Value for ${token}`}
              mono
              className="h-7"
              value={fieldAutosave.value[token] ?? ""}
              onChange={(e) =>
                fieldAutosave.setValue({ ...fieldAutosave.value, [token]: e.target.value })
              }
              onFocus={fieldAutosave.onFocus}
              onBlur={fieldAutosave.onBlur}
            />
            <span className="shrink-0 text-xs text-ink-subtle">
              {fallback
                ? fallback.source === "input"
                  ? `falls back to input \`${token}\``
                  : `falls back to workflow value \`${token}\``
                : "unresolved"}
            </span>
          </div>
        );
      })}
      {filled.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-subtle">Preview</span>
          <TextPreview
            text={renderPreview(text.body, fieldAutosave.value)}
            known={new Set(variables.map((v: Variable) => v.name))}
            field={`text-vars-${text.id}`}
          />
        </div>
      )}
      <div className="flex justify-end">
        <SaveIndicator status={fieldAutosave.status} onRetry={fieldAutosave.retry} />
      </div>
    </div>
  );
}

/** "Make shared": extract the step's own text into a shared text. */
function MakeSharedForm({
  workflowId,
  stepId,
  field,
  suggested,
}: {
  workflowId: string;
  stepId: string;
  field: TextField;
  suggested: string;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(suggested);
  const [error, setError] = useState<string | null>(null);
  const extract = useWorkflowMutation(WorkflowService.method.extractSharedText, {
    onSucceeded: () => {
      setOpen(false);
      setError(null);
    },
    onAppError: (e) => setError(appErrorToast(e)),
  });

  if (!open) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        data-testid="make-shared"
        onClick={() => {
          setKey(suggested);
          setError(null);
          setOpen(true);
        }}
      >
        Make shared
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      aria-label="Make the field text shared"
      onSubmit={(e) => {
        e.preventDefault();
        extract.mutate({ workflowId, stepId, field, key });
      }}
    >
      <Input
        aria-label="Shared text key"
        data-testid="make-shared-key"
        mono
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          loading={extract.isPending}
          data-testid="make-shared-confirm"
        >
          Share
        </Button>
      </div>
    </form>
  );
}
