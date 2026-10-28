import { useEffect } from "react";
import { subscribeToPanelKindRegistry } from "@shared/config/panelKindRegistry";
import { HAND_BACK_SEEN_DWELL_MS } from "@shared/utils/runHandBack";
import { activityReporterForPanel } from "@/lib/pluginPanelActivityPresentation";
import { canopyViewIsWatched } from "@/lib/canopySeen";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useCanopyStore } from "@/store/canopyStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import {
  selectPanelActivityReport,
  usePluginPanelActivityStore,
} from "@/store/pluginPanelActivityStore";

interface Unseen {
  panelId: string;
  revision: number;
}

/**
 * Turns a plugin's `finished` report from unread to seen once its panel has
 * been in front of the user (#13820), by the rule an agent's hand-back is held
 * to: the focused pane, while its view can be seen, its window has focus and
 * Canopy is not open over it, for `HAND_BACK_SEEN_DWELL_MS`. Opening a docked
 * panel focuses it, so a look in the dock counts the same. The project's Home
 * covers the grid but not the dock, so while it shows only an open dock
 * popover counts. Seen is this view's own record — nothing is told to main,
 * and no agent read mark moves.
 */
export function usePluginPanelActivitySeenTracking(): void {
  useEffect(() => {
    usePluginPanelActivityStore.getState().init();

    const unseenInFront = (): Unseen | null => {
      if (!canopyViewIsWatched() || useCanopyStore.getState().isOpen) return null;
      const { focusedId, panelsById, activeDockTerminalId } = usePanelStore.getState();
      if (focusedId === null) return null;
      // Home covers the grid, not the dock: only an open dock popover is seen.
      if (useProjectHomeStore.getState().presented && activeDockTerminalId !== focusedId) {
        return null;
      }
      const panel = panelsById[focusedId];
      if (!panel || panel.location === "trash") return null;
      const activity = usePluginPanelActivityStore.getState();
      const report = selectPanelActivityReport(
        activity,
        focusedId,
        activityReporterForPanel(panel)
      );
      if (report?.state !== "finished") return null;
      if (activity.seenRevisionByPanelId[focusedId] === report.revision) return null;
      return { panelId: focusedId, revision: report.revision };
    };

    let pending: Unseen | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const sync = () => {
      const next = unseenInFront();
      if (next?.panelId === pending?.panelId && next?.revision === pending?.revision) return;
      cancel();
      if (next === null) return;
      pending = next;
      timer = setTimeout(() => {
        timer = null;
        const target = pending;
        pending = null;
        const still = unseenInFront();
        if (target && still?.panelId === target.panelId && still.revision === target.revision) {
          usePluginPanelActivityStore.getState().markSeen(target.panelId, target.revision);
          return;
        }
        sync();
      }, HAND_BACK_SEEN_DWELL_MS);
    };
    sync();

    const offPanels = usePanelStore.subscribe((state, prev) => {
      if (
        state.focusedId !== prev.focusedId ||
        state.panelsById !== prev.panelsById ||
        state.activeDockTerminalId !== prev.activeDockTerminalId
      ) {
        sync();
      }
    });
    const offActivity = usePluginPanelActivityStore.subscribe((state, prev) => {
      if (
        state.activityByPanelId !== prev.activityByPanelId ||
        state.seenRevisionByPanelId !== prev.seenRevisionByPanelId
      ) {
        sync();
      }
    });
    const offRegistry = subscribeToPanelKindRegistry(sync);
    const offObservable = subscribeProjectViewObservability(sync);
    const offCanopy = useCanopyStore.subscribe((state, prev) => {
      if (state.isOpen !== prev.isOpen) sync();
    });
    const offHome = useProjectHomeStore.subscribe((state, prev) => {
      if (state.presented !== prev.presented) sync();
    });
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);

    return () => {
      offPanels();
      offActivity();
      offRegistry();
      offObservable();
      offCanopy();
      offHome();
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      cancel();
    };
  }, []);
}
