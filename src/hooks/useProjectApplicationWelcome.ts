import { useEffect } from "react";
import { makePluginTourId } from "@shared/utils/tourIds";
import type { ProjectWelcomeStatus } from "@shared/types/plugin";
import { getTour, subscribeToTourRegistry } from "@/components/Tour/tourRegistry";
import { requestTour } from "@/components/Tour/tourRequests";
import { TOUR_COMPLETED_EVENT, tourIdOf } from "@/components/Tour/tourEvents";
import { selectProjectDefaultLayout } from "@/hooks/useProjectLayoutSeed";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { notify } from "@/lib/notify";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { useProjectLayoutSeedStore } from "@/store/projectLayoutSeedStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useProjectWelcomeStore, type ProjectWelcomeHandoff } from "@/store/projectWelcomeStore";
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
 * The welcome this view is tracking. `record` is `loading` while main's record
 * is read, `unread` when that read failed, `open` while the welcome is still
 * on offer and `answered` once skipped or finished at this revision. `answer`
 * is set only when the user answered in this view, and is what the hand-off
 * strip follows. Module state, as in `tourRequests.ts`: one view per renderer.
 */
interface TrackedWelcome {
  identity: string;
  welcome: DeclaredWelcome;
  record: "loading" | "unread" | "open" | "answered";
  /** Bumped by every read, so only the latest one is believed. */
  read: number;
  answer: { skipped: boolean; tourTitle: string; dismissed: boolean } | null;
}

let tracked: TrackedWelcome | null = null;

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
 * applied, is being applied, is offered, failed and waits for a Retry, or left
 * recipes waiting to be started. One first-run strip at a time, in that order.
 */
function layoutComesFirst(): boolean {
  const { status, waiting } = useProjectLayoutSeedStore.getState();
  if (waiting !== null) return true;
  if (selectProjectDefaultLayout(usePluginLayoutsStore.getState().layouts) === null) return false;
  return status !== "settled" && status !== null;
}

/**
 * The hand-off strip, derived afresh: the application's first workflow once
 * the user answered the welcome here, while this view has that command
 * registered — one still registering appears when it lands, and one withdrawn
 * takes its button with it.
 */
function syncHandoff(): void {
  const { handoff, setHandoff } = useProjectWelcomeStore.getState();
  const current = tracked;
  const answer = current?.answer;
  const workflow = current?.welcome.firstWorkflow;
  let next: ProjectWelcomeHandoff | null = null;
  if (current && answer && !answer.dismissed && workflow !== undefined) {
    const actionId = `${current.welcome.instanceId}.${workflow}`;
    const title = getRegisteredPluginActionsSnapshot().get(actionId);
    if (title !== undefined) {
      next = {
        appName: current.welcome.appName,
        actionId,
        title: title || workflow,
        skipped: answer.skipped,
        tourTitle: answer.tourTitle,
      };
    }
  }
  const same =
    next === handoff ||
    (next !== null &&
      handoff !== null &&
      next.actionId === handoff.actionId &&
      next.title === handoff.title &&
      next.appName === handoff.appName &&
      next.skipped === handoff.skipped &&
      next.tourTitle === handoff.tourTitle);
  if (!same) setHandoff(next);
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
  tracked.answer = { skipped: status === "skipped", tourTitle, dismissed: false };
  useProjectWelcomeStore.getState().setOffer(null);
  syncHandoff();
}

/** The user's "Skip" on the welcome strip: not offered again until a new revision. */
export async function skipProjectWelcome(): Promise<void> {
  await answer("skipped");
}

/** The user's × on the hand-off strip, for as long as this view lives. */
export function dismissProjectWelcomeHandoff(): void {
  if (tracked?.answer) tracked.answer.dismissed = true;
  useProjectWelcomeStore.getState().setHandoff(null);
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
  // A tour that registered but failed to load is already reported by the
  // tour host, with the recovery that fits it.
  if (result.status !== "unavailable") return;
  notify({
    type: "error",
    priority: "high",
    title: "Couldn't start welcome",
    message: `${offer.appName}'s welcome isn't available right now. It may still be loading.`,
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
 * - the first-open layout is done with: applied, dismissed, or never coming;
 * - no dialog is open — host setup, trust, or another tour;
 * - this view is the one on screen, as main reports it.
 *
 * Once shown it stays until answered, the application stops being active, or
 * a layout arriving late takes its turn first; another window's answer is
 * picked up the next time this view comes on screen or its window takes focus.
 * Finishing the tour, however it was opened, records the answer and hands off
 * to the application's first workflow, which runs only on the user's click.
 */
export function useProjectApplicationWelcome(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const welcomeStore = useProjectWelcomeStore.getState;

    const load = (current: TrackedWelcome): void => {
      const { identity, welcome } = current;
      const read = ++current.read;
      // Only the latest read of the same welcome, and never over an answer
      // given here meanwhile.
      const stale = (): boolean =>
        disposed ||
        tracked?.identity !== identity ||
        tracked.read !== read ||
        tracked.record === "answered";
      void Promise.resolve()
        .then(() => window.electron.plugin.getProjectWelcome(welcome.ownerId, welcome.localTourId))
        .then(
          (record) => {
            if (stale() || tracked === null) return;
            tracked.record =
              record !== null && record.version >= welcome.version ? "answered" : "open";
            evaluate();
          },
          (error: unknown) => {
            // Unread is not unanswered: offering a welcome the user may have
            // turned down is worse than not offering it this time. The next
            // time the view comes on screen reads again.
            if (!stale() && tracked !== null) tracked.record = "unread";
            logWarn("[ProjectWelcome] Couldn't read the welcome record", { error });
          }
        );
    };

    /**
     * Another window may have answered meanwhile, and a failed read deserves
     * another go: coming on screen or taking focus reads main's record again.
     */
    const reread = (): void => {
      if (disposed || tracked === null) return;
      if (tracked.record === "open" || tracked.record === "unread") load(tracked);
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
        tracked = { identity, welcome, record: "loading", read: 0, answer: null };
        if (offer !== null) setOffer(null);
        if (handoff !== null) setHandoff(null);
        load(tracked);
        return;
      }
      // The same welcome, but the name or first workflow may have changed.
      tracked.welcome = welcome;
      syncHandoff();
      const tourId = makePluginTourId(welcome.instanceId, welcome.localTourId);
      const tour = getTour(tourId);
      // A layout that arrived late, or was offered meanwhile, takes its turn
      // first even over a welcome already shown.
      if (tracked.record !== "open" || tour === undefined || layoutComesFirst()) {
        if (offer !== null) setOffer(null);
        return;
      }
      if (offer?.tourId === tourId) return;
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
      subscribeToRegisteredPluginActions(evaluate),
      subscribeProjectViewObservability((observable) => {
        if (observable) reread();
        evaluate();
      }),
    ];
    window.addEventListener(TOUR_COMPLETED_EVENT, onCompleted);
    window.addEventListener("focus", reread);
    evaluate();

    return () => {
      disposed = true;
      tracked = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      window.removeEventListener(TOUR_COMPLETED_EVENT, onCompleted);
      window.removeEventListener("focus", reread);
    };
  }, [enabled]);
}

export function _resetProjectApplicationWelcomeForTest(): void {
  tracked = null;
}
