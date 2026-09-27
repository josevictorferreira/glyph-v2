/**
 * WorkflowCanvas (spec 0017): the DAG editing surface (build mode) and the
 * read-only run lens. Build renders from the mutable workflow + issues; lens
 * renders from the run snapshot + step run summaries.
 *
 * All mutations go through useWorkflowMutation so the cached workflow
 * aggregate stays the single source of truth; node/edge arrays re-derive from
 * it (keyed by workflow updated_at), with local positions held while dragging.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
  type OnBeforeDelete,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { StepKind as StepKindEnum, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { RunSnapshot, StepRunSummary } from "@/gen/glyph/v1/run_pb";
import { useWorkflowMutation } from "@/features/workflows";
import { topologicalOrder, wouldCreateCycle, type EdgeLike } from "./lib/dag";
import { buildEdges, buildNodes, lensEdges, lensNodes, type StepNode } from "./lib/mapping";
import { StepCard } from "./StepCard";
import { CanvasEmptyState } from "./CanvasEmptyState";
import { tidyUp } from "./lib/layout";
import { toast } from "@/shared/ui/toast";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

const nodeTypes = { step: StepCard };

const CANVAS_MAX = { x: 4000, y: 3000 };

export interface SelectionProps {
  selectedStepId?: string | null;
  onSelectStep?: (stepId: string | null) => void;
  /** Enter / double-click on a card. */
  onOpenStep?: (stepId: string) => void;
}

export interface WorkflowCanvasBuildProps extends SelectionProps {
  mode: "build";
  workflow: Workflow;
  issues: readonly Issue[];
  onImportYaml?: () => void;
}

export interface WorkflowCanvasLensProps extends SelectionProps {
  mode: "lens";
  snapshot: RunSnapshot;
  stepRuns: readonly StepRunSummary[];
  firstFailedStepRunId?: string;
}

export type WorkflowCanvasProps = WorkflowCanvasBuildProps | WorkflowCanvasLensProps;

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      {props.mode === "build" ? <BuildCanvas {...props} /> : <LensCanvas {...props} />}
    </ReactFlowProvider>
  );
}

function LensCanvas({ snapshot, stepRuns, firstFailedStepRunId, ...selection }: WorkflowCanvasLensProps) {
  const nodes = useMemo(
    () => lensNodes(snapshot, stepRuns, firstFailedStepRunId),
    [snapshot, stepRuns, firstFailedStepRunId],
  );
  const edges = useMemo(() => lensEdges(snapshot, stepRuns), [snapshot, stepRuns]);

  return (
    <div className="glyph-canvas-wrapper h-full w-full" data-testid="canvas-lens">
      <ReactFlow<StepNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onSelectionChange={
          selection.onSelectStep ? (p: OnSelectionChangeParams) => selection.onSelectStep?.(singleSelection(p)) : undefined
        }
        onNodeDoubleClick={(_e, node) => selection.onOpenStep?.(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
      </ReactFlow>
    </div>
  );
}

/**
 * Node state derived from the cache (rebuild on `version` change), with local
 * dragging held out of the re-derivation and external selection applied as
 * node.selected flags.
 */
function useDerivedNodes(
  version: string,
  rebuild: () => StepNode[],
  selectedStepId: string | null | undefined,
  holdLocal: () => boolean,
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const rebuildRef = useRef(rebuild);
  useEffect(() => {
    rebuildRef.current = rebuild;
  });

  useEffect(() => {
    if (holdLocal()) return;
    setNodes(rebuildRef.current().map((n) => ({ ...n, selected: n.id === selectedStepId })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the cache stamp
  }, [version]);

  useEffect(() => {
    setNodes((ns) =>
      ns.some((n) => n.selected !== (n.id === selectedStepId))
        ? ns.map((n) => ({ ...n, selected: n.id === selectedStepId }))
        : ns,
    );
  }, [selectedStepId, setNodes]);

  return [nodes, setNodes, onNodesChange] as const;
}

function BuildCanvas({ workflow, issues, onImportYaml, ...selection }: WorkflowCanvasBuildProps) {
  const workflowId = workflow.summary?.id ?? "";
  const { selectedStepId, onSelectStep, onOpenStep } = selection;
  const [menu, setMenu] = useState<{ x: number; y: number; stepId?: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { screenToFlowPosition, fitView, setViewport, getViewport } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const interactingRef = useRef(false);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveTarget = useRef<{ stepId: string; x: number; y: number } | null>(null);
  const edgesRef = useRef<Edge[]>([]);

  // Mutations (cache-reconciling, per use-workflow-mutation).
  const addStep = useWorkflowMutation(WorkflowService.method.addStep, {
    onSucceeded: (res) => selection.onSelectStep?.(res.newStepId),
  });
  const duplicateStep = useWorkflowMutation(WorkflowService.method.duplicateStep, {
    onSucceeded: (res) => selection.onSelectStep?.(res.newStepId),
  });
  const deleteStep = useWorkflowMutation(WorkflowService.method.deleteStep);
  const createConnection = useWorkflowMutation(WorkflowService.method.createConnection);
  const connectOutputToStep = useWorkflowMutation(WorkflowService.method.connectOutputToStep);
  const removeConnection = useWorkflowMutation(WorkflowService.method.removeConnection);
  const moveStep = useWorkflowMutation(WorkflowService.method.moveStep, {
    optimistic: (wf, req) => ({
      ...wf,
      steps: wf.steps.map((s) =>
        s.id === req.stepId ? { ...s, canvasX: req.canvasX ?? 0, canvasY: req.canvasY ?? 0 } : s,
      ),
    }),
    onAppError: (error) => toast({ title: "Move failed", description: error.message, tone: "danger" }),
  });

  // Cache stamp: updatedAt has seconds granularity, so structural facts are
  // folded in to catch same-second mutations (connect adds an input+edge).
  const stepStamp = workflow.steps.map((s) => `${s.id}:${s.inputs.length}`).join("|");
  const connStamp = workflow.connections.map((c) => `${c.id}:${c.destinationInputId}`).join("|");
  const version = `${workflow.summary?.updatedAt?.seconds ?? 0}-${workflow.summary?.updatedAt?.nanos ?? 0}:${issues.length}#${stepStamp}#${connStamp}`;
  const [nodes, setNodes, onNodesChange] = useDerivedNodes(
    version,
    useCallback(() => buildNodes(workflow, issues), [workflow, issues]),
    selectedStepId,
    () => interactingRef.current,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    if (interactingRef.current) return;
    setEdges(buildEdges(workflow.connections));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the cache stamp
  }, [version]);

  // Viewport persistence (per workflow).
  const storageKey = `glyph.canvas.viewport.${workflowId}`;
  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      try {
        void setViewport(JSON.parse(raw) as { x: number; y: number; zoom: number });
        return;
      } catch {
        localStorage.removeItem(storageKey);
      }
    }
    void fitView({ padding: 0.2, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per workflow
  }, [workflowId]);

  const addAt = useCallback(
    (kind: StepKindEnum, flow?: { x: number; y: number }) => {
      const center = flow ?? centerOf(wrapperRef.current, screenToFlowPosition);
      const cascade = (workflow.steps.length % 5) * 24;
      const pos = clampPos(center.x + cascade, center.y + cascade);
      addStep.mutate({ workflowId, kind, canvasX: pos.x, canvasY: pos.y });
    },
    [addStep, screenToFlowPosition, workflow.steps.length, workflowId],
  );

  // ── Connections ──────────────────────────────────────────────────────────
  const isValidConnection = useCallback<IsValidConnection>(
    (c) => c.source !== c.target && !wouldCreateCycle(edgeLikes(edgesRef.current), c.source, c.target),
    [],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const sourceId = c.source;
      const inputId = c.targetHandle;
      if (!sourceId || !inputId) return;
      if (!isValidConnection(c)) {
        toast({ title: "Connection not allowed", description: "This would create a cycle.", tone: "danger" });
        return;
      }
      const existing = workflow.connections.find((conn) => conn.destinationInputId === inputId);
      const replacing = Boolean(existing && existing.sourceStepId !== sourceId);
      if (replacing && !window.confirm(`Replace connection from “${stepDisplayName(workflow, sourceId)}”?`)) return;
      createConnection.mutate({
        workflowId,
        sourceStepId: sourceId,
        destinationInputId: inputId,
        replaceExisting: replacing,
      });
    },
    [createConnection, isValidConnection, workflow, workflowId],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid) return; // completed on a handle → onConnect ran
      const sourceId = state.fromNode?.id ?? state.fromHandle?.nodeId;
      if (!sourceId) return;
      const point = "clientX" in event ? { x: event.clientX, y: event.clientY } : undefined;
      const el = point
        ? (document.elementFromPoint(point.x, point.y)?.closest(".react-flow__node") as HTMLElement | null)
        : null;
      const targetId = el?.dataset.id;
      if (!targetId || targetId === sourceId) return;
      if (wouldCreateCycle(edgeLikes(edgesRef.current), sourceId, targetId)) {
        toast({ title: "Connection not allowed", description: "This would create a cycle.", tone: "danger" });
        return;
      }
      connectOutputToStep.mutate({ workflowId, sourceStepId: sourceId, targetStepId: targetId });
    },
    [connectOutputToStep, workflowId],
  );

  // ── Deletion (confirm copies per spec) ───────────────────────────────────
  const onBeforeDelete = useCallback<OnBeforeDelete<StepNode>>(
    async ({ nodes: deletedNodes, edges: deletedEdges }) => {
      for (const e of deletedEdges) {
        const input = findInput(workflow, e.targetHandle ?? "");
        const ok = window.confirm(
          `This also removes input “${input?.name ?? e.targetHandle ?? "?"}” from ${stepDisplayName(workflow, e.target)}.`,
        );
        if (!ok) return false;
      }
      for (const n of deletedNodes) {
        const conns = workflow.connections.filter(
          (c) => c.sourceStepId === n.id || c.destinationStepId === n.id,
        ).length;
        const ok = window.confirm(
          conns > 0
            ? `Delete “${stepDisplayName(workflow, n.id)}”? This removes ${conns} connection${conns === 1 ? "" : "s"}.`
            : `Delete “${stepDisplayName(workflow, n.id)}”?`,
        );
        if (!ok) return false;
      }
      try {
        await Promise.all([
          ...deletedEdges.map((e) => removeConnection.mutateAsync({ workflowId, connectionId: e.id })),
          ...deletedNodes.map((n) => deleteStep.mutateAsync({ workflowId, stepId: n.id })),
        ]);
        if (deletedNodes.length > 0) selection.onSelectStep?.(null);
        return true;
      } catch {
        toast({ title: "Delete failed", tone: "danger" });
        return false;
      }
    },
    [deleteStep, removeConnection, selection, workflow, workflowId],
  );

  // ── Move (drag stop + debounced arrow keys) ─────────────────────────────
  const flushMove = useCallback(() => {
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = null;
    const target = moveTarget.current;
    if (target) {
      moveTarget.current = null;
      moveStep.mutate({ workflowId, stepId: target.stepId, canvasX: target.x, canvasY: target.y });
    }
  }, [moveStep, workflowId]);

  const onNodeDragStop = useCallback(
    (_e: unknown, node: StepNode) => {
      interactingRef.current = false;
      const pos = clampPos(node.position.x, node.position.y);
      moveStep.mutate({ workflowId, stepId: node.id, canvasX: pos.x, canvasY: pos.y });
    },
    [moveStep, workflowId],
  );

  const nudge = useCallback(
    (stepId: string, dx: number, dy: number) => {
      const node = nodes.find((n) => n.id === stepId);
      if (!node) return;
      interactingRef.current = true;
      const pos = clampPos(node.position.x + dx, node.position.y + dy);
      setNodes((ns) => ns.map((n) => (n.id === stepId ? { ...n, position: pos } : n)));
      moveTarget.current = { stepId, x: pos.x, y: pos.y };
      if (moveTimer.current) clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(() => {
        interactingRef.current = false;
        flushMove();
      }, 400);
    },
    [flushMove, nodes, setNodes],
  );

  // ── Tidy up (elkjs layered layout + undo toast) ─────────────────────────
  const onTidy = useCallback(async () => {
    const previous = workflow.steps.map((s) => ({ stepId: s.id, x: s.canvasX, y: s.canvasY }));
    const layout = await tidyUp(workflow);
    await Promise.all(
      layout.map((m) => moveStep.mutateAsync({ workflowId, stepId: m.stepId, canvasX: m.x, canvasY: m.y })),
    );
    toast({
      title: "Layout tidied",
      tone: "neutral",
      action: {
        label: "Undo",
        onClick: () => {
          void Promise.all(
            previous.map((p) =>
              moveStep.mutateAsync({ workflowId, stepId: p.stepId, canvasX: p.x, canvasY: p.y }),
            ),
          ).then(() => toast({ title: "Layout restored", tone: "neutral" }));
        },
      },
      durationMs: 8000,
    });
    void fitView({ padding: 0.2, duration: 250 });
  }, [fitView, moveStep, workflow, workflowId]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isTypingTarget(e.target)) return;
      const selected = nodes.find((n) => n.selected);
      if (e.key === "Escape") {
        setMenu(null);
        setAddOpen(false);
        onSelectStep?.(null);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        cycleSelection(nodes, edgesRef.current, e.shiftKey ? -1 : 1, onSelectStep);
        return;
      }
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void addAt(e.shiftKey ? StepKindEnum.HELPER : StepKindEnum.PI);
        return;
      }
      if (e.key.toLowerCase() === "d" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (selected) duplicateStep.mutate({ workflowId, stepId: selected.id });
        return;
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        void fitView({ padding: 0.2, duration: 200 });
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        void setViewport({ x: 0, y: 0, zoom: 1 });
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const arrow = arrows[e.key];
      if (arrow && selected) {
        e.preventDefault();
        const step = e.shiftKey ? 100 : 20;
        nudge(selected.id, arrow[0] * step, arrow[1] * step);
      }
    },
    [addAt, duplicateStep, fitView, nudge, nodes, onSelectStep, setViewport, workflowId],
  );

  // ── Context menu ────────────────────────────────────────────────────────
  const openMenu = (e: ReactMouseEvent | MouseEvent, stepId?: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, stepId });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const onPaneDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.classList.contains("react-flow__pane")) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addAt(StepKindEnum.PI, { x: pos.x - 120, y: pos.y - 30 });
    },
    [addAt, screenToFlowPosition],
  );

  const menuAction = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div
      ref={wrapperRef}
      className="glyph-canvas-wrapper relative h-full w-full outline-none"
      data-testid="canvas"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDoubleClick={onPaneDoubleClick}
    >
      <ReactFlow<StepNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onSelectionChange={onSelectStep ? (p: OnSelectionChangeParams) => onSelectStep(singleSelection(p)) : undefined}
        onNodeDoubleClick={(_e, node) => onOpenStep?.(node.id)}
        onNodeContextMenu={(e, node) => openMenu(e, node.id)}
        onPaneContextMenu={(e) => openMenu(e)}
        onNodeDragStart={() => (interactingRef.current = true)}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => onSelectStep?.(null)}
        onMoveEnd={() => localStorage.setItem(storageKey, JSON.stringify(getViewport()))}
        connectionLineType={ConnectionLineType.Bezier}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
      </ReactFlow>

      {workflow.steps.length === 0 && <CanvasEmptyState onAddStep={addAt} onImportYaml={onImportYaml} />}

      {/* Toolbar */}
      <div className="glyph-canvas-toolbar absolute left-2 top-2 z-10 flex items-center gap-1 p-1" data-testid="canvas-toolbar">
        <div className="relative">
          <Button size="sm" variant="secondary" data-testid="canvas-add-step" onClick={() => setAddOpen((v) => !v)}>
            + Step
          </Button>
          {addOpen && (
            <div
              className="absolute left-0 top-9 z-20 w-40 rounded-card border border-border bg-surface p-1 shadow-md"
              data-testid="canvas-add-menu"
              role="menu"
            >
              <MenuItem onClick={() => (setAddOpen(false), void addAt(StepKindEnum.PI))}>Add Pi step</MenuItem>
              <MenuItem onClick={() => (setAddOpen(false), void addAt(StepKindEnum.HELPER))}>Add helper step</MenuItem>
            </div>
          )}
        </div>
        <Button size="sm" variant="secondary" data-testid="canvas-tidy" onClick={() => void onTidy()}>
          Tidy up
        </Button>
      </div>

      {/* Context menu */}
      {menu && (
        <div
          data-testid="canvas-context-menu"
          className="fixed z-30 w-44 rounded-card border border-border bg-surface p-1 shadow-md"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          {menu.stepId ? (
            <>
              <MenuItem onClick={menuAction(() => onOpenStep?.(menu.stepId!))}>Open step</MenuItem>
              <MenuItem
                onClick={menuAction(() => duplicateStep.mutate({ workflowId, stepId: menu.stepId! }))}
              >
                Duplicate step
              </MenuItem>
              <MenuItem
                danger
                onClick={menuAction(() => {
                  const stepId = menu.stepId!;
                  const conns = workflow.connections.filter(
                    (c) => c.sourceStepId === stepId || c.destinationStepId === stepId,
                  ).length;
                  const message =
                    conns > 0
                      ? `Delete “${stepDisplayName(workflow, stepId)}”? This removes ${conns} connection${conns === 1 ? "" : "s"}.`
                      : `Delete “${stepDisplayName(workflow, stepId)}”?`;
                  if (window.confirm(message)) {
                    deleteStep.mutate({ workflowId, stepId });
                    onSelectStep?.(null);
                  }
                })}
              >
                Delete step
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void addAt(StepKindEnum.PI);
                }}
              >
                Add Pi step
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void addAt(StepKindEnum.HELPER);
                }}
              >
                Add helper step
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void onTidy();
                }}
              >
                Tidy up
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "glyph-canvas-menu-item rounded px-2 py-1.5 text-xs hover:bg-surface-2",
        danger ? "text-status-failed" : "text-ink",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function stepDisplayName(workflow: Workflow, stepId: string): string {
  const step = workflow.steps.find((s) => s.id === stepId);
  return step?.name.trim() || "Untitled step";
}

function findInput(workflow: Workflow, inputId: string) {
  for (const s of workflow.steps) {
    const input = s.inputs.find((i) => i.id === inputId);
    if (input) return input;
  }
  return null;
}

function edgeLikes(edges: readonly Edge[]): EdgeLike[] {
  return edges.map((e) => ({ source: e.source, target: e.target }));
}

function clampPos(x: number, y: number) {
  return {
    x: Math.max(0, Math.min(CANVAS_MAX.x, Math.round(x))),
    y: Math.max(0, Math.min(CANVAS_MAX.y, Math.round(y))),
  };
}

function singleSelection(p: OnSelectionChangeParams): string | null {
  return p.nodes.length === 1 ? (p.nodes[0]?.id ?? null) : null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable
  );
}

function cycleSelection(nodes: StepNode[], edges: Edge[], direction: 1 | -1, onSelect?: (id: string | null) => void) {
  if (!onSelect || nodes.length === 0) return;
  const order = topologicalOrder(
    nodes.map((n) => n.id),
    edgeLikes(edges),
  );
  const current = nodes.find((n) => n.selected)?.id;
  const index = current ? order.indexOf(current) : -1;
  const next = order[(index + direction + order.length) % order.length];
  onSelect(next ?? null);
}

function centerOf(
  wrapper: HTMLDivElement | null,
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number },
) {
  if (!wrapper) return { x: 200, y: 150 };
  const rect = wrapper.getBoundingClientRect();
  return screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
}

function miniMapNodeColor(node: StepNode): string {
  switch (node.data.status) {
    case StepRunStatus.SUCCEEDED:
      return "var(--c-succeeded)";
    case StepRunStatus.FAILED:
      return "var(--c-failed)";
    case StepRunStatus.RUNNING:
      return "var(--c-running)";
    default:
      return "var(--c-border-strong)";
  }
}
