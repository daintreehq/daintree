import { useEffect } from "react";
import { makePluginTourId } from "@shared/utils/tourIds";
import type { ProjectWelcomeStatus } from "@shared/types/plugin";
import { getTour, subscribeToTourRegistry } from "@/components/Tour/tourRegistry";
import { requestTour } from "@/components/Tour/tourRequests";
import { TOUR_COMPLETED_EVENT, tourIdOf } from "@/components/Tour/tourEvents";
import { selectProjectDefaultLayout } from "@/hooks/useProjectLayoutSeed";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { notify } from "@/lib/notify";
import { getRegisteredPluginActionsSnapshot } from "@/services/plugin/registeredPluginActions";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { useProjectLayoutSeedStore } from "@/store/projectLayoutSeedStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useProjectWelcomeStore } from "@/store/projectWelcomeStore";
import { useUIStore } from "@/store/uiStore";
import { logWarn } from "@/utils/logger";

/** The active application's welcome, as the descriptor declares it. */
interface DeclaredWelcome {
  ownerId: string;
  instanceId: string;
  localTourId: string;
  version: number;
  appName: string;
  firstWorkflow: string | undefined;
}

/**
 * The welcome this view is tracking: `loading` while main's record is read,
 * `open` while it is still on offer, `answered` once skipped or finished at
 * this revision. Module state, as in `tourRequests.ts`: one view per renderer.
 */
let tracked: { identity: string; welcome: DeclaredWelcome; record: "loading" | "open" | "answered" } | null =
  null;

function declaredWelcome(): DeclaredWelcome | null {
  const application = useProjectPluginStore.getState().application;
  // Active means the owner is trusted, loaded and holds its landing; anything
  // else is the standard workspace, with no welcome to give.
  if (application?.status !== "active" || application.instanceId === undefined) return null;
  const tour = application.application.welcomeTour;
  if (tour === undefined) return null;
  return {
    ownerId: application.ownerId,
    instanceId: application.instanceId,
    localTourId: tour.id,
    version: tour.version,
    appName: application.application.name,
    firstWorkflow: application.application.firstWorkflow,
  };
}

function identityOf(welcome: DeclaredWelcome): string {
  return [welcome.ownerId, welcome.instanceId, welcome.localTourId, welcome.version].join("\n");
}

/**
 * Whether the project's first-open layout comes first: it is about to be
 * applied, is being applied, failed and waits for a Retry, or left recipes
 * waiting to be started. One first-run strip at a time, in that order.
 */
function layoutComesFirst(): boolean {
  const { status, waiting } = useProjectLayoutSeedStore.getState();
  if (waiting !== null) return true;
  if (selectProjectDefaultLayout(usePluginLayoutsStore.getState().layouts) === null) return false;
  return status === undefined || status === "pending" || status === "applying" || status === "failed";
}

function handOff(welcome: DeclaredWelcome, skipped: boolean, tourTitle: string): void {
  const { setHandoff } = useProjectWelcomeStore.getState();
  if (welcome.firstWorkflow === undefined) {
    setHandoff(null);
    return;
  }
  const actionId = `${welcome.instanceId}.${welcome.firstWorkflow}`;
  const title = getRegisteredPluginActionsSnapshot().get(actionId);
  // Only a command this view can run: one still registering, or withdrawn,
  // is no next step.
  setHandoff(
    title === undefined
      ? null
      : { appName: welcome.appName, actionId, title: title || welcome.firstWorkflow, skipped, tourTitle }
  );
}

async function answer(status: ProjectWelcomeStatus): Promise<void> {
  const current = tracked;
  if (current === null || current.record === "answered") return;
  const { welcome } = current;
  const tourTitle =
    getTour(makePluginTourId(welcome.instanceId, welcome.localTourId))?.summary.title ?? "Welcome";
  await window.electron.plugin.setProjectWelcome(
    welcome.ownerId,
    welcome.localTourId,
    welcome.version,
    status
  );
  if (tracked?.identity !== current.identity) return;
  tracked.record = "answered";
  useProjectWelcomeStore.getState().setOffer(null);
  handOff(welcome, status === "skipped", tourTitle);
}

/** The user's "Skip" on the welcome strip: not offered again until a new revision. */
export async function skipProjectWelcome(): Promise<void> {
  await answer("skipped");
}

/**
 * The user's "Start" on the welcome strip. Plays in the shared tour dialog;
 * the answer is recorded when the tour reaches its end, so closing it early
 * leaves the welcome on offer to pick up again.
 */
export async function startProjectWelcome(): Promise<void> {
  const offer = useProjectWelcomeStore.getState().offer;
  if (offer === null) return;
  const result = await requestTour([offer.tourId]);
  if (result.status !== "unavailable" && result.status !== "failed") return;
  notify({
    type: "error",
    priority: "high",
    title: "Welcome not started",
    message:
      result.status === "failed"
        ? `${offer.appName}'s welcome couldn't load: ${result.reason}.`
        : `${offer.appName}'s welcome isn't available right now.`,
    context: { eventKind: "uiFeedback" },
    action: { label: "Retry", onClick: () => void startProjectWelcome() },
  });
}

/**
 * Offer the project application's welcome, once it can be taken in (#14106).
 *
 * The policy is offer-only: a strip on the project's Home or grid, never a
 * tour that plays by itself, so it can't open over a dialog or in a project
 * nobody is looking at, and it starts nothing — no agent, install, recipe or
 * external work — until the user asks. It appears only when every gate holds
 * at once:
 *
 * - the application is active, so its plugin is trusted and loaded;
 * - main's record shows no answer at this welcome revision;
 * - the welcome tour has registered in this view;
 * - the first-open layout is done with: applied, offered, or settled;
 * - no dialog is open — host setup, trust, or another tour;
 * - this view is the one on screen, as main reports it.
 *
 * Once shown it stays until answered or the application stops being active.
 * Finishing the tour, however it was opened, records the answer and hands off
 * to the application's first workflow, which runs only on the user's click.
 */
export function useProjectApplicationWelcome(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const welcomeStore = useProjectWelcomeStore.getState;

    const load = (identity: string, welcome: DeclaredWelcome): void => {
      void Promise.resolve()
        .then(() => window.electron.plugin.getProjectWelcome(welcome.ownerId, welcome.localTourId))
        .then(
          (record) => {
            if (disposed || tracked?.identity !== identity) return;
            tracked.record = record !== null && record.version >= welcome.version ? "answered" : "open";
            evaluate();
          },
          // Unread is not unanswered: offering a welcome the user may have
          // turned down is worse than not offering it this time.
          (error: unknown) => logWarn("[ProjectWelcome] Couldn't read the welcome record", { error })
        );
    };

    const evaluate = (): void => {
      if (disposed) return;
      const { offer, handoff, setOffer, setHandoff } = welcomeStore();
      const welcome = declaredWelcome();
      if (welcome === null) {
        tracked = null;
        if (offer !== null) setOffer(null);
        if (handoff !== null) setHandoff(null);
        return;
      }
      const identity = identityOf(welcome);
      if (tracked?.identity !== identity) {
        tracked = { identity, welcome, record: "loading" };
        if (offer !== null) setOffer(null);
        load(identity, welcome);
        return;
      }
      const tourId = makePluginTourId(welcome.instanceId, welcome.localTourId);
      const tour = getTour(tourId);
      if (tracked.record !== "open" || tour === undefined) {
        if (offer !== null) setOffer(null);
        return;
      }
      if (offer?.tourId === tourId) return;
      if (layoutComesFirst()) return;
      if (useUIStore.getState().overlayStack.length > 0) return;
      if (!isProjectViewObservable()) return;
      setOffer({
        ownerId: welcome.ownerId,
        localTourId: welcome.localTourId,
        tourId,
        version: welcome.version,
        appName: welcome.appName,
        tourTitle: tour.summary.title,
        minutes: tour.summary.minutes,
      });
    };

    const onCompleted = (event: Event): void => {
      const current = tracked;
      if (current === null) return;
      const { instanceId, localTourId } = current.welcome;
      if (tourIdOf(event) !== makePluginTourId(instanceId, localTourId)) return;
      void answer("completed").catch((error: unknown) =>
        logWarn("[ProjectWelcome] Couldn't record the finished welcome", { error })
      );
    };

    const unsubscribers = [
      useProjectPluginStore.subscribe((state, prev) => {
        if (state.application !== prev.application) evaluate();
      }),
      useProjectLayoutSeedStore.subscribe((state, prev) => {
        if (state.status !== prev.status || state.waiting !== prev.waiting) evaluate();
      }),
      usePluginLayoutsStore.subscribe((state, prev) => {
        if (state.layouts !== prev.layouts) evaluate();
      }),
      useUIStore.subscribe((state, prev) => {
        if (state.overlayStack !== prev.overlayStack) evaluate();
      }),
      subscribeToTourRegistry(evaluate),
      subscribeProjectViewObservability(evaluate),
    ];
    window.addEventListener(TOUR_COMPLETED_EVENT, onCompleted);
    evaluate();

    return () => {
      disposed = true;
      tracked = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      window.removeEventListener(TOUR_COMPLETED_EVENT, onCompleted);
    };
  }, [enabled]);
}

export function _resetProjectApplicationWelcomeForTest(): void {
  tracked = null;
}
