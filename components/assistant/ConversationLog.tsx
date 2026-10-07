import { SectionHeader } from "@/components/ui/SectionHeader";
import type { MessageView } from "@/lib/assistant/types";
import { MessageEntry } from "./MessageEntry";
import { NewConversationButton } from "./NewConversationButton";

type ConversationLogProps = {
  messages: MessageView[];
  /** Date of the conversation, for the header. */
  dateLabel: string | null;
};

export function ConversationLog({ messages, dateLabel }: ConversationLogProps) {
  return (
    <section aria-labelledby="conversation-heading">
      <SectionHeader
        index="01"
        title="Conversación"
        id="conversation-heading"
        action={
          <span className="flex items-center gap-3">
            {dateLabel && <span className="text-graphite">{dateLabel}</span>}
            {messages.length > 0 && <NewConversationButton />}
          </span>
        }
      />
      {messages.length === 0 ? (
        <p className="max-w-[52ch] py-6 text-[15px] leading-[1.55] text-graphite">
          Pregunta por tus tareas, entregas, eventos o notas, o pide que prepare algo. TRAZA responde con tus datos reales y no crea nada sin tu
          confirmación.
        </p>
      ) : (
        <ol>
          {messages.map((message) => (
            <MessageEntry key={message.id} message={message} />
          ))}
        </ol>
      )}
    </section>
  );
}
