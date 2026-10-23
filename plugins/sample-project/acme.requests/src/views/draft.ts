import { REQUEST_STATUSES, type RequestRecord, type RequestStatus } from "../contracts";

/**
 * An edit the user hasn't saved, kept in the view's durable state so it
 * survives a remount, a Home/Grid switch, an evicted renderer or a restart.
 * Versioned: a draft written by an older build that no longer parses is
 * dropped rather than half-restored.
 */
export const DRAFT_VERSION = 1;

export interface RequestDraft {
  requestId: string;
  /** The revision the edit started from, to spot someone else's write. */
  baseRevision: number;
  title: string;
  status: RequestStatus;
  notes: string;
}

export function encodeDraft(draft: RequestDraft | null): Record<string, unknown> {
  return { draft: draft ? { v: DRAFT_VERSION, ...draft } : null };
}

export function readDraft(state: Record<string, unknown> | undefined): RequestDraft | null {
  const raw = state?.draft;
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (
    d.v !== DRAFT_VERSION ||
    typeof d.requestId !== "string" ||
    typeof d.baseRevision !== "number" ||
    typeof d.title !== "string" ||
    typeof d.notes !== "string" ||
    !(REQUEST_STATUSES as readonly unknown[]).includes(d.status)
  ) {
    return null;
  }
  return {
    requestId: d.requestId,
    baseRevision: d.baseRevision,
    title: d.title,
    status: d.status as RequestStatus,
    notes: d.notes,
  };
}

export function draftFrom(request: RequestRecord): RequestDraft {
  return {
    requestId: request.id,
    baseRevision: request.revision,
    title: request.title,
    status: request.status,
    notes: request.notes,
  };
}

export function isDirty(draft: RequestDraft, request: RequestRecord): boolean {
  return (
    draft.title !== request.title ||
    draft.status !== request.status ||
    draft.notes !== request.notes
  );
}

/**
 * What a restored draft means against the request as it is now: nothing to
 * restore, an edit that still applies, an edit someone else's write has
 * overtaken, or an edit to a request that no longer exists.
 */
export type DraftStanding = "clean" | "pending" | "overtaken" | "orphaned";

export function draftStanding(
  draft: RequestDraft | null,
  request: RequestRecord | null | undefined
): DraftStanding {
  if (!draft) return "clean";
  if (request === null) return "orphaned";
  if (request === undefined) return "pending";
  if (!isDirty(draft, request)) return "clean";
  return request.revision === draft.baseRevision ? "pending" : "overtaken";
}
