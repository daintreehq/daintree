import type { FleetSnapshot, RunCanopyRefinement } from "@shared/types/ipc/fleet";
import { formatTimeAgo } from "@/utils/timeAgo";
import { bandForRun, runCanopyPlacement } from "@/lib/fleetAttention";

/** Longest quote a row carries; the screen line it came from can run to the pane's width. */
const MAX_QUOTE_LENGTH = 160;

/** What each refinement says it read, ahead of the screen's own words. */
const EVIDENCE_LEAD: Record<RunCanopyRefinement["kind"], string> = {
  asked: "Asked",
  "not-asking": "Not asking",
  stalled: "Screen unchanged",
};

/** The two halves of a Canopy attribution: what was read, and who read it when. */
export interface CanopyEvidenceParts {
  /** `Asked: "…"` — the reading, in the screen's own words. */
  claim: string;
  /** `read by Canopy 2m ago` — kept whole wherever the claim has to be cut short. */
  attribution: string;
}

/**
 * The attribution a row placed by Canopy carries: what was read, in the
 * screen's own words, and who read it when — `Asked: "…" · read by Canopy 2m
 * ago`. A placement that can't show its evidence is one the user can't check,
 * which is the whole reason a reading may move a run at all.
 */
export function canopyEvidence(refinement: RunCanopyRefinement, nowMs: number): string {
  const { claim, attribution } = canopyEvidenceParts(refinement, nowMs);
  return `${claim} · ${attribution}`;
}

/**
 * The same attribution in halves, for a row too narrow for all of it: the quote
 * may truncate, but "read by Canopy" must never be what the ellipsis eats —
 * a placement nobody can tell came from a reading is an interpretation passing
 * as an observation.
 */
export function canopyEvidenceParts(
  refinement: RunCanopyRefinement,
  nowMs: number
): CanopyEvidenceParts {
  const quote =
    refinement.quote.length > MAX_QUOTE_LENGTH
      ? `${refinement.quote.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…`
      : refinement.quote;
  return {
    claim: `${EVIDENCE_LEAD[refinement.kind]}: "${quote}"`,
    attribution: `read by Canopy ${formatTimeAgo(refinement.readAt, nowMs)}`,
  };
}

const indexCache = new WeakMap<FleetSnapshot, Map<string, RunCanopyRefinement>>();

/**
 * The refinement placing one run (`runId` is the terminal id), or undefined
 * when the free rules alone placed it — a park or snooze included, which
 * outranks any reading. A snapshot not yet delivered places nothing.
 */
export function canopyPlacementForRun(
  snapshot: FleetSnapshot | null,
  runId: string
): RunCanopyRefinement | undefined {
  if (snapshot === null) return undefined;
  let index = indexCache.get(snapshot);
  if (index === undefined) {
    index = new Map();
    for (const run of snapshot.runs) {
      const placement = runCanopyPlacement(run);
      if (placement === undefined) continue;
      const band = bandForRun(run);
      if (band === "parked" || band === "snoozed") continue;
      index.set(run.runId, placement);
    }
    indexCache.set(snapshot, index);
  }
  return index.get(runId);
}
