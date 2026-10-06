"use client";

// Event panel for creating (?nuevo) or editing (?editar=<id>) a calendar event. Validation and
// writes happen in the Server Actions, which redirect back to the event's day on success.
// Deletion is a second, explicit step with its own confirmation.
import { Check, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { ProjectField } from "@/components/tasks/TaskFields";
import { Button } from "@/components/ui/Button";
import { createEvent, deleteEvent, updateEvent } from "@/lib/calendar/actions";
import { formatShortDate } from "@/lib/calendar/dates";
import {
  EVENT_DESCRIPTION_MAX_LENGTH,
  EVENT_LOCATION_MAX_LENGTH,
  EVENT_TITLE_MAX_LENGTH,
  isGoogleEvent,
  type CalendarEventRecord,
  type ISODate,
} from "@/lib/calendar/types";
import { projectChoices } from "@/lib/projects/projects";
import type { ProjectOption } from "@/lib/projects/types";

const inputClass =
  "rounded-md border border-charcoal/15 bg-paper px-3 text-[15px] text-charcoal outline-none focus:border-charcoal/40";

type EventFormProps = {
  /** A new event on `date`, or an existing event to edit. */
  mode: { kind: "create"; date: ISODate } | { kind: "edit"; event: CalendarEventRecord };
  /** All of the user's projects; narrowed to assignable ones plus the event's current project. */
  projects: ProjectOption[];
  /** Where "Cancelar" goes: the same day, without the panel. */
  closeHref: string;
  /** Google Calendar is connected: deleting a TRAZA event also removes its Google copy on the next sync. */
  googleConnected?: boolean;
};

export function EventForm(props: EventFormProps) {
  // Google-origin events: Google owns the synced fields, so they are shown, not edited.
  if (props.mode.kind === "edit" && isGoogleEvent(props.mode.event)) {
    return <GoogleEventPanel event={props.mode.event} projects={props.projects} closeHref={props.closeHref} />;
  }
  return <TrazaEventForm {...props} />;
}

function TrazaEventForm({ mode, projects, closeHref, googleConnected = false }: EventFormProps) {
  const event = mode.kind === "edit" ? mode.event : null;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefix = event ? `edit-event-${event.id}` : "new-event";
  const headingId = `${prefix}-heading`;

  // onSubmit rather than a form action, so a failed attempt keeps what was typed.
  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const formData = new FormData(formEvent.currentTarget);
    setError(null);
    startTransition(async () => {
      // On success the action redirects to the event's day, closing this panel.
      const result = event ? await updateEvent(event.id, formData) : await createEvent(formData);
      if (!result.ok) setError(result.error);
    });
  }

  function remove() {
    if (!event) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteEvent(event.id);
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-labelledby={headingId}
      aria-busy={pending}
      className="flex flex-col gap-4 border-y border-charcoal/10 py-5"
    >
      <h2 id={headingId} className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">
        {event ? "Editar evento" : "Nuevo evento"}
      </h2>

      <Field id={`${prefix}-title`} label="Título">
        <input
          id={`${prefix}-title`}
          name="title"
          type="text"
          required
          autoFocus
          autoComplete="off"
          maxLength={EVENT_TITLE_MAX_LENGTH}
          defaultValue={event?.title ?? ""}
          className={`h-11 w-full ${inputClass}`}
        />
      </Field>

      <Field id={`${prefix}-date`} label="Fecha">
        <input
          id={`${prefix}-date`}
          name="event_date"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={event?.event_date ?? (mode.kind === "create" ? mode.date : "")}
          className={`h-9 w-fit font-mono text-[13px] ${inputClass}`}
        />
      </Field>

      <label className="inline-flex w-fit cursor-pointer items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal">
        <span className="relative grid size-4 place-items-center">
          <input
            type="checkbox"
            name="all_day"
            checked={allDay}
            onChange={(change) => setAllDay(change.target.checked)}
            className="peer absolute inset-0 cursor-pointer appearance-none rounded-[3px] border border-charcoal/35 bg-paper checked:border-charcoal checked:bg-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
          />
          <Check aria-hidden className="pointer-events-none relative size-3 text-paper opacity-0 peer-checked:opacity-100" strokeWidth={2} />
        </span>
        Todo el día
      </label>

      {!allDay && (
        <div className="flex flex-wrap gap-4">
          <Field id={`${prefix}-start`} label="Inicio">
            <input
              id={`${prefix}-start`}
              name="start_time"
              type="time"
              required
              defaultValue={event?.start_time?.slice(0, 5) ?? ""}
              className={`h-9 w-32 font-mono text-[13px] tabular-nums ${inputClass}`}
            />
          </Field>
          <Field id={`${prefix}-end`} label="Fin" optional>
            <input
              id={`${prefix}-end`}
              name="end_time"
              type="time"
              defaultValue={event?.end_time?.slice(0, 5) ?? ""}
              className={`h-9 w-32 font-mono text-[13px] tabular-nums ${inputClass}`}
            />
          </Field>
        </div>
      )}

      <Field id={`${prefix}-location`} label="Ubicación" optional>
        <input
          id={`${prefix}-location`}
          name="location"
          type="text"
          autoComplete="off"
          maxLength={EVENT_LOCATION_MAX_LENGTH}
          defaultValue={event?.location ?? ""}
          className={`h-11 w-full ${inputClass}`}
        />
      </Field>

      <ProjectField idPrefix={prefix} projects={projectChoices(projects, event?.project_id ?? null)} initial={event?.project_id ?? null} />

      <Field id={`${prefix}-description`} label="Descripción" optional>
        <textarea
          id={`${prefix}-description`}
          name="description"
          rows={2}
          maxLength={EVENT_DESCRIPTION_MAX_LENGTH}
          defaultValue={event?.description ?? ""}
          className={`min-h-[4rem] w-full resize-y py-2.5 leading-[1.5] ${inputClass}`}
        />
      </Field>

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      {confirmingDelete ? (
        <div role="group" aria-labelledby={`${prefix}-delete`} className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
          <p id={`${prefix}-delete`} className="text-[14px] leading-[1.5]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Eliminar evento</span>
            <span className="mt-1 block text-graphite">
              Esta acción no se puede deshacer.
              {googleConnected && " Si está en Google Calendar, su copia se quitará en la próxima sincronización."}
            </span>
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
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={pending} icon={Check}>
              {event ? "Guardar" : "Crear evento"}
            </Button>
            <Link
              href={closeHref}
              scroll={false}
              className="inline-flex h-9 items-center rounded-md border border-charcoal/15 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
            >
              Cancelar
            </Link>
          </div>
          {event && (
            <Button variant="secondary" onClick={() => setConfirmingDelete(true)} disabled={pending} icon={Trash2}>
              Eliminar evento
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

/**
 * A Google-origin event: its synced data is read-only here (it is edited in Google Calendar and the
 * next sync brings the change). Only the TRAZA project can be chosen. No delete: Google owns it.
 */
function GoogleEventPanel({ event, projects, closeHref }: { event: CalendarEventRecord; projects: ProjectOption[]; closeHref: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const prefix = `google-event-${event.id}`;
  const choices = projectChoices(projects, event.project_id);
  const time = event.all_day ? "Todo el día" : [event.start_time?.slice(0, 5), event.end_time?.slice(0, 5)].filter(Boolean).join("–");

  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const formData = new FormData(formEvent.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await updateEvent(event.id, formData);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${prefix}-heading`} aria-busy={pending} className="flex flex-col gap-4 border-y border-charcoal/10 py-5">
      <h2 id={`${prefix}-heading`} className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">
        Evento de Google
      </h2>
      <div className="flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Google Calendar · Datos sincronizados</p>
        <p className="text-[15px] leading-[22px] font-medium tracking-[-0.01em] break-words">{event.title}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
          <dt className="font-mono text-[10px] uppercase leading-[21px] tracking-[0.14em] text-graphite">Fecha</dt>
          <dd>{formatShortDate(event.event_date)}</dd>
          <dt className="font-mono text-[10px] uppercase leading-[21px] tracking-[0.14em] text-graphite">Hora</dt>
          <dd className="font-mono text-[13px] leading-[21px] tabular-nums">{time}</dd>
          {event.location && (
            <>
              <dt className="font-mono text-[10px] uppercase leading-[21px] tracking-[0.14em] text-graphite">Lugar</dt>
              <dd className="break-words">{event.location}</dd>
            </>
          )}
        </dl>
        {event.description && <p className="max-w-[60ch] text-[13px] leading-[1.55] whitespace-pre-line break-words text-graphite">{event.description}</p>}
        <p className="text-[13px] leading-[1.5] text-graphite">Se edita en Google Calendar: TRAZA lo actualiza al sincronizar.</p>
      </div>

      <ProjectField idPrefix={prefix} projects={choices} initial={event.project_id} />

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        {choices.length > 0 && (
          <Button variant="primary" type="submit" disabled={pending} icon={Check}>
            Guardar proyecto
          </Button>
        )}
        <Link
          href={closeHref}
          scroll={false}
          className="inline-flex h-9 items-center rounded-md border border-charcoal/15 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          Cerrar
        </Link>
      </div>
    </form>
  );
}

function Field({ id, label, optional, children }: { id: string; label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
        {label}
        {optional && <span className="text-graphite/60"> · Opcional</span>}
      </label>
      {children}
    </div>
  );
}
