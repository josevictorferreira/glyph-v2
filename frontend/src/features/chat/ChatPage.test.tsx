import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  ChatSchema,
  CreateChatResponseSchema,
  ListChatsResponseSchema,
} from "@/gen/glyph/v1/chat_pb";
import { renderWithApp } from "../../../test/render";
import type { FakeServices } from "../../../test/fakeTransport";

const chat = (id: string, title: string, updatedSecondsAgo: number) =>
  create(ChatSchema, {
    id,
    title,
    updatedAt: {
      seconds: BigInt(Math.floor((Date.now() - updatedSecondsAgo * 1000) / 1000)),
    },
  });

/** Fakes; the backend orders by updated_at desc, so the fake sorts too. */
function makeServices(chats: ReturnType<typeof chat>[]) {
  const renameChat = vi.fn(() => Promise.resolve({}));
  const deleteChat = vi.fn(() => Promise.resolve({}));
  const services = {
    chat: {
      listChats: () =>
        Promise.resolve(
          create(ListChatsResponseSchema, {
            chats: [...chats].sort(
              (a, b) => Number(b.updatedAt!.seconds!) - Number(a.updatedAt!.seconds!),
            ),
          }),
        ),
      createChat: () =>
        Promise.resolve(create(CreateChatResponseSchema, { chat: chat("new-1", "", 0) })),
      renameChat,
      deleteChat,
    },
  } as unknown as FakeServices;
  return { services, renameChat, deleteChat };
}

describe("ChatPage list", () => {
  it("renders newest first", async () => {
    const { services } = makeServices([
      chat("old", "Old chat", 500),
      chat("new", "New chat", 1),
    ]);
    renderWithApp(undefined, { route: "/chat", services });
    const items = await screen.findAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["New chat", "Old chat"]);
  });

  it("New creates a chat and navigates to it", async () => {
    const { services } = makeServices([]);
    const rendered = renderWithApp(undefined, { route: "/chat", services });
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(rendered.router!.state.location.pathname).toBe("/chat/new-1"),
    );
  });

  it("rename and delete call their RPCs", async () => {
    const { services, renameChat, deleteChat } = makeServices([chat("c1", "One", 1)]);
    renderWithApp(undefined, { route: "/chat", services });
    fireEvent.click(await screen.findByRole("button", { name: "Rename One" }));
    const input = await screen.findByLabelText("Chat title");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(renameChat).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Delete One" }));
    await waitFor(() => expect(deleteChat).toHaveBeenCalled());
  });

  it("empty state invites a first chat", async () => {
    const { services } = makeServices([]);
    renderWithApp(undefined, { route: "/chat", services });
    expect(await screen.findByTestId("chat-empty")).toHaveTextContent(/No conversations yet/);
  });

  it("Escape cancels rename and deleting active chat navigates to /chat", async () => {
    const { services, deleteChat } = makeServices([chat("c1", "One", 1)]);
    const rendered = renderWithApp(undefined, { route: "/chat/c1", services });
    fireEvent.click(await screen.findByRole("button", { name: "Rename One" }));
    const input = await screen.findByLabelText("Chat title");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Chat title")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete One" }));
    await waitFor(() => expect(deleteChat).toHaveBeenCalled());
    await waitFor(() => expect(rendered.router!.state.location.pathname).toBe("/chat"));
  });
});
