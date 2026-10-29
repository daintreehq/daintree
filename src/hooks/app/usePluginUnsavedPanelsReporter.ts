import { useEffect } from "react";
import type { PluginUnsavedPanelReport } from "@shared/types/pluginUnsavedPanels";
import {
  getViewUnsavedPluginPanels,
  hasAnyViewUnsavedChanges,
  subscribeViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";
import { usePanelStore } from "@/store/panelStore";

const NOTHING_DIRTY = "[]";

/**
 * Tells Main which of this view's plugin panels say they hold unsaved work, so
 * the plugin manager in any view can ask before disabling, updating or
 * uninstalling their plugin (#15031). Sent when that set or one of its titles
 * changes. A view with nothing dirty never reports, and Main forgets a view's
 * report along with its document.
 */
export function usePluginUnsavedPanelsReporter() {
  useEffect(() => {
    const report = window.electron?.plugin?.reportUnsavedPanels;
    if (!report) return;
    // `null` after a failed send, so the next change sends again.
    let reported: string | null = NOTHING_DIRTY;
    const push = () => {
      if (reported === NOTHING_DIRTY && !hasAnyViewUnsavedChanges()) return;
      const { panelsById } = usePanelStore.getState();
      const panels: PluginUnsavedPanelReport[] = [];
      for (const { panelId, pluginId } of getViewUnsavedPluginPanels()) {
        const panel = panelsById[panelId];
        if (!panel) continue;
        panels.push({ panelId, pluginId, title: panel.title?.trim() ?? "" });
      }
      const key = JSON.stringify(panels);
      if (key === reported) return;
      reported = key;
      void report(panels).catch(() => {
        if (reported === key) reported = null;
      });
    };
    const offDirty = subscribeViewUnsavedChanges(push);
    const offPanels = usePanelStore.subscribe((state, prev) => {
      if (state.panelsById !== prev.panelsById) push();
    });
    push();
    return () => {
      offDirty();
      offPanels();
    };
  }, []);
}
