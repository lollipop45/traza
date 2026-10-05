"use client";

// One fast capture surface for three kinds. A task is written to public.tasks (exactly like Home
// quick capture); an idea or note to public.inbox_items. Validation happens in `captureEntry`.
import { CornerDownLeft, Tag } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { ProjectField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { IconButton } from "@/components/ui/IconButton";
import { inboxTypeLabels } from "@/lib/inbox/feed";
import { captureEntry } from "@/lib/inbox/actions";
import { ENTRY_KINDS, type EntryKind } from "@/lib/inbox/types";
import type { ProjectOption } from "@/lib/projects/types";

const KIND_OPTIONS = ENTRY_KINDS.map((kind) => ({ value: kind, label: inboxTypeLabels[kind] }));
const PROJECT_ROW_ID = "composer-project";

type InboxComposerProps = {
  /** Projects a new capture can be filed under (in course or planned). */
  projects: ProjectOption[];
};

export function InboxComposer({ projects }: InboxComposerProps) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The kind stays selected between captures; text and project reset after each save.
  const [kind, setKind] = useState<EntryKind>("note");
  const [projectOpen, setProjectOpen] = useState(false);
  const [saved, setSaved] = useState(0);

  // onSubmit rather than a form action, so a failed attempt keeps what was typed.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await captureEntry(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      form.current?.reset();
      setProjectOpen(false);
      setSaved((count) => count + 1);
    });
  }

  // Enter adds a line; Ctrl/⌘ + Enter saves.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  }

  return (
    <section aria-labelledby="composer-heading">
      <h2 id="composer-heading" className="sr-only">
        Nueva captura
      </h2>
      <form ref={form} onSubmit={submit} aria-busy={pending}>
        <div className="rounded-[10px] border border-charcoal/15 bg-paper transition-colors focus-within:border-charcoal/40">
          <textarea
            name="text"
            aria-labelledby="composer-heading"
            aria-describedby={error ? "composer-error" : "composer-hint"}
            placeholder="Escribe una tarea, idea o nota…"
            rows={4}
            onKeyDown={onKeyDown}
            className="block min-h-[7.5rem] w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[16px] leading-[1.5] text-charcoal outline-none placeholder:text-graphite lg:min-h-[9.5rem] lg:px-5 lg:pt-5"
          />

          {/* Keyed by the save count so the choice resets after each capture. */}
          <div key={saved} id={PROJECT_ROW_ID} hidden={!projectOpen} className="border-t border-charcoal/10 px-4 py-3 lg:px-5">
            {projectOpen && <ProjectField idPrefix="composer" projects={projects} initial={null} />}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-charcoal/10 px-1.5 py-1.5">
            <div className="flex items-center gap-1">
              <ChoiceGroup
                id="composer-kind"
                label="Tipo de captura"
                name="kind"
                options={KIND_OPTIONS}
                value={kind}
                onChange={(value) => setKind(value as EntryKind)}
                hideLabel
              />
              {projects.length > 0 && (
                <IconButton
                  label={projectOpen ? "Quitar proyecto" : "Asignar proyecto"}
                  icon={Tag}
                  iconClassName="size-[18px]"
                  expanded={projectOpen}
                  controls={PROJECT_ROW_ID}
                  onClick={() => setProjectOpen((open) => !open)}
                />
              )}
            </div>
            {/* Icon-only on narrow phones so the bar stays on one line; the label remains for screen readers. */}
            <Button variant="primary" type="submit" disabled={pending} icon={CornerDownLeft}>
              <span className="sr-only sm:not-sr-only">Guardar</span>
            </Button>
          </div>
        </div>
      </form>

      {error ? (
        <p id="composer-error" role="alert" className="mt-3 border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      ) : (
        <p id="composer-hint" className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite/80">
          {kind === "task" ? "Una línea · se añade a tus tareas" : "La primera línea es el título"}
        </p>
      )}
    </section>
  );
}
