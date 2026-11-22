// RareUI-inspired Faq (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

export interface FaqProps {
  items: FaqItem[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (id: string | null) => void;
  accent?: string;
  avatar?: ReactNode;
  className?: string;
}

export function Faq({
  items,
  value,
  defaultValue = null,
  onValueChange,
  accent = "var(--c-accent)",
  avatar = null,
  className,
}: FaqProps) {
  const reducedMotion = Boolean(useReducedMotion());
  const baseId = useId();
  const [internalValue, setInternalValue] = useState<string | null>(defaultValue);
  const isControlled = value !== undefined;
  const openId = isControlled ? value : internalValue;

  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setOpenId = useCallback(
    (next: string | null) => {
      if (!isControlled) {
        setInternalValue(next);
      }
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const handleToggle = (id: string) => {
    setOpenId(openId === id ? null : id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = (index + 1) % items.length;
      buttonRefs.current[nextIndex]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIndex = (index - 1 + items.length) % items.length;
      buttonRefs.current[prevIndex]?.focus();
    }
  };

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      {items.map((item, index) => {
        const isOpen = openId === item.id;
        const buttonId = `${baseId}-q-${item.id}`;
        const panelId = `${baseId}-a-${item.id}`;

        return (
          <div key={item.id} className="flex flex-col gap-2">
            {/* Right-aligned requester question bubble */}
            <div className="flex justify-end">
              <button
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => handleToggle(item.id)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                className={cn(
                  "group relative max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-surface-2 px-4 py-2.5 text-left text-sm font-medium text-ink transition-colors",
                  "hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                )}
              >
                <span>{item.question}</span>
              </button>
            </div>

            {/* Left-aligned reply bubble */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  initial={reducedMotion ? false : { opacity: 0, height: 0, y: -4 }}
                  animate={{ opacity: 1, height: "auto", y: 0 }}
                  exit={reducedMotion ? undefined : { opacity: 0, height: 0, y: -4 }}
                  transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="flex items-end gap-2">
                    {avatar && <div className="shrink-0">{avatar}</div>}
                    <div
                      className="relative max-w-[85%] rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm text-ink"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${accent} 12%, var(--c-surface))`,
                        borderColor: `color-mix(in srgb, ${accent} 28%, var(--c-border))`,
                      }}
                    >
                      {/* Small chat tail */}
                      <svg
                        aria-hidden="true"
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        className="absolute -left-1.5 bottom-0"
                        style={{
                          color: `color-mix(in srgb, ${accent} 12%, var(--c-surface))`,
                        }}
                      >
                        <path d="M10 0 L10 10 L0 10 Q6 8 10 0 Z" fill="currentColor" />
                      </svg>
                      <p className="leading-relaxed">{item.answer}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
