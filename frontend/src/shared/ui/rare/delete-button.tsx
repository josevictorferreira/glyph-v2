// RareUI-inspired DeleteButton (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Check, Trash, X } from "@/shared/ui/icons";

export interface DeleteButtonProps {
  onConfirm?: () => void;
  onCancel?: () => void;
  className?: string;
}

export function DeleteButton({ onConfirm, onCancel, className }: DeleteButtonProps) {
  const reducedMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const cancel = useCallback(() => {
    setExpanded(false);
    onCancel?.();
  }, [onCancel]);

  const confirm = useCallback(() => {
    setExpanded(false);
    onConfirm?.();
  }, [onConfirm]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, expanded]);

  const transition = reducedMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 460, damping: 32 };

  return (
    <motion.div
      ref={containerRef}
      layout
      transition={transition}
      data-slot="delete-button"
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "inline-flex h-8 items-center overflow-hidden rounded-md border bg-surface transition-colors",
        expanded ? "border-border-strong shadow-xs" : "border-border",
        className,
      )}
    >
      <button
        type="button"
        aria-label={expanded ? "Cancel delete" : "Delete"}
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) {
            cancel();
          } else {
            setExpanded(true);
          }
        }}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors",
          "text-status-failed hover:bg-status-failed/10",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        )}
      >
        <Trash size={15} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="actions"
            initial={reducedMotion ? { opacity: 1 } : { width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
            transition={transition}
            className="flex items-center overflow-hidden border-l border-border-strong"
          >
            <button
              type="button"
              aria-label="Confirm delete"
              onClick={confirm}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center text-status-failed transition-colors",
                "hover:bg-status-failed/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              )}
            >
              <Check size={15} />
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={cancel}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center border-l border-border text-ink-muted transition-colors",
                "hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              )}
            >
              <X size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
