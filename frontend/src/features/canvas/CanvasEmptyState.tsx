/** Empty-canvas CTA (spec 0017 §Empty state). */
import { Button } from "@/shared/ui/button";

export interface CanvasEmptyStateProps {
  onAddStep: (kind: 1 | 2) => void;
  onImportYaml?: () => void;
}

export function CanvasEmptyState({ onAddStep, onImportYaml }: CanvasEmptyStateProps) {
  return (
    <div
      data-testid="canvas-empty"
      className="pointer-events-auto absolute inset-0 grid place-items-center"
    >
      <div className="max-w-xs rounded-card border border-border bg-surface p-4 text-center shadow-sm">
        <p className="text-sm font-medium">Design your workflow</p>
        <p className="mt-1 text-xs text-ink-muted">
          Add your first step, then wire steps together. Double-click the canvas, press A, or
          right-click for options.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" onClick={() => onAddStep(1)} data-testid="canvas-empty-add">
            Add Pi step
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onAddStep(2)}>
            Add helper step
          </Button>
        </div>
        {onImportYaml && (
          <button
            type="button"
            onClick={onImportYaml}
            className="mt-2 text-xs text-accent underline-offset-2 hover:underline"
          >
            Import a definition instead
          </button>
        )}
      </div>
    </div>
  );
}
