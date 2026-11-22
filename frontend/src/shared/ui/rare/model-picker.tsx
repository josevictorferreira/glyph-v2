// RareUI-inspired ModelPicker (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Check, Search } from "@/shared/ui/icons";

export interface PickerModel {
  id: string;
  name: string;
  provider?: string;
  icon?: ReactNode;
  description?: string;
  speed?: 1 | 2 | 3 | 4 | 5;
  intelligence?: 1 | 2 | 3 | 4 | 5;
}

/** Pure: case-insensitive filter of models by name, provider and description. */
export function filterModels(models: PickerModel[], query: string): PickerModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) =>
    [m.name, m.provider ?? "", m.description ?? ""].some((field) =>
      field.toLowerCase().includes(q),
    ),
  );
}

/** Pure: next highlight index for an ArrowUp/ArrowDown key on a list of `size`. */
export function moveHighlight(index: number, size: number, delta: 1 | -1): number {
  if (size <= 0) return 0;
  return (index + delta + size) % size;
}

function DotMeter({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${value ?? 0}/5`}>
      <span className="text-[11px] text-ink-subtle">{label}</span>
      <span className="flex items-center gap-[3px]">
        {[1, 2, 3, 4, 5].map((dot) => (
          <span
            key={dot}
            className={cn("size-1.5 rounded-full", dot <= (value ?? 0) ? "bg-accent" : "bg-surface-3")}
          />
        ))}
      </span>
    </div>
  );
}

export interface ModelPickerProps {
  models: PickerModel[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  searchable?: boolean;
  className?: string;
}

export function ModelPicker({
  models,
  value,
  defaultValue,
  onChange,
  searchable = true,
  className,
}: ModelPickerProps) {
  const controlled = value !== undefined;
  const [selected, setSelected] = useState(defaultValue ?? models[0]?.id ?? "");
  const currentId = controlled ? (value ?? "") : selected;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const filtered = useMemo(() => filterModels(models, query), [models, query]);
  const current = models.find((m) => m.id === currentId);
  const active = filtered[highlight] ?? filtered[0];

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const pick = (model: PickerModel | undefined) => {
    if (!model) return;
    if (!controlled) setSelected(model.id);
    onChange?.(model.id);
    close();
  };

  // Outside click folds back to the currently-selected model.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus management: the filter box when searchable, else the list.
  useEffect(() => {
    if (!open) return;
    if (searchable) filterRef.current?.focus();
    else rootRef.current?.focus();
  }, [open, searchable]);

  const pillSpring = { type: "spring" as const, stiffness: 420, damping: 34 };

  return (
    <div ref={rootRef} className={cn("relative w-72", className)} data-testid="model-picker">
      {!open && current && (
        <motion.button
          key="pill"
          type="button"
          layoutId="model-picker-shell"
          onClick={() => setOpen(true)}
          transition={reduced ? { duration: 0 } : pillSpring}
          className={cn(
            "flex w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-left",
            "shadow-sm outline-none hover:border-border-strong hover:bg-surface-2",
          )}
          aria-haspopup="listbox"
          aria-expanded={false}
          aria-controls={listId}
        >
          {current.icon}
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{current.name}</span>
          {current.provider && (
            <span className="shrink-0 text-xs text-ink-subtle">{current.provider}</span>
          )}
          <motion.span
            layoutId="model-picker-chevron"
            transition={reduced ? { duration: 0 } : pillSpring}
            className="shrink-0 text-ink-subtle"
          >
            <Chevron />
          </motion.span>
        </motion.button>
      )}

      {open && (
        <motion.div
          key="card"
          layoutId="model-picker-shell"
          transition={reduced ? { duration: 0 } : pillSpring}
          role="listbox"
          aria-label="Models"
          id={listId}
          tabIndex={searchable ? -1 : 0}
          className={cn(
            "absolute inset-x-0 top-0 z-40 overflow-hidden rounded-card border border-border bg-surface shadow-lg",
          )}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => moveHighlight(h, filtered.length, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => moveHighlight(h, filtered.length, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          data-state={open ? "open" : "closed"}
        >
            {searchable && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search size={14} className="shrink-0 text-ink-subtle" />
                <input
                  ref={filterRef}
                  value={query}
                  placeholder="Search models"
                  aria-label="Search models"
                  aria-controls={listId}
                  className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                />
              </div>
            )}

            <ul className="max-h-64 overflow-y-auto p-1">
              {filtered.map((model, i) => {
                const isSelected = model.id === currentId;
                const isActive = i === highlight;
                return (
                  <li key={model.id} className="relative">
                    {isActive && (
                      <motion.span
                        layoutId="model-picker-highlight"
                        transition={reduced ? { duration: 0 } : pillSpring}
                        className="absolute inset-0 rounded-md bg-accent-soft"
                        aria-hidden
                      />
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => pick(model)}
                      className={cn(
                        "relative z-10 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                      )}
                    >
                      {model.icon}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{model.name}</span>
                        {model.description && (
                          <span className="block truncate text-xs text-ink-muted">
                            {model.description}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <span className="shrink-0 text-accent">
                          <Check size={14} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-2 py-3 text-center text-xs text-ink-subtle">No models found</li>
              )}
            </ul>

            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
              {active ? (
                <>
                  <span className="truncate text-xs text-ink-muted">{active.name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <DotMeter label="Speed" value={active.speed} />
                    <DotMeter label="Intelligence" value={active.intelligence} />
                  </span>
                </>
              ) : (
                <span className="text-xs text-ink-subtle">No models found</span>
              )}
            </div>
          </motion.div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
