import type { Metadata } from "next";
import { InboxComposer } from "@/components/inbox/InboxComposer";
import { InboxItemList } from "@/components/inbox/InboxItemList";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { FilterIndex } from "@/components/ui/FilterIndex";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { filterInboxItems, inboxFilters, resolveInboxFilter } from "@/lib/inbox/items";
import { inboxItems, today } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Inbox · TRAZA",
};

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { tipo } = await searchParams;
  const activeFilter = resolveInboxFilter(tipo);
  const filterOptions = inboxFilters.map((filter) => ({
    key: filter.label,
    label: filter.label,
    href: filter.slug ? `/inbox?tipo=${filter.slug}` : "/inbox",
    count: filterInboxItems(inboxItems, filter).length,
  }));

  return (
    <AppShell activeHref="/inbox">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="flex flex-col gap-6 lg:col-span-7 lg:gap-8">
          <PageHeader title="Inbox" subtitle="Captura cualquier cosa. Organízala después." date={today} />
          <InboxComposer />
        </div>

        {/* Sits right under the composer on mobile; becomes an index beside the list on desktop. */}
        <div className="-mt-4 lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:mt-0">
          <div className="hidden lg:block">
            <SectionHeader index="02" title="Tipo" id="filters-heading" />
          </div>
          <FilterIndex
            label="Filtrar por tipo"
            options={filterOptions}
            activeKey={activeFilter.label}
            variant="tabs"
          />
        </div>

        <div className="lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <InboxItemList items={filterInboxItems(inboxItems, activeFilter)} today={today} />
        </div>
      </div>
    </AppShell>
  );
}
