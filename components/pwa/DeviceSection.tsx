"use client";

// "Este dispositivo": install state and Web Push for THIS browser. Reads browser capabilities only
// after hydration; requests notification permission only when the user presses "Activar
// notificaciones"; never shows endpoints, keys or browser internals. States are text, not colour.
import { Bell, BellOff, Download, Send } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { sendTestNotification } from "@/lib/notifications/actions";
import {
  DEVICE_NOTIFICATION_LABELS,
  deviceNotificationState,
  installState,
  isStandalone,
  pushSupport,
} from "@/lib/pwa/device";
import { promptInstall } from "@/lib/pwa/install-prompt";
import { currentSubscription, disableNotifications, enableNotifications, refreshSubscription } from "@/lib/pwa/push-client";
import { useDisplayEnvironment, useInstallPrompt, usePushCapabilities } from "@/lib/pwa/use-device";

const labelClass = "font-mono text-[10px] uppercase tracking-[0.14em] text-graphite";
const stateClass = "font-mono text-[11px] uppercase leading-[21px] tracking-[0.14em] text-charcoal";

type DeviceSectionProps = {
  /** VAPID public key (not a secret), or null when push is not configured on the server. */
  publicKey: string | null;
};

export function DeviceSection({ publicKey }: DeviceSectionProps) {
  const environment = useDisplayEnvironment();
  const prompt = useInstallPrompt();
  const capabilities = usePushCapabilities();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!capabilities?.notification) return;
    let active = true;
    void currentSubscription().then((subscription) => {
      if (!active) return;
      setPermission(Notification.permission);
      setSubscribed(subscription !== null);
      // Keep the server's copy current (it may have been removed as expired meanwhile).
      if (subscription && Notification.permission === "granted") void refreshSubscription(subscription);
    });
    return () => {
      active = false;
    };
  }, [capabilities]);

  if (!environment || !capabilities) {
    return <p className="py-4 text-[14px] text-graphite">Comprobando este dispositivo…</p>;
  }

  const install = prompt === "installed" ? "installed" : installState(environment, prompt === "available");
  const support = pushSupport(environment, capabilities);
  const state = deviceNotificationState(support, permission, subscribed === true);

  function enable() {
    if (!publicKey) return;
    setMessage(null);
    // The permission request runs synchronously inside this click (required on iOS).
    const result = enableNotifications(publicKey);
    startTransition(async () => {
      const outcome = await result;
      setPermission(Notification.permission);
      setSubscribed(outcome === "active");
      if (outcome === "active") setMessage({ text: "Notificaciones activadas en este dispositivo.", ok: true });
      else if (outcome === "denied") setMessage({ text: "Has bloqueado las notificaciones. Puedes permitirlas en los ajustes del navegador.", ok: false });
      else if (outcome === "dismissed") setMessage({ text: "No se ha concedido el permiso.", ok: false });
      else setMessage({ text: "No se han podido activar las notificaciones. Inténtalo de nuevo.", ok: false });
    });
  }

  function disable() {
    setMessage(null);
    startTransition(async () => {
      const ok = await disableNotifications();
      setSubscribed(false);
      setMessage(ok ? { text: "Notificaciones desactivadas en este dispositivo.", ok: true } : { text: "Se ha desactivado aquí, pero no se ha podido avisar al servidor.", ok: false });
    });
  }

  function test() {
    setMessage(null);
    startTransition(async () => {
      const result = await sendTestNotification();
      setMessage(result.ok ? { text: result.message, ok: true } : { text: result.error, ok: false });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[14px]">
        <dt className={`${labelClass} leading-[21px]`}>Instalación</dt>
        <dd className={stateClass}>{install === "installed" || isStandalone(environment) ? "Instalada" : "No instalada"}</dd>
        <dt className={`${labelClass} leading-[21px]`}>Notificaciones</dt>
        <dd className={stateClass} role="status">
          {publicKey ? DEVICE_NOTIFICATION_LABELS[state] : "No configuradas"}
        </dd>
      </dl>

      {install === "prompt" && (
        <div>
          <Button variant="secondary" onClick={() => void promptInstall()} icon={Download}>
            Instalar TRAZA
          </Button>
        </div>
      )}
      {install === "ios" && (
        <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">
          Para instalar TRAZA en el iPhone: Compartir → Añadir a pantalla de inicio. Después ábrela desde el icono.
        </p>
      )}

      {!publicKey ? (
        <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">Las notificaciones no están configuradas en el servidor.</p>
      ) : state === "unsupported" ? (
        <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">Este navegador no admite notificaciones de TRAZA.</p>
      ) : state === "needs-install" ? (
        <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">
          En iPhone, las notificaciones funcionan con TRAZA instalada en la pantalla de inicio (iOS 16.4 o posterior). Instálala y actívalas desde la app.
        </p>
      ) : state === "blocked" ? (
        <p className="max-w-[46ch] text-[14px] leading-[1.55] text-graphite">
          Las notificaciones están bloqueadas para TRAZA. Puedes permitirlas en los ajustes del navegador o del sistema.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {state === "active" ? (
            <>
              <Button variant="secondary" onClick={test} disabled={pending} icon={Send}>
                Enviar notificación de prueba
              </Button>
              <Button variant="secondary" onClick={disable} disabled={pending} icon={BellOff}>
                Desactivar en este dispositivo
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={enable} disabled={pending} icon={Bell}>
              Activar notificaciones
            </Button>
          )}
        </div>
      )}

      <div role="status" aria-live="polite">
        {message && (
          <p className={`border-l pl-3 text-[13px] leading-[1.5] ${message.ok ? "border-sage text-charcoal" : "border-charcoal text-charcoal"}`}>{message.text}</p>
        )}
        {pending && <p className={labelClass}>Un momento…</p>}
      </div>
    </div>
  );
}
