"use client";

// Project form fields shared by the creation panel and the inline editor. They submit exactly the
// column names the server validates: name, area, description, status and (edit only) progress.
import { useState, type ReactNode } from "react";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { projectStatusLabels } from "@/lib/projects/projects";
import {
  PROJECT_AREA_MAX_LENGTH,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectStatus,
} from "@/lib/projects/types";

const inputClass =
  "rounded-md border border-charcoal/15 bg-paper px-3 text-[15px] text-charcoal outline-none focus:border-charcoal/40";

export type ProjectFieldValues = {
  name: string;
  area: string | null;
  description: string | null;
  status: ProjectStatus;
  /** Only shown when editing; new projects start at the database default (0). */
  progress?: number;
};

type ProjectFieldsProps = {
  /** Prefix keeping element ids unique when several forms are on the page. */
  idPrefix: string;
  initial: ProjectFieldValues;
  /** Status choices offered; creation skips "archived". */
  statuses: readonly ProjectStatus[];
  /** The user's existing areas, suggested while typing (free text is still allowed). */
  areas: string[];
};

export function ProjectFields({ idPrefix, initial, statuses, areas }: ProjectFieldsProps) {
  const [status, setStatus] = useState<ProjectStatus>(initial.status);
  const areaListId = `${idPrefix}-areas`;

  return (
    <>
      <Field id={`${idPrefix}-name`} label="Nombre">
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          autoFocus
          autoComplete="off"
          maxLength={PROJECT_NAME_MAX_LENGTH}
          defaultValue={initial.name}
          className={`h-11 w-full ${inputClass}`}
        />
      </Field>

      <Field id={`${idPrefix}-area`} label="Área" optional>
        <input
          id={`${idPrefix}-area`}
          name="area"
          type="text"
          autoComplete="off"
          list={areas.length > 0 ? areaListId : undefined}
          maxLength={PROJECT_AREA_MAX_LENGTH}
          defaultValue={initial.area ?? ""}
          placeholder="Arquitectura, Universidad…"
          className={`h-11 w-full ${inputClass} placeholder:text-graphite/60`}
        />
        {areas.length > 0 && (
          <datalist id={areaListId}>
            {areas.map((area) => (
              <option key={area} value={area} />
            ))}
          </datalist>
        )}
      </Field>

      <Field id={`${idPrefix}-description`} label="Descripción" optional>
        <textarea
          id={`${idPrefix}-description`}
          name="description"
          rows={3}
          maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
          defaultValue={initial.description ?? ""}
          className={`min-h-[5.5rem] w-full resize-y py-2.5 leading-[1.5] ${inputClass}`}
        />
      </Field>

      <ChoiceGroup
        id={`${idPrefix}-status`}
        label="Estado"
        name="status"
        options={statuses.map((value) => ({ value, label: projectStatusLabels[value] }))}
        value={status}
        onChange={(value) => setStatus(value as ProjectStatus)}
      />

      {initial.progress !== undefined && (
        <Field id={`${idPrefix}-progress`} label="Avance">
          <span className="flex items-center gap-2">
            <input
              id={`${idPrefix}-progress`}
              name="progress"
              type="number"
              inputMode="numeric"
              required
              min={0}
              max={100}
              step={1}
              defaultValue={initial.progress}
              className={`h-9 w-24 font-mono text-[13px] tabular-nums ${inputClass}`}
            />
            <span aria-hidden className="font-mono text-[11px] text-graphite">
              %
            </span>
          </span>
        </Field>
      )}
    </>
  );
}

function Field({ id, label, optional, children }: { id: string; label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
        {label}
        {optional && <span className="text-graphite/60"> · Opcional</span>}
      </label>
      {children}
    </div>
  );
}
