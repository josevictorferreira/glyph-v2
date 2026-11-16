import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  ChatMessageSchema,
  ChatSchema,
  GetChatResponseSchema,
  ToolCallSchema,
} from "@/gen/glyph/v1/chat_pb";
import { renderWithApp } from "../../../test/render";
import type { FakeServices } from "../../../test/fakeTransport";

const msg = (seq: number, init: Partial<{}> & Record<string, unknown>) =>
  create(ChatMessageSchema, { id: `m${seq}`, chatId: "c1", seq, ...init });

function services(response = create(GetChatResponseSchema, { chat: baseChat })) {
  return {
    chat: {
      getChat: () => Promise.resolve(response),
      listChats: () => Promise.resolve({ chats: [] }),
    },
  } as unknown as FakeServices;
}

const baseChat = create(ChatSchema, { id: "c1", title: "Tournament" });

describe("Conversation", () => {
  it("renders user and assistant messages in seq order", async () => {
    const response = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [
        msg(1, { kind: 1, status: 2, text: "Design a tournament" }),
        msg(2, {
          kind: 2,
          status: 2,
          text: "**Done.** See the table:\n\n| a | b |\n| - | - |\n| 1 | 2 |",
        }),
      ],
    });
    renderWithApp(undefined, { route: "/chat/c1", services: services(response) });
    expect(await screen.findByText("Design a tournament")).toBeTruthy();
    // Assistant markdown renders a table…
    expect(await screen.findByRole("table")).toBeTruthy();
    // …and a <script> never becomes an element
    const response2 = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [msg(1, { kind: 2, status: 2, text: 'Hi <script>alert("x")</script>' })],
    });
    const { unmount } = renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(response2),
    });
    const md = (await screen.findAllByTestId("markdown"))[0]!;
    expect(md.querySelector("script")).toBeNull();
    unmount();
  });

  it("shows a failed message error", async () => {
    const response = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [msg(1, { kind: 2, status: 3, error: "model unavailable" })],
    });
    renderWithApp(undefined, { route: "/chat/c1", services: services(response) });
    expect(await screen.findByRole("alert")).toHaveTextContent("model unavailable");
  });

  it("renders a tool call with its summary", async () => {
    const response = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [
        msg(1, {
          kind: 3,
          status: 2,
          tool: create(ToolCallSchema, {
            name: "update_workflow",
            summary: "Edited \"Design POC Tournament\"",
            isError: false,
          }),
        }),
      ],
    });
    renderWithApp(undefined, { route: "/chat/c1", services: services(response) });
    expect(await screen.findByText(/Edited .Design POC Tournament./)).toBeTruthy();
  });

  it("shows a hint when the chat has no messages yet", async () => {
    const response = create(GetChatResponseSchema, { chat: baseChat, messages: [] });
    renderWithApp(undefined, { route: "/chat/c1", services: services(response) });
    expect(await screen.findByTestId("conversation-empty")).toBeTruthy();
  });
});
