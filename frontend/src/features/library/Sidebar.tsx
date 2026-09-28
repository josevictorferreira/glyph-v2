// Sidebar workflow library (spec 0016): search (debounced 200ms), status
// filter chips, New button, live-ish summaries, keyboard navigation, and a
// collapse-to-icons mode. Current workflow highlighted.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { useWorkflowList } from "@/features/workflows";
import type { WorkflowListFilter } from "@/shared/api/keys";
import { useDebouncedValue } from "@/shared/lib/use-debounced";
import { useNow } from "@/shared/lib/time";
import { describeWorkflowStatus } from "@/shared/api/enums";
import { Button, PanelLeft, Plus, Search, StatusDot } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import { secondaryLine, sortWorkflows } from "./summaries";
import { useCreateWorkflowDialog } from "./create-dialog";

type FilterChip = "all" | "active" | "draft" | "paused" | "attention";

const CHIPS: { id: FilterChip; label: string; status?: WorkflowStatus }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active", status: WorkflowStatus.ACTIVE },
  { id: "draft", label: "Draft", status: WorkflowStatus.DRAFT },
  { id: "paused", label: "Paused", status: WorkflowStatus.PAUSED },
  { id: "attention", label: "Needs attention", status: WorkflowStatus.NEEDS_ATTENTION },
];

export function LibrarySidebar({ className }: { className?: string }) {
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<FilterChip>("all");
  const [collapsed, setCollapsed] = useState(false);
  const debounced = useDebouncedValue(query, 200);
  const createDialog = useCreateWorkflowDialog();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const currentId = typeof params.id === "string" ? params.id : undefined;
  const searchRef = useRef<HTMLInputElement>(null);

  const filter = useMemo<WorkflowListFilter>(
    () => ({ query: debounced, status: CHIPS.find((c) => c.id === chip)?.status, limit: 100 }),
    [debounced, chip],
  );
  const { data, isFetching } = useWorkflowList(filter);
  const now = useNow(10_000);
  const workflows = useMemo(() => sortWorkflows(data?.workflows ?? []), [data?.workflows]);

  // `/` focuses search (when not already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      e.preventDefault();
      setCollapsed(false);
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Roving list index for ↑/↓ + Enter (clamped at use, not in an effect).
  const [activeRaw, setActive] = useState(0);
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const active = Math.min(activeRaw, Math.max(0, workflows.length - 1));

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, workflows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const target = workflows[active];
      if (target) {
        e.preventDefault();
        void navigate({ to: "/workflows/$id", params: { id: target.id } });
      }
    }
  };
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className={cn("flex h-full flex-col", className)} data-testid="library-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((c) => !c)}
          className="w-7 px-0"
        >
          <PanelLeft />
        </Button>
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm font-semibold tracking-wide hover:bg-surface-2"
          aria-label="Home"
        >
          Home
        </Link>
        {!collapsed && (
          <span className="ml-auto text-xs font-normal text-ink-subtle">Workflows</span>
        )}
      </div>

      {!collapsed && (
        <div className="space-y-2 border-b border-border p-2">
          <div className="relative">
            <span
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
              aria-hidden
            >
              <Search />
            </span>
            <input
              ref={searchRef}
              data-testid="library-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  rowRefs.current[0]?.focus();
                }
              }}
              placeholder="Search workflows…  /"
              aria-label="Search workflows"
              className="h-8 w-full rounded-md border border-border bg-canvas pl-7 pr-2 text-sm outline-none placeholder:text-ink-subtle focus:border-accent"
            />
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChip(c.id)}
                aria-pressed={chip === c.id}
                data-testid={`chip-${c.id}`}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] leading-4",
                  chip === c.id
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-ink-muted hover:bg-surface-2",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            aria-label="New workflow"
            data-testid="library-new"
            onClick={() => createDialog.open("blank")}
            className="w-full"
          >
            <Plus /> New
          </Button>
        </div>
      )}
      {collapsed && (
        <div className="flex flex-col items-center gap-1 border-b border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Search workflows"
            onClick={() => {
              setCollapsed(false);
              searchRef.current?.focus();
            }}
            className="w-7 px-0"
          >
            <Search />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="New workflow"
            onClick={() => createDialog.open("blank")}
            className="w-7 px-0"
          >
            <Plus />
          </Button>
        </div>
      )}

      <nav
        aria-label="Workflow library"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        onKeyDown={onListKeyDown}
        data-testid="library-list"
        data-loading={isFetching || undefined}
      >
        {workflows.length === 0 && !collapsed && (
          <p className="px-2 py-4 text-center text-xs text-ink-subtle" data-testid="library-empty">
            {debounced ? "No workflows match." : "No workflows yet."}
          </p>
        )}
        <ul className="space-y-0.5">
          {workflows.map((w, i) => {
            const line = secondaryLine(w, now);
            const status = describeWorkflowStatus(w.status);
            const current = w.id === currentId;
            return (
              <li key={w.id}>
                <Link
                  to="/workflows/$id"
                  params={{ id: w.id }}
                  ref={(el: HTMLAnchorElement | null) => {
                    rowRefs.current[i] = el;
                  }}
                  data-testid={`library-row-${w.id}`}
                  aria-current={current ? "page" : undefined}
                  tabIndex={i === active ? 0 : -1}
                  onFocus={() => setActive(i)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    current
                      ? "bg-accent/10 text-ink"
                      : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                    i === active && !current && "bg-surface-2",
                  )}
                  title={collapsed ? w.name : undefined}
                >
                  <StatusDot tone={line.dot} />
                  {!collapsed && (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" data-testid="library-row-name">
                        {w.name}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">{line.text}</span>
                    </span>
                  )}
                  {!collapsed && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-subtle">
                      {status.label}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
