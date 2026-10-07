import type { Metadata } from "next";
import { AssistantComposer } from "@/components/assistant/AssistantComposer";
import { CapabilityIndex } from "@/components/assistant/CapabilityIndex";
import { ConversationLog } from "@/components/assistant/ConversationLog";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAssistantView } from "@/lib/assistant/queries";
import { currentISODate } from "@/lib/calendar/dates";

export const metadata: Metadata = {
  title: "Asistente · TRAZA",
};

export default async function AssistantPage() {
  // The user's latest conversation and its proposals (server-rendered). The model is only called
  // when the user sends a message; opening the page calls nothing.
  const view = await getAssistantView();

  return (
    <AppShell activeHref="/assistant">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-7">
          <PageHeader title="Asistente" subtitle="Organiza, interpreta y convierte ideas en acciones." date={currentISODate()} />
        </div>

        <div className="flex flex-col gap-6 lg:col-span-7 lg:col-start-1 lg:row-start-2 lg:gap-8">
          {view ? (
            <>
              <ConversationLog messages={view.messages} dateLabel={view.dateLabel} />
              <AssistantComposer conversationId={view.conversationId} suggestions={view.suggestions} configured={view.configured} />
            </>
          ) : (
            <p role="alert" className="py-6 text-[14px] text-graphite">
              No se ha podido cargar el asistente.
            </p>
          )}
        </div>

        {/* Desktop-only context; on mobile the conversation and composer stay uninterrupted. */}
        <aside className="hidden lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:block">
          <CapabilityIndex />
        </aside>
      </div>
    </AppShell>
  );
}
