import type { TourOutcome } from "@shared/types";
import { DAINTREE_TOUR_ID, makePluginTourId, tourProgressFor } from "@shared/utils/tourIds";
import { getOnboardingState } from "@/clients/onboardingClient";
import { getTour } from "./tourRegistry";

/**
 * The ids a `help.tour.*` request may mean, most specific first. A plugin's
 * request reads `tourId` as one of its own local ids before the same string
 * as a qualified one, so it never has to spell out its instance key — which,
 * for a project-owned plugin, it shouldn't be parsing anyway. The string is
 * only also tried as a qualified id when it is the plugin's own or the
 * Daintree tour, so one plugin can't open another's tour and read its outcome.
 */
export function tourCandidates(tourId: string | undefined, callerPluginId?: string): string[] {
  if (tourId === undefined) return [DAINTREE_TOUR_ID];
  if (callerPluginId === undefined) return [tourId];
  const local = makePluginTourId(callerPluginId, tourId);
  if (local === tourId) return [tourId];
  const qualifiedFallback = tourId === DAINTREE_TOUR_ID || tourId.startsWith(`${callerPluginId}.`);
  return qualifiedFallback ? [local, tourId] : [local];
}

export interface TourStatus {
  tourId: string;
  /** Whether this view can play the tour right now. */
  registered: boolean;
  /** The registered tour's declared content version, null when it declares none or isn't registered. */
  contentVersion: string | null;
  /** Finished at least once, under any version. */
  completed: boolean;
  /** Finished under the version registered now. */
  completedCurrentVersion: boolean;
  /** The user turned down its invitation. */
  dismissed: boolean;
  /** Where a reopened run resumes, when the saved record still applies to this version. */
  lastChapterId: string | null;
  /** The content version the saved progress was recorded against. */
  progressVersion: string | null;
  lastOutcome: TourOutcome | null;
  /** The run `lastOutcome` belongs to: match it against the `runId` `help.tour.show` returned. */
  lastRunId: string | null;
}

/** Saved progress for the first registered candidate, else the first with saved progress, else the first. */
export async function readTourStatus(candidates: readonly string[]): Promise<TourStatus> {
  const state = await getOnboardingState();
  // A withdrawn tour still has its saved progress, under whichever id it was saved.
  const tourId =
    candidates.find((id) => getTour(id) !== undefined) ??
    candidates.find((id) => state.tours !== undefined && Object.hasOwn(state.tours, id)) ??
    candidates[0]!;
  const registration = getTour(tourId);
  const progress = tourProgressFor(state.tours, tourId);
  const version = registration?.summary.version;
  const sameVersion = progress.contentVersion === version;
  return {
    tourId,
    registered: registration !== undefined,
    contentVersion: version ?? null,
    completed: progress.completed,
    completedCurrentVersion: progress.completed && progress.completedVersion === version,
    dismissed: progress.dismissed,
    lastChapterId: sameVersion ? (progress.lastChapterId ?? null) : null,
    progressVersion: progress.contentVersion ?? null,
    lastOutcome: progress.lastOutcome ?? null,
    lastRunId: progress.lastRunId ?? null,
  };
}
