"use client";

// Inline editor for an idea or note. Kind, title, content and project are editable; deletion is a
// second, explicit step with its own confirmation.
import { Check, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { ProjectField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { deleteInboxItem, updateInboxItem } from "@/lib/inbox/actions";
import { inboxTypeLabels } from "@/lib/inbox/feed";
import {
  CAPTURE_CONTENT_MAX_LENGTH,
  CAPTURE_KINDS,
  CAPTURE_TITLE_MAX_LENGTH,
  type CaptureKind,
  type InboxCaptureEntry,
} from "@/lib/inbox/types";
import { projectChoices } from "@/lib/projects/projects";
import type { ProjectOption } from "@/lib/projects/types";

const KIND_OPTIONS = CAPTURE_KINDS.map((kind) => ({ value: kind, label: inboxTypeLabels[kind] }));

const inputClass =
  "w-full rounded-md border border-charcoal/15 bg-paper px-3 text-[15px] text-charcoal outline-none focus:border-charcoal/40";
const labelClass = "font-mono text-[10px] uppercase tracking-[0.14em] text-graphite";

type InboxCaptureEditorProps = {
  entry: InboxCaptureEntry;
  /** All of the user's projects; narrowed to assignable ones plus the current project. */
  projects: ProjectOption[];
  onClose: () => void;
};

export function InboxCaptureEditor({ entry, projects, onClose }: InboxCaptureEditorProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<CaptureKind>(entry.kind);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefix = `edit-capture-${entry.id}`;
  const noun = inboxTypeLabels[entry.kind].toLowerCase();

  // onSubmit rather than a form action: React resets form fields after an action, which would
  // discard the user's edits when saving fails.
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await updateInboxItem(entry.id, formData);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteInboxItem(entry.id);
      // On success the revalidated feed no longer contains this row.
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
      }
    });
  }

  return (
    <form onSubmit={save} aria-label={`Editar ${noun}`} aria-busy={pending} className="flex flex-col gap-4 py-4">
      <ChoiceGroup
        id={`${prefix}-kind`}
        label="Tipo"
        name="kind"
        options={KIND_OPTIONS}
        value={kind}
        onChange={(value) => setKind(value as CaptureKind)}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor={`${prefix}-title`} className={labelClass}>
          Título<span className="text-graphite/60"> · Opcional</span>
        </label>
        <input
          id={`${prefix}-title`}
          name="title"
          type="text"
          autoFocus
          autoComplete="off"
          maxLength={CAPTURE_TITLE_MAX_LENGTH}
          defaultValue={entry.title ?? ""}
          className={`h-11 ${inputClass}`}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${prefix}-content`} className={labelClass}>
          Contenido<span className="text-graphite/60"> · Opcional</span>
        </label>
        <textarea
          id={`${prefix}-content`}
          name="content"
          rows={4}
          maxLength={CAPTURE_CONTENT_MAX_LENGTH}
          defaultValue={entry.content ?? ""}
          className={`min-h-[6rem] resize-y py-2.5 leading-[1.5] ${inputClass}`}
        />
      </div>

      <ProjectField idPrefix={prefix} projects={projectChoices(projects, entry.projectId)} initial={entry.projectId} />

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      {confirmingDelete ? (
        <div role="group" aria-labelledby={`${prefix}-delete`} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
          <p id={`${prefix}-delete`} className="text-[14px] leading-[1.5]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Eliminar {noun}</span>
            <span className="mt-1 block text-graphite">Esta acción no se puede deshacer.</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={remove} disabled={pending} icon={Trash2}>
              Eliminar
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)} disabled={pending} autoFocus>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-charcoal/10 pt-4">
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={pending} icon={Check}>
              Guardar
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
          </div>
          <Button variant="secondary" onClick={() => setConfirmingDelete(true)} disabled={pending} icon={Trash2}>
            Eliminar {noun}
          </Button>
        </div>
      )}
    </form>
  );
}
