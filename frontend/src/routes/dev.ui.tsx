import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useTransport } from "@connectrpc/connect-query";
import { createClient } from "@connectrpc/connect";
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuTrigger,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  Disclosure,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
  Duration,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Panel,
  PanelGroup,
  PanelHandle,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  RelativeTime,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  Skeleton,
  StepRunStatusBadge,
  RunStatusBadge,
  WorkflowStatusBadge,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  toast,
} from "@/shared/ui";
import { useTheme } from "@/app/theme";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";
import { LiveService } from "@/gen/glyph/v1/live_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { EventType } from "@/gen/glyph/v1/live_pb";

export const Route = createFileRoute("/dev/ui")({
  component: import.meta.env.PROD ? DevNotFound : DevPage,
});

function DevNotFound() {
  return <div className="p-6 text-sm text-ink-muted">The /dev page is only available in development.</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-5 last:border-b-0">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}

function DevPage() {
  const { theme, toggle } = useTheme();

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
        <h1 className="text-sm font-semibold">UI showcase (dev only)</h1>
        <Button size="sm" onClick={toggle}>
          Theme: {theme}
        </Button>
      </div>

      <Section title="Buttons / Kbd">
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button loading>Saving</Button>
        <Button size="sm">Small</Button>
        <IconButton label="Add" variant="secondary">＋</IconButton>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </Section>

      <Section title="Inputs">
        <Field label="Name" hint="The workflow name" className="w-56">
          <Input placeholder="Untitled workflow" />
        </Field>
        <Field label="Prompt" className="w-72">
          <Textarea mono placeholder="Summarize {{topic}}…" />
        </Field>
        <Select
          ariaLabel="Model"
          className="w-48"
          placeholder="Pick a model"
          items={[
            { value: "a", label: "Anthropic/claude" },
            { value: "b", label: "OpenAI/gpt" },
          ]}
        />
        <Combobox
          ariaLabel="Timezone"
          className="w-48"
          placeholder="Timezone…"
          items={[
            { value: "sp", label: "America/Sao_Paulo", group: "America" },
            { value: "ny", label: "America/New_York", group: "America" },
            { value: "ln", label: "Europe/London", group: "Europe" },
          ]}
          onValueChange={() => {}}
        />
        <Switch label="Fail fast" checked onCheckedChange={() => {}} />
        <Checkbox checked onCheckedChange={() => {}} />
      </Section>

      <Section title="Tabs / Tooltip / Popover">
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent value="one" className="pt-2 text-sm text-ink-muted">First tab</TabsContent>
          <TabsContent value="two" className="pt-2 text-sm text-ink-muted">Second tab</TabsContent>
        </Tabs>
        <Tooltip content="A helpful tooltip">
          <Button variant="ghost">Hover me</Button>
        </Tooltip>
        <PopoverRoot>
          <PopoverTrigger asChild>
            <Button>Popover</Button>
          </PopoverTrigger>
          <PopoverContent className="p-3 text-sm">Popover content</PopoverContent>
        </PopoverRoot>
      </Section>

      <Section title="Menus">
        <Dropdown>
          <DropdownTrigger asChild>
            <Button>Dropdown</Button>
          </DropdownTrigger>
          <DropdownContent>
            <DropdownLabel>Actions</DropdownLabel>
            <DropdownItem>Rename</DropdownItem>
            <DropdownItem>Duplicate</DropdownItem>
            <DropdownSeparator />
            <DropdownItem className="text-status-failed">Delete</DropdownItem>
          </DropdownContent>
        </Dropdown>
        <ContextMenuRoot>
          <ContextMenuTrigger asChild>
            <div className="grid h-16 w-40 place-items-center rounded-md border border-dashed border-border text-xs text-ink-muted">
              Right-click me
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Add Pi step</ContextMenuItem>
            <ContextMenuItem>Add helper step</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuRoot>
      </Section>

      <Section title="Dialogs / Sheets / Disclosure">
        <Dialog>
          <DialogTrigger asChild>
            <Button>Dialog</Button>
          </DialogTrigger>
          <DialogContent title="Confirm" description="A dialog with a description.">
            <p className="text-sm text-ink-muted">Body copy</p>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button variant="primary">Confirm</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild>
            <Button>Sheet</Button>
          </SheetTrigger>
          <SheetContent title="Side panel" description="Used for the schedule composer.">
            <p className="text-sm text-ink-muted">Sheet body</p>
          </SheetContent>
        </Sheet>
        <Disclosure title="Fixed values" defaultOpen>
          <p className="py-1 text-sm text-ink-muted">Collapsed content</p>
        </Disclosure>
      </Section>

      <Section title="Badges / Status">
        <Badge>neutral</Badge>
        <Badge tone="accent">accent</Badge>
        <Badge tone="success">success</Badge>
        <Badge tone="danger">danger</Badge>
        <Badge tone="warning">warning</Badge>
        <WorkflowStatusBadge status={1} />
        <WorkflowStatusBadge status={2} />
        <WorkflowStatusBadge status={3} />
        <WorkflowStatusBadge status={4} />
        <RunStatusBadge status={1} />
        <RunStatusBadge status={2} />
        <RunStatusBadge status={3} />
        <RunStatusBadge status={4} />
        <RunStatusBadge status={5} />
        <StepRunStatusBadge status={5} />
        <StepRunStatusBadge status={6} />
        <StepRunStatusBadge status={0} />
      </Section>

      <Section title="Feedback / Time">
        <Button onClick={() => toast("Saved")}>Toast</Button>
        <Button onClick={() => toast({ title: "Run failed", tone: "danger", description: "Step Research failed." })}>
          Danger toast
        </Button>
        <Button onClick={() => toast({ title: "Run started", action: { label: "View run", onClick: () => {} } })}>
          Toast with action
        </Button>
        <CopyButton value="copied text" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
        <span className="text-sm"><RelativeTime date={twelveMinAgo} /></span>
        <span className="text-sm"><Duration ms={134_000} /></span>
        <span className="text-sm"><Duration from={aboutAMinuteAgo} live /></span>
      </Section>

      <Section title="Empty / Resizable">
        <EmptyState className="w-64" title="No workflows yet" description="Create one to get started." />
        <div className="h-24 w-96 overflow-hidden rounded-md border border-border">
          <PanelGroup orientation="horizontal" className="h-full">
            <Panel defaultSize={50} className="grid place-items-center text-xs text-ink-subtle">One</Panel>
            <PanelHandle />
            <Panel defaultSize={50} className="grid place-items-center text-xs text-ink-subtle">Two</Panel>
          </PanelGroup>
        </div>
      </Section>

      <ApiSection />
    </div>
  );
}

/** Live API checks through the Vite proxy: ListTools + WatchWorkflow. */

// Module-scope demo timestamps (impure calls are not allowed during render).
const twelveMinAgo = new Date(Date.now() - 12 * 60_000);
const aboutAMinuteAgo = new Date(Date.now() - 65_000);

function ApiSection() {
  const tools = useQuery(CatalogService.method.listTools, {});
  const workflows = useQuery(WorkflowService.method.listWorkflows, { limit: 1 });
  const workflowId = workflows.data?.workflows[0]?.id;
  const [events, setEvents] = useState<{ type: EventType; at: Date }[]>([]);
  const live = createClient(LiveService, useTransport());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    const abort = new AbortController();
    abortRef.current = abort;
    (async () => {
      try {
        for await (const res of live.watchWorkflow({ workflowId }, { signal: abort.signal })) {
          setEvents((prev) => [...prev.slice(-9), { type: res.event?.type ?? EventType.UNSPECIFIED, at: new Date() }]);
        }
      } catch {
        /* stream ended or aborted */
      }
    })();
    return () => abort.abort();
  }, [live, workflowId]);

  const heartbeats = events.filter((e) => e.type === EventType.HEARTBEAT).length;

  return (
    <Section title="API through the dev proxy">
      <div className="text-sm">
        <p>
          Tools:{" "}
          {tools.isPending ? (
            <Skeleton className="inline-block h-4 w-16 align-middle" />
          ) : tools.isError ? (
            <span className="text-status-failed">error: {String(tools.error.message)}</span>
          ) : (
            <strong data-testid="tool-count">{tools.data.tools.length}</strong>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          Live stream {workflowId ? `on ${workflowId.slice(0, 8)}…` : "(no workflow — run `nix run .#seed`)"}
        </p>
        <p className="text-xs">
          Events: <strong data-testid="event-count">{events.length}</strong> · Heartbeats:{" "}
          <strong data-testid="heartbeat-count">{heartbeats}</strong>
        </p>
        <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-[0.6875rem] text-ink-muted">
          {events.map((e, i) => (
            <li key={i}>
              {e.at.toLocaleTimeString()} {EventType[e.type] ?? e.type}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
