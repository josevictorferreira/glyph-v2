// Workspace header (spec 0018): name, status, readiness pill, save + live
// indicators, mode switch (Build · Runs · Definition) and the primary
// action matrix per workflow status. Lifecycle preconditions open the
// readiness sheet instead of toasting.
import { useCallback, useState } from "react";
import { Link } from "@tanstack/react-router";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { LiveConnectionIndicator } from "@/features/live";
import { useRunSheet } from "@/features/runs";
import { ScheduleChip } from "@/features/schedule";
import { useIssues, useWorkflow, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast, type AppError } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import {
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
  SaveIndicator,
  toast,
  WorkflowStatusBadge,
} from "@/shared/ui";
import { useEditorChrome } from "./chrome";

export function WorkspaceHeader({ workflowId }: { workflowId: string }) {
  const { data } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const issues = useIssues(workflowId);
  const issueCount = issues.all.length;
  const { requestFocus } = useEditorChrome();

  return (
    <div
      data-testid="workspace-header"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
    >
      {workflow ? (
        <>
          <WorkflowNameInput workflow={workflow} />
          <WorkflowStatusBadge status={workflow.summary?.status ?? WorkflowStatus.DRAFT} />
          <ReadinessPill issueCount={issueCount} />
          <ScheduleChip workflow={workflow} onClick={() => requestFocus({ target: "schedule" })} />
        </>
      ) : (
        <div className="h-7 w-64 animate-pulse rounded-md bg-surface-3" />
      )}
      <div className="ml-auto flex items-center gap-2">
        {workflow && <ModeSwitch workflowId={workflowId} />}
        <LiveConnectionIndicator />
        {workflow && <PrimaryActions workflow={workflow} issueCount={issueCount} />}
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

function ReadinessPill({ issueCount }: { issueCount: number }) {
  const { setReadinessOpen } = useEditorChrome();
  const ready = issueCount === 0;
  return (
    <button
      type="button"
      data-testid="readiness-pill"
      aria-label={ready ? "Workflow readiness: ready" : `Workflow readiness: ${issueCount} issues`}
      onClick={() => setReadinessOpen(true)}
      className="rounded-full focus-visible:outline-none"
    >
      <Badge tone={ready ? "success" : "danger"}>
        {ready ? "Ready" : `${issueCount} ${issueCount === 1 ? "issue" : "issues"}`}
      </Badge>
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

function PrimaryActions({ workflow, issueCount }: { workflow: Workflow; issueCount: number }) {
  const workflowId = workflow.summary?.id ?? "";
  const status = workflow.summary?.status ?? WorkflowStatus.DRAFT;
  const { setReadinessOpen } = useEditorChrome();
  const [pauseOpen, setPauseOpen] = useState(false);

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
          Activate
        </Button>
      )}
      {status === WorkflowStatus.ACTIVE && (
        <Button size="sm" variant="primary" data-testid="run-now" onClick={runNow}>
          Run now
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
          Resume
        </Button>
      )}
      {status === WorkflowStatus.NEEDS_ATTENTION && (
        <Button
          size="sm"
          variant="primary"
          data-testid="review-issues"
          onClick={() => setReadinessOpen(true)}
        >
          Review issues
        </Button>
      )}

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
            {secondaryRunLabel}
          </DropdownItem>
          {(status === WorkflowStatus.ACTIVE || status === WorkflowStatus.NEEDS_ATTENTION) && (
            <DropdownItem onSelect={() => setPauseOpen(true)}>Pause</DropdownItem>
          )}
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
              Pause
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
