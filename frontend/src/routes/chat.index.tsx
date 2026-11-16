import { createFileRoute } from "@tanstack/react-router";
import { Sparkle } from "@/shared/ui/icons";

export const Route = createFileRoute("/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  return (
    <div className="grid h-full place-items-center p-6 text-center" data-testid="chat-index">
      <div>
        <p className="flex items-center justify-center gap-1.5 text-sm font-semibold">
          <Sparkle /> Pick a conversation
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          Choose a chat on the left, or start a new one.
        </p>
      </div>
    </div>
  );
}
