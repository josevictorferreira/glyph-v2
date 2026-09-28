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
  return (
    <div data-testid="app-shell" className="flex h-dvh overflow-hidden bg-canvas">
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
        <main data-testid="app-main" className="min-h-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      {/* Command palette mount point (populated in 0016). */}
      <div id="command-palette-root" />
    </div>
  );
}

/** Minimal 0014 sidebar: logo, Home link; the library list arrives in 0016. */
export function DefaultSidebar() {
  const { theme, toggle } = useTheme();
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
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="flex h-7 items-center rounded-md px-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          activeProps={{ className: "bg-surface-2 text-ink font-medium" }}
        >
          Home
        </Link>
      </nav>
      <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <span className="text-xs text-ink-subtle">Workflows arrive in 0016</span>
        <IconButton
          size="sm"
          label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={toggle}
        >
          {theme === "dark" ? "☀" : "☾"}
        </IconButton>
      </div>
    </>
  );
}

/** Minimal 0014 header: theme toggle + breadcrumb slot. */
export function DefaultHeader({ title }: { title?: string }) {
  return (
    <>
      {title ? <span className="text-sm font-medium">{title}</span> : null}
      <span className="ml-auto text-xs text-ink-subtle">Glyph</span>
    </>
  );
}
