import { GoogleCalendarAutoSyncTrigger } from "@/components/calendar/GoogleCalendarAutoSyncTrigger";
import { CanvasAutoSyncTrigger } from "@/components/canvas/CanvasAutoSyncTrigger";
import { requireUser } from "@/lib/auth/session";
import { isCanvasConfigured } from "@/lib/canvas/queries";
import { isGoogleCalendarConfigured } from "@/lib/google-calendar/queries";

/**
 * Private TRAZA app. proxy.ts already redirects signed-out visitors; this server-side check is the
 * second, independent layer so that no page renders without verified claims.
 *
 * The automatic Canvas and Google Calendar checks live here, so they run on every private page
 * (never on /login) and stay mounted across navigation. Each is rendered only when its integration
 * is configured on the server. They are independent client effects: neither blocks rendering,
 * neither waits for the other, and a failure of one never stops the other.
 */
export default async function PrivateLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return (
    <>
      {children}
      {isCanvasConfigured() && <CanvasAutoSyncTrigger />}
      {isGoogleCalendarConfigured() && <GoogleCalendarAutoSyncTrigger />}
    </>
  );
}
