import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/shared/lib/cn";

// Tooltip ships its own provider so it can be used anywhere without setup.
export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  delayMs = 350,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayMs?: number;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayMs}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              "z-50 max-w-64 rounded-md border border-border bg-surface px-2 py-1",
              "text-xs text-ink shadow-md",
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border",
        "bg-surface-2 px-1 font-sans text-[0.6875rem] font-medium text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
