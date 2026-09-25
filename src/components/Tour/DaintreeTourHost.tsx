import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { TourOnboardingState } from "@shared/types";
import { DAINTREE_TOUR_ID, tourProgressFor } from "@shared/utils/tourIds";
import { getOnboardingState } from "@/clients/onboardingClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { TOUR_CHAPTER_TITLES } from "./tourSummary.generated";
import { DAINTREE_TOUR_COMPLETED_EVENT, OPEN_DAINTREE_TOUR_EVENT } from "./tourEvents";

const LazyTourDialog = lazy(() => import("./TourDialog").then((m) => ({ default: m.TourDialog })));

interface OpenState {
  initialChapter: number;
  initialMuted: boolean;
}

/**
 * Owns the tour's open state and persistence. Mounted once per project view;
 * `help.tour.show` and the empty-grid launcher both open it through the event.
 */
export function DaintreeTourHost() {
  const [open, setOpen] = useState<OpenState | null>(null);
  const openingRef = useRef(false);

  useEffect(() => {
    const onOpen = () => {
      if (openingRef.current) return;
      openingRef.current = true;
      void getOnboardingState()
        .then((state) =>
          resolveOpenState(tourProgressFor(state.tours, DAINTREE_TOUR_ID), state.tourMuted)
        )
        .catch(() => ({ initialChapter: 0, initialMuted: false }))
        .then((next) => {
          openingRef.current = false;
          setOpen(next);
        });
    };
    window.addEventListener(OPEN_DAINTREE_TOUR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DAINTREE_TOUR_EVENT, onOpen);
  }, []);

  const onClose = useCallback(() => setOpen(null), []);
  const onChapterReached = useCallback((index: number) => {
    safeFireAndForget(
      window.electron.onboarding.setTourProgress(DAINTREE_TOUR_ID, { lastChapter: index }),
      {
        context: "Saving tour progress",
      }
    );
  }, []);
  const onCompleted = useCallback(() => {
    window.dispatchEvent(new CustomEvent(DAINTREE_TOUR_COMPLETED_EVENT));
    safeFireAndForget(
      window.electron.onboarding.setTourProgress(DAINTREE_TOUR_ID, {
        completed: true,
        lastChapter: 0,
      }),
      { context: "Saving tour completion" }
    );
  }, []);
  const onMutedChange = useCallback((muted: boolean) => {
    safeFireAndForget(window.electron.onboarding.setTourMuted(muted), {
      context: "Saving tour mute preference",
    });
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyTourDialog
        isOpen
        onClose={onClose}
        initialChapter={open.initialChapter}
        initialMuted={open.initialMuted}
        onChapterReached={onChapterReached}
        onCompleted={onCompleted}
        onMutedChange={onMutedChange}
      />
    </Suspense>
  );
}

/** Resume where an unfinished tour was left; a finished one starts over. */
export function resolveOpenState(tour: TourOnboardingState, muted: boolean): OpenState {
  const resume = !tour.completed && tour.lastChapter < TOUR_CHAPTER_TITLES.length;
  return { initialChapter: resume ? tour.lastChapter : 0, initialMuted: muted };
}
