// Named workflow query hooks (spec 0015). Every screen reads workflows
// through these — never useQuery(WorkflowService…) directly.
import { useMemo } from "react";
import { useQuery } from "@connectrpc/connect-query";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { GetWorkflowResponse } from "@/gen/glyph/v1/workflow_pb";
import type { Issue, IssueEntityType } from "@/gen/glyph/v1/common_pb";
import { useIsLive } from "@/shared/api/liveness";
import type { WorkflowListFilter } from "@/shared/api/keys";

/** Live-aware freshness: events keep it fresh while a subscription is open. */
export function useWorkflow(id: string) {
  const live = useIsLive(id);
  return useQuery(
    WorkflowService.method.getWorkflow,
    { id },
    { staleTime: live ? Infinity : 30_000, enabled: id.length > 0 },
  );
}

export type WorkflowQueryData = GetWorkflowResponse;

export function useWorkflowList(filter: WorkflowListFilter = {}, options?: { refetchInterval?: number }) {
  return useQuery(
    WorkflowService.method.listWorkflows,
    { query: filter.query ?? "", status: filter.status, limit: filter.limit ?? 0 },
    // No cross-workflow stream exists; lists poll.
    { staleTime: 15_000, refetchOnWindowFocus: true, ...options },
  );
}

/** Issues indexed by (entityType, entityId, field), cached with the workflow. */
export interface IssueIndex {
  all: Issue[];
  forEntity(entityType: IssueEntityType, entityId: string): Issue[];
  at(entityType: IssueEntityType, entityId: string, field: string): Issue[];
}

function indexIssues(issues: Issue[]): IssueIndex {
  const byEntity = new Map<string, Issue[]>();
  const byField = new Map<string, Issue[]>();
  for (const issue of issues) {
    const eKey = `${issue.entityType}/${issue.entityId}`;
    byEntity.set(eKey, [...(byEntity.get(eKey) ?? []), issue]);
    byField.set(`${eKey}/${issue.field}`, [...(byField.get(`${eKey}/${issue.field}`) ?? []), issue]);
  }
  return {
    all: issues,
    forEntity: (t, id) => byEntity.get(`${t}/${id}`) ?? [],
    at: (t, id, field) => byField.get(`${t}/${id}/${field}`) ?? [],
  };
}

export function useIssues(workflowId: string): IssueIndex {
  const { data } = useWorkflow(workflowId);
  return useMemo(() => indexIssues(data?.issues ?? []), [data?.issues]);
}

/** Validation dry run (needs-attention reasons on Home cards). */
export function useValidateWorkflow(id: string) {
  return useQuery(WorkflowService.method.validateWorkflow, { id }, { staleTime: 30_000, enabled: id.length > 0 });
}
