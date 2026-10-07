import { Link, useLocation } from "@tanstack/react-router";
import { Button, ChevronLeft, CopyButton, RotateCw } from "@/shared/ui";

// Root errorComponent (spec 0022): an app-styled crash page instead of the
// router default. Diagnostics (path, message, stack) are copyable. This is a
// route-level fallback — no router hooks or data APIs, only what survives a
// render crash of the route component itself.
export function RouteError({ error }: { error: unknown }) {
  const location = useLocation();
  const detail = describeRouteError(error);
  const diagnostics =
    `path: ${location.pathname}\n` +
    `error: ${detail.message}\n` +
    (detail.stack ? `stack:\n${detail.stack}` : "");
  return (
    <div className="grid h-full place-items-center overflow-auto p-6">
      <div className="max-w-xl text-left">
        <p className="text-sm font-semibold">Something went wrong</p>
        <p className="mt-1 text-xs text-ink-muted">
          Glyph hit an unexpected error on <code className="font-mono">{location.pathname}</code>.
          Your data is safe; reloading the page usually fixes it.
        </p>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCw /> Reload
          </Button>
          <Link
            to="/"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <ChevronLeft /> Back to Home
          </Link>
        </div>
        <div className="mt-4">
          <details>
            <summary className="cursor-pointer text-xs text-ink-subtle select-none">
              Diagnostics
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap text-ink-muted">
              {diagnostics}
            </pre>
            <div className="mt-2">
              <CopyButton value={diagnostics} label="Copy diagnostics" />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

export function describeRouteError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === "string") return { message: error };
  const json = typeof error === "symbol" ? undefined : JSON.stringify(error);
  return { message: json ?? String(error) };
}
