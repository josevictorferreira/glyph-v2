// Workspace-header wiring (spec 0015): reads the enclosing LiveProvider's
// status and renders the shared indicator. Stale data stays on screen.
import { ConnectionIndicator } from "@/shared/ui";
import { useLiveLastSeen, useLiveStatus } from "./live-provider";

export function LiveConnectionIndicator({ className }: { className?: string }) {
  const status = useLiveStatus();
  const lastEventAt = useLiveLastSeen();
  return <ConnectionIndicator status={status} lastEventAt={lastEventAt} className={className} />;
}
