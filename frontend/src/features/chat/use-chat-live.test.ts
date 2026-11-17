// useChatLive (spec 0024): deltas stitch into the GetChat cache in place;
// other events invalidate; refetch on a gap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import type { ServiceImpl } from "@connectrpc/connect";
import { ChatService, type ChatEvent, type GetChatResponse } from "@/gen/glyph/v1/chat_pb";
import { chatKeys } from "@/shared/api/keys";
import { renderHookWithApp } from "../../../test/render";
import { useChatLive } from "./use-chat-live";

function scriptStream() {
  const pending: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const next = () => new Promise<void>((r) => (wake = r));
  return {
    push(event: ChatEvent) {
      pending.push(event);
      const w = wake;
      wake = undefined;
      w?.();
    },
    watchChat: async function* (): AsyncIterable<{ event?: ChatEvent }> {
      while (true) {
        while (pending.length > 0) yield { event: pending.shift()! };
        await next();
      }
    },
  };
}
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const ev = (type: ChatEvent["type"], init: Partial<ChatEvent> = {}) =>
  ({ type, ...init }) as ChatEvent;

describe("useChatLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("stitches TEXT_DELTA into the GetChat cache in place", async () => {
    const script = scriptStream();
    // Seed the cache the way useQuery would, then stream into it.
    const { queryClient, transport, unmount } = renderHookWithApp(
      () => useChatLive({ chatId: "c1" }),
      { services: { chat: script as Partial<ServiceImpl<typeof ChatService>> } },
    );
    const seed: GetChatResponse = {
      chat: { id: "c1", status: 1 },
      messages: [{ id: "m1", text: "hello" }],
    } as unknown as GetChatResponse;
    queryClient.setQueryData(chatKeys.detail("c1", transport), seed);
    script.push(ev(1, { messageId: "m1", offset: 5, text: " world" }));
    await flush();
    const cached = queryClient.getQueryData(chatKeys.detail("c1", transport));
    expect(cached?.messages[0]?.text).toBe("hello world");
    unmount();
  });

  it("invalidates on MESSAGE_UPDATED, CHAT_UPDATED and RESYNC", async () => {
    const script = scriptStream();
    const { queryClient, unmount } = renderHookWithApp(
      () => useChatLive({ chatId: "c1" }),
      { services: { chat: script as Partial<ServiceImpl<typeof ChatService>> } },
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    script.push(ev(2, { messageId: "m1" }));
    await flush();
    script.push(ev(3));
    await flush();
    script.push(ev(4));
    await flush();
    const keys = invalidate.mock.calls.map(([f]) =>
      JSON.stringify((f as { queryKey?: unknown } | undefined)?.queryKey),
    );
    expect(keys).toContain(JSON.stringify(chatKeys.detail("c1")));
    expect(keys).toContain(JSON.stringify(chatKeys.lists()));
    unmount();
  });

  it("refetches when a delta cannot be stitched", async () => {
    const script = scriptStream();
    const { queryClient, transport, unmount } = renderHookWithApp(
      () => useChatLive({ chatId: "c1" }),
      { services: { chat: script as Partial<ServiceImpl<typeof ChatService>> } },
    );
    const seed: GetChatResponse = {
      chat: { id: "c1", status: 1 },
      messages: [{ id: "m1", text: "hello" }],
    } as unknown as GetChatResponse;
    queryClient.setQueryData(chatKeys.detail("c1", transport), seed);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    script.push(ev(1, { messageId: "m1", offset: 9, text: "XY" })); // gap
    await flush();
    const cached = queryClient.getQueryData(chatKeys.detail("c1", transport));
    expect(cached?.messages[0]?.text).toBe("hello"); // untouched
    const keys = invalidate.mock.calls.map(([f]) =>
      JSON.stringify((f as { queryKey?: unknown } | undefined)?.queryKey),
    );
    expect(keys).toContain(JSON.stringify(chatKeys.detail("c1")));
    unmount();
  });
});
