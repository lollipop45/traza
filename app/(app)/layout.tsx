import { CanvasAutoSyncTrigger } from "@/components/canvas/CanvasAutoSyncTrigger";
import { requireUser } from "@/lib/auth/session";
import { isCanvasConfigured } from "@/lib/canvas/queries";

/**
 * Private TRAZA app. proxy.ts already redirects signed-out visitors; this server-side check is the
 * second, independent layer so that no page renders without verified claims.
 *
 * The automatic Canvas check lives here, so it runs on every private page (never on /login) and
 * stays mounted across navigation. It is only rendered when Canvas is configured on the server.
 */
export default async function PrivateLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return (
    <>
      {children}
      {isCanvasConfigured() && <CanvasAutoSyncTrigger />}
    </>
  );
}
