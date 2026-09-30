import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { AppShell, DefaultHeader } from "@/app/shell";
import { RouteError } from "@/app/route-error";
import { CommandPaletteProvider, useAppCommands } from "@/app/commands";
import { CreateWorkflowDialogProvider, LibrarySidebar } from "@/features/library";

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

function RootComponent() {
  return (
    <CommandPaletteProvider>
      <CreateWorkflowDialogProvider>
        <AppFrame />
      </CreateWorkflowDialogProvider>
    </CommandPaletteProvider>
  );
}

function AppFrame() {
  useAppCommands();
  return (
    <AppShell sidebar={<LibrarySidebar />} header={<DefaultHeader />}>
      <Outlet />
    </AppShell>
  );
}

function NotFound() {
  return (
    <div className="grid h-full place-items-center gap-2 p-6 text-center">
      <div>
        <p className="text-sm font-semibold">Not found</p>
        <p className="mt-1 text-xs text-ink-muted">Nothing lives at this address.</p>
        <Link to="/" className="mt-3 inline-block text-sm text-accent hover:underline">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
