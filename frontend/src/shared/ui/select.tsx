import { forwardRef, type SelectHTMLAttributes } from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";

// ---------------------------------------------------------------------------
// Select (Radix): native-like listbox for short lists.
// ---------------------------------------------------------------------------
export interface SelectItem {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  items: SelectItem[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Select({ value, onValueChange, items, placeholder, disabled, className, ariaLabel }: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border",
          "bg-surface px-2.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? "Select…"} />
        <SelectPrimitive.Icon className="text-ink-subtle" aria-hidden>
          <ChevronDownIcon />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          <SelectPrimitive.Viewport className="p-1">
            {items.map((item) => (
              <SelectPrimitive.Item
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                className="flex cursor-default select-none items-center justify-between rounded px-2 py-1.5 text-sm"
              >
                <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="text-accent">
                  <CheckIcon />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Combobox (cmdk in a Popover): searchable, grouped, for long lists.
// ---------------------------------------------------------------------------
export interface ComboboxItem {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
  hint?: string;
}

export interface ComboboxProps {
  items: ComboboxItem[];
  value?: string | null;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Combobox({
  items,
  value,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled,
  className,
  ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.value === value);
  const groups = [...new Set(items.map((i) => i.group).filter(Boolean) as string[])];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border",
          "bg-surface px-2.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50",
          !selected && "text-ink-subtle",
          className,
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <span className="text-ink-subtle" aria-hidden>
          <ChevronDownIcon />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50">
          <Command loop className="w-64 overflow-hidden rounded-md border border-border bg-surface shadow-lg">
            <Command.Input
              autoFocus
              placeholder={searchPlaceholder}
              className="w-full border-b border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-ink-subtle"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-xs text-ink-subtle">{emptyText}</Command.Empty>
              {groups.length === 0
                ? items.map(renderItem)
                : groups.map((group) => (
                    <Command.Group
                      key={group}
                      heading={group}
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-subtle"
                    >
                      {items.filter((i) => i.group === group).map(renderItem)}
                    </Command.Group>
                  ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  function renderItem(item: ComboboxItem) {
    return (
      <Command.Item
        key={item.value}
        value={`${item.label} ${item.value}`}
        disabled={item.disabled}
        onSelect={() => {
          onValueChange(item.value);
          setOpen(false);
        }}
        className="flex cursor-default select-none items-center justify-between gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-surface-2 aria-disabled:opacity-50"
      >
        <span className="truncate">{item.label}</span>
        {item.hint && <span className="shrink-0 text-xs text-ink-subtle">{item.hint}</span>}
        {item.value === value && <span className="text-accent" aria-hidden><CheckIcon /></span>}
      </Command.Item>
    );
  }
}

// ---------------------------------------------------------------------------
// Raw select — for tests and tiny forms where Radix is overkill.
// ---------------------------------------------------------------------------
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          "h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-ink",
          className,
        )}
        {...props}
      />
    );
  },
);

export function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
