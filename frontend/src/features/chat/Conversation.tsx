// Conversation view (spec 0024): messages in seq order, sanitized assistant
// markdown, error surfaces, tool summaries. Composer and streaming arrive in
// Phase 5.
import { useChat } from "./hooks";
import { Markdown } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import type { ChatMessage } from "@/gen/glyph/v1/chat_pb";

export function Conversation({ chatId }: { chatId: string }) {
  const { data, isLoading } = useChat(chatId);
  const messages = data?.messages ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        <p className="truncate text-sm font-semibold">{data?.chat?.title || "New chat"}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="conversation-scroll">
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
    <li
      className={cn("flex", message.kind === 1 ? "justify-end" : "justify-start")}
      data-seq={message.seq}
    >
      {body}
    </li>
  );
}
