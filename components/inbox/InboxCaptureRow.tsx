"use client";

// An idea or note (public.inbox_items) in the Inbox feed. Client Component only to switch to its
// inline editor; changes go through the Inbox Server Actions.
import { PencilLine } from "lucide-react";
import { useRef, useState } from "react";
import { itemTypeIcons } from "@/components/ui/itemTypeIcons";
import type { ISODate } from "@/lib/calendar/types";
import { entryDateLabel, inboxTypeLabels } from "@/lib/inbox/feed";
import type { InboxCaptureEntry } from "@/lib/inbox/types";
import type { ProjectOption } from "@/lib/projects/types";
import { InboxCaptureEditor } from "./InboxCaptureEditor";

type InboxCaptureRowProps = {
  entry: InboxCaptureEntry;
  today: ISODate;
  projects: ProjectOption[];
};

export function InboxCaptureRow({ entry, today, projects }: InboxCaptureRowProps) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const Icon = itemTypeIcons[entry.kind];
  const isIdea = entry.kind === "idea";
  const date = entryDateLabel(entry, today);
  const typeLabel = inboxTypeLabels[entry.kind];
  // A capture always has a title or a content; without a title the content leads.
  const heading = entry.title ?? entry.content ?? "";
  const body = entry.title ? entry.content : null;

  function closeEditor() {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  if (editing) {
    return (
      <li>
        <InboxCaptureEditor entry={entry} projects={projects} onClose={closeEditor} />
      </li>
    );
  }

  return (
    <li className="relative isolate flex items-start gap-1">
      {/* Ideas get a faint paper wash and a sage icon: the only colour in the list. The wash
          bleeds slightly past the text column while the dividers stay aligned. */}
      {isIdea && <span aria-hidden className="absolute inset-y-0 -inset-x-3 -z-10 bg-paper/70" />}
      <div className="grid min-w-0 flex-1 grid-cols-[1.25rem_1fr] items-start gap-x-3.5 py-3.5 lg:py-4">
        <Icon
          aria-hidden
          className={`mt-0.5 size-[18px] ${isIdea ? "text-sage" : "text-charcoal/70"}`}
          strokeWidth={isIdea ? 1.6 : 1.25}
        />

        <div className="min-w-0">
          <p
            className={`text-[15px] leading-[22px] tracking-[-0.01em] break-words ${
              entry.title ? "font-medium" : "line-clamp-3 whitespace-pre-line"
            }`}
          >
            {heading}
          </p>
          {body && (
            <p className="mt-1 line-clamp-3 text-[14px] leading-[1.5] break-words whitespace-pre-line text-graphite">{body}</p>
          )}
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              {typeLabel} · {date.text}
            </span>
            {entry.projectName && <span className="text-[13px] text-graphite">{entry.projectName}</span>}
          </p>
        </div>
      </div>

      <button
        ref={editButton}
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Editar ${typeLabel.toLowerCase()}: ${heading.slice(0, 80)}`}
        title={`Editar ${typeLabel.toLowerCase()}`}
        className="mt-2.5 grid size-8 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal lg:mt-3"
      >
        <PencilLine aria-hidden className="size-4" strokeWidth={1.25} />
      </button>
    </li>
  );
}
