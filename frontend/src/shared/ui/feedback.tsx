import { useState } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "@/shared/lib/cn";
import { ChevronRight } from "./icons";
import { CheckIcon } from "./select";
import { toast } from "./toast";

// ---------------------------------------------------------------------------
export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed",
        "border-border px-6 py-10 text-center",
        className,
      )}
    >
      {icon && <div className="text-ink-subtle">{icon}</div>}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="max-w-sm text-xs text-ink-muted">{description}</p>}
      {actions && <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-surface-3", className)} {...props} />;
}

// ---------------------------------------------------------------------------
export function Disclosure({
  title,
  defaultOpen = false,
  children,
  right,
  className,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("group", className)}>
      <div className="flex items-center justify-between gap-2">
        <Collapsible.Trigger className="flex flex-1 items-center gap-1.5 rounded py-1 text-left text-sm font-medium text-ink hover:bg-surface-2">
          <ChevronRight
            size={14}
            className="text-ink-subtle transition-transform group-data-[state=open]:rotate-90"
          />
          {title}
        </Collapsible.Trigger>
        {right}
      </div>
      <Collapsible.Content className="pl-5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

// ---------------------------------------------------------------------------
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface",
        "px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink",
        className,
      )}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions or insecure context) — inform user (fixes.md #14)
          toast({ title: "Copy failed", tone: "danger" });
        }
      }}
    >
      {copied ? <CheckIcon /> : null}
      {copied ? "Copied" : label}
    </button>
  );
}
