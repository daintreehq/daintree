import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { TourOnboardingState } from "@shared/types";
import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";

/**
 * Imported first by `invitePreview.tsx`. `?chapter=<n>` seeds a tour stopped
 * at that chapter (0-based), so the card renders its resume copy; without it
 * the tour is untouched and the card invites.
 */
const chapter = Number(new URLSearchParams(window.location.search).get("chapter") ?? 0);
const tours: Record<string, TourOnboardingState> = {
  [DAINTREE_TOUR_ID]: { completed: false, dismissed: false, lastChapter: chapter },
};

installPreviewShims({
  onboarding: {
    get: async () => ({ tours: structuredClone(tours), tourMuted: false }),
    dismissTourInvite: async (tourId: string) => {
      tours[tourId] = { ...tours[tourId]!, dismissed: true };
      return structuredClone(tours[tourId]!);
    },
  },
});
