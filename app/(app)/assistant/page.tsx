import type { Metadata } from "next";
import { AssistantComposer } from "@/components/assistant/AssistantComposer";
import { CapabilityIndex } from "@/components/assistant/CapabilityIndex";
import { ConversationLog } from "@/components/assistant/ConversationLog";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { assistantConversation, mockProjectNames, today } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Asistente · TRAZA",
};

export default function AssistantPage() {
  const projectNames = new Map(Object.entries(mockProjectNames));

  return (
    <AppShell activeHref="/assistant">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-7">
          <PageHeader
            title="Asistente"
            subtitle="Organiza, interpreta y convierte ideas en acciones."
            date={today}
          />
        </div>

        <div className="flex flex-col gap-6 lg:col-span-7 lg:col-start-1 lg:row-start-2 lg:gap-8">
          <ConversationLog messages={assistantConversation} projectNames={projectNames} />
          <AssistantComposer />
        </div>

        {/* Desktop-only context; on mobile the conversation and composer stay uninterrupted. */}
        <aside className="hidden lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:block">
          <CapabilityIndex />
        </aside>
      </div>
    </AppShell>
  );
}
