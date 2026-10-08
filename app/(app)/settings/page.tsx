import type { Metadata } from "next";
import { DeviceSection } from "@/components/pwa/DeviceSection";
import { NotificationPreferencesForm } from "@/components/pwa/NotificationPreferencesForm";
import { AppShell } from "@/components/layout/AppShell";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { requireUser } from "@/lib/auth/session";
import { currentISODate } from "@/lib/calendar/dates";
import { readPushPublicKey } from "@/lib/notifications/env";
import { DEFAULT_PREFERENCES } from "@/lib/notifications/preferences";
import { countSubscriptions, loadPreferences } from "@/lib/notifications/store";

export const metadata: Metadata = {
  title: "Ajustes · TRAZA",
};

export default async function SettingsPage() {
  const user = await requireUser();
  const [preferences, devices] = await Promise.all([loadPreferences(user.id), countSubscriptions(user.id)]);
  // Only the PUBLIC VAPID key reaches the browser (it needs it to subscribe); the private key stays
  // on the server.
  const publicKey = readPushPublicKey();

  return (
    <AppShell activeHref="/settings">
      <div className="relative isolate grid gap-y-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-7">
          <PageHeader title="Ajustes" subtitle="TRAZA en este dispositivo y sus avisos." date={currentISODate()} />
        </div>

        <div className="flex flex-col gap-12 lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <section aria-labelledby="device-heading">
            <SectionHeader index="01" title="Este dispositivo" id="device-heading" />
            <div className="pt-4">
              <DeviceSection publicKey={publicKey} />
            </div>
          </section>

          <section aria-labelledby="preferences-heading">
            <SectionHeader
              index="02"
              title="Avisos"
              id="preferences-heading"
              meta={devices === null ? undefined : devices === 1 ? "1 dispositivo" : `${devices} dispositivos`}
            />
            <div className="pt-3">
              <NotificationPreferencesForm preferences={preferences ?? DEFAULT_PREFERENCES} />
            </div>
          </section>
        </div>

        <aside className="lg:col-span-4 lg:col-start-9 lg:row-start-2">
          <SectionHeader index="00" title="Cómo funciona" id="settings-how-heading" />
          <p className="pt-4 text-[14px] leading-[1.55] text-graphite">
            Las notificaciones se activan en cada dispositivo y solo cuando tú lo pides. Por defecto no muestran títulos en la
            pantalla de bloqueo, solo recuentos. Las horas son de Canarias.
          </p>
          <p className="mt-3 text-[14px] leading-[1.55] text-graphite">
            De momento, los avisos se comprueban mientras TRAZA está abierta. El envío programado con TRAZA cerrada llegará
            con la puesta en producción.
          </p>
          <p className="mt-3 text-[14px] leading-[1.55] text-graphite">
            Sin conexión, TRAZA no muestra datos guardados: tus tareas y eventos solo se cargan desde el servidor.
          </p>
        </aside>
      </div>
    </AppShell>
  );
}
