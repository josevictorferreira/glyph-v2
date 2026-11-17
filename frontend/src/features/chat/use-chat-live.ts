// useChatLive (spec 0024): one WatchChat subscription per conversation.
// TEXT_DELTA writes directly into the GetChat cache (exact key), so a reply
// grows in place without refetches; MESSAGE_UPDATED / CHAT_UPDATED / RESYNC
// invalidate. Reconnects share the backoff shape of use-workflow-live.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { useTransport } from "@connectrpc/connect-query";
import { ChatService, ChatEventType, type ChatEvent, type GetChatResponse } from "@/gen/glyph/v1/chat_pb";
import { chatKeys } from "@/shared/api/keys";
import { applyDelta } from "./lib/stream";
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const OFFLINE_AFTER_ATTEMPTS = 5;
export interface ChatLiveState {
  status: "connecting" | "connected" | "reconnecting" | "offline";
  lastEventAt: number | undefined;
}
export function useChatLive({ chatId }: { chatId: string }): ChatLiveState {
  const queryClient = useQueryClient();
  const transport = useTransport();
  const [status, setStatus] = useState<ChatLiveState["status"]>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const queryClientRef = useRef(queryClient);
  useEffect(() => {
    queryClientRef.current = queryClient;
  }, [queryClient]);
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const client = createClient(ChatService, transport);
    const key = chatKeys.detail(chatId, transport);
    const handleEvent = (ev: ChatEvent) => {
      const ts = ev.occurredAt;
      setLastEventAt(ts ? Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6) : Date.now());
      const qc = queryClientRef.current;
      switch (ev.type) {
        case ChatEventType.TEXT_DELTA: {
          const state = qc.getQueryState(key);
          const response = qc.getQueryData(key);
          const messages = response?.messages ?? [];
          const index = messages.findIndex((m) => m.id === ev.messageId);
          // Only stitch into a message we already hold; anything else is a
          // server-side change we learn about via refetch.
          if (state !== undefined && index >= 0) {
            const message = messages[index]!;
            const applied = applyDelta({ text: ev.text, known: message.text, offset: ev.offset });
            if (applied.refetch) {
              void qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
              break;
            }
            const next = messages.slice();
            next[index] = { ...message, text: applied.text };
            const updated: GetChatResponse = { ...response!, messages: next };
            qc.setQueryData(key, updated);
          } else {
            void qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
          }
          break;
        }
        case ChatEventType.MESSAGE_UPDATED:
        case ChatEventType.CHAT_UPDATED:
        case ChatEventType.RESYNC:
          void qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
          if (ev.type !== ChatEventType.MESSAGE_UPDATED) {
            void qc.invalidateQueries({ queryKey: chatKeys.lists() });
          }
          break;
        case ChatEventType.HEARTBEAT:
          break;
        default:
          break;
      }
    };
    const scheduleReconnect = () => {
      setStatus(attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
      const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      const delay = base * (0.75 + Math.random() / 2); // ±25% jitter
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        controller = connect();
      }, delay);
    };
    const connect = (): AbortController => {
      setStatus(
        attempt === 0
          ? "connecting"
          : attempt >= OFFLINE_AFTER_ATTEMPTS
            ? "offline"
            : "reconnecting",
      );
      const ac = new AbortController();
      void (async () => {
        try {
          for await (const res of client.watchChat({ chatId }, { signal: ac.signal })) {
            if (cancelled) return;
            attempt = 0;
            setStatus("connected");
            if (res.event) handleEvent(res.event);
          }
          if (!cancelled) scheduleReconnect(); // server closed the stream
        } catch {
          if (!cancelled) scheduleReconnect();
        }
      })();
      return ac;
    };
    controller = connect();
    return () => {
      cancelled = true;
      controller?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [chatId, transport]);
  return { status, lastEventAt };
}
