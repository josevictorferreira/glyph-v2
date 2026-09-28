// Readiness sheet (spec 0018): all validator issues grouped by entity, with
// deep links into the editor (select entity → open tab → focus field → pan
// canvas). The empty state celebrates readiness and offers Activate.
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflow, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { AlertTriangle, Button, CheckCircle, Sheet, SheetContent, toast } from "@/shared/ui";
import { useEditorChrome } from "./chrome";
import { groupIssues, issueField, issueStepId, issueTarget } from "./issues";

export function ReadinessSheet({ workflowId }: { workflowId: string }) {
  const { readinessOpen, setReadinessOpen, requestFocus, selectStep } = useEditorChrome();
  const { data } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const issues = data?.issues ?? [];

  const activate = useWorkflowMutation(WorkflowService.method.activateWorkflow, {
    onSucceeded: () => {
      setReadinessOpen(false);
      toast({ title: "Workflow activated", tone: "success" });
    },
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });

  const deepLink = (issue: Issue) => {
    const stepId = issueStepId(issue, workflow);
    selectStep(stepId ?? null);
    requestFocus({ stepId, target: issueTarget(issue), field: issueField(issue) });
    setReadinessOpen(false);
  };

  const status = workflow?.summary?.status;
  const draft = status === WorkflowStatus.DRAFT;
  // Rails parity: the review modal offers Activate whenever the workflow is
  // not active and has no blocking issues — this also recovers
  // needs_attention after its issues are fixed.
  const canActivate = issues.length === 0 && workflow !== undefined && status !== WorkflowStatus.ACTIVE;

  return (
    <Sheet open={readinessOpen} onOpenChange={setReadinessOpen}>
      <SheetContent
        title="Readiness"
        description={
          issues.length === 0
            ? "Everything this workflow needs is in place."
            : `${issues.length} ${issues.length === 1 ? "issue" : "issues"} before this workflow can run.`
        }
        data-testid="readiness-sheet"
      >
        {issues.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <CheckCircle className="text-status-succeeded" />
            <p className="text-sm font-medium text-ink">
              {draft ? "Ready to activate" : "No issues. Everything is ready."}
            </p>
            {canActivate && (
              <Button
                variant="primary"
                size="sm"
                data-testid="readiness-activate"
                loading={activate.isPending}
                onClick={() => activate.mutate({ id: workflowId })}
              >
                Activate
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupIssues(issues, workflow).map((group) => (
              <section key={group.key} aria-label={group.label}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  {group.label}
                </h3>
                <ul className="flex flex-col gap-1">
                  {group.issues.map((issue, i) => (
                    <li key={`${group.key}-${i}`}>
                      <button
                        type="button"
                        onClick={() => deepLink(issue)}
                        className="flex w-full items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-left text-sm text-ink hover:bg-surface-2"
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-failed" />
                        <span>{issue.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
