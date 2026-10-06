import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ConnectionMetadata, ConnectionStore, StoredCredentials } from "./connection";

// Supabase access to the signed-in user's own Google Calendar connection. Server-only; callers must
// have verified the session. RLS restricts every statement to the owner's row, the explicit
// user_id filters document intent, and the ciphertext columns are never selected here (clients
// have no SELECT privilege on them): they are read only through get_google_calendar_credentials().
// Errors are not logged: they can echo data.

const TABLE = "google_calendar_connections";
export const CONNECTION_METADATA_COLUMNS = "status, google_account_email, selected_calendar_id, selected_calendar_name";

export function createConnectionStore(userId: string): ConnectionStore {
  return {
    async loadMetadata() {
      const supabase = await createClient();
      const { data, error } = await supabase.from(TABLE).select(CONNECTION_METADATA_COLUMNS).eq("user_id", userId).maybeSingle();
      if (error) return { ok: false };
      const metadata: ConnectionMetadata | null = data
        ? {
            status: data.status,
            accountEmail: data.google_account_email,
            selectedCalendarId: data.selected_calendar_id,
            selectedCalendarName: data.selected_calendar_name,
          }
        : null;
      return { ok: true, metadata };
    },

    async loadCredentials() {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("get_google_calendar_credentials");
      if (error || !Array.isArray(data)) return { ok: false };
      const row = data[0];
      const credentials: StoredCredentials | null =
        row && row.refresh_token_ciphertext
          ? { refreshCiphertext: row.refresh_token_ciphertext, accessCiphertext: row.access_token_ciphertext, accessExpiresAt: row.access_token_expires_at }
          : null;
      return { ok: true, credentials };
    },

    async saveConnection({ accountEmail, refreshCiphertext, accessCiphertext, accessExpiresAt, keepSelection }) {
      const supabase = await createClient();
      const values = {
        google_account_email: accountEmail,
        status: "connected",
        refresh_token_ciphertext: refreshCiphertext,
        access_token_ciphertext: accessCiphertext,
        access_token_expires_at: accessExpiresAt,
        connected_at: new Date().toISOString(),
        ...(keepSelection ? {} : { selected_calendar_id: null, selected_calendar_name: null }),
      };
      // NOT an upsert: INSERT … ON CONFLICT DO UPDATE reads the new values through EXCLUDED, and
      // Postgres requires SELECT privilege on every column read that way — which clients
      // deliberately do not have on the ciphertext columns ("permission denied"). So: update the
      // existing row (reconnection), otherwise insert it. RETURNING only `id` (selectable).
      const update = () => supabase.from(TABLE).update(values).eq("user_id", userId).select("id");
      const updated = await update();
      if (updated.error) return false;
      if (updated.data.length === 1) return true;

      const inserted = await supabase.from(TABLE).insert(values);
      if (!inserted.error) return true;
      // A concurrent callback inserted first (unique user_id): update that row instead.
      if (inserted.error.code === "23505") {
        const retried = await update();
        return !retried.error && retried.data.length === 1;
      }
      return false;
    },

    async saveAccessToken({ accessCiphertext, accessExpiresAt, refreshCiphertext }) {
      const supabase = await createClient();
      const { error } = await supabase
        .from(TABLE)
        .update({
          access_token_ciphertext: accessCiphertext,
          access_token_expires_at: accessExpiresAt,
          ...(refreshCiphertext ? { refresh_token_ciphertext: refreshCiphertext } : {}),
        })
        .eq("user_id", userId)
        .eq("status", "connected");
      return !error;
    },

    async markRevoked() {
      const supabase = await createClient();
      const { error } = await supabase
        .from(TABLE)
        .update({ status: "revoked", refresh_token_ciphertext: null, access_token_ciphertext: null, access_token_expires_at: null })
        .eq("user_id", userId);
      return !error;
    },

    async saveSelectedCalendar(calendarId, calendarName) {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from(TABLE)
        .update({ selected_calendar_id: calendarId, selected_calendar_name: calendarName })
        .eq("user_id", userId)
        .eq("status", "connected")
        .select("id");
      return !error && data.length === 1;
    },

    async deleteConnection() {
      const supabase = await createClient();
      const { error } = await supabase.from(TABLE).delete().eq("user_id", userId);
      return !error;
    },
  };
}
