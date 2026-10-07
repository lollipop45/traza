import type { MessageView } from "@/lib/assistant/types";
import { ProposedActions } from "./ProposedActions";

/** One log entry: a mono label and time over the text, no bubbles. User text is set off by a hairline rule. */
export function MessageEntry({ message }: { message: MessageView }) {
  const isUser = message.role === "user";
  const author = isUser ? "Tú" : "TRAZA";

  return (
    <li className="border-t border-charcoal/10 py-5 first:border-t-0 lg:py-6">
      <article aria-label={`${isUser ? "Tu mensaje" : "Respuesta de TRAZA"}, ${message.time}`}>
        <p className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em]">
          <span className="inline-flex items-center gap-2 text-charcoal">
            {!isUser && <span aria-hidden className="size-[5px] rounded-full bg-sage" />}
            {author}
          </span>
          <time dateTime={message.createdAt} className="text-graphite tabular-nums">
            {message.time}
          </time>
        </p>

        {/* Plain text (never HTML): line breaks kept, anything else shown as typed. */}
        <p
          className={
            isUser
              ? "mt-3 border-l border-charcoal/30 pl-4 text-[17px] leading-[1.5] whitespace-pre-line break-words"
              : "mt-3 text-[15px] leading-[1.55] whitespace-pre-line break-words"
          }
        >
          {message.content}
        </p>

        {message.actions.length > 0 && <ProposedActions headingId={`${message.id}-actions`} actions={message.actions} />}
      </article>
    </li>
  );
}
