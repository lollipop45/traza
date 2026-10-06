"use client";

// Google Calendar connection and manual sync. Receives connection METADATA only from the server
// (state, account address, chosen calendar name): never a token. Every action is a Server Action;
// "Conectar" is a form post that redirects to Google's consent screen.
import { Check, Link2, Unlink } from "lucide-react";
import { useState, useTransition } from "react";
import { GoogleSyncPanel } from "@/components/calendar/GoogleSyncPanel";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import {
  disconnectGoogleCalendar,
  listGoogleCalendars,
  selectGoogleCalendar,
  startGoogleCalendarConnection,
  type CalendarListState,
} from "@/lib/google-calendar/actions";
import type { GoogleConnectionStatus } from "@/lib/google-calendar/types";

type GoogleCalendarSectionProps = {
  status: GoogleConnectionStatus;
  /** Result of the OAuth callback (?google=…), already mapped to Spanish on the server. */
  notice: { text: string; success: boolean } | null;
};

const STATE_LABELS: Record<GoogleConnectionStatus["state"], string> = {
  "not-configured": "No configurado",
  disconnected: "No conectado",
  error: "No disponible",
  connected: "Conectado",
  revoked: "Acceso retirado",
};

const labelClass = "font-mono text-[10px] uppercase tracking-[0.14em] text-graphite";

export function GoogleCalendarSection({ status, notice }: GoogleCalendarSectionProps) {
  const [pending, startTransition] = useTransition();
  const [calendars, setCalendars] = useState<CalendarListState | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = status.state === "connected" || status.state === "revoked";

  function openChooser() {
    setError(null);
    startTransition(async () => {
      const result = await listGoogleCalendars();
      setCalendars(result);
      if (result.ok) setChoice(result.selectedId ?? result.calendars[0]?.id ?? "");
    });
  }

  function saveChoice() {
    setError(null);
    startTransition(async () => {
      const result = await selectGoogleCalendar(choice);
      if (result.ok) setCalendars(null);
      else setError(result.error);
    });
  }

  function confirmDisconnect() {
    setError(null);
    startTransition(async () => {
      const result = await disconnectGoogleCalendar();
      if (result.ok) {
        setConfirmingDisconnect(false);
        setCalendars(null);
      } else setError(result.error);
    });
  }

  return (
    <section aria-labelledby="google-heading" aria-busy={pending}>
      <SectionHeader index="04" title="Google Calendar" id="google-heading" meta={STATE_LABELS[status.state]} />

      <div className="flex flex-col gap-4 pt-4">
        {notice && (
          <p role="status" className={`border-l pl-3 text-[13px] leading-[1.5] ${notice.success ? "border-sage text-charcoal" : "border-charcoal text-charcoal"}`}>
            {notice.text}
          </p>
        )}

        {status.state === "not-configured" && (
          <p className="text-[14px] leading-[1.55] text-graphite">Faltan las credenciales de Google en el servidor (docs/supabase.md · Google Calendar).</p>
        )}
        {status.state === "error" && <p className="text-[14px] leading-[1.55] text-graphite">No se ha podido leer la conexión con Google.</p>}

        {status.state === "disconnected" && (
          <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">
            Conecta tu cuenta de Google y elige uno de tus calendarios para sincronizarlo con TRAZA a mano.
          </p>
        )}

        {linked && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
            <dt className={`${labelClass} leading-[21px]`}>Cuenta</dt>
            <dd className="break-all">{status.accountEmail ?? "Cuenta de Google"}</dd>
            <dt className={`${labelClass} leading-[21px]`}>Calendario</dt>
            <dd className="break-words">{status.calendarName ?? <span className="text-graphite">Sin elegir</span>}</dd>
          </dl>
        )}

        {status.state === "revoked" && (
          <p className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
            Google ha retirado el acceso de TRAZA. Vuelve a conectar para seguir.
          </p>
        )}

        {calendars && !calendars.ok && (
          <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
            {calendars.error}
          </p>
        )}

        {calendars?.ok && (
          <fieldset className="flex flex-col gap-2 border-y border-charcoal/10 py-4">
            <legend className={`${labelClass} pb-2`}>Calendario para TRAZA</legend>
            {calendars.calendars.map((calendar) => (
              <label key={calendar.id} className="flex cursor-pointer items-baseline gap-2.5 text-[14px] leading-[20px]">
                <input
                  type="radio"
                  name="google-calendar"
                  value={calendar.id}
                  checked={choice === calendar.id}
                  onChange={() => setChoice(calendar.id)}
                  className="translate-y-[2px] accent-charcoal"
                />
                <span className="break-words">
                  {calendar.name}
                  {calendar.primary && <span className={`${labelClass} ml-2`}>Principal</span>}
                </span>
              </label>
            ))}
            {calendars.notOwned > 0 && (
              <p className="pt-1 text-[13px] text-graphite">
                {calendars.notOwned === 1 ? "1 calendario compartido contigo no aparece" : `${calendars.notOwned} calendarios compartidos contigo no aparecen`}: TRAZA solo
                escribirá en calendarios tuyos.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="primary" onClick={saveChoice} disabled={pending || !choice} icon={Check}>
                Guardar
              </Button>
              <Button variant="secondary" onClick={() => setCalendars(null)} disabled={pending}>
                Cancelar
              </Button>
            </div>
          </fieldset>
        )}

        {error && (
          <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
            {error}
          </p>
        )}

        {status.state === "connected" && status.calendarName && !calendars?.ok && !confirmingDisconnect && <GoogleSyncPanel />}

        {confirmingDisconnect ? (
          <div role="group" aria-labelledby="google-disconnect" className="flex flex-col gap-3 border-t border-charcoal/10 pt-4">
            <p id="google-disconnect" className="text-[14px] leading-[1.5]">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Desconectar Google Calendar</span>
              <span className="mt-1 block text-graphite">
                TRAZA dejará de tener acceso a tu cuenta de Google. No se borra nada: ni tus eventos de TRAZA ni lo que ya esté en Google.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={confirmDisconnect} disabled={pending} icon={Unlink}>
                Desconectar
              </Button>
              <Button variant="secondary" onClick={() => setConfirmingDisconnect(false)} disabled={pending} autoFocus>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(status.state === "disconnected" || status.state === "revoked") && (
              // A real form post: Server Actions reject cross-origin requests, and the redirect to
              // Google happens on the server.
              <form action={startGoogleCalendarConnection}>
                <Button variant={status.state === "disconnected" ? "primary" : "secondary"} type="submit" disabled={pending} icon={Link2}>
                  {status.state === "revoked" ? "Volver a conectar" : "Conectar Google Calendar"}
                </Button>
              </form>
            )}
            {status.state === "connected" && !calendars?.ok && (
              <Button variant={status.calendarName ? "secondary" : "primary"} onClick={openChooser} disabled={pending}>
                {status.calendarName ? "Cambiar calendario" : "Elegir calendario"}
              </Button>
            )}
            {linked && (
              <Button variant="secondary" onClick={() => setConfirmingDisconnect(true)} disabled={pending}>
                Desconectar Google Calendar
              </Button>
            )}
          </div>
        )}

        {pending && <p className={labelClass}>Conectando con Google…</p>}
      </div>
    </section>
  );
}
