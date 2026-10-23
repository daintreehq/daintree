import { useEffect } from "react";
import { getPanelKindConfig, subscribeToPanelKindRegistry } from "@shared/config/panelKindRegistry";
import { usePanelStore } from "@/store/panelStore";
import {
  syncPluginPanels,
  type PluginPanelSnapshotEntry,
} from "@/services/plugin/pluginPanelLifecycle";

type PanelsById = ReturnType<typeof usePanelStore.getState>["panelsById"];

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
    let lastPanelsById: PanelsById = usePanelStore.getState().panelsById;
    let lastPanelCount = Object.keys(lastPanelsById).length;
    let lastNonPluginKey: string | null = null;

    const collect = (): void => {
      if (disposed) return;
      const { panelsById } = usePanelStore.getState();
      const entries: PluginPanelSnapshotEntry[] = [];
      const livePanelIds = new Set<string>();
      const nonPluginPanelIds: string[] = [];
      for (const [panelId, panel] of Object.entries(panelsById)) {
        // Every panel counts as live, plugin-owned or not: liveness is what
        // decides permanent removal, and a plugin mid-upgrade briefly has no
        // registered kind while its panels are perfectly alive.
        livePanelIds.add(panelId);
        if (!panel?.kind) continue;
        // A PTY-backed plugin panel is a "terminal"; the kind it was opened as
        // is what names its plugin (#13213).
        const kindId = panel.pluginPanelKindId ?? panel.kind;
        const kind = getPanelKindConfig(kindId);
        const extensionId = kind?.extensionId;
        if (!extensionId) {
          // Only a registered kind with no plugin is known to be non-plugin; an
          // unregistered one may be a plugin kind mid-upgrade.
          if (kind) nonPluginPanelIds.push(panelId);
          continue;
        }
        entries.push({
          panelId,
          kindId,
          pluginId: extensionId,
          location: panel.location,
        });
      }
      syncPluginPanels(entries, livePanelIds);
      reportNonPluginPanels(nonPluginPanelIds);
    };

    // Lets main refuse `host.reloadPanel()` on a terminal or browser panel
    // explicitly rather than calling it unmounted (#12610). Sent only when the
    // set changes — title, focus and resize writes leave it untouched.
    const reportNonPluginPanels = (panelIds: string[]): void => {
      panelIds.sort();
      const key = panelIds.join("\u0000");
      if (key === lastNonPluginKey) return;
      const report = window.electron?.plugin?.reportPanelInventory;
      if (!report) return;
      lastNonPluginKey = key;
      void report(panelIds).catch(() => {
        // Retried on the next change; a missing inventory only costs a refusal
        // its specific reason.
        lastNonPluginKey = null;
      });
    };

    // `collect` reads only panel ids, `kind`, `pluginPanelKindId` and
    // `location`. Activity, status and title writes replace the map (and the
    // one entry they touch) at up to frame rate in a busy session, so compare
    // entries by reference and those fields only: a non-structural write costs
    // a pointer walk, not a kind lookup per panel (#14126). Every store writer
    // patches immutably, so an untouched entry keeps its reference.
    const isStructuralChange = (prev: PanelsById, next: PanelsById): boolean => {
      const prevCount = lastPanelCount;
      let nextCount = 0;
      let changed = false;
      for (const id in next) {
        nextCount++;
        if (changed) continue;
        const before = prev[id];
        const after = next[id];
        if (before === after) continue;
        if (
          !before ||
          !after ||
          before.kind !== after.kind ||
          before.pluginPanelKindId !== after.pluginPanelKindId ||
          before.location !== after.location
        ) {
          changed = true;
        }
      }
      lastPanelCount = nextCount;
      // With no id added, an equal count means none was removed either.
      return changed || nextCount !== prevCount;
    };

    const unsubscribe = usePanelStore.subscribe((state) => {
      // Focus and resize writes leave the panel map identical.
      if (state.panelsById === lastPanelsById) return;
      const prev = lastPanelsById;
      lastPanelsById = state.panelsById;
      if (isStructuralChange(prev, state.panelsById)) collect();
    });

    // A plugin loading, unloading or upgrading changes which kinds carry an
    // `extensionId` without any panel-store write — a persisted panel whose
    // plugin was still loading is invisible to `collect` until its kind
    // registers. `usePluginPanelKinds` applies both main's broadcasts and its
    // own mount-time pull to the registry, so its change signal covers the
    // cached `WebContentsView` that missed the cold-start broadcast too,
    // without a second `getPanelKinds()` round-trip from here.
    const stopKinds = subscribeToPanelKindRegistry(collect);

    collect();

    return () => {
      disposed = true;
      unsubscribe();
      stopKinds();
    };
  }, []);
}
