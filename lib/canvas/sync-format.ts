import { CLASS_REASON_LABELS } from "./classify";
import type { CanvasSyncSummary, CourseSyncReport, SyncItem } from "./sync";

// Spanish copy for sync results. Pure, so the wording is tested; no ids ever appear.

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function reviewCount(n: number): string {
  return `${n} ${n === 1 ? "requiere" : "requieren"} revisión`;
}

/** "5 nuevas · 2 actualizadas · 8 sin cambios · 4 requieren revisión · 8 omitidas" */
export function syncTotalsLine(summary: Pick<CanvasSyncSummary, "created" | "updated" | "unchanged" | "review" | "omitted" | "userIgnored">): string {
  const parts = [
    count(summary.created, "nueva", "nuevas"),
    count(summary.updated, "actualizada", "actualizadas"),
    `${summary.unchanged} sin cambios`,
    reviewCount(summary.review),
    count(summary.omitted, "omitida", "omitidas"),
  ];
  if (summary.userIgnored > 0) parts.push(count(summary.userIgnored, "ignorada por ti", "ignoradas por ti"));
  return parts.join(" · ");
}

/** "12 se importarían (9 nuevas · 3 ya importadas) · 4 requieren revisión · 8 omitidas" */
export function previewTotalsLine(summary: Pick<CanvasSyncSummary, "toImport" | "toCreate" | "existing" | "review" | "omitted" | "userIgnored">): string {
  const parts = [
    `${summary.toImport} ${summary.toImport === 1 ? "se importaría" : "se importarían"} (${count(summary.toCreate, "nueva", "nuevas")} · ${summary.existing} ya ${
      summary.existing === 1 ? "importada" : "importadas"
    })`,
    reviewCount(summary.review),
    count(summary.omitted, "omitida", "omitidas"),
  ];
  if (summary.userIgnored > 0) parts.push(count(summary.userIgnored, "ignorada por ti", "ignoradas por ti"));
  return parts.join(" · ");
}

/** One line per course, by status. */
export function courseReportLine(report: CourseSyncReport): string {
  if (report.status === "not-in-canvas") return "No visible en Campus · se omite, el vínculo se conserva";
  if (report.status === "failed" && report.received === 0) return "No se han podido leer sus entregas";

  const parts = [count(report.received, "entrega", "entregas")];
  if (report.status === "previewed") {
    parts.push(`${report.toImport} ${report.toImport === 1 ? "se importaría" : "se importarían"}`);
  } else {
    parts.push(count(report.created, "nueva", "nuevas"), count(report.updated, "actualizada", "actualizadas"), `${report.unchanged} sin cambios`);
  }
  if (report.review > 0) parts.push(reviewCount(report.review));
  const omitted = report.autoIgnored + report.old + report.malformed;
  if (omitted > 0) parts.push(count(omitted, "omitida", "omitidas"));
  if (report.status === "failed") parts.push("sincronización incompleta");
  return parts.join(" · ");
}

/** Secondary line for one listed assignment: course → project, and why it is listed. */
export function itemLine(item: SyncItem): string {
  const parts = [item.projectName ? `${item.courseName} → ${item.projectName}` : item.courseName];
  if (item.group === "import") {
    if (item.included) parts.push("Importada por ti");
    else if (item.imported) parts.push("Ya importada");
  } else {
    parts.push(CLASS_REASON_LABELS[item.classification.reason]);
  }
  return parts.join(" · ");
}

/** "1 ignorada por ti · 22 antiguas, no publicadas o ilegibles" (empty when both are 0). */
export function omittedFootnote(userIgnored: number, old: number): string {
  return [
    userIgnored > 0 && count(userIgnored, "ignorada por ti", "ignoradas por ti"),
    old > 0 && `${count(old, "antigua", "antiguas")}, no ${old === 1 ? "publicada o ilegible" : "publicadas o ilegibles"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Warnings worth showing after a run, without exposing any Canvas detail. */
export function syncWarnings(summary: CanvasSyncSummary): string[] {
  const warnings: string[] = [];
  if (summary.coursesFailed > 0) {
    const failed = count(summary.coursesFailed, "curso no se ha podido", "cursos no se han podido");
    warnings.push(summary.mode === "sync" ? `${failed} sincronizar. Lo demás se ha guardado.` : `${failed} leer.`);
  }
  if (summary.coursesSkipped > 0) {
    warnings.push(`${count(summary.coursesSkipped, "curso vinculado ya no aparece", "cursos vinculados ya no aparecen")} en Campus y se ${summary.coursesSkipped === 1 ? "ha" : "han"} omitido.`);
  }
  if (summary.importedReview > 0) {
    warnings.push(
      summary.importedReview === 1
        ? "1 tarea importada antes ya no se importaría. Revísala: no se borra sola."
        : `${summary.importedReview} tareas importadas antes ya no se importarían. Revísalas: no se borran solas.`,
    );
  }
  if (summary.courses.some((course) => course.truncated)) warnings.push("Algún curso tiene demasiadas entregas: la lista puede estar incompleta.");
  return warnings;
}
