import { DropdownMenu, Popover, ContextMenu } from "radix-ui";
import { cn } from "@/shared/lib/cn";

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-ink " +
  "outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "data-[highlighted]:bg-surface-2";

const contentClass =
  "z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface p-1 shadow-lg";

// ---------------------------------------------------------------------------
export const Dropdown = DropdownMenu.Root;
export const DropdownTrigger = DropdownMenu.Trigger;

export function DropdownContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={4}
        align="end"
        className={cn(contentClass, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function DropdownItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  );
}

export function DropdownLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn("px-2 py-1 text-xs font-medium text-ink-subtle", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
export const PopoverRoot = Popover.Root;
export const PopoverTrigger = Popover.Trigger;
export const PopoverAnchor = Popover.Anchor;

export function PopoverContent({
  className,
  ...props
}: React.ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content sideOffset={6} className={cn(contentClass, className)} {...props} />
    </Popover.Portal>
  );
}

// ---------------------------------------------------------------------------
export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={cn(contentClass, className)} {...props} />
    </ContextMenu.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu.Item>) {
  return <ContextMenu.Item className={cn(itemClass, className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu.Separator>) {
  return (
    <ContextMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  );
}
