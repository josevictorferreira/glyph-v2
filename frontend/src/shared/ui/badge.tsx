import { cn } from "@/shared/lib/cn";
import type { Tone } from "@/shared/api/enums";
import {
  describeRunStatus,
  describeStepRunStatus,
  describeWorkflowStatus,
  type EnumView,
} from "@/shared/api/enums";
import { RunStatus, StepRunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";

// ---------------------------------------------------------------------------
// Badge: generic label chip.
// ---------------------------------------------------------------------------
export type BadgeTone = "neutral" | "muted" | "accent" | "success" | "danger" | "warning";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-border bg-surface-2 text-ink-muted",
  muted: "border-transparent bg-surface-3 text-ink-muted",
  accent: "border-accent/30 bg-accent-soft text-accent",
  success: "border-status-succeeded/30 bg-status-succeeded/10 text-status-succeeded",
  danger: "border-status-failed/30 bg-status-failed/10 text-status-failed",
  warning: "border-status-paused/30 bg-status-paused/10 text-status-paused",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2",
        "text-[0.6875rem] font-medium leading-none",
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// StatusDot / StatusBadge: the one shared status vocabulary (spec 0014).
// ---------------------------------------------------------------------------
const toneDotColors: Record<Tone, string> = {
  neutral: "bg-status-queued",
  muted: "bg-status-cancelled",
  accent: "bg-status-running",
  success: "bg-status-succeeded",
  danger: "bg-status-failed",
  warning: "bg-status-paused",
  striped: "status-stripes bg-status-skipped text-status-skipped",
};

const toneBadge: Record<Tone, BadgeTone> = {
  neutral: "neutral",
  muted: "muted",
  accent: "accent",
  success: "success",
  danger: "danger",
  warning: "warning",
  striped: "muted",
};

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        toneDotColors[tone],
        pulse && tone === "accent" && "animate-status-running",
        className,
      )}
    />
  );
}

export function StatusBadge({ view, className }: { view: EnumView; className?: string }) {
  return (
    <Badge tone={toneBadge[view.tone]} className={className}>
      {view.tone === "accent" && <StatusDot tone="accent" pulse />}
      {view.tone === "striped" && <StatusDot tone="striped" />}
      {view.label}
    </Badge>
  );
}

export function WorkflowStatusBadge({
  status,
  className,
}: {
  status: WorkflowStatus;
  className?: string;
}) {
  return <StatusBadge view={describeWorkflowStatus(status)} className={className} />;
}

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return <StatusBadge view={describeRunStatus(status)} className={className} />;
}

export function StepRunStatusBadge({
  status,
  className,
}: {
  status: StepRunStatus;
  className?: string;
}) {
  return <StatusBadge view={describeStepRunStatus(status)} className={className} />;
}
