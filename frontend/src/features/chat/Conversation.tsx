// Conversation view (spec 0024): messages in seq order, sanitized assistant
// markdown, error surfaces, tool summaries, live streaming and the composer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useChat } from "./hooks";
import { Markdown } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import type { ChatMessage } from "@/gen/glyph/v1/chat_pb";
import { useChatLive } from "./use-chat-live";
import { Composer } from "./Composer";
import { ToolCard } from "./ToolCard";

const STARTER_PROMPTS = [
  "Create a daily summary workflow",
  "List my active workflows",
  "Schedule a workflow to run every morning",
];

export function Conversation({ chatId }: { chatId: string }) {
  const { data, isLoading } = useChat(chatId);
  const messages = useMemo(() => data?.messages ?? [], [data]);
  const running = data?.chat?.status === 2; // CHAT_STATUS_RUNNING
  const [draft, setDraft] = useState("");
  useChatLive({ chatId });
  // Follow the bottom only when the user was already there: growing text
  // must not yank someone who scrolled up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [messages, running, pinned]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Link
          to="/chat"
          aria-label="Back to conversations"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink md:hidden"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <p className="truncate text-sm font-semibold">{data?.chat?.title || "New chat"}</p>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="conversation-scroll"
      >
        {isLoading ? (
          <p className="mx-auto max-w-3xl text-xs text-ink-subtle">Loading…</p>
        ) : messages.length === 0 ? (
          <div
            className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 text-center"
            data-testid="conversation-empty"
          >
            <p className="text-sm font-medium text-ink">
              Ask the agent to create, edit, schedule or run a workflow.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setDraft(prompt)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-ink"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageRow key={m.id} chatId={chatId} message={m} />
            ))}
            {running ? (
              <li className="text-xs text-ink-subtle" aria-live="polite">
                Thinking…
              </li>
            ) : null}
          </ol>
        )}
      </div>
      <Composer chatId={chatId} running={running} draft={draft} onDraftChange={setDraft} />
    </div>
  );
}

function MessageRow({ chatId, message }: { chatId: string; message: ChatMessage }) {
  const body =
    message.kind === 1 ? (
      <div className="ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm text-on-accent">
        {message.text}
      </div>
    ) : message.kind === 3 && message.tool ? (
      <ToolCard chatId={chatId} messageId={message.id} tool={message.tool} />
    ) : message.status === 3 ? (
      <p
        className="max-w-[85%] rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm"
        role="alert"
      >
        {message.error || "The turn failed."}
      </p>
    ) : (
      <div className="max-w-[85%]">
        <Markdown text={message.text} />
      </div>
    );
  return (
    <li className={cn("flex flex-col", message.kind === 1 && "items-end")}>
      {body}
    </li>
  );
}
