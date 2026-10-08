"use client";

// Notification preferences (all devices). A plain form posted to a Server Action, which takes the
// user from the session and validates every field. Times are Atlantic/Canary.
import { Check } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { saveNotificationPreferences, type NotificationActionResult } from "@/lib/notifications/actions";
import { EVENT_LEAD_MINUTES, type NotificationPreferences } from "@/lib/notifications/preferences";

const labelClass = "font-mono text-[10px] uppercase tracking-[0.14em] text-graphite";

function Toggle({ name, label, hint, defaultChecked }: { name: string; label: string; hint: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-[3px] size-4 shrink-0 accent-charcoal" />
      <span className="min-w-0 text-[14px] leading-[1.45]">
        {label}
        <span className="block text-[13px] text-graphite">{hint}</span>
      </span>
    </label>
  );
}

export function NotificationPreferencesForm({ preferences }: { preferences: NotificationPreferences }) {
  const [result, action, pending] = useActionState<NotificationActionResult | null, FormData>(saveNotificationPreferences, null);

  return (
    <form action={action} aria-busy={pending} className="flex flex-col gap-1">
      <Toggle name="pushEnabled" label="Notificaciones de TRAZA" hint="En todos tus dispositivos activados." defaultChecked={preferences.pushEnabled} />
      <Toggle name="tomorrowTasks" label="Tareas para mañana" hint="La tarde anterior, a las 20:00." defaultChecked={preferences.tomorrowTasks} />
      <Toggle name="morningSummary" label="Resumen de la mañana" hint="A las 08:00: tareas de hoy y vencidas." defaultChecked={preferences.morningSummary} />
      <Toggle name="eventReminders" label="Antes de eventos con hora" hint="Los eventos de todo el día y las tareas no tienen hora." defaultChecked={preferences.eventReminders} />
      <label className="flex flex-wrap items-center gap-3 py-2 pl-7">
        <span className={labelClass}>Antelación</span>
        <select
          name="eventLeadMinutes"
          defaultValue={String(preferences.eventLeadMinutes)}
          className="h-11 rounded-md border border-charcoal/15 bg-paper px-3 font-mono text-[13px] text-charcoal outline-none focus:border-charcoal/40"
        >
          {EVENT_LEAD_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 120 ? "2 h" : `${minutes} min`}
            </option>
          ))}
        </select>
      </label>
      <Toggle
        name="showDetails"
        label="Mostrar títulos en la pantalla de bloqueo"
        hint="Desactivado: solo recuentos («Tienes 2 tareas para mañana»)."
        defaultChecked={preferences.showDetails}
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" type="submit" disabled={pending} icon={Check}>
          Guardar preferencias
        </Button>
        <p role="status" aria-live="polite" className="text-[13px] text-graphite">
          {result ? (result.ok ? result.message : result.error) : ""}
        </p>
      </div>
    </form>
  );
}
