import { create } from "zustand";
import {
  pluginManifestIdFromInstanceKey,
  type ProjectSurfaceChoice,
  type ProjectSurfaceChoices,
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
   * True once main's answers have been read. Until then "no answer" is unknown
   * rather than known, and the first-show notice must not flash up in a project
   * that answered long ago.
   */
  choicesLoaded: boolean;
  /** Answer for whichever plugin owns `slot` now, or forget the answer with `null`. */
  setSurfaceChoice: (slot: ProjectSurfaceSlot, choice: ProjectSurfaceChoice | null) => Promise<void>;
  /** Idempotent: pulls claims and answers once, then follows their change signals. */
  init: () => void;
}

let initialized = false;
let unsubscribers: Array<() => void> = [];
// Monotonic pull sequences, so a slow pull can never overwrite a newer answer.
// Separate counters: an answer the user just gave must beat a choices pull that
// was already in flight without discarding an unrelated surfaces pull.
let surfacesSeq = 0;
let choicesSeq = 0;

/**
 * The remembered answer for `slot`, but only when it was about the plugin that
 * owns the slot NOW.
 *
 * A slot that has passed to a different plugin is undecided again: agreeing to
 * one plugin's canvas is not agreeing to whatever claims it next, which is also
 * why a new owner gets its own first-show notice.
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
  const pullSurfaces = () => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.getProjectSurfaces !== "function") return;
    const seq = ++surfacesSeq;
    void plugin
      .getProjectSurfaces()
      .then((surfaces) => {
        if (seq !== surfacesSeq) return;
        set({ surfaces });
      })
      .catch((err: unknown) => {
        // Clear rather than keep the last answer. A retained claim outlives the
        // plugin that made it: if the same runtime kind id is later
        // re-registered without a claim behind it, a stale snapshot would
        // resurrect a surface main no longer owns. Falling back to the host's
        // own canvas is always safe; showing a plugin's is not.
        if (seq !== surfacesSeq) return;
        set({ surfaces: {} });
        logWarn("[pluginProjectSurfacesStore] Failed to fetch project surfaces", { error: err });
      });
  };

  const pullChoices = () => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.getProjectSurfaceChoices !== "function") return;
    const seq = ++choicesSeq;
    void plugin
      .getProjectSurfaceChoices()
      .then((choices) => {
        if (seq !== choicesSeq) return;
        set({ choices, choicesLoaded: true });
      })
      .catch((err: unknown) => {
        // Stay unloaded rather than read the failure as "never answered": the
        // claimed surface still shows, as its manifest asked, and nobody is
        // asked a question this view could not tell they already answered.
        if (seq !== choicesSeq) return;
        logWarn("[pluginProjectSurfacesStore] Failed to fetch project surface choices", {
          error: err,
        });
      });
  };

  return {
    surfaces: {},
    choices: {},
    choicesLoaded: false,
    setSurfaceChoice: async (slot, choice) => {
      const { surfaces, choices } = get();
      const next = { ...choices };
      if (choice === null) {
        delete next[slot];
      } else {
        const claim = surfaces[slot];
        // Nothing owns the slot, so there is nothing to answer about — main
        // would refuse the write for the same reason.
        if (claim === undefined) return;
        next[slot] = {
          pluginId: pluginManifestIdFromInstanceKey(claim.pluginId),
          choice,
          decidedAt: Date.now(),
        };
      }
      // Applied before the round trip: the switch has to move on the click, not
      // when the store write lands.
      const seq = ++choicesSeq;
      set({ choices: next });

      const plugin = window.electron?.plugin;
      if (typeof plugin?.setProjectSurfaceChoice !== "function") return;
      try {
        const persisted = await plugin.setProjectSurfaceChoice(slot, choice);
        if (seq !== choicesSeq) return;
        set({ choices: persisted, choicesLoaded: true });
      } catch (err) {
        // Kept for this session rather than rolled back — the user asked for
        // this canvas and gets it — but it will not survive a relaunch.
        logWarn("[pluginProjectSurfacesStore] Failed to save a project surface choice", {
          slot,
          choice,
          error: err,
        });
      }
    },
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

      pullSurfaces();
      pullChoices();
      const subscriptions = [plugin.onPanelKindsChanged(() => pullSurfaces())];
      const events = window.electron?.events;
      if (typeof events?.on === "function") {
        subscriptions.push(
          events.on("plugin:project-surface-choices-changed", (payload) => {
            // Main sends this only to the views of the project it names, and it
            // is the full set, so it supersedes anything in flight.
            ++choicesSeq;
            set({ choices: payload.choices, choicesLoaded: true });
          })
        );
      }
      unsubscribers = subscriptions;

      // Latch only after the pulls and the listeners are in place, so a throw
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
  surfacesSeq = 0;
  choicesSeq = 0;
  usePluginProjectSurfacesStore.setState({ surfaces: {}, choices: {}, choicesLoaded: false });
}
