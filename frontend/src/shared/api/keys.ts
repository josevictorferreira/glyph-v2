// Typed query keys (spec 0015). connect-query derives its own keys inside
// useQuery; these factories build the same shape so invalidation and
// setQueryData stay in sync by construction. Keys omitting `input` and/or
// `transport` act as partial filters (TanStack deep-partial matching); keys
// with a transport are exact and safe for setQueryData.
import { createConnectQueryKey } from "@connectrpc/connect-query";
import type { Transport } from "@connectrpc/connect";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { RunService } from "@/gen/glyph/v1/run_pb";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";

export interface WorkflowListFilter {
  query?: string;
  status?: WorkflowStatus;
  limit?: number;
}

export const workflowKeys = {
  /** Filter: every WorkflowService query. */
  service: () => createConnectQueryKey({ schema: WorkflowService, cardinality: undefined }),
  /** Filter: every ListWorkflows query, any input. */
  lists: () =>
    createConnectQueryKey({ schema: WorkflowService.method.listWorkflows, cardinality: "finite" }),
  list: (input: WorkflowListFilter, transport?: Transport) =>
    createConnectQueryKey({
      schema: WorkflowService.method.listWorkflows,
      input: { query: input.query ?? "", status: input.status, limit: input.limit ?? 0 },
      transport,
      cardinality: "finite",
    }),
  /** Exact when `transport` is given, partial filter otherwise. */
  detail: (id: string, transport?: Transport) =>
    createConnectQueryKey({
      schema: WorkflowService.method.getWorkflow,
      input: { id },
      transport,
      cardinality: "finite",
    }),
};

export const runKeys = {
  /** Filter: every RunService query. */
  service: () => createConnectQueryKey({ schema: RunService, cardinality: undefined }),
  /** Filter: ListRuns for one workflow, any limit/page (finite and infinite). */
  lists: (workflowId: string) =>
    createConnectQueryKey({
      schema: RunService.method.listRuns,
      input: { workflowId },
      cardinality: undefined,
    }),
  list: (workflowId: string, limit: number, transport?: Transport) =>
    createConnectQueryKey({
      schema: RunService.method.listRuns,
      input: { workflowId, limit },
      transport,
      cardinality: "finite",
    }),
  /** Filter: GetRun for one run. */
  detail: (workflowId: string, runId: string, transport?: Transport) =>
    createConnectQueryKey({
      schema: RunService.method.getRun,
      input: { workflowId, runId },
      transport,
      cardinality: "finite",
    }),
  /** Filter: GetStepRun for one step run. */
  stepRun: (workflowId: string, runId: string, stepRunId: string, transport?: Transport) =>
    createConnectQueryKey({
      schema: RunService.method.getStepRun,
      input: { workflowId, runId, stepRunId },
      transport,
      cardinality: "finite",
    }),
};

export const catalogKeys = {
  models: (includeUnavailable: boolean, transport?: Transport) =>
    createConnectQueryKey({
      schema: CatalogService.method.listModels,
      input: { includeUnavailable },
      transport,
      cardinality: "finite",
    }),
  tools: (transport?: Transport) =>
    createConnectQueryKey({
      schema: CatalogService.method.listTools,
      input: {},
      transport,
      cardinality: "finite",
    }),
};
