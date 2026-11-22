// RareUI-inspired navigation demos (rareui.com) — reimplemented on the Glyph design system.
import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Button } from "@/shared/ui";
import { FileText, Play } from "@/shared/ui/icons";
import type { DemoEntry } from "./frame";
import { BounceSidebar } from "../bounce-sidebar";
import { HookSidebar } from "../hook-sidebar";
import { ProximitySidebar } from "../proximity-sidebar";
import { ScrollProgress } from "../scroll-progress";
import { RailToc } from "../rail-toc";
import { GooeyNav } from "../gooey-nav";

/** Fixed-height scrollable container with tall sections to drive scroll demos. */
function ScrollStage({
  containerRef,
  sections,
  children,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  sections: { id: string; label: string; kind?: "title" | "subtitle" | "section" | "body" }[];
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full items-stretch gap-3">
      <div
        ref={containerRef}
        className="h-56 flex-1 overflow-y-auto rounded-card border border-border bg-surface p-4"
      >
        {sections.map((s) => (
          <section key={s.id} id={s.id} className="mb-6">
            <h4 className="text-sm font-semibold text-ink">{s.label}</h4>
            <p className="mt-1 text-sm text-ink-muted">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
              incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
              exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
            </p>
          </section>
        ))}
      </div>
      {children}
    </div>
  );
}

function BounceSidebarDemo() {
  const [value, setValue] = useState(0);
  return (
    <div className="flex items-start gap-4">
      <BounceSidebar
        className="w-44 rounded-card border border-border bg-surface p-2"
        items={[
          { label: "Workspace", heading: true },
          "Overview",
          "Workflows",
          "Runs",
          { label: "Settings", heading: true },
          "Schedules",
          "Providers",
        ]}
        value={value}
        onChange={setValue}
      />
      <div className="flex flex-col gap-2 text-xs text-ink-muted">
        <span>Active index: {value}</span>
        <Button size="sm" onClick={() => setValue((v) => Math.max(v - 1, 0))}>
          Prev
        </Button>
        <Button size="sm" onClick={() => setValue((v) => Math.min(v + 1, 4))}>
          Next
        </Button>
      </div>
    </div>
  );
}

function HookSidebarDemo() {
  const [value, setValue] = useState(1);
  return (
    <HookSidebar
      className="w-44 rounded-card border border-border bg-surface p-3"
      label="Run details"
      items={["Summary", "Steps", "Logs", "Artifacts"]}
      value={value}
      onChange={setValue}
    />
  );
}

function ProximitySidebarDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sections: { id: string; label: string; kind?: "title" | "section" | "body" }[] = [
    { id: "px-intro", label: "Introduction", kind: "title" },
    { id: "px-model", label: "Workflow model", kind: "section" },
    { id: "px-runs", label: "Runs and evidence", kind: "section" },
    { id: "px-notes", label: "Notes", kind: "body" },
  ];
  return (
    <ScrollStage containerRef={containerRef} sections={sections}>
      <ProximitySidebar
        containerRef={containerRef}
        className="rounded-card border border-border bg-surface px-2"
        sections={sections}
      />
    </ScrollStage>
  );
}

function ScrollProgressDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sections = [
    { id: "sp-one", label: "Getting started" },
    { id: "sp-two", label: "Building workflows" },
    { id: "sp-three", label: "Scheduling runs" },
    { id: "sp-four", label: "Auditing results" },
  ];
  return (
    <ScrollStage containerRef={containerRef} sections={sections}>
      <div className="flex items-start pt-2">
        <ScrollProgress containerRef={containerRef} sections={sections} />
      </div>
    </ScrollStage>
  );
}

function RailTocDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const items = [
    { id: "rt-one", label: "Overview", depth: 0 },
    { id: "rt-two", label: "Step inputs", depth: 1 },
    { id: "rt-three", label: "Connections", depth: 1 },
    { id: "rt-four", label: "Scheduling", depth: 0 },
  ];
  return (
    <ScrollStage containerRef={containerRef} sections={items}>
      <RailToc containerRef={containerRef} items={items} />
    </ScrollStage>
  );
}

function GooeyNavDemo() {
  const [value, setValue] = useState(0);
  const [size, setSize] = useState<"xs" | "sm" | "md" | "lg">("md");
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <GooeyNav
        value={value}
        onChange={setValue}
        size={size}
        items={[
          { label: "Overview", icon: <FileText /> },
          { label: "Steps", icon: <Play /> },
          "Runs",
          "History",
        ]}
      />
      <div className="flex items-center gap-2">
        {(["xs", "sm", "md", "lg"] as const).map((s) => (
          <Button key={s} size="sm" variant={s === size ? "primary" : "secondary"} onClick={() => setSize(s)}>
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

export const navigationDemos: DemoEntry[] = [
  {
    id: "bounce-sidebar",
    title: "Bounce Sidebar",
    description: "A dot marker springs bouncily between items; headings are skipped.",
    wide: true,
    element: <BounceSidebarDemo />,
  },
  {
    id: "hook-sidebar",
    title: "Hook Sidebar",
    description: "A dashed rail with a colored hook segment marking the active item.",
    wide: true,
    element: <HookSidebarDemo />,
  },
  {
    id: "proximity-sidebar",
    title: "Proximity Sidebar",
    description: "Document minimap: dashes expand near the pointer; the active section highlights.",
    wide: true,
    element: <ProximitySidebarDemo />,
  },
  {
    id: "scroll-progress",
    title: "Scroll Progress",
    description: "Progress pill that expands into a section menu.",
    wide: true,
    element: <ScrollProgressDemo />,
  },
  {
    id: "rail-toc",
    title: "Rail Toc",
    description: "Bent rail with a paper plane that springs to the active heading.",
    wide: true,
    element: <RailTocDemo />,
  },
  {
    id: "gooey-nav",
    title: "Gooey Nav",
    description: "Segmented nav whose active tile is lifted out with gooey gaps.",
    wide: true,
    element: <GooeyNavDemo />,
  },
];
