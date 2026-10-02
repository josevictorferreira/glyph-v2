// Build tab (spec 0018): the canvas plus the contextual right panel
// (workflow panel when nothing is selected, step editor when a step is).
// The panel is resizable (width remembered per browser) and collapses
// with “]”. Readiness deep links arrive through the editor chrome.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { WorkflowCanvas } from "@/features/canvas";
import { useWorkflow } from "@/features/workflows";
import { Panel, PanelGroup, PanelHandle, Skeleton } from "@/shared/ui";
import { isStepEditorTab, useEditorChrome, type StepEditorTab } from "./chrome";
import { StepEditor } from "./StepEditor";
import { WorkflowPanel } from "./WorkflowPanel";

const PANEL_STORAGE_KEY = "glyph.editor.panel";

export function BuildTab({
  workflowId,
  selectedStepId,
  onSelectStep,
}: {
  workflowId: string;
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
}) {
  const { data, isLoading } = useWorkflow(workflowId);
  const { focus } = useEditorChrome();
  const [tab, setTab] = useState<StepEditorTab>("instructions");
  const [appliedNonce, setAppliedNonce] = useState(0);
  // The shared text hovered in the workflow panel (spec 0023): the canvas
  // gives its steps a highlight ring.
  const [highlightTextId, setHighlightTextId] = useState<string | null>(null);
  const panelRef = useRef<PanelImperativeHandle>(null);

  // Deep links adjust the tab during render (React's adjust-state pattern);
  // selection and panel expansion happen in the effect below.
  let activeTab = tab;
  if (focus && focus.nonce !== appliedNonce) {
    setAppliedNonce(focus.nonce);
    if (focus.stepId && isStepEditorTab(focus.target)) {
      activeTab = focus.target;
      setTab(focus.target);
    }
  }

  // Remember the panel split between visits (spec: resizable, remembers width).
  const defaultLayout = useCallback((): Record<string, number> => {
    try {
      const raw = localStorage.getItem(PANEL_STORAGE_KEY);
      if (raw) return JSON.parse(raw) as Record<string, number>;
    } catch {
      localStorage.removeItem(PANEL_STORAGE_KEY);
    }
    return { "canvas-panel": 68, "editor-panel": 32 };
  }, []);
  const persistLayout = useCallback((layout: Record<string, number>) => {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout));
  }, []);

  // “]” toggles the contextual panel (ignored while typing).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "]") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      )
        return;
      const panel = panelRef.current;
      if (!panel) return;
      if (panel.isCollapsed()) panel.expand();
      else panel.collapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Deep links: select the entity, open the requested tab, pan the canvas.
  useEffect(() => {
    if (!focus?.stepId) return;
    panelRef.current?.expand();
    if (focus.stepId !== selectedStepId) onSelectStep(focus.stepId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per deep-link request
  }, [focus?.nonce]);

  if (isLoading || !data?.workflow) {
    return <Skeleton className="h-full w-full" />;
  }

  const workflow = data.workflow;
  const step = workflow.steps.find((s) => s.id === selectedStepId) ?? null;

  return (
    <PanelGroup
      orientation="horizontal"
      className="h-full"
      defaultLayout={defaultLayout()}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) persistLayout(meta.requestedLayout ?? layout);
      }}
    >
      <Panel id="canvas-panel" minSize="30%">
        <WorkflowCanvas
          mode="build"
          workflow={workflow}
          issues={data.issues}
          selectedStepId={selectedStepId}
          onSelectStep={onSelectStep}
          onOpenStep={onSelectStep}
          panToStepId={focus?.stepId}
          highlightTextId={highlightTextId}
        />
      </Panel>
      <PanelHandle />
      <Panel
        panelRef={panelRef}
        id="editor-panel"
        defaultSize="32%"
        minSize="20%"
        maxSize="55%"
        collapsible
        className="border-l border-border bg-surface"
      >
        {step ? (
          <StepEditor
            workflowId={workflowId}
            workflow={workflow}
            step={step}
            tab={activeTab}
            onTabChange={setTab}
            onSelectStep={onSelectStep}
            focus={focus}
          />
        ) : (
          <WorkflowPanel workflow={workflow} focus={focus} onHighlightText={setHighlightTextId} />
        )}
      </Panel>
    </PanelGroup>
  );
}
