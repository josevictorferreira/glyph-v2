// Model & tool pickers (spec 0018). Presentational over the catalog
// queries: callers own saving (UpdateStepModel / ToggleStepTool).
import type { AvailableModel, ToolDefinition } from "@/gen/glyph/v1/catalog_pb";
import { Badge, Button, Checkbox, Combobox, Skeleton, type ComboboxItem } from "@/shared/ui";
import { useModels, useRefreshModels, useTools } from "./hooks";

/** A step's model id is "{provider}/{model_id}"; legacy bare ids match model_id. */
export function findModel(
  models: readonly AvailableModel[],
  id: string,
): AvailableModel | undefined {
  return models.find((m) => m.fullId === id) ?? models.find((m) => m.modelId === id);
}

export function modelCapabilities(model: AvailableModel | undefined): string[] {
  return Object.entries(model?.capabilities ?? {})
    .filter(([, on]) => on)
    .map(([key]) => key)
    .sort();
}

export function ModelPicker({
  value,
  onChange,
  field,
}: {
  value: string;
  onChange: (fullId: string) => void;
  /** data-editor-field for readiness deep links. */
  field?: string;
}) {
  const { data, isLoading } = useModels(true);
  const refresh = useRefreshModels();
  if (isLoading) return <Skeleton className="h-8 w-full" />;

  const models = data?.models ?? [];
  const current = value ? findModel(models, value) : undefined;
  const items: ComboboxItem[] = models.map((m) => ({
    value: m.fullId,
    label: m.displayName || m.modelId,
    group: m.available ? m.provider : "Unavailable",
    hint: modelCapabilities(m).join(" · ") || undefined,
  }));
  // The current selection stays visible even when the catalog dropped it;
  // the validator's model_id issue renders next to the picker.
  if (value && !current) items.push({ value, label: value, group: "Unavailable" });

  return (
    <div className="flex flex-col gap-1.5">
      <Combobox
        ariaLabel="Model"
        triggerProps={field ? { "data-editor-field": field } : undefined}
        items={items}
        value={current?.fullId ?? (value || null)}
        onValueChange={onChange}
        placeholder="Choose a model"
        searchPlaceholder="Search models…"
      />
      {current && modelCapabilities(current).length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Capabilities">
          {modelCapabilities(current).map((cap) => (
            <Badge key={cap} tone="muted">
              {cap}
            </Badge>
          ))}
        </div>
      )}
      {data?.stale && (
        <p className="flex items-center gap-1 text-xs text-ink-subtle">
          Catalog may be out of date ·
          <Button
            variant="ghost"
            size="sm"
            loading={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            Refresh
          </Button>
        </p>
      )}
    </div>
  );
}

export function ToolChecklist({
  enabledKeys,
  onToggle,
  disabled,
}: {
  enabledKeys: readonly string[];
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  const { data, isLoading } = useTools();
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  const tools = data?.tools ?? [];
  // Keys enabled on the step but missing from the catalog stay listed so they can be removed.
  const orphaned = enabledKeys.filter((key) => !tools.some((t) => t.key === key));

  return (
    <div className="flex flex-col gap-2">
      {tools.length === 0 && orphaned.length === 0 && (
        <p className="text-xs text-ink-subtle">No tools are available.</p>
      )}
      {tools.map((tool) => (
        <ToolRow
          key={tool.key}
          tool={tool}
          checked={enabledKeys.includes(tool.key)}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
      {orphaned.map((key) => (
        <ToolRow
          key={key}
          tool={{ key, displayName: key, description: "Not available." }}
          checked
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function ToolRow({
  tool,
  checked,
  onToggle,
  disabled,
}: {
  tool: Pick<ToolDefinition, "key" | "displayName" | "description">;
  checked: boolean;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  const id = `tool-${tool.key}`;
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={() => onToggle(tool.key)}
        className="mt-0.5"
      />
      <label htmlFor={id} className="flex flex-col text-sm">
        <span className="font-medium text-ink">{tool.displayName || tool.key}</span>
        {tool.description && <span className="text-xs text-ink-subtle">{tool.description}</span>}
      </label>
    </div>
  );
}
