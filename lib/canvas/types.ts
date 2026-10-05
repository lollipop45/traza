// Only the subset of Canvas data TRAZA uses. Canvas responses are untrusted input: they are
// projected field by field (lib/canvas/parse.ts), never cast. IDs are strings (requested with
// `Accept: application/json+canvas-string-ids`) so large Canvas IDs never lose precision.

/** Why a Canvas call failed. Never carries response bodies, URLs or credentials. */
export type CanvasErrorKind =
  /** CANVAS_BASE_URL / CANVAS_ACCESS_TOKEN missing or malformed. */
  | "not-configured"
  /** 401: token invalid, expired or revoked. */
  | "unauthorized"
  /** 403: the token works but lacks permission for this resource. */
  | "forbidden"
  /** Network failure, timeout, 429 or 5xx. */
  | "unavailable"
  /** 3xx: usually a wrong CANVAS_BASE_URL (e.g. http vs https or a login portal). */
  | "redirected"
  /** Unexpected status (e.g. 404), non-JSON body or a shape TRAZA cannot read. */
  | "invalid-response";

export class CanvasError extends Error {
  readonly kind: CanvasErrorKind;
  readonly status: number | null;

  constructor(kind: CanvasErrorKind, status: number | null = null) {
    // Fixed message: no URL, body or header can leak through error logging.
    super(`Canvas request failed: ${kind}${status ? ` (${status})` : ""}`);
    this.name = "CanvasError";
    this.kind = kind;
    this.status = status;
  }
}

export type CanvasProfile = {
  id: string;
  name: string;
  /** Display name chosen in Canvas, when different from the full name. */
  shortName: string | null;
};

export type CanvasTerm = {
  id: string | null;
  name: string | null;
  startAt: string | null;
  endAt: string | null;
};

export type CanvasEnrollment = {
  /** e.g. "student", "teacher", "ta". */
  type: string | null;
  /** e.g. "active", "invited", "completed". */
  state: string | null;
};

export type CanvasCourse = {
  /** Stable Canvas course id: the key for any future mapping, never the name. */
  id: string;
  /** Null when Canvas withholds details (access restricted by dates). */
  name: string | null;
  courseCode: string | null;
  /** "available", "unpublished", "completed", … */
  workflowState: string | null;
  startAt: string | null;
  endAt: string | null;
  term: CanvasTerm | null;
  enrollments: CanvasEnrollment[];
  /** Canvas hides the course contents outside its access dates. */
  accessRestricted: boolean;
};
