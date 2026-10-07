// Run sheet (spec 0020): collects values asked at run time before StartRun.
// Prefills from the stored default, else the latest run ("Used last time");
// constants are shown read-only; drafts get a test-run banner; readiness
// issues block Start. Workflows with no required asked value skip the sheet
// and start immediately (useRunNow). One sheet per workspace, opened from
// the header, the palette and the run strip through RunSheetProvider.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useIssues, useWorkflow } from "@/features/workflows";
import { appErrorToast, type AppError } from "@/shared/api/errors";
import { cn } from "@/shared/lib/cn";
import {
  AlertTriangle,
  Button,
  Disclosure,
  Kbd,
  Play,
  Sheet,
  SheetContent,
  Textarea,
  toast,
} from "@/shared/ui";
import { useRuns } from "./hooks";
import {
  askedInputs,
  looksLikeJson,
  missingValues,
  needsRunSheet,
  prefillValues,
  valuesToSend,
} from "./lib/run-view";
import { useStartRun } from "./use-start-run";

interface RunSheetContextValue {
  /** Open the sheet, or start right away when nothing is asked (spec: Run now). */
  runNow: () => void;
  openSheet: () => void;
}

const RunSheetContext = createContext<RunSheetContextValue | null>(null);

export function useRunSheet(): RunSheetContextValue {
  const ctx = useContext(RunSheetContext);
  if (!ctx) throw new Error("useRunSheet requires RunSheetProvider (workspace layout)");
  return ctx;
}

export function RunSheetProvider({
  workflowId,
  onReviewIssues,
  children,
}: {
  workflowId: string;
  onReviewIssues: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useWorkflow(workflowId);
  // Latest run, for "Used last time" prefill; loaded before the sheet mounts.
  const recent = useRuns(workflowId, 1);
  const workflow = data?.workflow;
  const navigate = useNavigate();
  const onStarted = useCallback(
    (runId: string) =>
      void navigate({ to: "/workflows/$id/runs/$runId", params: { id: workflowId, runId } }),
    [navigate, workflowId],
  );
  const startRun = useStartRun((error) => {
    if (error.kind === "precondition" && error.reason === "VALIDATION_FAILED") onReviewIssues();
    toast({ title: appErrorToast(error), tone: "danger" });
  });

  const runNow = useCallback(() => {
    if (!workflow) return;
    if (needsRunSheet(workflow)) {
      setOpen(true);
      return;
    }
    startRun
      .mutateAsync({ workflowId })
      .then((res) => {
        const runId = res.run?.id;
        toast({
          title: "Run started",
          action: runId ? { label: "View run", onClick: () => onStarted(runId) } : undefined,
        });
      })
      .catch(() => undefined);
  }, [workflow, workflowId, startRun, onStarted]);

  const value = useMemo(() => ({ runNow, openSheet: () => setOpen(true) }), [runNow]);

  return (
    <RunSheetContext.Provider value={value}>
      {children}
      {workflow && (
        <Sheet open={open} onOpenChange={setOpen}>
          {open && !recent.isLoading && (
            <RunSheetBody
              workflow={workflow}
              lastRun={recent.data?.runs[0]}
              onReviewIssues={() => {
                setOpen(false);
                onReviewIssues();
              }}
              onStarted={(runId) => {
                setOpen(false);
                onStarted(runId);
              }}
            />
          )}
        </Sheet>
      )}
    </RunSheetContext.Provider>
  );
}

function RunSheetBody({
  workflow,
  lastRun,
  onReviewIssues,
  onStarted,
}: {
  workflow: Workflow;
  lastRun: Run | undefined;
  onReviewIssues: () => void;
  onStarted: (runId: string) => void;
}) {
  const workflowId = workflow.summary?.id ?? "";
  const issues = useIssues(workflowId).all;
  const [prefill] = useState(() => prefillValues(workflow, lastRun));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(prefill).map(([name, p]) => [name, p.value])),
  );
  const [highlight, setHighlight] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const startRun = useStartRun((e: AppError) => {
    if (e.kind === "precondition" && e.reason === "MISSING_VALUES") {
      setHighlight(missingValues(workflow, values));
    }
    setError(appErrorToast(e));
  });

  const asked = askedInputs(workflow);
  const constants = workflow.inputs.filter((i) => !i.askAtRunTime);
  const draft = workflow.summary?.status === WorkflowStatus.DRAFT;
  const blocked = issues.length > 0;

  const submit = () => {
    if (blocked) return;
    const missing = missingValues(workflow, values);
    setHighlight(missing);
    if (missing.length > 0) return;
    setError(null);
    startRun
      .mutateAsync({ workflowId, values: valuesToSend(values) })
      .then((res) => res.run && onStarted(res.run.id))
      .catch(() => undefined);
  };

  return (
    <SheetContent
      title={draft ? "Test run" : "Run now"}
      description={workflow.summary?.name}
      data-testid="run-sheet"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {blocked && (
          <div
            className="flex items-start gap-2 rounded-md border border-status-failed/40 bg-status-failed/10 p-2.5 text-sm"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-failed" />
            <div className="flex-1">
              <p className="text-ink">
                {issues.length} {issues.length === 1 ? "issue blocks" : "issues block"} this run.
              </p>
              <ul className="mt-1 list-disc pl-4 text-xs text-ink-muted">
                {issues.slice(0, 3).map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onReviewIssues}>
              <AlertTriangle className="size-3.5" /> Review issues
            </Button>
          </div>
        )}
        {draft && (
          <p
            className="rounded-md bg-surface-2 p-2.5 text-xs text-ink-muted"
            data-testid="draft-test-banner"
          >
            This is a test run of a draft. It won't activate the workflow.
          </p>
        )}

        {asked.length === 0 && (
          <p className="text-sm text-ink-muted">This workflow asks for no values.</p>
        )}
        {asked.map((input) => {
          const value = values[input.name] ?? "";
          const missing = highlight.includes(input.name);
          return (
            <Textarea
              key={input.id}
              label={input.required ? `${input.name} *` : input.name}
              aria-label={input.name}
              aria-required={input.required}
              mono={looksLikeJson(value)}
              rows={2}
              value={value}
              error={missing ? "Provide a value for this run." : undefined}
              hint={
                prefill[input.name]?.fromLastRun && value === prefill[input.name]?.value
                  ? "Used last time"
                  : (input.description ?? undefined)
              }
              onChange={(e) => {
                setValues({ ...values, [input.name]: e.target.value });
                if (missing) setHighlight(highlight.filter((n) => n !== input.name));
              }}
              className={cn(missing && "border-status-failed")}
            />
          );
        })}

        {constants.length > 0 && (
          <Disclosure title={`Fixed values (${constants.length})`}>
            <dl className="flex flex-col gap-1.5 py-2 text-sm">
              {constants.map((c) => (
                <div key={c.id} className="flex gap-2">
                  <dt className="shrink-0 font-mono text-ink-muted">{c.name}</dt>
                  <dd className="min-w-0 truncate font-mono text-ink">{c.value}</dd>
                </div>
              ))}
            </dl>
          </Disclosure>
        )}

        {error && (
          <p className="text-xs text-status-failed" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-ink-subtle">
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
          </span>
          <Button
            type="submit"
            variant="primary"
            disabled={blocked}
            loading={startRun.isPending}
            data-testid="start-run"
          >
            <Play /> Start run
          </Button>
        </div>
      </form>
    </SheetContent>
  );
}
