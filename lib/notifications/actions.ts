"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { deliverToUser } from "./delivery";
import { createDeliveryDeps } from "./deps";
import { TEST_PAYLOAD } from "./payload";
import { parsePreferencesForm } from "./preferences";
import { savePreferences } from "./store";

// Server Actions for notification settings (Server Actions verify the session and reject
// cross-origin requests). The browser sends only the form fields; the user always comes from the
// session. Results are fixed Spanish sentences: never push-service errors, endpoints or keys.

export type NotificationActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function saveNotificationPreferences(_previous: NotificationActionResult | null, form: FormData): Promise<NotificationActionResult> {
  await requireUser();
  const preferences = parsePreferencesForm(form);
  if (!preferences) return { ok: false, error: "Revisa las preferencias." };
  if (!(await savePreferences(preferences))) return { ok: false, error: "No se han podido guardar las preferencias." };
  revalidatePath("/settings");
  return { ok: true, message: "Preferencias guardadas." };
}

/** "Enviar notificación de prueba": a fixed message to the user's own devices only. Creates nothing. */
export async function sendTestNotification(): Promise<NotificationActionResult> {
  const user = await requireUser();
  const deps = createDeliveryDeps(user.id);
  if (!deps) return { ok: false, error: "Las notificaciones no están configuradas en el servidor." };
  const report = await deliverToUser(deps, TEST_PAYLOAD);
  revalidatePath("/settings");
  if (report.sent > 0) {
    return { ok: true, message: report.sent === 1 ? "Notificación enviada a 1 dispositivo." : `Notificación enviada a ${report.sent} dispositivos.` };
  }
  switch (report.code) {
    case "no_subscriptions":
      return { ok: false, error: "No hay ningún dispositivo con notificaciones activas." };
    case "expired_subscription":
      return { ok: false, error: "La suscripción de este dispositivo ha caducado. Vuelve a activar las notificaciones." };
    case "push_rejected":
      return { ok: false, error: "El servicio de notificaciones ha rechazado el envío. Revisa la configuración del servidor." };
    default:
      return { ok: false, error: "No se ha podido enviar ahora. Inténtalo de nuevo más tarde." };
  }
}
