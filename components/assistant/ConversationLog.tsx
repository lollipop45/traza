import { SectionHeader } from "@/components/ui/SectionHeader";
import type { AssistantMessage } from "@/lib/assistant/types";
import { MessageEntry } from "./MessageEntry";

type ConversationLogProps = {
  messages: AssistantMessage[];
  projectNames: Map<string, string>;
};

export function ConversationLog({ messages, projectNames }: ConversationLogProps) {
  return (
    <section aria-labelledby="conversation-heading">
      <SectionHeader index="01" title="Conversación" id="conversation-heading" meta="Hoy" />
      <ol>
        {messages.map((message) => (
          <MessageEntry key={message.id} message={message} projectNames={projectNames} />
        ))}
      </ol>
    </section>
  );
}
