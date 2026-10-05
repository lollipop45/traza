"use client";

// Creation panel under the Projects header, opened by the "+" link (?nuevo). The project is
// validated and inserted by the `createProject` Server Action, which then returns to the index.
import { Check } from "lucide-react";
import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { createProject } from "@/lib/projects/actions";
import { DEFAULT_PROJECT_STATUS } from "@/lib/projects/types";
import { ProjectFields } from "./ProjectFields";

/** New projects are in course or planned; archiving is an edit. */
const CREATE_STATUSES = ["active", "planned"] as const;

type NewProjectFormProps = {
  /** Where "Cancelar" goes: the same filter, without the panel. */
  closeHref: string;
  areas: string[];
};

export function NewProjectForm({ closeHref, areas }: NewProjectFormProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // onSubmit rather than a form action, so a failed attempt keeps what was typed.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      // On success the action redirects to the index, closing this panel.
      const result = await createProject(formData);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <form
      id="new-project"
      onSubmit={submit}
      aria-labelledby="new-project-heading"
      aria-busy={pending}
      className="flex flex-col gap-4 border-y border-charcoal/10 py-5"
    >
      <h2 id="new-project-heading" className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">
        Nuevo proyecto
      </h2>

      <ProjectFields
        idPrefix="new-project"
        initial={{ name: "", area: null, description: null, status: DEFAULT_PROJECT_STATUS }}
        statuses={CREATE_STATUSES}
        areas={areas}
      />

      {error && (
        <p role="alert" className="border-l border-charcoal pl-3 text-[13px] leading-[1.5] text-charcoal">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="primary" type="submit" disabled={pending} icon={Check}>
          Crear proyecto
        </Button>
        <Link
          href={closeHref}
          scroll={false}
          className="inline-flex h-9 items-center rounded-md border border-charcoal/15 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          Cancelar
        </Link>
      </div>
    </form>
  );
}
