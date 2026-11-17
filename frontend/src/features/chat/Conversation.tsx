// Conversation view (spec 0024): messages in seq order, sanitized assistant
// markdown, error surfaces, tool summaries, live streaming and the composer.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./hooks";
import { Markdown } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import type { ChatMessage } from "@/gen/glyph/v1/chat_pb";
import { useChatLive } from "./use-chat-live";
import { Composer } from "./Composer";

export function Conversation({ chatId }: { chatId: string }) {
  const { data, isLoading } = useChat(chatId);
  const messages = useMemo(() => data?.messages ?? [], [data]);
  const running = data?.chat?.status === 1;
  useChatLive({ chatId });
  // Follow the bottom only when the user was already there: growing text
  // must not yank someone who scrolled up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [messages, pinned]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        <p className="truncate text-sm font-semibold">{data?.chat?.title || "New chat"}</p>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="conversation-scroll"
      >
        {isLoading ? (
          <p className="text-xs text-ink-subtle">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-ink-subtle" data-testid="conversation-empty">
            Ask the agent to create, edit, schedule or run a workflow.
          </p>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </ol>
        )}
      </div>
      <Composer chatId={chatId} running={running} />
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const body =
    message.kind === 1 ? (
      <div className="ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm text-on-accent">
        {message.text}
      </div>
    ) : message.kind === 3 ? (
      <div
        className="max-w-[85%] rounded-md border border-border bg-surface px-3 py-2 text-xs"
        data-testid="tool-card"
      >
        <p className="font-medium">
          {message.tool?.name}
          {message.tool?.isError ? " (failed)" : ""}
        </p>
        <p className="mt-0.5 text-ink-muted">{message.tool?.summary}</p>
      </div>
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
