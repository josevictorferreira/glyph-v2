import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/shared/lib/cn";
import { CheckIcon } from "./select";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  const input = (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-transparent",
        "bg-surface-3 transition-colors data-[state=checked]:bg-accent disabled:opacity-50",
      )}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[1.125rem]" />
    </SwitchPrimitive.Root>
  );
  if (!label) return input;
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
      {input}
      <span>{label}</span>
    </label>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
}: {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <CheckboxPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border border-border-strong bg-surface",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent",
        "data-[state=indeterminate]:bg-accent disabled:opacity-50",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="text-on-accent">
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
