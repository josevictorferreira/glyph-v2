// Composer (spec 0024): Enter sends, Shift+Enter adds a newline; disabled
// while a turn runs, Stop cancels it. Without a chat model the composer is
// replaced by a link to Settings.
import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui";
import { useSettings } from "@/features/settings";
import { useCancelTurn, useSendMessage } from "./hooks";
export function Composer({ chatId, running }: { chatId: string; running: boolean }) {
  const { data: settings, isLoading } = useSettings();
  const send = useSendMessage();
  const cancel = useCancelTurn();
  const formRef = useRef<HTMLFormElement>(null);
  // An unset chat model omits the optional field (undefined): distinguish
  // that from the query still loading — show nothing rather than flapping
  // into the "pick a model" state for a frame.
  if (isLoading) return null;
  const model = settings?.chatModelId ?? "";
  if (model === "") {
    return (
      <div
        className="mx-auto flex max-w-3xl items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm"
        data-testid="composer-missing-model"
      >
        <span className="text-ink-subtle">Pick a model for the agent to start chatting.</span>
        <Link to="/settings" className="font-medium text-accent hover:underline">
          Open Settings
        </Link>
      </div>
    );
  }
  const submit = () => {
    const textarea = formRef.current?.elements.namedItem("text") as HTMLTextAreaElement | null;
    const text = textarea?.value.trim() ?? "";
    if (text) {
      send.mutate({ chatId, text });
      if (textarea) textarea.value = "";
    }
  };
  return (
    <form
      ref={formRef}
      className="mx-auto flex max-w-3xl items-end gap-2 border-t border-border px-4 py-3"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        name="text"
        rows={2}
        autoFocus
        aria-label="Message"
        placeholder="Ask the agent to create, edit, schedule or run a workflow…"
        disabled={running}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
      />
      {running ? (
        <Button type="button" variant="secondary" onClick={() => cancel.mutate({ chatId })}>
          Stop
        </Button>
      ) : (
        <Button type="submit">Send</Button>
      )}
    </form>
  );
}
