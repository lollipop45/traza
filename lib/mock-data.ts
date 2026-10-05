// Static placeholder content. Replaced by real sources in later phases.

import type { AssistantMessage } from "@/lib/assistant/types";
import type { ISODate } from "@/lib/calendar/types";
import type { InboxItem } from "@/lib/inbox/types";

/** Mocked "now" for the screens that still use mock data (Inbox, Assistant). */
export const today: ISODate = "2026-10-05";

/**
 * Names for the project slugs referenced by the mock inbox and assistant data. These are
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
