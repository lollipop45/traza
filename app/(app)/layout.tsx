import { requireUser } from "@/lib/auth/session";

/**
 * Private TRAZA app. proxy.ts already redirects signed-out visitors; this server-side check is the
 * second, independent layer so that no page renders without verified claims.
 */
export default async function PrivateLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return children;
}
