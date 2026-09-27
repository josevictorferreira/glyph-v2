// Catalog query hooks (spec 0015). Models and tools change rarely.
import { useQuery } from "@connectrpc/connect-query";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";

export function useModels(includeUnavailable = false) {
  return useQuery(CatalogService.method.listModels, { includeUnavailable }, { staleTime: 5 * 60_000 });
}

export function useTools() {
  return useQuery(CatalogService.method.listTools, {}, { staleTime: 5 * 60_000 });
}
