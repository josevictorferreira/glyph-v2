// Tool cards (spec 0024, task 5.2): summaries, workflow/run links, revert,
// validation detail and error styling.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  ChatMessageSchema,
  ChatSchema,
  GetChatResponseSchema,
  ToolCallSchema,
} from "@/gen/glyph/v1/chat_pb";
import { renderWithApp } from "../../../test/render";
import type { FakeServices } from "../../../test/fakeTransport";

const baseChat = create(ChatSchema, { id: "c1", title: "Tournament" });
const msg = (init: Record<string, unknown>) =>
  create(ChatMessageSchema, { id: "m1", chatId: "c1", seq: 1, ...init });

function services(tool: ReturnType<typeof create>, extra: FakeServices["chat"] = {}) {
  const response = create(GetChatResponseSchema, {
    chat: baseChat,
    messages: [msg({ kind: 3, status: 2, tool })],
  });
  return {
    chat: {
      getChat: () => Promise.resolve(response),
      listChats: () => Promise.resolve({ chats: [] }),
      ...extra,
    },
  } as unknown as FakeServices;
}

describe("ToolCard", () => {
  it("an update card shows the summary, links to the workflow and offers Revert only when revertible", async () => {
    const revertible = create(ToolCallSchema, {
      name: "update_workflow",
      summary: 'Edited "Weekly digest"',
      workflowId: "wf-1",
      revertible: true,
    });
    const notRevertible = create(ToolCallSchema, {
      name: "update_workflow",
      summary: 'Edited "Other"',
      workflowId: "wf-2",
      revertible: false,
    });
    const { unmount } = renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(revertible),
    });
    expect(await screen.findByText(/Edited .Weekly digest./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "wf-1" });
    expect(link.getAttribute("href")).toContain("/workflows/wf-1");
    expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
    unmount();

    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(notRevertible),
    });
    expect(await screen.findByText(/Edited .Other./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });

  it("Revert calls the RPC, then shows Reverted once the chat refetches", async () => {
    let reverted = false;
    const revert = vi.fn().mockImplementation(async () => {
      reverted = true;
      return {};
    });
    const tool = create(ToolCallSchema, {
      name: "update_workflow",
      summary: 'Edited "Weekly digest"',
      workflowId: "wf-1",
      revertible: true,
    });
    const response = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [msg({ kind: 3, status: 2, tool })],
    });
    const after = create(GetChatResponseSchema, {
      chat: baseChat,
      messages: [
        msg({
          kind: 3,
          status: 2,
          tool: create(ToolCallSchema, {
            name: "update_workflow",
            summary: 'Edited "Weekly digest"',
            workflowId: "wf-1",
            revertible: false,
            reverted: true,
          }),
        }),
      ],
    });
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: {
        chat: {
          getChat: () => Promise.resolve(reverted ? after : response),
          listChats: () => Promise.resolve({ chats: [] }),
          revertChange: revert,
        },
      } as unknown as FakeServices,
    });
    await screen.findByText(/Edited .Weekly digest./);
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    const arg = revert.mock.calls[0]?.[0] as { chatId: string; messageId: string };
    expect(arg?.chatId).toBe("c1");
    expect(arg?.messageId).toBe("m1");
    expect(await screen.findByText("Reverted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });

  it("a rejected revert shows the server message", async () => {
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(
        create(ToolCallSchema, {
          name: "update_workflow",
          summary: 'Edited "Weekly digest"',
          workflowId: "wf-1",
          revertible: true,
        }),
        {
          revertChange: () => {
            throw new ConnectError(
              "This workflow changed after the agent's edit, so it can't be reverted automatically.",
              Code.Aborted,
            );
          },
        },
      ),
    });
    await screen.findByText(/Edited .Weekly digest./);
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(
      await screen.findByText(
        "This workflow changed after the agent's edit, so it can't be reverted automatically.",
      ),
    ).toBeTruthy();
  });

  it("a reverted card shows Reverted instead of the button", async () => {
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(
        create(ToolCallSchema, {
          name: "update_workflow",
          summary: 'Edited "Weekly digest"',
          workflowId: "wf-1",
          revertible: false,
          reverted: true,
        }),
      ),
    });
    expect(await screen.findByText(/Edited .Weekly digest./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
    expect(screen.getByText("Reverted")).toBeTruthy();
  });

  it("a run card links to the run", async () => {
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(
        create(ToolCallSchema, {
          name: "start_run",
          summary: "Started a run",
          workflowId: "wf-1",
          runId: "run-9",
        }),
      ),
    });
    const link = await screen.findByRole("link", { name: /run/i });
    expect(link.getAttribute("href")).toContain("/workflows/wf-1/runs/run-9");
  });

  it("a validation card expands its detail", async () => {
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(
        create(ToolCallSchema, {
          name: "validate_yaml",
          summary: "The document has 2 errors.",
          detail: "/steps/0/name: is required\n/model: is not an available model",
        }),
      ),
    });
    expect(await screen.findByText(/2 errors/)).toBeTruthy();
    expect(screen.queryByText(/is not an available model/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/is not an available model/)).toBeTruthy();
  });

  it("an error card is visibly an error", async () => {
    renderWithApp(undefined, {
      route: "/chat/c1",
      services: services(
        create(ToolCallSchema, {
          name: "update_workflow",
          summary: "update_workflow needs the fingerprint from get_workflow_yaml.",
          isError: true,
        }),
      ),
    });
    const card = await screen.findByTestId("tool-card");
    expect(card.className).toContain("danger");
    expect(card).toHaveTextContent(/needs the fingerprint/);
  });
});
