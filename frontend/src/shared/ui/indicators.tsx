// Header indicators (spec 0015): SaveIndicator aggregates autosave state,
// ConnectionIndicator shows the WatchWorkflow connection. Both are
// presentational; features/live owns the wiring.
import { cn } from "@/shared/lib/cn";
import { Badge, StatusDot, type BadgeTone } from "./badge";
import type { Tone } from "@/shared/api/enums";
import type { AutosaveStatus } from "@/shared/lib/autosave";
import type { LiveStatus } from "@/shared/api/live";
import { formatRelative } from "@/shared/lib/time";

interface IndicatorView {
  label: string;
  dot: Tone;
  badge: BadgeTone;
  pulse: boolean;
}

// ---------------------------------------------------------------------------
const saveViews: Record<AutosaveStatus, IndicatorView> = {
  idle: { label: "Saved", dot: "muted", badge: "muted", pulse: false },
  dirty: { label: "Unsaved changes", dot: "warning", badge: "warning", pulse: false },
  saving: { label: "Saving…", dot: "accent", badge: "accent", pulse: true },
  saved: { label: "Saved", dot: "success", badge: "success", pulse: false },
  error: { label: "Save failed", dot: "danger", badge: "danger", pulse: false },
};

export function SaveIndicator({
  status,
  onRetry,
  className,
}: {
  status: AutosaveStatus;
  onRetry?: () => void;
  className?: string;
}) {
  const view = saveViews[status];
  return (
    <Badge tone={view.badge} className={cn("gap-1.5", className)} data-testid="save-indicator">
      <StatusDot tone={view.dot} pulse={view.pulse} />
      {view.label}
      {status === "error" && onRetry && (
        <button
          type="button"
          className="ml-0.5 rounded font-semibold text-status-failed underline decoration-dotted hover:text-ink"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
const connectionViews: Record<LiveStatus, IndicatorView> = {
  connecting: { label: "Connecting…", dot: "warning", badge: "warning", pulse: true },
  connected: { label: "Live", dot: "success", badge: "success", pulse: false },
  reconnecting: { label: "Reconnecting…", dot: "warning", badge: "warning", pulse: true },
  offline: { label: "Offline", dot: "danger", badge: "danger", pulse: false },
};

export function ConnectionIndicator({
  status,
  lastEventAt,
  className,
}: {
  status: LiveStatus;
  /** Epoch ms of the last received event; shown as a tooltip when not connected. */
  lastEventAt?: number;
  className?: string;
}) {
  const view = connectionViews[status];
  const title =
    lastEventAt !== undefined && status !== "connected"
      ? `${view.label} · last event ${formatRelative(new Date(lastEventAt))}`
      : view.label;
  return (
    <Badge
      tone={view.badge}
      className={cn("gap-1.5", className)}
      title={title}
      data-testid="connection-indicator"
    >
      <StatusDot tone={view.dot} pulse={view.pulse} />
      {view.label}
    </Badge>
  );
}
