import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransportProvider } from "@connectrpc/connect-query";
import { ThemeProvider } from "./theme";
import { Toaster } from "@/shared/ui";
import { transport } from "@/shared/api/transport";

// Provider stack (spec 0014): theme → query client → transport → toaster.
// The command palette mount point (0016) will slot in beside the toaster.
export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          {children}
          <Toaster />
        </TransportProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
