// Catalog query hooks (spec 0015). Models and tools change rarely.
import { createClient } from "@connectrpc/connect";
import { createConnectQueryKey, useQuery, useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";
import { workflowKeys } from "@/shared/api/keys";

export function useModels(includeUnavailable = false) {
  return useQuery(
    CatalogService.method.listModels,
    { includeUnavailable },
    { staleTime: 5 * 60_000 },
  );
}

export function useTools() {
  return useQuery(CatalogService.method.listTools, {}, { staleTime: 5 * 60_000 });
}

/** RefreshModels, then refetch the catalog and workflows (availability issues change). */
export function useRefreshModels() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createClient(CatalogService, transport).refreshModels({}),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: createConnectQueryKey({ schema: CatalogService, cardinality: undefined }),
        }),
        queryClient.invalidateQueries({ queryKey: workflowKeys.service() }),
      ]),
  });
}
