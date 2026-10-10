import { useEffect } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { usePanelStore } from "@/store/panelStore";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * Tells main when the user has a terminal in front of them, so Canopy can rank
 * a working agent up the longer it goes unlooked-at, and count what an agent
 * did as read once the user has had it on screen a moment. Most looking
 * happens in the terminal's own pane, not in the panel, so the focused pane is
 * what counts: in front of the user while its view can be seen, its window has
 * focus, and Canopy is not open over it. Only while Canopy is on.
 *
 * One look at a time, reconciled on every change that could move it — focus,
 * the view being cached or shown, the window, the panel — so a look always
 * ends, however it stopped being true. The look is told again each minute it
 * lasts; main lets one go that is not.
 */
export function useCanopySeenTracking(): void {
  useEffect(() => {
    if (!window.electron?.canopy?.markSeen) return;

    /** The pane in front of the user now, or null. */
    const inFront = (): string | null => {
      const { isOpen, mode } = useCanopyStore.getState();
      // Not on, Canopy reads nothing, so nothing here is told.
      if (mode !== "on" || !canopyViewIsWatched() || isOpen) return null;
      const id = usePanelStore.getState().focusedId;
      if (id === null) return null;
      const panel = usePanelStore.getState().panelsById[id];
      if (!panel || !isPtyPanel(panel) || panel.location === "trash") return null;
      return id;
    };

    let current: string | null = null;
    const sync = () => {
      const next = inFront();
      if (next === current) return;
      if (current !== null) reportCanopySeen(current, false);
      current = next;
      if (current !== null) reportCanopySeen(current, true);
    };
    sync();

    const offFocus = usePanelStore.subscribe((state, prev) => {
      if (state.focusedId !== prev.focusedId || state.panelsById !== prev.panelsById) sync();
    });
    const offObservable = subscribeProjectViewObservability(sync);
    const offCanopy = useCanopyStore.subscribe((state, prev) => {
      if (state.isOpen !== prev.isOpen || state.mode !== prev.mode) sync();
    });
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);

    const heartbeat = window.setInterval(() => {
      sync();
      if (current !== null) reportCanopySeen(current, true);
    }, CANOPY_SEEN_HEARTBEAT_MS);

    return () => {
      offFocus();
      offObservable();
      offCanopy();
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      if (current !== null) reportCanopySeen(current, false);
      current = null;
    };
  }, []);
}
