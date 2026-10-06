"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { applyCourseDecision, type DecisionDeps, type DecisionInput, type DecisionResult } from "./decisions";
import { supabaseDecisionStore } from "./links";
import { getCanvasOverview } from "./queries";

// Server Actions for Canvas course decisions. Each one verifies the TRAZA session, then
// applyCourseDecision re-reads the user's courses from Canvas on the server and accepts only a
// course id present there, deriving its name/code from that response. The browser sends a course
// id (and a project choice); nothing else it says about the course is trusted.

const deps: DecisionDeps = { loadOverview: getCanvasOverview, store: supabaseDecisionStore };

async function decide(input: DecisionInput): Promise<DecisionResult> {
  await requireUser();
  const result = await applyCourseDecision(deps, input);
  if (result.ok) {
    revalidatePath("/projects/canvas");
    // Projects shows the CAMPUS label; Home and others list projects (create-project).
    revalidatePath("/projects");
    if (input.action === "create-project") {
      for (const path of ["/", "/calendar", "/inbox"]) revalidatePath(path);
    }
  }
  return result;
}

export async function linkCanvasCourse(courseId: string, formData: FormData): Promise<DecisionResult> {
  return decide({ action: "link", courseId, formData });
}

export async function ignoreCanvasCourse(courseId: string): Promise<DecisionResult> {
  return decide({ action: "ignore", courseId });
}

export async function createProjectFromCanvasCourse(courseId: string, formData: FormData): Promise<DecisionResult> {
  return decide({ action: "create-project", courseId, formData });
}

/** Unlink or un-ignore: removes the decision; the course returns to "unmapped". */
export async function clearCanvasCourseDecision(courseId: string): Promise<DecisionResult> {
  return decide({ action: "clear", courseId });
}
