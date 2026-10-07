import { addDays } from "@/lib/calendar/dates";
import type { ISODate } from "@/lib/calendar/types";
import { canaryNow, upcomingDays, weekOf, type AssistantNow } from "./clock";

// The deliberate, bounded projection of the user's TRAZA data that the model sees. Never raw rows:
// no database ids, no user id, no external (Canvas/Google) ids, no tokens, no emails, no errors.
// Projects are named by a short reference (P1, P2, …) that only this request understands; the
// server maps a reference in the model's answer back to the project id it stands for.
//
// Every text in here is the user's or an integration's content (task titles, Canvas assignment
// names, Google event titles, notes) and is passed as DATA: the prompt states that nothing in it
// can change the instructions.

/** What context-store.ts reads (the signed-in user's own rows only). */
export type ContextSource = {
  projects: { id: string; name: string; status: string; area: string | null }[];
  tasks: { title: string; status: string; due_date: string | null; priority: string; project_id: string | null; source: string; completed_at: string | null }[];
  events: {
    title: string;
    event_date: string;
    start_time: string | null;
    end_time: string | null;
    all_day: boolean;
    location: string | null;
    project_id: string | null;
    source: string;
  }[];
  inbox: { kind: string; title: string | null; content: string | null; project_id: string | null; created_at: string }[];
};

export const CONTEXT_LIMITS = {
  projects: 40,
  pendingTasks: 80,
  completedTasks: 15,
  /** Completed tasks are recent ones only. */
  completedDays: 14,
  events: 60,
  /** Events from yesterday to this many days ahead. */
  eventDaysAhead: 60,
  inbox: 15,
  title: 200,
  excerpt: 300,
} as const;

export type AssistantContext = {
  ahora: { fecha: ISODate; dia: string; hora: string; zona: "Atlantic/Canary" };
  dias: { fecha: ISODate; dia: string }[];
  semanas: { estaSemana: { desde: ISODate; hasta: ISODate }; semanaQueViene: { desde: ISODate; hasta: ISODate } };
  proyectos: { ref: string; nombre: string; estado: string; area?: string }[];
  tareasPendientes: { titulo: string; fecha?: ISODate; vencida?: true; prioridad?: string; proyecto?: string; campus?: true }[];
  tareasHechasRecientes: { titulo: string; fecha?: ISODate; proyecto?: string }[];
  eventos: { titulo: string; fecha: ISODate; inicio?: string; fin?: string; todoElDia?: true; lugar?: string; proyecto?: string; google?: true }[];
  inbox: { tipo: string; titulo?: string; extracto?: string; proyecto?: string }[];
  /** True when a list was cut at its limit. */
  recortado?: string[];
};

export type BuiltContext = {
  context: AssistantContext;
  /** "P3" → project id, for resolving the model's projectRef. Only listed projects. */
  projectRefs: Map<string, string>;
  /** The user's project ids (every status), for validation. */
  projectIds: Set<string>;
  /** Project id → name, for display. */
  projectNames: Map<string, string>;
  today: ISODate;
};

function clip(value: string | null, max: number): string | undefined {
  if (!value) return undefined;
  const single = value.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  const chars = [...single];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : single;
}

/** Accent- and case-insensitive form, for matching project names in the user's message. */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Projects the message names (whole name, accent/case-insensitive). Used to focus the context. */
export function mentionedProjects(message: string, projects: ContextSource["projects"]): Set<string> {
  const folded = fold(message);
  return new Set(projects.filter((project) => project.name.trim().length >= 3 && folded.includes(fold(project.name.trim()))).map((project) => project.id));
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id);

export function buildAssistantContext(source: ContextSource, now: Date, message: string): BuiltContext {
  const clock: AssistantNow = canaryNow(now);
  const today = clock.date;
  const projectNames = new Map(source.projects.map((project) => [project.id, project.name]));
  const projectIds = new Set(source.projects.map((project) => project.id));
  const focus = mentionedProjects(message, source.projects);
  const cut: string[] = [];
  const limit = <T>(list: T[], max: number, name: string): T[] => {
    if (list.length > max) cut.push(name);
    return list.slice(0, max);
  };

  // Projects: active and planned (archived ones are not offered for new items), stable references.
  const listed = limit(source.projects.filter((project) => project.status !== "archived").sort(byName), CONTEXT_LIMITS.projects, "proyectos");
  const refById = new Map(listed.map((project, i) => [project.id, `P${i + 1}`]));
  const projectRefs = new Map(listed.map((project, i) => [`P${i + 1}`, project.id]));
  const projectLabel = (id: string | null) => (id ? clip(projectNames.get(id) ?? null, CONTEXT_LIMITS.title) : undefined);

  // Pending tasks: the named project first, then by date (overdue first, undated last).
  const pending = source.tasks
    .filter((task) => task.status !== "done")
    .sort(
      (a, b) =>
        Number(focus.has(b.project_id ?? "")) - Number(focus.has(a.project_id ?? "")) ||
        (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
        a.title.localeCompare(b.title, "es"),
    );
  const since = addDays(today, -CONTEXT_LIMITS.completedDays);
  const completed = source.tasks
    .filter((task) => task.status === "done" && task.completed_at && task.completed_at.slice(0, 10) >= since)
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

  const from = addDays(today, -1);
  const until = addDays(today, CONTEXT_LIMITS.eventDaysAhead);
  const events = source.events
    .filter((event) => event.event_date >= from && event.event_date <= until)
    .sort(
      (a, b) =>
        Number(focus.has(b.project_id ?? "")) - Number(focus.has(a.project_id ?? "")) ||
        a.event_date.localeCompare(b.event_date) ||
        (a.start_time ?? "").localeCompare(b.start_time ?? ""),
    );
  const inbox = [...source.inbox].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const week = weekOf(today);
  const nextWeek = weekOf(addDays(week.to, 1));

  const context: AssistantContext = {
    ahora: { fecha: today, dia: clock.weekday, hora: clock.time, zona: "Atlantic/Canary" },
    dias: upcomingDays(today).map(({ date, weekday }) => ({ fecha: date, dia: weekday })),
    semanas: { estaSemana: { desde: week.from, hasta: week.to }, semanaQueViene: { desde: nextWeek.from, hasta: nextWeek.to } },
    proyectos: listed.map((project) => ({
      ref: refById.get(project.id)!,
      nombre: clip(project.name, CONTEXT_LIMITS.title)!,
      estado: project.status === "planned" ? "planificado" : "activo",
      ...(project.area ? { area: clip(project.area, 60) } : {}),
    })),
    tareasPendientes: limit(pending, CONTEXT_LIMITS.pendingTasks, "tareasPendientes").map((task) => ({
      titulo: clip(task.title, CONTEXT_LIMITS.title)!,
      ...(task.due_date ? { fecha: task.due_date } : {}),
      ...(task.due_date && task.due_date < today ? { vencida: true as const } : {}),
      ...(task.priority !== "normal" ? { prioridad: task.priority === "high" ? "alta" : "baja" } : {}),
      ...(task.project_id ? { proyecto: projectLabel(task.project_id) } : {}),
      ...(task.source === "canvas" ? { campus: true as const } : {}),
    })),
    tareasHechasRecientes: limit(completed, CONTEXT_LIMITS.completedTasks, "tareasHechasRecientes").map((task) => ({
      titulo: clip(task.title, CONTEXT_LIMITS.title)!,
      ...(task.due_date ? { fecha: task.due_date } : {}),
      ...(task.project_id ? { proyecto: projectLabel(task.project_id) } : {}),
    })),
    eventos: limit(events, CONTEXT_LIMITS.events, "eventos").map((event) => ({
      titulo: clip(event.title, CONTEXT_LIMITS.title)!,
      fecha: event.event_date,
      ...(event.all_day ? { todoElDia: true as const } : {}),
      ...(!event.all_day && event.start_time ? { inicio: event.start_time.slice(0, 5) } : {}),
      ...(!event.all_day && event.end_time ? { fin: event.end_time.slice(0, 5) } : {}),
      ...(event.location ? { lugar: clip(event.location, CONTEXT_LIMITS.title) } : {}),
      ...(event.project_id ? { proyecto: projectLabel(event.project_id) } : {}),
      ...(event.source === "google-calendar" ? { google: true as const } : {}),
    })),
    inbox: limit(inbox, CONTEXT_LIMITS.inbox, "inbox").map((item) => ({
      tipo: item.kind === "idea" ? "idea" : "nota",
      ...(item.title ? { titulo: clip(item.title, CONTEXT_LIMITS.title) } : {}),
      ...(item.content ? { extracto: clip(item.content, CONTEXT_LIMITS.excerpt) } : {}),
      ...(item.project_id ? { proyecto: projectLabel(item.project_id) } : {}),
    })),
    ...(cut.length > 0 ? { recortado: cut } : {}),
  };
  return { context, projectRefs, projectIds, projectNames, today };
}
