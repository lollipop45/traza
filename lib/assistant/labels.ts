import type { ProposedActionType } from "./types";

export const actionTypeLabels: Record<ProposedActionType, string> = {
  task: "Tarea",
  event: "Evento",
  note: "Nota",
  idea: "Idea",
};

export const actionSourceLabels = {
  ai: "Asistente",
} as const;
