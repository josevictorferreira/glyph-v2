import { createFileRoute } from "@tanstack/react-router";
import { Conversation } from "@/features/chat";

export const Route = createFileRoute("/chat/$chatId")({
  component: ChatConversationRoute,
});

function ChatConversationRoute() {
  const { chatId } = Route.useParams();
  return <Conversation chatId={chatId} />;
}
