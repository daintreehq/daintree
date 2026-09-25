import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { TourOnboardingState } from "@shared/types";
import { tourProgressFor } from "@shared/utils/tourIds";
import { getOnboardingState } from "@/clients/onboardingClient";
import { notify } from "@/lib/notify";
import { logError, logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { TourDefinition, TourRegistration } from "./tourDefinition";
import { OPEN_TOUR_EVENT, TOUR_COMPLETED_EVENT, tourIdOf } from "./tourEvents";
import { getTour, subscribeTours } from "./tourRegistry";

const LazyTourDialog = lazy(() => import("./TourDialog").then((m) => ({ default: m.TourDialog })));

interface OpenState {
  initialChapter: number;
  initialMuted: boolean;
}

/**
 * Owns the open tour and its persistence. Mounted once per project view;
 * `help.tour.show` and the empty-grid launcher both open tours through the event.
 */
export function TourHost() {
  const [open, setOpen] = useState<(OpenState & { tour: TourDefinition }) | null>(null);
  // The latest request wins: a slower load for an earlier one is dropped.
  const requestRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  // The registrations behind the pending and open tours. A plugin tour is
  // withdrawn when its plugin is disabled, and replaced under the same id when
  // it reloads, so identity — not the id — says whether a tour is still current.
  const pendingRegistrationRef = useRef<TourRegistration | null>(null);
  const openRegistrationRef = useRef<TourRegistration | null>(null);

  useEffect(
    () =>
      subscribeTours((changedId) => {
        const current = getTour(changedId);
        if (pendingRef.current === changedId && current !== pendingRegistrationRef.current) {
          requestRef.current++;
          pendingRef.current = null;
          pendingRegistrationRef.current = null;
        }
        if (openIdRef.current === changedId && current !== openRegistrationRef.current) {
          // Progress stays saved; reopening plays whatever is registered now.
          openIdRef.current = null;
          openRegistrationRef.current = null;
          setOpen(null);
        }
      }),
    []
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const tourId = tourIdOf(event);
      if (pendingRef.current === tourId) return;
      // Asking for the tour already playing keeps it where it is, and
      // withdraws any switch to another tour still loading.
      if (openIdRef.current === tourId) {
        requestRef.current++;
        pendingRef.current = null;
        return;
      }
      const registration = getTour(tourId);
      if (!registration) {
        logWarn("No tour is registered under this id", { tourId });
        return;
      }
      const request = ++requestRef.current;
      pendingRef.current = tourId;
      pendingRegistrationRef.current = registration;
      const saved = Promise.resolve()
        .then(() => getOnboardingState())
        .catch(() => null);
      // Inside the chain, so a loader that throws rather than rejects is still handled.
      const loaded = Promise.resolve().then(() => registration.load());
      void Promise.all([loaded, saved])
        .then(([tour, state]) => {
          if (request !== requestRef.current) return;
          // Withdrawn or replaced while it loaded: the subscription above has
          // already dropped the request, but a loader that settled in the same
          // turn as the withdrawal must not open a stale tour either.
          if (getTour(tourId) !== registration) return;
          openIdRef.current = tourId;
          openRegistrationRef.current = registration;
          setOpen({
            tour,
            ...(state
              ? resolveOpenState(
                  tourProgressFor(state.tours, tourId),
                  state.tourMuted,
                  tour.chapters.length
                )
              : { initialChapter: 0, initialMuted: false }),
          });
        })
        .catch((error: unknown) => {
          if (request !== requestRef.current) return;
          logError("Couldn't load the tour", error, { tourId });
          // A failed module import is cached for its URL, so retrying can't
          // help until the plugin reloads; say so instead of offering it.
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Tour didn't open",
            message: `${registration.summary.title} couldn't be loaded. Reload or update the plugin that provides it.`,
          });
        })
        .finally(() => {
          if (request !== requestRef.current) return;
          pendingRef.current = null;
          pendingRegistrationRef.current = null;
        });
    };
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    const requests = requestRef;
    const pending = pendingRef;
    const pendingRegistration = pendingRegistrationRef;
    return () => {
      // Unmounting drops whatever is still loading.
      requests.current++;
      pending.current = null;
      pendingRegistration.current = null;
      window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
    };
  }, []);

  const tourId = open?.tour.id;
  const onClose = useCallback(() => {
    // Closing also drops a tour still loading, so it can't open after the fact.
    requestRef.current++;
    pendingRef.current = null;
    pendingRegistrationRef.current = null;
    openIdRef.current = null;
    openRegistrationRef.current = null;
    setOpen(null);
  }, []);
  const onChapterReached = useCallback(
    (index: number) => {
      if (!tourId) return;
      safeFireAndForget(
        window.electron.onboarding.setTourProgress(tourId, { lastChapter: index }),
        {
          context: "Saving tour progress",
        }
      );
    },
    [tourId]
  );
  const onCompleted = useCallback(() => {
    if (!tourId) return;
    window.dispatchEvent(new CustomEvent(TOUR_COMPLETED_EVENT, { detail: { tourId } }));
    safeFireAndForget(
      window.electron.onboarding.setTourProgress(tourId, {
        completed: true,
        lastChapter: 0,
      }),
      { context: "Saving tour completion" }
    );
  }, [tourId]);
  const onMutedChange = useCallback((muted: boolean) => {
    safeFireAndForget(window.electron.onboarding.setTourMuted(muted), {
      context: "Saving tour mute preference",
    });
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      {/* Keyed by tour so switching tours disposes the old player; reopening the same one keeps it. */}
      <LazyTourDialog
        key={open.tour.id}
        isOpen
        tour={open.tour}
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
export function resolveOpenState(
  tour: TourOnboardingState,
  muted: boolean,
  chapterCount: number
): OpenState {
  const resume = !tour.completed && tour.lastChapter < chapterCount;
  return { initialChapter: resume ? tour.lastChapter : 0, initialMuted: muted };
}
