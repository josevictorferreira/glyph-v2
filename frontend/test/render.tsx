// renderWithApp (spec 0014): wraps providers + an optional memory router.
import { createMemoryHistory, createRouter, RouterProvider, type Router } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransportProvider } from "@connectrpc/connect-query";
import { render, renderHook, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { Transport } from "@connectrpc/connect";
import { fakeTransport, type FakeServices } from "./fakeTransport";
import { ThemeProvider } from "@/app/theme";
import { Toaster } from "@/shared/ui";
import { routeTree } from "@/routeTree.gen";

export interface RenderWithAppOptions extends Omit<RenderOptions, "wrapper"> {
  services?: FakeServices;
  transport?: Transport;
  /** When set, renders the real route tree at this path instead of `ui`. */
  route?: string;
}

export interface RenderWithAppResult extends RenderResult {
  queryClient: QueryClient;
  transport: Transport;
  /** Present when `route` was passed. */
  router?: Router<typeof routeTree>;
}

/** renderHook with the same provider stack (spec 0015). */
export function renderHookWithApp<TResult>(
  hook: () => TResult,
  opts: RenderWithAppOptions = {},
): { result: { current: TResult }; unmount: () => void; rerender: (hook?: () => TResult) => void; queryClient: QueryClient; transport: Transport } {
  const transport = opts.transport ?? fakeTransport(opts.services ?? {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  const rendered = renderHook(hook, { wrapper });
  return { ...rendered, queryClient, transport };
}

export function renderWithApp(ui?: React.ReactNode, opts: RenderWithAppOptions = {}): RenderWithAppResult {
  const transport = opts.transport ?? fakeTransport(opts.services ?? {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          {children}
          <Toaster />
        </TransportProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );

  if (opts.route) {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [opts.route] }),
    });
    const rendered = render(<RouterProvider router={router} />, { wrapper });
    return { ...rendered, queryClient, transport, router };
  }

  const rendered = render(<>{ui}</>, { wrapper });
  return { ...rendered, queryClient, transport };
}
