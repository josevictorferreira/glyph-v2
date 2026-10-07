// Workspace header (spec 0018): name, status, readiness pill, save + live
// indicators, mode switch (Build · Runs · Definition) and the primary
// action matrix per workflow status. Lifecycle preconditions open the
// readiness sheet instead of toasting.
import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { LiveConnectionIndicator } from "@/features/live";
import { useRunSheet } from "@/features/runs";
import { ScheduleChip } from "@/features/schedule";
import {
  useDeleteWorkflow,
  useIssues,
  useWorkflow,
  useWorkflowMutation,
} from "@/features/workflows";
import { appErrorToast, type AppError } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import {
  AlertTriangle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
  IconButton,
  Input,
  MenuBars,
  Pause,
  Play,
  Power,
  RotateCw,
  SaveIndicator,
  toast,
  Trash,
  WorkflowStatusBadge,
} from "@/shared/ui";
import { useEditorChrome } from "./chrome";

export function WorkspaceHeader({ workflowId }: { workflowId: string }) {
  const { data } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const issues = useIssues(workflowId);
  const issueCount = issues.all.length;
  const { requestFocus } = useEditorChrome();
  const status = workflow?.summary?.status ?? WorkflowStatus.DRAFT;
  // A needs_attention workflow whose issues were fixed (e.g. the schedule
  // that blocked it was removed) validates clean but only resume() clears
  // the status. Showing "Ready" next to "Needs attention" reads as a lie —
  // the pill states the recovery instead (audit ticket 3).
  const readyToReactivate = status === WorkflowStatus.NEEDS_ATTENTION && issueCount === 0;

  return (
    <div
      data-testid="workspace-header"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
    >
      {workflow ? (
        <>
          <WorkflowNameInput workflow={workflow} />
          <WorkflowStatusBadge status={status} />
          <ReadinessPill issueCount={issueCount} readyToReactivate={readyToReactivate} />
          <ScheduleChip workflow={workflow} onClick={() => requestFocus({ target: "schedule" })} />
        </>
      ) : (
        <div className="h-7 w-64 animate-pulse rounded-md bg-surface-3" />
      )}
      <div className="ml-auto flex items-center gap-2">
        {workflow && <ModeSwitch workflowId={workflowId} />}
        <LiveConnectionIndicator />
        {workflow && (
          <PrimaryActions
            workflow={workflow}
            issueCount={issueCount}
            readyToReactivate={readyToReactivate}
          />
        )}
      </div>
    </div>
  );
}

function WorkflowNameInput({ workflow }: { workflow: Workflow }) {
  const workflowId = workflow.summary?.id ?? "";
  const name = workflow.summary?.name ?? "";
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateWorkflow, {
    onAppError: appErrorToast,
  });
  const saveName = useCallback(
    (next: string) => mutateAsync({ id: workflowId, name: next }).then(() => undefined),
    [mutateAsync, workflowId],
  );
  const field = useAutosaveField({ value: name, save: saveName });
  return (
    <>
      <h1 className="sr-only">{name || "Workflow"}</h1>
      <Input
        aria-label="Workflow name"
        data-testid="workflow-name"
        value={field.value}
        onChange={(e) => field.setValue(e.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        className="h-7 w-64 text-sm font-medium"
      />
      <SaveIndicator status={field.status} onRetry={field.retry} />
    </>
  );
}

function ReadinessPill({
  issueCount,
  readyToReactivate,
}: {
  issueCount: number;
  readyToReactivate: boolean;
}) {
  const { setReadinessOpen } = useEditorChrome();
  const label = readyToReactivate
    ? "Ready — reactivate"
    : issueCount === 0
      ? "Ready"
      : `${issueCount} ${issueCount === 1 ? "issue" : "issues"}`;
  return (
    <button
      type="button"
      data-testid="readiness-pill"
      aria-label={`Workflow readiness: ${label}`}
      onClick={() => setReadinessOpen(true)}
      // 24px hit area (WCAG 2.2 target size; root font is 14px so rem
      // spacing would land at 21px).
      className="min-h-[24px] rounded-full focus-visible:outline-none"
    >
      <Badge tone={issueCount === 0 ? "success" : "danger"}>{label}</Badge>
    </button>
  );
}

function ModeSwitch({ workflowId }: { workflowId: string }) {
  const modes = [
    { label: "Build", to: "/workflows/$id" as const, exact: true },
    { label: "Runs", to: "/workflows/$id/runs" as const, exact: false },
    { label: "Definition", to: "/workflows/$id/definition" as const, exact: false },
  ];
  return (
    <nav
      aria-label="Workspace mode"
      className="flex h-7 items-center rounded-lg bg-surface-2 p-0.5"
    >
      {modes.map((mode) => (
        <Link
          key={mode.label}
          to={mode.to}
          params={{ id: workflowId }}
          activeOptions={{ exact: mode.exact }}
          className="flex h-6 items-center rounded-md px-2.5 text-xs font-medium text-ink-muted hover:text-ink data-[status=active]:bg-surface data-[status=active]:text-ink data-[status=active]:shadow-sm"
        >
          {mode.label}
        </Link>
      ))}
    </nav>
  );
}

function PrimaryActions({
  workflow,
  issueCount,
  readyToReactivate,
}: {
  workflow: Workflow;
  issueCount: number;
  readyToReactivate: boolean;
}) {
  const workflowId = workflow.summary?.id ?? "";
  const status = workflow.summary?.status ?? WorkflowStatus.DRAFT;
  const name = workflow.summary?.name ?? "";
  const { setReadinessOpen } = useEditorChrome();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const navigate = useNavigate();

  // Run now opens the run sheet when values are asked, else starts at once.
  const { runNow } = useRunSheet();

  const lifecycleError = useCallback(
    (error: AppError) => {
      if (error.kind === "precondition" && error.reason === "VALIDATION_FAILED") {
        setReadinessOpen(true);
        return;
      }
      toast({ title: appErrorToast(error), tone: "danger" });
    },
    [setReadinessOpen],
  );

  const activate = useWorkflowMutation(WorkflowService.method.activateWorkflow, {
    onSucceeded: () => toast({ title: "Workflow activated", tone: "success" }),
    onAppError: lifecycleError,
  });
  const pause = useWorkflowMutation(WorkflowService.method.pauseWorkflow, {
    onSucceeded: () => setPauseOpen(false),
    onAppError: (error) => {
      setPauseOpen(false);
      toast({ title: appErrorToast(error), tone: "danger" });
    },
  });
  // A resume that landed in NEEDS_ATTENTION explains itself via the sheet.
  const resume = useWorkflowMutation(WorkflowService.method.resumeWorkflow, {
    onSucceeded: (res) => {
      if (!res.resumed) {
        setReadinessOpen(true);
        toast({ title: "Workflow still needs attention" });
      }
    },
    onAppError: lifecycleError,
  });

  const secondaryRunLabel = status === WorkflowStatus.DRAFT ? "Test run" : "Run now";

  const remove = useDeleteWorkflow((error) => {
    setDeleteOpen(false);
    toast({ title: appErrorToast(error), tone: "danger" });
  });

  return (
    <>
      {status === WorkflowStatus.DRAFT && (
        <Button
          size="sm"
          variant="primary"
          data-testid="activate"
          loading={activate.isPending}
          disabled={issueCount > 0}
          title={
            issueCount > 0
              ? `Resolve ${issueCount} ${issueCount === 1 ? "issue" : "issues"} to activate.`
              : undefined
          }
          onClick={() => activate.mutate({ id: workflowId })}
        >
          <Power className="size-3.5" /> Activate
        </Button>
      )}
      {status === WorkflowStatus.ACTIVE && (
        <Button size="sm" variant="primary" data-testid="run-now" onClick={runNow}>
          <Play className="size-3.5" /> Run now
        </Button>
      )}
      {status === WorkflowStatus.PAUSED && (
        <Button
          size="sm"
          variant="primary"
          data-testid="resume"
          loading={resume.isPending}
          onClick={() => resume.mutate({ id: workflowId })}
        >
          <Play className="size-3.5" /> Resume
        </Button>
      )}
      {status === WorkflowStatus.NEEDS_ATTENTION &&
        (readyToReactivate ? (
          <Button
            size="sm"
            variant="primary"
            data-testid="reactivate"
            loading={resume.isPending}
            title="The issues are resolved — reactivate the workflow."
            onClick={() => resume.mutate({ id: workflowId })}
          >
            <RotateCw className="size-3.5" /> Reactivate
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            data-testid="review-issues"
            onClick={() => setReadinessOpen(true)}
          >
            <AlertTriangle className="size-3.5" /> Review issues
          </Button>
        ))}

      <Dropdown>
        <DropdownTrigger asChild>
          <IconButton label="More workflow actions" size="sm">
            <MenuBars />
          </IconButton>
        </DropdownTrigger>
        <DropdownContent align="end">
          <DropdownItem
            onSelect={runNow}
            disabled={status === WorkflowStatus.NEEDS_ATTENTION}
            title={
              status === WorkflowStatus.NEEDS_ATTENTION
                ? "Fix the issues that need attention before running."
                : undefined
            }
          >
            <Play className="size-3.5" /> {secondaryRunLabel}
          </DropdownItem>
          {(status === WorkflowStatus.ACTIVE || status === WorkflowStatus.NEEDS_ATTENTION) && (
            <DropdownItem onSelect={() => setPauseOpen(true)}>
              <Pause className="size-3.5" /> Pause
            </DropdownItem>
          )}
          <DropdownItem onSelect={() => setDeleteOpen(true)} className="text-danger">
            <Trash className="size-3.5" /> Delete workflow…
          </DropdownItem>
        </DropdownContent>
      </Dropdown>

      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent
          title="Pause this workflow?"
          description="Scheduled runs stop. Manual runs stay available. History is kept."
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPauseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="confirm-pause"
              loading={pause.isPending}
              onClick={() => pause.mutate({ id: workflowId })}
            >
              <Pause className="size-3.5" /> Pause
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          title={`Delete “${name}”?`}
          description="Its steps, values, and schedule are removed. Runs are kept until deleted separately."
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="confirm-delete-workflow"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(workflowId, {
                  onSuccess: () => {
                    setDeleteOpen(false);
                    toast({ title: `Workflow “${name}” deleted.`, tone: "success" });
                    void navigate({ to: "/" });
                  },
                })
              }
            >
              <Trash className="size-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
