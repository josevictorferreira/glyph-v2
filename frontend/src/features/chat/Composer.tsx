// Composer (spec 0024): Enter sends, Shift+Enter adds a newline; disabled
// while a turn runs, Stop cancels it. Without a chat model the composer is
// replaced by a link to Settings.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui";
import { toAppError } from "@/shared/api/errors";
import { useSettings } from "@/features/settings";
import { useCancelTurn, useSendMessage } from "./hooks";

const MAX_TEXTAREA_HEIGHT = 200;

export function Composer({
  chatId,
  running,
  draft,
  onDraftChange,
}: {
  chatId: string;
  running: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
}) {
  const { data: settings, isLoading } = useSettings();
  const send = useSendMessage();
  const cancel = useCancelTurn();
  const [localText, setLocalText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const text = draft ?? localText;
  const setText = (next: string) => {
    if (onDraftChange) onDraftChange(next);
    else setLocalText(next);
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  // An unset chat model omits the optional field (undefined): distinguish
  // that from the query still loading — show nothing rather than flapping
  // into the "pick a model" state for a frame.
  if (isLoading) return null;
  const model = settings?.chatModelId ?? "";
  if (model === "") {
    return (
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div
          className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 text-sm"
          data-testid="composer-missing-model"
        >
          <span className="text-ink-subtle">Pick a model for the agent to start chatting.</span>
          <Link to="/settings" className="font-medium text-accent hover:underline">
            Open Settings
          </Link>
        </div>
      </div>
    );
  }

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !send.isPending && !running;

  const submit = () => {
    if (!canSend) return;
    send.mutate(
      { chatId, text: trimmed },
      {
        onSuccess: () => {
          setText("");
        },
      },
    );
  };

  return (
    <div className="shrink-0 border-t border-border px-4 py-3">
      <form
        className="mx-auto flex w-full max-w-3xl flex-col gap-1.5"
        data-testid="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {send.isError ? (
          <p role="alert" className="text-xs text-danger">
            {toAppError(send.error).message}
          </p>
        ) : null}
        <div className="flex w-full items-end gap-2">
          <textarea
            ref={textareaRef}
            name="text"
            rows={2}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Message"
            placeholder="Ask the agent to create, edit, schedule or run a workflow…"
            disabled={running || send.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="min-h-[2.75rem] max-h-[200px] flex-1 resize-none overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50"
          />
          {running ? (
            <Button type="button" variant="secondary" onClick={() => cancel.mutate({ chatId })}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!canSend}>
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
