// Shared frame for the RareUI-inspired component gallery (dev-only route /dev/rare).
// Each batch of components ships a demo array of DemoEntry; the gallery renders
// them grouped by RareUI category with attribution.
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface DemoEntry {
  id: string;
  title: string;
  description?: string;
  /** Wide demos (sidebars, full-width navigation) span the whole grid row. */
  wide?: boolean;
  element: ReactNode;
}

export function DemoFrame({ entry }: { entry: DemoEntry }) {
  return (
    <div
      data-demo={entry.id}
      className={cn(
        "flex min-h-44 flex-col gap-3 rounded-card border border-border bg-surface p-4",
        entry.wide && "md:col-span-2 xl:col-span-3",
      )}
    >
      <div>
        <h3 className="text-sm font-semibold text-ink">{entry.title}</h3>
        {entry.description && (
          <p className="mt-0.5 text-xs text-ink-muted">{entry.description}</p>
        )}
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-center gap-4 overflow-hidden">
        {entry.element}
      </div>
    </div>
  );
}

export function DemoSection({ title, entries }: { title: string; entries: DemoEntry[] }) {
  return (
    <section className="border-b border-border px-4 py-5 last:border-b-0 md:px-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <DemoFrame key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
