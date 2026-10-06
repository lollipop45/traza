import { formatShortDate } from "@/lib/calendar/dates";
import type { GoogleSyncSummary, SyncDetailGroup, SyncMode } from "./sync";

// Spanish copy for the Google Calendar preview and sync. Pure (tested); never shows an id.

function n(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Conditional / past forms, singular and plural. */
const VERBS = {
  create: { preview: ["se crearía", "se crearían"], sync: ["creado", "creados"] },
  update: { preview: ["se actualizaría", "se actualizarían"], sync: ["actualizado", "actualizados"] },
  send: { preview: ["se enviaría", "se enviarían"], sync: ["enviada", "enviadas"] },
  taskUpdate: { preview: ["se actualizaría", "se actualizarían"], sync: ["actualizada", "actualizadas"] },
  import: { preview: ["se importaría", "se importarían"], sync: ["importado", "importados"] },
  remove: { preview: ["se quitaría", "se quitarían"], sync: ["quitada", "quitadas"] },
} as const;

function verb(kind: keyof typeof VERBS, mode: SyncMode, count: number): string {
  return VERBS[kind][mode][count === 1 ? 0 : 1];
}

/**
 * The compact summary, one line per non-empty group, "sin cambios" always last:
 *   8 eventos TRAZA se crearían · 4 tareas se enviarían · 5 eventos de Google se importarían · 12 sin cambios
 */
export function summaryLines(summary: GoogleSyncSummary): string[] {
  const { mode, events, tasks, imports } = summary;
  const lines: string[] = [];
  if (events.create) lines.push(`${n(events.create, "evento TRAZA", "eventos TRAZA")} ${verb("create", mode, events.create)}`);
  if (events.update) lines.push(`${n(events.update, "evento TRAZA", "eventos TRAZA")} ${verb("update", mode, events.update)}`);
  if (tasks.create) lines.push(`${n(tasks.create, "tarea", "tareas")} ${verb("send", mode, tasks.create)}`);
  if (tasks.update) lines.push(`${n(tasks.update, "tarea", "tareas")} ${verb("taskUpdate", mode, tasks.update)}`);
  if (summary.removals) lines.push(`${n(summary.removals, "copia", "copias")} ${verb("remove", mode, summary.removals)} de Google`);
  if (imports.create) lines.push(`${n(imports.create, "evento de Google", "eventos de Google")} ${verb("import", mode, imports.create)}`);
  if (imports.update) lines.push(`${n(imports.update, "evento de Google", "eventos de Google")} ${verb("update", mode, imports.update)} en TRAZA`);
  lines.push(`${events.unchanged + tasks.unchanged + imports.unchanged} sin cambios`);
  return lines;
}

/** "Del 6 SEP 2026 al 6 OCT 2027" */
export function windowLine(summary: Pick<GoogleSyncSummary, "window">): string {
  return `Del ${formatShortDate(summary.window.from)} al ${formatShortDate(summary.window.to)}`;
}

/** Things worth a sentence, without any Google detail. */
export function summaryNotes(summary: GoogleSyncSummary): string[] {
  const notes: string[] = [];
  if (summary.incomplete) notes.push("Google ha dejado de responder o ha retirado el acceso: la sincronización está incompleta. Lo hecho se ha guardado; vuelve a intentarlo más tarde.");
  if (summary.failed > 0) notes.push(`${n(summary.failed, "cambio no se ha podido", "cambios no se han podido")} completar. Se reintentará en la próxima sincronización.`);
  if (summary.missingInGoogle > 0) {
    notes.push(
      summary.missingInGoogle === 1
        ? "1 evento importado de Google ya no aparece allí. Se conserva en TRAZA: no se borra solo."
        : `${summary.missingInGoogle} eventos importados de Google ya no aparecen allí. Se conservan en TRAZA: no se borran solos.`,
    );
  }
  if (summary.skipped > 0) notes.push(`${n(summary.skipped, "evento de Google se omite", "eventos de Google se omiten")}: no se puede leer o es una copia de TRAZA sin elemento.`);
  if (summary.otherCalendarLinks > 0) {
    notes.push(`${n(summary.otherCalendarLinks, "copia sigue", "copias siguen")} en un calendario elegido antes: no se modifica${summary.otherCalendarLinks === 1 ? "" : "n"} ni se borra${summary.otherCalendarLinks === 1 ? "" : "n"}.`);
  }
  return notes;
}

const GROUP_TITLES: Record<SyncDetailGroup, Record<SyncMode, string>> = {
  "event-create": { preview: "Eventos TRAZA · se crearían", sync: "Eventos TRAZA · creados" },
  "event-update": { preview: "Eventos TRAZA · se actualizarían", sync: "Eventos TRAZA · actualizados" },
  "task-create": { preview: "Tareas · se enviarían", sync: "Tareas · enviadas" },
  "task-update": { preview: "Tareas · se actualizarían", sync: "Tareas · actualizadas" },
  removal: { preview: "Se quitarían de Google", sync: "Quitadas de Google" },
  "import-create": { preview: "De Google · se importarían", sync: "De Google · importados" },
  "import-update": { preview: "De Google · se actualizarían", sync: "De Google · actualizados" },
  missing: { preview: "Ya no están en Google", sync: "Ya no están en Google" },
};

export const DETAIL_GROUPS = Object.keys(GROUP_TITLES) as SyncDetailGroup[];

export function detailGroupTitle(group: SyncDetailGroup, mode: SyncMode): string {
  return GROUP_TITLES[group][mode];
}
