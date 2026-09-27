// In-memory transport for tests (spec 0014): register the handlers you need,
// every other method throws Unimplemented.
import {
  Code,
  ConnectError,
  createRouterTransport,
  type ServiceImpl,
  type Transport,
} from "@connectrpc/connect";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import { LiveService } from "@/gen/glyph/v1/live_pb";
import { RunService } from "@/gen/glyph/v1/run_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";

export interface FakeServices {
  workflow?: Partial<ServiceImpl<typeof WorkflowService>>;
  run?: Partial<ServiceImpl<typeof RunService>>;
  catalog?: Partial<ServiceImpl<typeof CatalogService>>;
  live?: Partial<ServiceImpl<typeof LiveService>>;
  definition?: Partial<ServiceImpl<typeof DefinitionService>>;
}

export function fakeTransport(impl: FakeServices = {}): Transport {
  return createRouterTransport(({ service }) => {
    const register = <T extends { typeName: string }>(
      svc: T,
      handlers: Record<string, unknown> | undefined,
    ) => {
      const proxy = new Proxy(handlers ?? {}, {
        get(target, prop) {
          if (prop in target) return target[prop as keyof typeof target];
          // Missing handler: return a function so registration succeeds and the
          // call fails with Unimplemented instead of crashing registration.
          return () => {
            throw new ConnectError(
              `fake transport: ${svc.typeName}.${String(prop)} not implemented`,
              Code.Unimplemented,
            );
          };
        },
      });
      // service() expects the impl shape; the proxy fills missing methods.
      service(svc as never, proxy as never);
    };
    register(WorkflowService, impl.workflow);
    register(RunService, impl.run);
    register(CatalogService, impl.catalog);
    register(LiveService, impl.live);
    register(DefinitionService, impl.definition);
  });
}

// Re-exported for tests that build raw clients or errors.
export { Code, ConnectError };
export type { Transport };
