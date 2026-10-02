// useWorkflowMutation (spec 0015): every mutation whose response carries the
// workflow aggregate reconciles the GetWorkflow cache with what the server
// returned and invalidates list summaries. Optional optimistic patch (used by
// canvas MoveStep) rolls back on failure. Errors surface as AppError via
// onAppError — never inspect ConnectError in screens.
import { useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import type {
  DescMessage,
  DescMethodUnary,
  DescService,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { GetWorkflowResponseSchema } from "@/gen/glyph/v1/workflow_pb";
import type { GetWorkflowResponse, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { workflowKeys } from "@/shared/api/keys";
import { toAppError, type AppError } from "@/shared/api/errors";

interface AggregateResponse {
  workflow?: Workflow | undefined;
  issues: Issue[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type namespace for the union below
const m = WorkflowService.method;

/** RPCs that return the {workflow, issues} aggregate. */
export type WorkflowMutationRpc =
  | typeof m.createWorkflow
  | typeof m.updateWorkflow
  | typeof m.addStep
  | typeof m.duplicateStep
  | typeof m.updateStepDetails
  | typeof m.updateStepPrompt
  | typeof m.updateStepOutput
  | typeof m.updateStepModel
  | typeof m.toggleStepTool
  | typeof m.moveStep
  | typeof m.deleteStep
  | typeof m.addStepInput
  | typeof m.removeStepInput
  | typeof m.mapStepInput
  | typeof m.addWorkflowInput
  | typeof m.updateWorkflowInput
  | typeof m.removeWorkflowInput
  | typeof m.addSharedText
  | typeof m.updateSharedText
  | typeof m.removeSharedText
  | typeof m.setStepTextRef
  | typeof m.extractSharedText
  | typeof m.createConnection
  | typeof m.connectOutputToStep
  | typeof m.removeConnection
  | typeof m.saveSchedule
  | typeof m.setScheduleValue
  | typeof m.activateWorkflow
  | typeof m.pauseWorkflow
  | typeof m.resumeWorkflow
  | typeof DefinitionService.method.applyDefinition
  | typeof DefinitionService.method.importWorkflow;

function requestWorkflowId(request: object): string | undefined {
  for (const key of ["id", "workflowId", "workflow_id"] as const) {
    const value = (request as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export interface UseWorkflowMutationOptions<Req, Res> {
  /** Patch the cached workflow before the request (MoveStep). */
  optimistic?: (workflow: Workflow, request: Req) => Workflow;
  onSucceeded?: (response: Res, request: Req) => void;
  onAppError?: (error: AppError, request: Req) => void;
}

interface MutationContext {
  id?: string;
  snapshot?: GetWorkflowResponse;
}

type RequestOf<T> = T extends DescMethodUnary<infer I, DescMessage> ? MessageInitShape<I> : never;
type ResponseOf<T> = T extends DescMethodUnary<DescMessage, infer O> ? MessageShape<O> : never;

export function useWorkflowMutation<Rpc extends WorkflowMutationRpc>(
  rpc: Rpc,
  options: UseWorkflowMutationOptions<RequestOf<Rpc>, ResponseOf<Rpc>> = {},
) {
  const queryClient = useQueryClient();
  const transport = useTransport();
  const serviceName = (rpc.parent as DescService).typeName;
  return useMutation({
    mutationKey: [serviceName, rpc.name],
    mutationFn: async (request: RequestOf<Rpc>): Promise<ResponseOf<Rpc>> => {
      // rpc.parent is the owning service (WorkflowService or DefinitionService).
      const client = createClient(rpc.parent as typeof WorkflowService, transport);
      const method = (
        client as unknown as Record<string, (req: RequestOf<Rpc>) => Promise<ResponseOf<Rpc>>>
      )[rpc.name.charAt(0).toLowerCase() + rpc.name.slice(1)]!;
      return method(request);
    },
    onMutate: async (request): Promise<MutationContext> => {
      const id = requestWorkflowId(request);
      if (!id) return {};
      if (!options.optimistic) return { id };
      const key = workflowKeys.detail(id, transport);
      await queryClient.cancelQueries({ queryKey: key });
      const snapshot = queryClient.getQueryData<GetWorkflowResponse>(key);
      if (snapshot?.workflow) {
        queryClient.setQueryData<GetWorkflowResponse>(key, {
          ...snapshot,
          workflow: options.optimistic(snapshot.workflow, request),
        });
      }
      return { id, snapshot };
    },
    onSuccess: (response, request, ctx?) => {
      const res = response as AggregateResponse;
      const id = ctx?.id ?? res.workflow?.summary?.id;
      if (id && res.workflow) {
        queryClient.setQueryData(
          workflowKeys.detail(id, transport),
          create(GetWorkflowResponseSchema, { workflow: res.workflow, issues: res.issues }),
        );
      } else if (id) {
        void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(id) });
      }
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      options.onSucceeded?.(response, request);
    },
    onError: (error: unknown, request: RequestOf<Rpc>, ctx?: MutationContext) => {
      if (ctx?.id) {
        const key = workflowKeys.detail(ctx.id, transport);
        if (ctx.snapshot) queryClient.setQueryData(key, ctx.snapshot);
        else {
          const query = queryClient.getQueryCache().find({ queryKey: key });
          if (query?.isActive()) {
            // Something is watching this workflow (e.g. the workspace
            // header): removing the entry would leave its observer dangling
            // on the removed query, blind to later cache writes (an aborted
            // definition apply hits this). Invalidate so it refetches.
            void queryClient.invalidateQueries({ queryKey: key });
          } else {
            queryClient.removeQueries({ queryKey: key });
          }
        }
      }
      options.onAppError?.(toAppError(error), request);
    },
  });
}
