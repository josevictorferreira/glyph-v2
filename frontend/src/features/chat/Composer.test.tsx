// Composer (spec 0024): Enter sends and Shift+Enter adds a newline; while
// running the input is disabled and Stop calls CancelTurn; without a model
// the composer is replaced by a link to Settings.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../../../test/render";
import type { FakeServices } from "../../../test/fakeTransport";

const services = (model: string, chat: Record<string, unknown> = {}): FakeServices => ({
  settings: { getSettings: () => Promise.resolve({ chatModelId: model }) },
  chat: {
    getChat: () => Promise.resolve({ chat: { id: "c1", status: 0 }, messages: [] }),
    listChats: () => Promise.resolve({ chats: [] }),
    ...chat,
  },
});
const runningServices = (model: string, chat: Record<string, unknown> = {}): FakeServices => ({
  settings: { getSettings: () => Promise.resolve({ chatModelId: model }) },
  chat: {
    getChat: () => Promise.resolve({ chat: { id: "c1", status: 2 }, messages: [] }), // RUNNING
    listChats: () => Promise.resolve({ chats: [] }),
    ...chat,
  },
});

describe("Composer", () => {
  it("Enter sends, Shift+Enter adds a newline", async () => {
    const sendMessage = vi.fn((_req: unknown) => Promise.resolve({}));
    renderWithApp(undefined, {
      services: services("m/x", { sendMessage }),
      route: "/chat/c1",
    });
    const textarea = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(textarea, { target: { value: "line1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("line1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ chatId: "c1", text: "line1" });
  });

  it("while running the input is disabled and Stop cancels", async () => {
    const cancelTurn = vi.fn((_req: unknown) => Promise.resolve({}));
    renderWithApp(undefined, {
      services: runningServices("m/x", { cancelTurn }),
      route: "/chat/c1",
    });
    const textarea = await screen.findByRole("textbox", { name: "Message" });
    expect(textarea).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancelTurn).toHaveBeenCalled());
    expect(cancelTurn.mock.calls[0]![0]).toMatchObject({ chatId: "c1" });
  });

  it("without a model shows a link to Settings instead", async () => {
    renderWithApp(undefined, {
      services: services(""),
      route: "/chat/c1",
    });
    expect(await screen.findByTestId("composer-missing-model")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
