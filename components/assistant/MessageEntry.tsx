import { Check, CornerDownRight, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { AssistantMessage } from "@/lib/assistant/types";
import { ProposedActionRecord } from "./ProposedActionRecord";

type MessageEntryProps = {
  message: AssistantMessage;
  projectNames: Map<string, string>;
};

/** One log entry: a mono label and time over the text, no bubbles. User text is set off by a hairline rule. */
export function MessageEntry({ message, projectNames }: MessageEntryProps) {
  const isUser = message.role === "user";
  const author = isUser ? "Tú" : "TRAZA";
  const time = message.createdAt.slice(11, 16);
  const actions = message.proposedActions ?? [];

  return (
    <li className="border-t border-charcoal/10 py-5 first:border-t-0 lg:py-6">
      <article aria-label={`${isUser ? "Tu mensaje" : "Respuesta de TRAZA"}, ${time}`}>
        <p className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em]">
          <span className="inline-flex items-center gap-2 text-charcoal">
            {!isUser && <span aria-hidden className="size-[5px] rounded-full bg-sage" />}
            {author}
          </span>
          <time dateTime={message.createdAt} className="text-graphite tabular-nums">
            {time}
          </time>
        </p>

        <p
          className={
            isUser
              ? "mt-3 border-l border-charcoal/30 pl-4 text-[17px] leading-[1.5]"
              : "mt-3 text-[15px] leading-[1.55]"
          }
        >
          {message.content}
        </p>

        {actions.length > 0 && (
          <section aria-labelledby={`${message.id}-actions`} className="mt-5">
            <div className="flex items-baseline justify-between border-b border-charcoal/10 pb-2.5 font-mono text-[10px] uppercase tracking-[0.14em]">
              <h3 id={`${message.id}-actions`} className="text-charcoal">
                Acciones propuestas
              </h3>
              <span className="text-graphite">Sin confirmar</span>
            </div>
            <ol className="divide-y divide-charcoal/10 border-b border-charcoal/10">
              {actions.map((action, i) => (
                <ProposedActionRecord
                  key={action.id}
                  action={action}
                  number={i + 1}
                  projectName={action.projectId ? projectNames.get(action.projectId) : undefined}
                />
              ))}
            </ol>
            {/* Nothing is created until the user confirms; both controls are visual only in this phase. */}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" icon={Check}>
                Confirmar {actions.length} {actions.length === 1 ? "acción" : "acciones"}
              </Button>
              <Button variant="secondary" icon={PencilLine}>
                Editar
              </Button>
            </div>
          </section>
        )}

        {message.suggestions && (
          <ul aria-label="Sugerencias" className="mt-3">
            {message.suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  className="inline-flex items-center gap-2.5 py-1.5 text-[14px] text-charcoal underline-offset-4 outline-none hover:underline hover:decoration-charcoal/30 focus-visible:underline"
                >
                  <CornerDownRight aria-hidden className="size-3.5 text-graphite" strokeWidth={1.5} />
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>
    </li>
  );
}
