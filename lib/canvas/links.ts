import "server-only";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { DecisionStore, DecisionWrite } from "./decisions";
import { CANVAS_COURSE_LINK_COLUMNS, type CanvasCourseLink } from "./mapping";

// Supabase access for Canvas course decisions (public.canvas_course_links). Server-only; callers
// must have verified the session. RLS restricts every statement to the owner's rows; errors are
// not logged. No Canvas token or Canvas call here.

export type CanvasLinksResult = { ok: true; links: CanvasCourseLink[] } | { ok: false };

export async function getCanvasCourseLinks(): Promise<CanvasLinksResult> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_course_links")
    .select(CANVAS_COURSE_LINK_COLUMNS)
    .eq("user_id", user.id)
    .order("canvas_course_id", { ascending: true });
  if (error) return { ok: false };
  return { ok: true, links: data };
}

/** Projects with at least one linked Canvas course (derived, never stored on projects). */
export async function getCanvasLinkedProjectIds(): Promise<Set<string> | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_course_links")
    .select("project_id")
    .eq("user_id", user.id)
    .eq("state", "linked");
  if (error) return null;
  return new Set(data.map((row) => row.project_id).filter((id) => id !== null));
}

export const supabaseDecisionStore: DecisionStore = {
  async saveDecision(write: DecisionWrite) {
    const user = await requireUser();
    const supabase = await createClient();
    const { data: existing, error: readError } = await supabase
      .from("canvas_course_links")
      .select("id")
      .eq("user_id", user.id)
      .eq("canvas_course_id", write.canvas_course_id)
      .maybeSingle();
    if (readError) return false;

    if (existing) {
      // canvas_course_id is the identity and is not updatable; refresh the snapshot with the decision.
      const changes = {
        state: write.state,
        project_id: write.project_id,
        canvas_course_name: write.canvas_course_name,
        canvas_course_code: write.canvas_course_code,
      };
      const { data, error } = await supabase.from("canvas_course_links").update(changes).eq("id", existing.id).select("id");
      return !error && data.length === 1;
    }
    const { error } = await supabase.from("canvas_course_links").insert(write);
    return !error;
  },

  async createProjectWithLink(snapshot, project) {
    await requireUser();
    const supabase = await createClient();
    const { error } = await supabase.rpc("create_project_from_canvas_course", {
      p_canvas_course_id: snapshot.canvas_course_id,
      // Optional arguments (SQL default null) are omitted rather than sent as null.
      p_canvas_course_name: snapshot.canvas_course_name ?? undefined,
      p_canvas_course_code: snapshot.canvas_course_code ?? undefined,
      p_name: project.name,
      p_area: project.area ?? undefined,
      p_description: project.description ?? undefined,
      p_status: project.status,
    });
    return !error;
  },

  async clearDecision(courseId) {
    const user = await requireUser();
    const supabase = await createClient();
    const { error } = await supabase.from("canvas_course_links").delete().eq("user_id", user.id).eq("canvas_course_id", courseId);
    return !error;
  },
};
