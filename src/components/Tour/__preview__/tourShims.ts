import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { TourOnboardingState } from "@shared/types";

/**
 * Imported first by `preview.tsx`: the tour only talks to main through the
 * onboarding namespace, so that is all the harness answers.
 */
const tour: TourOnboardingState = {
  completed: false,
  launcherSessions: 0,
  muted: false,
  lastChapter: 0,
};

installPreviewShims({
  onboarding: {
    get: async () => ({ tour: structuredClone(tour) }),
    markTourLauncherShown: async () => structuredClone(tour),
    setTourProgress: async (update: { completed?: boolean; lastChapter?: number }) => {
      if (update.completed) tour.completed = true;
      if (typeof update.lastChapter === "number") tour.lastChapter = update.lastChapter;
      return structuredClone(tour);
    },
    setTourMuted: async (muted: boolean) => {
      tour.muted = muted;
      return structuredClone(tour);
    },
  },
});
