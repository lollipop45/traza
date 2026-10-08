import { GoogleCalendarAutoSyncTrigger } from "@/components/calendar/GoogleCalendarAutoSyncTrigger";
import { CanvasAutoSyncTrigger } from "@/components/canvas/CanvasAutoSyncTrigger";
import { NotificationCheckTrigger } from "@/components/pwa/NotificationCheckTrigger";
import { requireUser } from "@/lib/auth/session";
import { isCanvasConfigured } from "@/lib/canvas/queries";
import { isGoogleCalendarConfigured } from "@/lib/google-calendar/queries";
import { readPushPublicKey } from "@/lib/notifications/env";

/**
 * Private TRAZA app. proxy.ts already redirects signed-out visitors; this server-side check is the
 * second, independent layer so that no page renders without verified claims.
 *
 * The automatic Canvas, Google Calendar and reminder checks live here, so they run on every private
 * page (never on /login) and stay mounted across navigation. Each is rendered only when its
 * integration is configured on the server. They are independent client effects: none blocks
 * rendering, none waits for another, and a failure of one never stops the others.
 */
export default async function PrivateLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return (
    <>
      {children}
      {isCanvasConfigured() && <CanvasAutoSyncTrigger />}
      {isGoogleCalendarConfigured() && <GoogleCalendarAutoSyncTrigger />}
      {readPushPublicKey() !== null && <NotificationCheckTrigger />}
    </>
  );
}
