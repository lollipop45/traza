// Static placeholder content. Replaced by real sources in later phases.

import type { AssistantMessage } from "@/lib/assistant/types";
import type { ISODate } from "@/lib/calendar/types";

/** Mocked "now" for the screen that still uses mock data (Assistant). */
export const today: ISODate = "2026-10-05";

/**
 * Names for the project slugs referenced by the mock assistant data. These are
 * NOT real projects (those live in public.projects, with UUIDs); they only label mock content.
 */
export const mockProjectNames: Record<string, string> = {
  "taller-proyectos": "Taller de Proyectos",
  "dibujo-integrado-iii": "Taller de Dibujo Integrado III",
  astronomia: "Astronomía",
  traza: "TRAZA",
};

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
