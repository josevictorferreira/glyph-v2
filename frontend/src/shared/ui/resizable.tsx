import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/shared/lib/cn";

export { Group as PanelGroup, Panel };

export function PanelHandle({ className }: { className?: string }) {
  return (
    <Separator
      className={cn(
        "flex w-1.5 items-center justify-center bg-transparent outline-none",
        "transition-colors hover:bg-accent/30 data-[dragging=true]:bg-accent/50",
        className,
      )}
    >
      <span className="h-8 w-0.5 rounded bg-border-strong" aria-hidden />
    </Separator>
  );
}
