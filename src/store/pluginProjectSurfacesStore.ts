import { create } from "zustand";
import {
  pluginManifestIdFromInstanceKey,
  type ProjectSurfaceChoice,
  type ProjectSurfaceChoices,
  type ProjectSurfaceChoicesSnapshot,
  type ProjectSurfaceSlot,
  type ProjectSurfaceSnapshot,
} from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of the project surfaces claimed in THIS view's project
 * (§7.8), and of the user's remembered answers about them. Main is the source
 * of truth for both; neither pull carries a project id, because main resolves
 * the project from the sender's own view registration — a renderer that could
 * name the project could read another one's surfaces.
 *
 * Renderer state is per project view (each project gets its own
 * `WebContentsView` and V8 context), so this module-level store is already
 * scoped to one project — there is no cross-project state for it to mix up.
 *
 * There is no dedicated `plugin:surfaces-changed` push. A surface claim always
 * resolves to a plugin panel KIND, so a claim can only appear or disappear in
 * the same load/unload that registers or unregisters that kind — and the
 * project-scoped `plugin:panel-kinds-changed` broadcast already fires on
 * exactly those transitions. Re-pulling on it keeps the snapshot correct
 * without a second event to keep in step with the first. Answers are different:
 * only the user changes them, so main pushes the full set to every view of the
 * project when one does.
 *
 * Claims and answers are pulled together and applied in one update. Apart, a
 * claim could land a render before the answer behind it and mount the plugin's
 * view — or ask the first-show question — in a project that chose the launcher
 * long ago.
 */
interface PluginProjectSurfacesState {
  surfaces: ProjectSurfaceSnapshot;
  /**
   * This project's remembered answers: whether each claimed slot shows the
   * plugin's surface or the host's stock content.
   *
   * Persisted, because a project whose owner chose the launcher should not swap
   * back on every relaunch — and never silent, because project plugin settings
   * name the plugin that owns the slot and offer a reset. An answer only counts
   * for the plugin it was about; read it through {@link selectSurfaceChoice}.
   */
  choices: ProjectSurfaceChoices;
  /**
   * True once main has answered for this view's project. Until then "no answer"
   * is unknown rather than known, and the first-show question must not appear
   * in a project that answered long ago. A sender main has not bound to its
   * project yet stays unknown too: a relaunch restores the last project before
   * its view is registered, and the pull that follows the claim reads it again.
   */
  choicesLoaded: boolean;
  /** The project main named for `choices`; a push naming any other is refused. */
  choicesProjectId: string | null;
  /** The last answer main could not record, so the canvas can say so and retry it. */
  failedSave: { slot: ProjectSurfaceSlot; choice: ProjectSurfaceChoice | null } | null;
  /** Answer for whichever plugin owns `slot` now, or forget the answer with `null`. */
  setSurfaceChoice: (slot: ProjectSurfaceSlot, choice: ProjectSurfaceChoice | null) => Promise<void>;
  dismissFailedSave: () => void;
  /** Idempotent: pulls claims and answers once, then follows their change signals. */
  init: () => void;
}

let initialized = false;
let unsubscribers: Array<() => void> = [];
// Monotonic pull sequence, so a slow pull can never overwrite a newer one
// started by a panel-kinds push that arrived while it was in flight.
let pullSeq = 0;
// Bumped whenever answers are adopted outside a pull (a save or a push), so a
// pull that was already in flight cannot roll them back to what it read.
let choicesSeq = 0;

/**
 * The remembered answer for `slot`, but only when it was about the plugin that
 * owns the slot NOW.
 *
 * A slot that has passed to a different plugin is undecided again: agreeing to
 * one plugin's canvas is not agreeing to whatever claims it next, which is also
 * why a new owner gets its own first-show question.
 */
export function selectSurfaceChoice(
  state: Pick<PluginProjectSurfacesState, "surfaces" | "choices">,
  slot: ProjectSurfaceSlot
): ProjectSurfaceChoice | null {
  const claim = state.surfaces[slot];
  const record = state.choices[slot];
  if (claim === undefined || record === undefined) return null;
  return record.pluginId === pluginManifestIdFromInstanceKey(claim.pluginId)
    ? record.choice
    : null;
}

export const usePluginProjectSurfacesStore = create<PluginProjectSurfacesState>((set, get) => {
  const adoptChoices = (snapshot: ProjectSurfaceChoicesSnapshot) => {
    ++choicesSeq;
    set({
      choices: snapshot.choices,
      choicesProjectId: snapshot.projectId,
      choicesLoaded: true,
    });
  };

  const pull = () => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.getProjectSurfaces !== "function") return;
    const seq = ++pullSeq;
    const choicesAtStart = choicesSeq;
    const answers =
      typeof plugin.getProjectSurfaceChoices === "function"
        ? plugin.getProjectSurfaceChoices()
        : Promise.resolve(null);
    void Promise.allSettled([plugin.getProjectSurfaces(), answers]).then(
      ([surfaces, snapshot]) => {
        if (seq !== pullSeq) return;
        const next: Partial<PluginProjectSurfacesState> = {};
        if (surfaces.status === "fulfilled") {
          next.surfaces = surfaces.value;
        } else {
          // Clear rather than keep the last answer. A retained claim outlives
          // the plugin that made it: if the same runtime kind id is later
          // re-registered without a claim behind it, a stale snapshot would
          // resurrect a surface main no longer owns. Falling back to the host's
          // own canvas is always safe; showing a plugin's is not.
          next.surfaces = {};
          logWarn("[pluginProjectSurfacesStore] Failed to fetch project surfaces", {
            error: surfaces.reason,
          });
        }
        if (snapshot.status === "rejected") {
          // Stay as loaded as we were rather than read the failure as "never
          // answered": the claimed surface still shows, as its manifest asked,
          // and nobody is asked a question they may already have answered.
          logWarn("[pluginProjectSurfacesStore] Failed to fetch project surface choices", {
            error: snapshot.reason,
          });
        } else if (snapshot.value !== null && choicesSeq === choicesAtStart) {
          next.choices = snapshot.value.choices;
          next.choicesProjectId = snapshot.value.projectId;
          next.choicesLoaded = true;
        }
        set(next);
      }
    );
  };

  return {
    surfaces: {},
    choices: {},
    choicesLoaded: false,
    choicesProjectId: null,
    failedSave: null,
    setSurfaceChoice: async (slot, choice) => {
      const plugin = window.electron?.plugin;
      if (typeof plugin?.setProjectSurfaceChoice !== "function") return;
      set({ failedSave: null });
      try {
        // Not applied ahead of the round trip. Main records answers in the
        // order they arrive and pushes each one before replying, so adopting
        // only what main returns keeps every view in step with disk with
        // nothing to reconcile — and the round trip is one store write.
        adoptChoices(await plugin.setProjectSurfaceChoice(slot, choice));
      } catch (err) {
        set({ failedSave: { slot, choice } });
        logWarn("[pluginProjectSurfacesStore] Failed to save a project surface choice", {
          slot,
          choice,
          error: err,
        });
      }
    },
    dismissFailedSave: () => set({ failedSave: null }),
    init: () => {
      if (initialized) return;

      // Tolerate a partially-stubbed bridge rather than forcing a plugin-
      // namespace mock into every component test that renders an empty canvas.
      // Absent bridge ⇒ no surfaces ⇒ stock content, matching prod before the
      // first pull. Don't latch until the bridge is present, so this stays
      // retryable.
      const plugin = window.electron?.plugin;
      if (
        typeof plugin?.getProjectSurfaces !== "function" ||
        typeof plugin.onPanelKindsChanged !== "function"
      ) {
        return;
      }

      pull();
      const subscriptions = [plugin.onPanelKindsChanged(() => pull())];
      const events = window.electron?.events;
      if (typeof events?.on === "function") {
        subscriptions.push(
          events.on("plugin:project-surface-choices-changed", (payload) => {
            // Main addresses this to one project's views. Refuse a set for a
            // project this view has already been told it is not — the guard
            // `projectPluginStore` applies — and accept it before the first
            // answer names one, since main sent it here on purpose.
            const owner = get().choicesProjectId;
            if (owner !== null && owner !== payload.projectId) return;
            adoptChoices(payload);
          })
        );
      }
      unsubscribers = subscriptions;

      // Latch only after the pull and the listeners are in place, so a throw
      // from any of them leaves the store retryable rather than subscribed to
      // nothing.
      initialized = true;
    },
  };
});

/** Test-only: reset the module-level init guard, pull sequences, and state. */
export function _resetPluginProjectSurfacesStoreForTest(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  initialized = false;
  pullSeq = 0;
  choicesSeq = 0;
  usePluginProjectSurfacesStore.setState({
    surfaces: {},
    choices: {},
    choicesLoaded: false,
    choicesProjectId: null,
    failedSave: null,
  });
}
