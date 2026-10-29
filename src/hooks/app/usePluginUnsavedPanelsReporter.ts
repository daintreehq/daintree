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
 * Tells Main which of this view's plugin views say they hold unsaved work, so
 * the plugin manager in any view can ask before disabling, updating or
 * uninstalling their plugin (#15031). Sent once on mount, so a new document
 * replaces whatever the last one in this view said, then only when that set or
 * one of its titles changes. A view hosted outside the grid has no panel record
 * and goes by its own name.
 */
export function usePluginUnsavedPanelsReporter() {
  useEffect(() => {
    const report = window.electron?.plugin?.reportUnsavedPanels;
    if (!report) return;
    // `null` before the first send and after a failed one, so the next push sends.
    let reported: string | null = null;
    const push = () => {
      if (reported === NOTHING_DIRTY && !hasAnyViewUnsavedChanges()) return;
      const { panelsById } = usePanelStore.getState();
      const panels: PluginUnsavedPanelReport[] = getViewUnsavedPluginPanels().map(
        ({ panelId, pluginId, displayName }) => ({
          panelId,
          pluginId,
          title: panelsById[panelId]?.title?.trim() || displayName,
        })
      );
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
