import { useEffect, useState } from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cn } from "@/shared/lib/cn";
import { X } from "./icons";

// Imperative toaster: `toast("Saved")` from anywhere. The <Toaster /> is
// mounted once in app/providers.

export interface ToastInput {
  title: string;
  description?: string;
  tone?: "neutral" | "success" | "danger";
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

type Listener = (t: ToastInput) => void;
const listeners = new Set<Listener>();

export function toast(input: ToastInput | string): void {
  const t = typeof input === "string" ? { title: input } : input;
  for (const l of listeners) l(t);
}

export function Toaster() {
  const [items, setItems] = useState<(ToastInput & { key: number })[]>([]);

  useEffect(() => {
    const listener: Listener = (t) => {
      const key = Date.now() + Math.random();
      setItems((prev) => [...prev.slice(-4), { ...t, key }]);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.key}
          duration={item.durationMs ?? 5000}
          onOpenChange={(open) => {
            if (!open) setItems((prev) => prev.filter((i) => i.key !== item.key));
          }}
          className={cn(
            "pointer-events-auto flex w-80 items-start gap-3 rounded-lg border border-border",
            "bg-surface p-3 shadow-lg",
            item.tone === "success" && "border-status-succeeded/50",
            item.tone === "danger" && "border-status-failed/50",
          )}
        >
          <div className="flex-1">
            <ToastPrimitive.Title className="text-sm font-medium text-ink">
              {item.title}
            </ToastPrimitive.Title>
            {item.description && (
              <ToastPrimitive.Description className="mt-0.5 text-xs text-ink-muted">
                {item.description}
              </ToastPrimitive.Description>
            )}
            {item.action && (
              <button
                type="button"
                className="mt-1.5 text-xs font-medium text-accent hover:underline"
                onClick={() => {
                  item.action?.onClick();
                  setItems((prev) => prev.filter((i) => i.key !== item.key));
                }}
              >
                {item.action.label}
              </button>
            )}
          </div>
          <ToastPrimitive.Close
            aria-label="Dismiss"
            className="rounded p-0.5 text-ink-subtle hover:bg-surface-2 hover:text-ink"
          >
            <X size={14} />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
