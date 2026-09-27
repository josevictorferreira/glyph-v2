/**
 * Tidy up (spec 0017): elkjs layered layout, left→right, snapped to the
 * canvas grid (20px). Heights are estimated from the rendered card shape
 * (fixed width 240 + ~20px per input row).
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";

const NODE_WIDTH = 240;
const NODE_BASE_HEIGHT = 88;
const PER_INPUT = 20;
const GRID = 20;

const elk = new ELK();

export interface LayoutPosition {
  stepId: string;
  x: number;
  y: number;
}

function estimateHeight(step: Workflow["steps"][number]): number {
  return NODE_BASE_HEIGHT + step.inputs.length * PER_INPUT;
}

export async function tidyUp(workflow: Workflow): Promise<LayoutPosition[]> {
  if (workflow.steps.length === 0) return [];
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    },
    children: workflow.steps.map((s) => ({
      id: s.id,
      width: NODE_WIDTH,
      height: estimateHeight(s),
    })),
    edges: workflow.connections.map((c) => ({
      id: c.id,
      sources: [c.sourceStepId],
      targets: [c.destinationStepId],
    })),
  };
  const result = await elk.layout(graph);
  return (result.children ?? []).map((child) => ({
    stepId: child.id,
    x: snap((child.x ?? 0)),
    y: snap(child.y ?? 0),
  }));
}

function snap(value: number): number {
  return Math.max(0, Math.round(value / GRID) * GRID);
}
