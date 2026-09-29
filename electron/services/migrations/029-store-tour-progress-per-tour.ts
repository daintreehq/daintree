import type { Migration } from "../StoreMigrations.js";
import { DAINTREE_TOUR_ID } from "../../../shared/utils/tourIds.js";

interface OnboardingLike {
  tour?: unknown;
  tours?: unknown;
  tourMuted?: unknown;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Key tour progress by tour id (issue #12765). The single `onboarding.tour`
 * record always meant the built-in Daintree tour, so it becomes
 * `tours.daintree`; its `muted` flag becomes the global `tourMuted`, since mute
 * is one preference across every tour. Each destination is guarded on its own
 * so a replay never overwrites progress already recorded under the new shape.
 */
export const migration029: Migration = {
  version: 29,
  description: "Store welcome tour progress per tour id (issue #12765)",
  up: (store) => {
    const onboarding = store.get("onboarding") as OnboardingLike | undefined;
    if (!isPlainObject(onboarding) || !("tour" in onboarding)) return;

    const { tour: legacy, ...rest } = onboarding;
    const tours = isPlainObject(rest.tours) ? { ...rest.tours } : {};
    const legacyRecord = isPlainObject(legacy) ? legacy : undefined;

    if (legacyRecord && !Object.prototype.hasOwnProperty.call(tours, DAINTREE_TOUR_ID)) {
      tours[DAINTREE_TOUR_ID] = {
        completed: legacyRecord.completed === true,
        dismissed: legacyRecord.dismissed === true,
        lastChapter: toCount(legacyRecord.lastChapter),
      };
    }
    const tourMuted =
      typeof rest.tourMuted === "boolean" ? rest.tourMuted : legacyRecord?.muted === true;

    store.set("onboarding", { ...rest, tours, tourMuted } as never);
  },
};
