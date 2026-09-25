import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { TourOnboardingState, TourProgressUpdate } from "@shared/types";
import { tourProgressFor } from "@shared/utils/tourIds";

/**
 * Imported first by `preview.tsx`: the tour only talks to main through the
 * onboarding namespace, so that is all the harness answers.
 */
const tours: Record<string, TourOnboardingState> = {};
let tourMuted = false;

function update(tourId: string, patch: Partial<TourOnboardingState>): TourOnboardingState {
  tours[tourId] = { ...tourProgressFor(tours, tourId), ...patch };
  return structuredClone(tours[tourId]!);
}

installPreviewShims({
  onboarding: {
    get: async () => ({ tours: structuredClone(tours), tourMuted }),
    dismissTourInvite: async (tourId: string) => update(tourId, { dismissed: true }),
    setTourProgress: async (tourId: string, progress: TourProgressUpdate) =>
      update(tourId, {
        ...(progress.completed ? { completed: true } : {}),
        ...(typeof progress.lastChapter === "number" ? { lastChapter: progress.lastChapter } : {}),
      }),
    setTourMuted: async (muted: boolean) => {
      tourMuted = muted;
      return tourMuted;
    },
  },
});
