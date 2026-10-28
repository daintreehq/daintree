import type { HostId } from "@shared/types/remoteHosts";

/** How long after leaving through "Go to terminal" a reopened panel still lands where it was left. */
export const CANOPY_RESUME_MS = 30 * 60 * 1000;

/** The panel as "Go to terminal" left it. */
export interface CanopyResume {
  at: number;
  hostId: HostId | null;
  query: string;
  runId: string;
  /** The runs listed then, first to last, so a run since gone has a neighbour to give its place to. */
  order: readonly string[];
}

export function canopyResumeFresh(resume: CanopyResume | null, now: number): boolean {
  return resume !== null && now - resume.at >= 0 && now - resume.at <= CANOPY_RESUME_MS;
}

/**
 * The run to select on reopening: the one left, else the nearest run to it in
 * the order it was left in that is still listed — the one after it first.
 */
export function canopyResumeTarget(
  resume: Pick<CanopyResume, "runId" | "order">,
  listedIds: readonly string[]
): string | null {
  const listed = new Set(listedIds);
  if (listed.has(resume.runId)) return resume.runId;
  const index = resume.order.indexOf(resume.runId);
  if (index === -1) return null;
  for (let distance = 1; distance < resume.order.length; distance++) {
    const after = resume.order[index + distance];
    if (after !== undefined && listed.has(after)) return after;
    const before = resume.order[index - distance];
    if (before !== undefined && listed.has(before)) return before;
  }
  return null;
}
