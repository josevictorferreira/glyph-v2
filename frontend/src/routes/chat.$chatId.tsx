import { createFileRoute } from "@tanstack/react-router";

// Placeholder until 2.5's Conversation view; the route must exist so the
// chat list can navigate to a conversation.
export const Route = createFileRoute("/chat/$chatId")({
  component: () => <div data-testid="chat-conversation" />,
});
