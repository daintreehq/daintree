import { create } from "zustand";
import type { ProjectSurfaceSnapshot } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of the project surfaces claimed in THIS view's project
 * (§7.8). Main is the source of truth; the pull carries no project id, because
 * main resolves the project from the sender's own view registration — a
 * renderer that could name the project could read another one's surfaces.
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
 * without a second event to keep in step with the first.
 */
interface PluginProjectSurfacesState {
  surfaces: ProjectSurfaceSnapshot;
  /**
   * The user has asked for the host's own empty canvas back, so a claimed
   * `emptyCanvas` surface stands down until they switch again.
   *
   * A surface slot replaces something the host draws, and the one thing a
   * plugin must never be able to do is take the launcher away — so the
   * replacement is always reversible, from the surface itself. Deliberately
   * NOT persisted: the pin is a "let me get at the stock launcher" gesture for
   * right now, not a preference, and a persisted one would leave a project
   * silently showing stock chrome long after the user forgot they asked.
   */
  stockCanvasPinned: boolean;
  setStockCanvasPinned: (pinned: boolean) => void;
  /** Idempotent: pulls the current claims once and re-pulls on kind changes. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Monotonic pull sequence, so a slow pull can never overwrite a newer one
// started by a panel-kinds push that arrived while it was in flight.
let pullSeq = 0;

export const usePluginProjectSurfacesStore = create<PluginProjectSurfacesState>((set) => {
  const pull = () => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.getProjectSurfaces !== "function") return;
    const seq = ++pullSeq;
    void plugin
      .getProjectSurfaces()
      .then((surfaces) => {
        if (seq !== pullSeq) return;
        set({ surfaces });
      })
      .catch((err: unknown) => {
        // Clear rather than keep the last answer. A retained claim outlives the
        // plugin that made it: if the same runtime kind id is later
        // re-registered without a claim behind it, a stale snapshot would
        // resurrect a surface main no longer owns. Falling back to the host's
        // own canvas is always safe; showing a plugin's is not.
        if (seq !== pullSeq) return;
        set({ surfaces: {} });
        logWarn("[pluginProjectSurfacesStore] Failed to fetch project surfaces", { error: err });
      });
  };

  return {
    surfaces: {},
    stockCanvasPinned: false,
    setStockCanvasPinned: (pinned: boolean) => set({ stockCanvasPinned: pinned }),
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
      unsubscribe = plugin.onPanelKindsChanged(() => pull());

      // Latch only after both the pull and the listener are in place, so a
      // throw from either leaves the store retryable rather than subscribed to
      // nothing.
      initialized = true;
    },
  };
});

/** Test-only: reset the module-level init guard, pull sequence, and state. */
export function _resetPluginProjectSurfacesStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  usePluginProjectSurfacesStore.setState({ surfaces: {}, stockCanvasPinned: false });
}
