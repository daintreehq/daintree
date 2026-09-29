import type { TourOnboardingState } from "../types/ipc/maps.js";

/**
 * Tour progress is persisted per tour id. The built-in tour owns a bare id;
 * plugin tours are `{pluginId}.{localId}`, the same composite every other
 * plugin contribution uses, so two plugins shipping a "welcome" tour can't
 * share a resume point.
 */
export const DAINTREE_TOUR_ID = "daintree";

export function makePluginTourId<const P extends string, const L extends string>(
  pluginId: P,
  localId: L
): `${P}.${L}` {
  return `${pluginId}.${localId}`;
}

export const DEFAULT_TOUR_PROGRESS: Readonly<TourOnboardingState> = Object.freeze({
  completed: false,
  dismissed: false,
  lastChapter: 0,
});

/** A tour with no stored record has never been started. */
export function tourProgressFor(
  tours: Record<string, TourOnboardingState> | undefined,
  tourId: string
): TourOnboardingState {
  if (tours && Object.prototype.hasOwnProperty.call(tours, tourId)) return tours[tourId]!;
  return { ...DEFAULT_TOUR_PROGRESS };
}
