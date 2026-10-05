"use client";

// Client Component only to switch an index entry to its inline editor and back. The database is
// the source of truth: every change goes through a Server Action, then the index is revalidated.
import { PencilLine } from "lucide-react";
import { useRef, useState } from "react";
import type { ProjectWithCounts } from "@/lib/projects/types";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectEntry } from "./ProjectEntry";

type ProjectItemProps = {
  project: ProjectWithCounts;
  number: number;
  areas: string[];
};

export function ProjectItem({ project, number, areas }: ProjectItemProps) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);

  function closeEditor() {
    setEditing(false);
    // Return focus to the entry's edit control once it is back in the DOM.
    requestAnimationFrame(() => editButton.current?.focus());
  }

  return (
    <li>
      {editing ? (
        <ProjectEditor project={project} areas={areas} onClose={closeEditor} />
      ) : (
        <ProjectEntry
          project={project}
          number={number}
          action={
            <button
              ref={editButton}
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Editar proyecto: ${project.name}`}
              title="Editar proyecto"
              className="-mt-0.5 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal"
            >
              <PencilLine aria-hidden className="size-4" strokeWidth={1.25} />
            </button>
          }
        />
      )}
    </li>
  );
}
