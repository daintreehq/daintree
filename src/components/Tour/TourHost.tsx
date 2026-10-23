import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { TourOnboardingState, TourOutcome } from "@shared/types";
import { tourProgressFor } from "@shared/utils/tourIds";
import { getOnboardingState } from "@/clients/onboardingClient";
import { notify } from "@/lib/notify";
import { logError, logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { TourDefinition, TourRegistration } from "./tourDefinition";
import {
  OPEN_TOUR_EVENT,
  requestIdOf,
  TOUR_COMPLETED_EVENT,
  TOUR_OUTCOME_EVENT,
  tourIdOf,
} from "./tourEvents";
import { getTour, subscribeTours } from "./tourRegistry";
import { registerTourHost, settleTourRequest, type TourStartResult } from "./tourRequests";

const LazyTourDialog = lazy(() => import("./TourDialog").then((m) => ({ default: m.TourDialog })));

interface OpenState {
  initialChapter: number;
  initialMuted: boolean;
}

/** The tour playing now: what its progress writes are stamped with, and whether it reached the end. */
interface Run {
  runId: string;
  tourId: string;
  version: string | undefined;
  chapterIds: readonly string[];
  completed: boolean;
}

function saveOutcome(
  tourId: string,
  version: string | undefined,
  outcome: TourOutcome,
  runId?: string
): void {
  window.dispatchEvent(
    new CustomEvent(TOUR_OUTCOME_EVENT, { detail: { tourId, outcome, runId: runId ?? null } })
  );
  safeFireAndForget(
    window.electron.onboarding.setTourProgress(tourId, {
      lastOutcome: outcome,
      ...(runId !== undefined ? { lastRunId: runId } : {}),
      contentVersion: version ?? null,
    }),
    { context: "Saving how the tour ended" }
  );
}

/** Mounts with the dialog once its lazy chunk has resolved: the tour is on screen. */
function OnDialogMounted({ onMounted }: { onMounted: () => void }) {
  useEffect(() => {
    onMounted();
  }, [onMounted]);
  return null;
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
  // `requestTour` calls waiting on the pending load, answered when it settles.
  const pendingRequestIdsRef = useRef<number[]>([]);
  const openIdRef = useRef<string | null>(null);
  // The registrations behind the pending and open tours. A plugin tour is
  // withdrawn when its plugin is disabled, and replaced under the same id when
  // it reloads, so identity — not the id — says whether a tour is still current.
  const pendingRegistrationRef = useRef<TourRegistration | null>(null);
  const openRegistrationRef = useRef<TourRegistration | null>(null);
  const runRef = useRef<Run | null>(null);
  // Requests for the open run, answered `started` once its dialog has mounted.
  const startingRequestIdsRef = useRef<number[]>([]);

  const answerStarting = useCallback((result: (run: Run) => TourStartResult) => {
    const ids = startingRequestIdsRef.current;
    const run = runRef.current;
    startingRequestIdsRef.current = [];
    if (!run) return;
    for (const id of ids) settleTourRequest(id, result(run));
  }, []);

  // Taking the run first makes the outcome once-only, however many close paths fire.
  const endRun = useCallback(
    (outcome: TourOutcome | ((run: Run) => TourOutcome)) => {
      const run = runRef.current;
      if (!run) return;
      const ended = typeof outcome === "function" ? outcome(run) : outcome;
      answerStarting(({ tourId }) =>
        ended === "withdrawn"
          ? { status: "unavailable", tourId, reason: "not-registered" }
          : { status: "superseded", tourId }
      );
      runRef.current = null;
      saveOutcome(run.tourId, run.version, ended, run.runId);
    },
    [answerStarting]
  );

  const answerPending = useCallback((result: (tourId: string) => TourStartResult) => {
    const ids = pendingRequestIdsRef.current;
    const tourId = pendingRef.current;
    pendingRequestIdsRef.current = [];
    if (tourId === null) return;
    for (const id of ids) settleTourRequest(id, result(tourId));
  }, []);

  useEffect(() => registerTourHost(), []);

  useEffect(
    () =>
      subscribeTours((changedId) => {
        const current = getTour(changedId);
        if (pendingRef.current === changedId && current !== pendingRegistrationRef.current) {
          requestRef.current++;
          answerPending((tourId) =>
            current
              ? { status: "superseded", tourId }
              : { status: "unavailable", tourId, reason: "not-registered" }
          );
          pendingRef.current = null;
          pendingRegistrationRef.current = null;
        }
        if (openIdRef.current === changedId && current !== openRegistrationRef.current) {
          // Progress stays saved; reopening plays whatever is registered now.
          endRun("withdrawn");
          openIdRef.current = null;
          openRegistrationRef.current = null;
          setOpen(null);
        }
      }),
    [answerPending, endRun]
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const tourId = tourIdOf(event);
      const requestId = requestIdOf(event);
      if (pendingRef.current === tourId) {
        if (requestId !== null) pendingRequestIdsRef.current.push(requestId);
        return;
      }
      // Asking for the tour already playing keeps it where it is, and
      // withdraws any switch to another tour still loading.
      if (openIdRef.current === tourId) {
        requestRef.current++;
        answerPending((id) => ({ status: "superseded", tourId: id }));
        pendingRef.current = null;
        const run = runRef.current;
        if (requestId !== null && run) {
          if (startingRequestIdsRef.current.length > 0) {
            startingRequestIdsRef.current.push(requestId);
          } else {
            settleTourRequest(requestId, { status: "started", tourId, runId: run.runId });
          }
        }
        return;
      }
      const registration = getTour(tourId);
      if (!registration) {
        logWarn("No tour is registered under this id", { tourId });
        if (requestId !== null) {
          settleTourRequest(requestId, { status: "unavailable", tourId, reason: "not-registered" });
        }
        return;
      }
      const request = ++requestRef.current;
      answerPending((id) => ({ status: "superseded", tourId: id }));
      pendingRef.current = tourId;
      pendingRegistrationRef.current = registration;
      if (requestId !== null) pendingRequestIdsRef.current.push(requestId);
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
          if (getTour(tourId) !== registration) {
            answerPending((id) => ({
              status: "unavailable",
              tourId: id,
              reason: "not-registered",
            }));
            return;
          }
          endRun("superseded");
          openIdRef.current = tourId;
          openRegistrationRef.current = registration;
          runRef.current = {
            runId: crypto.randomUUID(),
            tourId,
            version: tour.version,
            chapterIds: tour.chapters.map((chapter) => chapter.id),
            completed: false,
          };
          startingRequestIdsRef.current = pendingRequestIdsRef.current;
          pendingRequestIdsRef.current = [];
          setOpen({
            tour,
            ...(state
              ? resolveOpenState(
                  tourProgressFor(state.tours, tourId),
                  state.tourMuted,
                  tour.chapters,
                  tour.version
                )
              : { initialChapter: 0, initialMuted: false }),
          });
        })
        .catch((error: unknown) => {
          if (request !== requestRef.current) return;
          logError("Couldn't load the tour", error, { tourId });
          answerPending((id) => ({
            status: "failed",
            tourId: id,
            reason: formatErrorMessage(error, "The tour couldn't be loaded"),
          }));
          saveOutcome(tourId, registration.summary.version, "failed");
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
          pendingRequestIdsRef.current = [];
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
      answerPending((id) => ({ status: "unavailable", tourId: id, reason: "no-host" }));
      answerStarting(({ tourId }) => ({ status: "unavailable", tourId, reason: "no-host" }));
      pending.current = null;
      pendingRegistration.current = null;
      window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
    };
  }, [answerPending, answerStarting, endRun]);

  const tourId = open?.tour.id;
  const onDialogMounted = useCallback(() => {
    answerStarting(({ tourId: id, runId }) => ({ status: "started", tourId: id, runId }));
  }, [answerStarting]);
  const onClose = useCallback(() => {
    // Closing also drops a tour still loading, so it can't open after the fact.
    requestRef.current++;
    answerPending((id) => ({ status: "superseded", tourId: id }));
    pendingRef.current = null;
    pendingRegistrationRef.current = null;
    endRun((run) => (run.completed ? "completed" : "dismissed"));
    openIdRef.current = null;
    openRegistrationRef.current = null;
    setOpen(null);
  }, [answerPending, endRun]);
  const onChapterReached = useCallback(
    (index: number) => {
      const run = runRef.current;
      if (!tourId || run?.tourId !== tourId) return;
      const chapterId = run.chapterIds[index];
      safeFireAndForget(
        window.electron.onboarding.setTourProgress(tourId, {
          lastChapter: index,
          ...(chapterId !== undefined ? { lastChapterId: chapterId } : {}),
          contentVersion: run.version ?? null,
        }),
        { context: "Saving tour progress" }
      );
    },
    [tourId]
  );
  const onCompleted = useCallback(() => {
    const run = runRef.current;
    if (!tourId || run?.tourId !== tourId) return;
    run.completed = true;
    window.dispatchEvent(new CustomEvent(TOUR_COMPLETED_EVENT, { detail: { tourId } }));
    safeFireAndForget(
      window.electron.onboarding.setTourProgress(tourId, {
        completed: true,
        lastChapter: 0,
        contentVersion: run.version ?? null,
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
      <OnDialogMounted key={`ready-${open.tour.id}`} onMounted={onDialogMounted} />
    </Suspense>
  );
}

/**
 * The chapter a reopened tour starts at. Progress resumes by chapter id, so
 * reordered chapters land where the user left off, and only while it was
 * recorded against the tour's current content version — a record from before
 * versioning counts as unversioned. A run finished under this version starts
 * over; a record holding only an index (written before ids were kept) resumes
 * by index while that chapter still exists.
 */
export function resumeChapter(
  progress: TourOnboardingState,
  chapters: readonly { id: string }[],
  version: string | undefined
): number {
  if (progress.contentVersion !== version) return 0;
  if (progress.completed && progress.completedVersion === version) return 0;
  if (progress.lastChapterId !== undefined) {
    return Math.max(
      0,
      chapters.findIndex((chapter) => chapter.id === progress.lastChapterId)
    );
  }
  return progress.lastChapter < chapters.length ? progress.lastChapter : 0;
}

/** Resume where an unfinished tour was left; a finished one starts over. */
export function resolveOpenState(
  progress: TourOnboardingState,
  muted: boolean,
  chapters: readonly { id: string }[],
  version?: string
): OpenState {
  return { initialChapter: resumeChapter(progress, chapters, version), initialMuted: muted };
}
