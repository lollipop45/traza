// Notification preferences: types, defaults and validation. Pure. Stored in
// public.notification_preferences (no row = these defaults).

export type NotificationPreferences = {
  /** Master switch for every device (devices keep their subscriptions). */
  pushEnabled: boolean;
  /** 20:00 Atlantic/Canary: tasks due tomorrow. */
  tomorrowTasks: boolean;
  /** 08:00 Atlantic/Canary: tasks due today and overdue. */
  morningSummary: boolean;
  /** Before timed calendar events. */
  eventReminders: boolean;
  eventLeadMinutes: EventLeadMinutes;
  /** Lock-screen privacy: false = counts only; true = titles as well. */
  showDetails: boolean;
};

export const EVENT_LEAD_MINUTES = [10, 15, 30, 60, 120] as const;
export type EventLeadMinutes = (typeof EVENT_LEAD_MINUTES)[number];

/** Privacy-conscious defaults: deadline and event reminders on, no titles on the lock screen. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  tomorrowTasks: true,
  morningSummary: false,
  eventReminders: true,
  eventLeadMinutes: 60,
  showDetails: false,
};

export function isEventLeadMinutes(value: unknown): value is EventLeadMinutes {
  return typeof value === "number" && (EVENT_LEAD_MINUTES as readonly number[]).includes(value);
}

/** A database row (or null) → preferences; anything unexpected falls back to the default. */
export function preferencesFromRow(
  row: {
    push_enabled: boolean;
    tomorrow_tasks: boolean;
    morning_summary: boolean;
    event_reminders: boolean;
    event_lead_minutes: number;
    show_details: boolean;
  } | null,
): NotificationPreferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    pushEnabled: row.push_enabled,
    tomorrowTasks: row.tomorrow_tasks,
    morningSummary: row.morning_summary,
    eventReminders: row.event_reminders,
    eventLeadMinutes: isEventLeadMinutes(row.event_lead_minutes) ? row.event_lead_minutes : DEFAULT_PREFERENCES.eventLeadMinutes,
    showDetails: row.show_details,
  };
}

/**
 * The preferences form (checkboxes + one select). Unchecked boxes are absent from FormData, so
 * absence means false; the lead time must be one of the offered values.
 */
export function parsePreferencesForm(form: { get(name: string): unknown }): NotificationPreferences | null {
  const on = (name: string) => form.get(name) === "on";
  const lead = Number(form.get("eventLeadMinutes"));
  if (!isEventLeadMinutes(lead)) return null;
  return {
    pushEnabled: on("pushEnabled"),
    tomorrowTasks: on("tomorrowTasks"),
    morningSummary: on("morningSummary"),
    eventReminders: on("eventReminders"),
    eventLeadMinutes: lead,
    showDetails: on("showDetails"),
  };
}
