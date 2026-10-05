// Static placeholder content. Replaced by real sources in later phases.

import type { AssistantMessage } from "@/lib/assistant/types";
import type { CalendarEvent, ISODate } from "@/lib/calendar/types";
import type { InboxItem } from "@/lib/inbox/types";

/** Mocked "now" for the screens that still use mock data (Calendar, Inbox, Assistant). */
export const today: ISODate = "2026-10-05";

export const calendarEvents: CalendarEvent[] = [
  { id: "ev-01", title: "Taller de Proyectos", date: "2026-10-05", startTime: "10:00", endTime: "13:00", location: "Aula 3.2 · Arquitectura", course: "Taller de Proyectos", category: "arquitectura", kind: "event", projectId: "taller-proyectos", source: "manual" },
  { id: "ev-02", title: "Imprimir A1", date: "2026-10-05", startTime: "14:00", location: "Copycenter", category: "arquitectura", kind: "event", source: "manual" },
  { id: "ev-03", title: "Observación astronómica", date: "2026-10-05", startTime: "18:00", endTime: "22:00", location: "Roque de los Muchachos", category: "astronomia", kind: "event", projectId: "astronomia", source: "manual" },
  { id: "ev-04", title: "Tutoría", date: "2026-10-07", startTime: "11:00", endTime: "11:30", location: "Despacho 2.14", course: "Taller de Proyectos", category: "universidad", kind: "event", projectId: "taller-proyectos", source: "manual" },
  { id: "ev-05", title: "Entrega de planos", date: "2026-10-07", startTime: "13:00", course: "Taller de Dibujo", category: "arquitectura", kind: "deadline", projectId: "dibujo-integrado-iii", source: "manual" },
  { id: "ev-06", title: "Reunión de grupo", date: "2026-10-09", startTime: "17:00", endTime: "18:30", location: "Biblioteca · Sala 4", category: "universidad", kind: "event", source: "manual" },
  { id: "ev-07", title: "Análisis territorial", date: "2026-10-12", startTime: "23:59", course: "Taller de Proyectos", category: "arquitectura", kind: "deadline", projectId: "taller-proyectos", source: "manual" },
  { id: "ev-08", title: "Crítica de proyecto", date: "2026-10-15", startTime: "09:30", endTime: "13:30", location: "Aula 3.2 · Arquitectura", course: "Taller de Proyectos", category: "arquitectura", kind: "event", projectId: "taller-proyectos", source: "manual" },
  { id: "ev-09", title: "Examen de estructuras", date: "2026-10-19", startTime: "09:00", endTime: "12:00", location: "Aula Magna", course: "Estructuras I", category: "universidad", kind: "event", source: "manual" },
  { id: "ev-10", title: "Entrega maqueta", date: "2026-10-23", startTime: "10:00", course: "Taller de Proyectos", category: "arquitectura", kind: "deadline", projectId: "taller-proyectos", source: "manual" },
  { id: "ev-11", title: "Observación astronómica", date: "2026-10-26", startTime: "21:00", location: "Roque de los Muchachos", category: "astronomia", kind: "event", projectId: "astronomia", source: "manual" },
  { id: "ev-12", title: "Entrega final", date: "2026-10-30", startTime: "12:00", course: "Taller de Proyectos", category: "arquitectura", kind: "deadline", projectId: "taller-proyectos", source: "manual" },
];

/**
 * Names for the project slugs referenced by the mock calendar, inbox and assistant data. These are
 * NOT real projects (those live in public.projects, with UUIDs); they only label mock content.
 */
export const mockProjectNames: Record<string, string> = {
  "taller-proyectos": "Taller de Proyectos",
  "dibujo-integrado-iii": "Taller de Dibujo Integrado III",
  astronomia: "Astronomía",
  traza: "TRAZA",
};

/** Most recent capture first. */
export const inboxItems: InboxItem[] = [
  { id: "in-01", type: "task", title: "Comprar cartón pluma", createdAt: "2026-10-05T09:40", dueDate: "2026-10-05", project: "Arquitectura", tags: ["maqueta"], source: "manual" },
  { id: "in-02", type: "task", title: "Preguntar a Orlando por los detalles de la maqueta", createdAt: "2026-10-05T09:12", dueDate: "2026-10-06", project: "Taller de Dibujo", tags: ["maqueta"], projectId: "dibujo-integrado-iii", source: "manual" },
  { id: "in-03", type: "idea", title: "Vivienda experimental semienterrada en Ucanca", content: "Excavar en la ladera para aprovechar la inercia térmica del terreno.", createdAt: "2026-10-05T08:30", project: "Taller de Proyectos", tags: ["vivienda", "paisaje"], projectId: "taller-proyectos", source: "manual" },
  { id: "in-04", type: "note", title: "Investigar telescopios de campo amplio", createdAt: "2026-10-05T07:55", project: "Astronomía", tags: ["equipo"], projectId: "astronomia", source: "manual" },
  { id: "in-05", type: "task", title: "Terminar módulo de autenticación", createdAt: "2026-10-04T22:10", dueDate: "2026-10-06", project: "Programación", tags: [], projectId: "traza", source: "manual" },
  { id: "in-06", type: "note", title: "Posibles referencias arquitectónicas para el taller", createdAt: "2026-10-04T18:05", project: "Arquitectura", tags: ["referencias"], source: "manual" },
];

export const assistantConversation: AssistantMessage[] = [
  {
    id: "msg-01",
    role: "user",
    content: "Recuérdame entregar Taller el jueves y apunta que tengo que imprimir el A1.",
    createdAt: "2026-10-05T10:42",
  },
  {
    id: "msg-02",
    role: "assistant",
    content: "He entendido lo siguiente.",
    createdAt: "2026-10-05T10:42",
    proposedActions: [
      { id: "act-01", type: "event", title: "Entrega Taller de Proyectos", date: "2026-10-08", startTime: "23:59", projectId: "taller-proyectos", source: "ai" },
      { id: "act-02", type: "task", title: "Imprimir A1", date: "2026-10-07", projectId: "taller-proyectos", source: "ai" },
    ],
  },
  {
    id: "msg-03",
    role: "assistant",
    content: "También puedo añadir ubicación, notas o recordatorios.",
    createdAt: "2026-10-05T10:42",
    suggestions: ["Añadir ubicación", "Recordar el miércoles por la mañana"],
  },
];
