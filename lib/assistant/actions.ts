import type { ProposedActionType } from "./types";

export const actionTypeLabels: Record<ProposedActionType, string> = {
  task: "Tarea",
  event: "Evento",
  note: "Nota",
  project: "Proyecto",
};

export const actionSourceLabels = {
  ai: "Asistente",
} as const;
