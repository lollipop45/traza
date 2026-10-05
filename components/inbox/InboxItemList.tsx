import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ISODate } from "@/lib/calendar/types";
import type { InboxEntry } from "@/lib/inbox/types";
import type { ProjectOption } from "@/lib/projects/types";
import { InboxCaptureRow } from "./InboxCaptureRow";
import { InboxTaskRow } from "./InboxTaskRow";

type InboxItemListProps = {
  /** null when the feed could not be loaded. */
  entries: InboxEntry[] | null;
  today: ISODate;
  /** All of the user's projects (choices for editors). */
  projects: ProjectOption[];
};

export function InboxItemList({ entries, today, projects }: InboxItemListProps) {
  return (
    <section aria-labelledby="recent-heading">
      <SectionHeader
        index="01"
        title="Elementos recientes"
        id="recent-heading"
        meta={entries === null ? "—" : String(entries.length).padStart(2, "0")}
      />
      {entries === null ? (
        <p role="alert" className="py-6 text-[14px] text-graphite">
          No se ha podido cargar el Inbox.
        </p>
      ) : entries.length > 0 ? (
        <ul className="divide-y divide-charcoal/10">
          {entries.map((entry) =>
            entry.kind === "task" ? (
              <InboxTaskRow key={`task-${entry.id}`} entry={entry} today={today} projects={projects} />
            ) : (
              <InboxCaptureRow key={`capture-${entry.id}`} entry={entry} today={today} projects={projects} />
            ),
          )}
        </ul>
      ) : (
        <p className="py-6 text-[14px] text-graphite">No hay elementos de este tipo.</p>
      )}
    </section>
  );
}
