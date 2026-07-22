import { useEffect } from "react";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { usePanelStore } from "@/store/panelStore";
import {
  syncPluginPanels,
  type PluginPanelSnapshotEntry,
} from "@/services/plugin/pluginPanelLifecycle";

/**
 * Watch the panel store and feed plugin panel record transitions into
 * `pluginPanelLifecycle` (#11301).
 *
 * This lives above every panel presentation, beside `usePluginPanelKinds()` in
 * `App`, precisely because it must keep observing a panel whose view has
 * unmounted — the case that made the old single `disposeSignal` ambiguous. A
 * subscription owned by the plugin view itself would go away at the exact
 * moment it needed to report "I was backgrounded, not closed".
 *
 * Only panel kinds carrying an `extensionId` are tracked; built-in panels have
 * no plugin to notify.
 */
export function usePluginPanelLifecycle(): void {
  useEffect(() => {
    let disposed = false;
    let lastPanelsById: unknown = null;

    const collect = (): void => {
      if (disposed) return;
      const { panelsById } = usePanelStore.getState();
      const entries: PluginPanelSnapshotEntry[] = [];
      const livePanelIds = new Set<string>();
      for (const [panelId, panel] of Object.entries(panelsById)) {
        // Every panel counts as live, plugin-owned or not: liveness is what
        // decides permanent removal, and a plugin mid-upgrade briefly has no
        // registered kind while its panels are perfectly alive.
        livePanelIds.add(panelId);
        if (!panel?.kind) continue;
        const extensionId = getPanelKindConfig(panel.kind)?.extensionId;
        if (!extensionId) continue;
        entries.push({
          panelId,
          kindId: panel.kind,
          pluginId: extensionId,
          location: panel.location,
        });
      }
      syncPluginPanels(entries, livePanelIds);
    };

    const unsubscribe = usePanelStore.subscribe((state) => {
      // Most store writes (focus, resize, title) leave the panel map identical.
      // Bail on reference equality so a busy store doesn't rescan every panel
      // on every keystroke-driven update.
      if (state.panelsById === lastPanelsById) return;
      lastPanelsById = state.panelsById;
      collect();
    });

    // A plugin loading (or unloading) changes which kinds carry an
    // `extensionId`, and that happens without any panel-store write — a
    // persisted panel whose plugin was still loading is invisible to `collect`
    // until its kind registers. Re-collecting on the kind broadcast closes that
    // window; it is also what surfaces a panel after a plugin upgrade.
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    const stopKinds = electron?.plugin?.onPanelKindsChanged?.(() => collect());

    lastPanelsById = usePanelStore.getState().panelsById;
    collect();

    return () => {
      disposed = true;
      unsubscribe();
      stopKinds?.();
    };
  }, []);
}
