import { APP_TIME_ZONE, addDays } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { instantOfWallClock, wallClockAt } from "@/lib/google-calendar/time";
import { buildPayload, clip, type NotificationKind, type PushPayload } from "./payload";
import type { NotificationPreferences } from "./preferences";

// Which notifications are due right now. PURE and deterministic: preferences + the user's tasks and
// events + an instant → a list of reminders, each with a stable dedupe key. All calendar semantics
// are Atlantic/Canary wall-clock time (never the server's zone): the planner turns "now" into a
// Canary date and time first. It does not send or store anything; lib/notifications/run.ts claims
// each reminder by its key (durable dedupe) and delivers it. Invoked while the app is open and by
// the trusted scheduler while it is closed, unchanged.
//
//   tomorrow_tasks   from 20:00 until midnight: pending tasks due tomorrow (by date; tasks have no time).
//   morning_summary  from 08:00 until 12:00: pending tasks due today, plus overdue ones.
//   event_reminder   timed calendar events (any origin), `lead` minutes before they start; sent at most
//                    EVENT_GRACE_MINUTES late and never once the event has started. All-day events
//                    have no time and get no reminder.
// Titles appear only when show_details is on; otherwise counts only ("Tienes 2 tareas para mañana.").

export const TOMORROW_TASKS_FROM = "20:00";
export const MORNING_SUMMARY_FROM = "08:00";
export const MORNING_SUMMARY_UNTIL = "12:00";
export const EVENT_GRACE_MINUTES = 30;
const TITLES_IN_DETAIL = 2;

export type PlannerTask = { id: string; title: string; status: string; due_date: ISODate | null };
export type PlannerEvent = { id: string; title: string; event_date: ISODate; start_time: string | null; all_day: boolean };

export type PlannedNotification = {
  kind: Exclude<NotificationKind, "test">;
  /** Stable identity (never a title): one reminder is sent at most once. */
  dedupeKey: string;
  /** When it was due (ISO instant). */
  scheduledFor: string;
  eventId: string | null;
  payload: PushPayload;
};

export type PlanInput = {
  now: number;
  preferences: NotificationPreferences;
  tasks: PlannerTask[];
  events: PlannerEvent[];
  timeZone?: string;
};

const pending = (task: PlannerTask) => task.status !== "done";
const tasksWord = (n: number) => (n === 1 ? "1 tarea" : `${n} tareas`);

/** "Panel final, Lámina 3 y 2 más" */
function titleList(tasks: PlannerTask[]): string {
  const names = tasks.slice(0, TITLES_IN_DETAIL).map((task) => clip(task.title, 50));
  const rest = tasks.length - names.length;
  return rest > 0 ? `${names.join(", ")} y ${rest} más` : names.join(" y ");
}

function byTitle(a: PlannerTask, b: PlannerTask) {
  return a.title.localeCompare(b.title, "es") || a.id.localeCompare(b.id);
}

export function planNotifications(input: PlanInput): PlannedNotification[] {
  const { preferences, now } = input;
  const timeZone = input.timeZone ?? APP_TIME_ZONE;
  if (!preferences.pushEnabled) return [];
  const local = wallClockAt(now, timeZone);
  const today = local.date;
  const planned: PlannedNotification[] = [];
  const iso = (instant: number) => new Date(instant).toISOString();

  // ---- The evening before: tasks due tomorrow ----
  if (preferences.tomorrowTasks && local.time >= TOMORROW_TASKS_FROM) {
    const tomorrow = addDays(today, 1);
    const due = input.tasks.filter((task) => pending(task) && task.due_date === tomorrow).sort(byTitle);
    if (due.length > 0) {
      planned.push({
        kind: "tomorrow_tasks",
        dedupeKey: `tomorrow_tasks:${tomorrow}`,
        scheduledFor: iso(instantOfWallClock(today, TOMORROW_TASKS_FROM, timeZone)),
        eventId: null,
        payload: buildPayload({
          body: preferences.showDetails ? `Mañana: ${titleList(due)}.` : `Tienes ${tasksWord(due.length)} para mañana.`,
          url: "/",
          tag: `tomorrow-${tomorrow}`,
          kind: "tomorrow_tasks",
        }),
      });
    }
  }

  // ---- The morning: today's and overdue tasks ----
  if (preferences.morningSummary && local.time >= MORNING_SUMMARY_FROM && local.time < MORNING_SUMMARY_UNTIL) {
    const dueToday = input.tasks.filter((task) => pending(task) && task.due_date === today).sort(byTitle);
    const overdue = input.tasks.filter((task) => pending(task) && task.due_date !== null && task.due_date < today);
    if (dueToday.length + overdue.length > 0) {
      const late = overdue.length === 0 ? "" : overdue.length === 1 ? "1 vencida" : `${overdue.length} vencidas`;
      const body = preferences.showDetails && dueToday.length > 0
        ? `Hoy: ${titleList(dueToday)}.${late ? ` Además, ${late}.` : ""}`
        : dueToday.length > 0
          ? `Hoy tienes ${tasksWord(dueToday.length)}${late ? ` y ${late}` : ""}.`
          : `Tienes ${overdue.length === 1 ? "1 tarea vencida" : `${overdue.length} tareas vencidas`}.`;
      planned.push({
        kind: "morning_summary",
        dedupeKey: `morning_summary:${today}`,
        scheduledFor: iso(instantOfWallClock(today, MORNING_SUMMARY_FROM, timeZone)),
        eventId: null,
        payload: buildPayload({ body, url: "/", tag: `morning-${today}`, kind: "morning_summary" }),
      });
    }
  }

  // ---- Timed events: `lead` minutes before ----
  if (preferences.eventReminders) {
    const lead = preferences.eventLeadMinutes;
    for (const event of input.events) {
      if (event.all_day || !event.start_time || !/^\d{2}:\d{2}/.test(event.start_time)) continue;
      const time = event.start_time.slice(0, 5);
      const start = instantOfWallClock(event.event_date, time, timeZone);
      const remindAt = start - lead * 60_000;
      if (now < remindAt || now >= start || now - remindAt > EVENT_GRACE_MINUTES * 60_000) continue;
      const startIso = iso(start);
      planned.push({
        kind: "event_reminder",
        dedupeKey: `event:${event.id}:${lead}m:${startIso}`,
        scheduledFor: iso(remindAt),
        eventId: event.id,
        payload: buildPayload({
          body: preferences.showDetails ? `${clip(event.title, 80)} · ${time}` : `Tienes un evento a las ${time}.`,
          url: "/calendar",
          tag: `event-${event.id}`,
          kind: "event_reminder",
        }),
      });
    }
  }
  return planned;
}

/** The task/event range the planner needs around `now` (what the store should load). */
export function plannerRange(now: number, timeZone: string = APP_TIME_ZONE): { today: ISODate; tomorrow: ISODate } {
  const today = wallClockAt(now, timeZone).date;
  return { today, tomorrow: addDays(today, 1) };
}
