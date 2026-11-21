import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTheme } from "./theme";
import { IconButton, Layers, MenuBars } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

// App shell skeleton (spec 0014): persistent sidebar slot, header slot, main
// outlet, global toaster (mounted in providers) and an (empty) command
// palette mount point. The workspace routes own the full-bleed main area.
// Below 768px (spec 0016) the sidebar becomes a drawer.
export function AppShell({
  sidebar,
  header,
  children,
}: {
  sidebar?: React.ReactNode;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The mobile drawer must not survive a navigation: picking a workflow from
  // it has to reveal the destination (audit ticket 6). Every interactive
  // element in the drawer is a link, so click capture covers mouse, keyboard
  // (Enter on a focused link fires click) and assistive tech alike.
  const closeDrawer = () => setDrawerOpen(false);
  return (
    <div data-testid="app-shell" className="flex h-dvh overflow-hidden bg-canvas">
      <a
        href="#glyph-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-1.5 focus:text-sm focus:text-ink focus:shadow-md"
      >
        Skip to content
      </a>
      <aside
        data-testid="app-sidebar"
        className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex"
      >
        {sidebar}
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            data-testid="sidebar-backdrop"
          />
          <aside
            className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-surface"
            data-testid="app-sidebar-drawer"
            onClickCapture={closeDrawer}
          >
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-testid="app-header"
          role="banner"
          className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
        >
          <button
            type="button"
            aria-label="Open menu"
            data-testid="open-sidebar"
            className={cn("rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink md:hidden")}
            onClick={() => setDrawerOpen(true)}
          >
            <MenuBars />
          </button>
          {header}
        </header>
        <main
          data-testid="app-main"
          id="glyph-main-content"
          className="min-h-0 flex-1 overflow-hidden"
        >
          {children}
        </main>
      </div>
      {/* Command palette mount point (populated in 0016). */}
      <div id="command-palette-root" />
    </div>
  );
}

/** Primary navigation, shared by the header bar and the mobile drawer. */
function PrimaryNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex items-center gap-1" onClick={onNavigate}>
      <Link
        to="/"
        activeOptions={{ exact: true }}
        className="flex h-7 items-center rounded-md px-2 text-sm font-semibold tracking-wide text-ink-muted hover:bg-surface-2 hover:text-ink"
        activeProps={{ className: "bg-surface-2 text-ink font-medium" }}
      >
        Home
      </Link>
      <Link
        to="/chat"
        activeOptions={{ exact: false }}
        className="flex h-7 items-center rounded-md px-2 text-sm font-semibold tracking-wide text-ink-muted hover:bg-surface-2 hover:text-ink"
        activeProps={{ className: "bg-surface-2 text-ink font-medium" }}
      >
        Chat
      </Link>
      <Link
        to="/settings"
        className="flex h-7 items-center rounded-md px-2 text-sm font-semibold tracking-wide text-ink-muted hover:bg-surface-2 hover:text-ink"
        activeProps={{ className: "bg-surface-2 text-ink font-medium" }}
      >
        Settings
      </Link>
    </nav>
  );
}

/** Minimal 0014 sidebar: logo only; the library list arrives in 0016. */
export function DefaultSidebar() {
  return (
    <>
      <div className="flex h-11 items-center gap-2 border-b border-border px-3">
        <span
          className="grid size-6 place-items-center rounded-md bg-accent text-on-accent"
          aria-hidden
        >
          <Layers size={14} />
        </span>
        <span className="text-sm font-semibold tracking-wide">Glyph</span>
      </div>
      <div className="flex-1" />
    </>
  );
}

/** Header: brand mark, primary nav and theme toggle in one full-width bar. */
export function DefaultHeader({ title }: { title?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <>
      <span
        className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-on-accent"
        aria-hidden
      >
        <Layers size={14} />
      </span>
      {title ? <span className="text-sm font-medium">{title}</span> : null}
      <PrimaryNav />
      <IconButton
        size="sm"
        className="ml-auto"
        label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        onClick={toggle}
      >
        {theme === "dark" ? "☀" : "☾"}
      </IconButton>
    </>
  );
}
