// Chat hooks (spec 0024).
import { useQuery, useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { ChatService } from "@/gen/glyph/v1/chat_pb";
import { chatKeys } from "@/shared/api/keys";

export function useChats() {
  return useQuery(ChatService.method.listChats, {}, { staleTime: 10_000 });
}

export function useChat(chatId: string) {
  return useQuery(ChatService.method.getChat, { chatId }, { enabled: chatId.length > 0 });
}

export function useCreateChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createClient(ChatService, transport).createChat({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.lists() }),
  });
}

export function useRenameChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string; title: string }) =>
      createClient(ChatService, transport).renameChat(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.lists() }),
  });
}

export function useDeleteChat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      createClient(ChatService, transport).deleteChat(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.lists() }),
  });
}
export function useSendMessage() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string; text: string }) =>
      createClient(ChatService, transport).sendMessage(input),
    onSuccess: (_d, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
    },
  });
}
export function useRevertChange(chatId: string, messageId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      createClient(ChatService, transport).revertChange({ chatId, messageId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
}
export function useCancelTurn() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      createClient(ChatService, transport).cancelTurn(input),
    onSuccess: (_d, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
}
