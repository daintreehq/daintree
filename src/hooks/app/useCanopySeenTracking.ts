import { useEffect } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { usePanelStore } from "@/store/panelStore";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * Tells main when the user had a terminal in front of them, so Canopy can rank
 * a working agent up the longer it goes unlooked-at. Most looking happens in
 * the terminal's own pane, not in the panel, so the focused pane is what
 * counts: marked as it takes focus, again as it gives focus up (it was in view
 * until then), again each minute it stays in front of the user, and as the
 * view or window stops being seen.
 *
 * Only a view someone can see marks anything: a cached project view, or a
 * window behind another app, keeps a focused pane nobody is looking at.
 */
export function useCanopySeenTracking(): void {
  useEffect(() => {
    if (!window.electron?.canopy?.markSeen) return;

    const mark = (id: string | null = usePanelStore.getState().focusedId) => {
      if (id === null) return;
      const panel = usePanelStore.getState().panelsById[id];
      if (!panel || !isPtyPanel(panel) || panel.location === "trash") return;
      reportCanopySeen(id);
    };

    let focusedId = usePanelStore.getState().focusedId;
    if (canopyViewIsWatched()) mark(focusedId);

    const offFocus = usePanelStore.subscribe((state) => {
      if (state.focusedId === focusedId) return;
      const previous = focusedId;
      focusedId = state.focusedId;
      // A focus move nobody saw (a pane exiting in a window behind another
      // app) is no look at either pane.
      if (!canopyViewIsWatched()) return;
      mark(previous);
      mark(focusedId);
    });

    // The view going out of sight ends a look, provided its window had focus;
    // coming back into sight starts one.
    const offObservable = subscribeProjectViewObservability(() => {
      if (document.hasFocus()) mark();
    });

    // Leaving the window ends a look at its pane — focus is already gone by
    // the time blur fires, so only the view's own visibility is asked.
    const onWindowBlur = () => {
      if (isProjectViewObservable()) mark();
    };
    const onWindowFocus = () => {
      if (canopyViewIsWatched()) mark();
    };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);

    // A pane in front of the user for a long stretch stays seen. Not while
    // Canopy covers it: the panel reports the run it shows itself.
    const heartbeat = window.setInterval(() => {
      if (!useCanopyStore.getState().isOpen && canopyViewIsWatched()) mark();
    }, CANOPY_SEEN_HEARTBEAT_MS);

    // The pane the user was in up to the moment the panel opened over it.
    const offCanopy = useCanopyStore.subscribe((state, prev) => {
      if (state.isOpen && !prev.isOpen && canopyViewIsWatched()) mark();
    });

    return () => {
      offFocus();
      offObservable();
      offCanopy();
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);
}
