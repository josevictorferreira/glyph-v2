// Chat list + conversation shell (spec 0024). Two panes above `md`; the
// list and the conversation are separate screens below.
import { useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Pencil, Plus, Sparkle, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import { useChats, useCreateChat, useDeleteChat, useRenameChat } from "./hooks";

export function ChatPage() {
  const { chatId } = useParams({ strict: false }) ?? {};
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0" data-testid="chat-page">
      <aside
        className={cn(
          "flex w-72 shrink-0 flex-col border-r border-border",
          chatId ? "hidden md:flex" : "flex",
        )}
        aria-label="Conversations"
      >
        <ChatList renaming={renaming} setRenaming={setRenaming} />
      </aside>
      <main className={cn("min-w-0 flex-1", !chatId && "hidden md:block")}>
        <Outlet />
      </main>
    </div>
  );
}

function ChatList({
  renaming,
  setRenaming,
}: {
  renaming: string | null;
  setRenaming: (id: string | null) => void;
}) {
  const { data, isLoading } = useChats();
  const create = useCreateChat();
  const rename = useRenameChat();
  const remove = useDeleteChat();
  const navigate = useNavigate();
  const { chatId } = useParams({ strict: false }) ?? {};

  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="flex items-center gap-1.5 px-1.5 text-sm font-semibold tracking-wide">
          <Sparkle /> Chat
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New chat"
          disabled={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (response) =>
                navigate({ to: "/chat/$chatId", params: { chatId: response.chat!.id } }),
            })
          }
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="chat-list">
        {isLoading ? (
          <p className="p-2 text-xs text-ink-subtle">Loading…</p>
        ) : (data?.chats ?? []).length === 0 ? (
          <p className="p-2 text-xs text-ink-subtle" data-testid="chat-empty">
            No conversations yet. Start one to design, schedule and run workflows by chatting.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {(data?.chats ?? []).map((chat) => (
              <li key={chat.id}>
                {renaming === chat.id ? (
                  <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const title = new FormData(e.currentTarget).get("title");
                      if (typeof title === "string" && title.trim()) {
                        rename.mutate({ chatId: chat.id, title });
                      }
                      setRenaming(null);
                    }}
                  >
                    <input
                      name="title"
                      defaultValue={chat.title}
                      autoFocus
                      className="h-7 w-full rounded-md border border-border bg-surface px-2 text-sm"
                      aria-label="Chat title"
                    />
                    <Button variant="ghost" size="sm" type="submit" aria-label="Save title">
                      ✓
                    </Button>
                  </form>
                ) : (
                  <div
                    className={cn(
                      "group flex items-center gap-1 rounded-md px-1.5 hover:bg-surface-2",
                      chatId === chat.id && "bg-surface-2",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate py-1.5 text-left text-sm"
                      onClick={() => navigate({ to: "/chat/$chatId", params: { chatId: chat.id } })}
                    >
                      {chat.title || "Untitled"}
                    </button>
                    <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Rename ${chat.title || "Untitled"}`}
                        className="h-6 w-6 px-0"
                        onClick={() => setRenaming(chat.id)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${chat.title || "Untitled"}`}
                        className="h-6 w-6 px-0"
                        onClick={() => remove.mutate({ chatId: chat.id })}
                      >
                        <Trash />
                      </Button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
