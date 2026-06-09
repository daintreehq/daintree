import { useEffect } from "react";
import { create } from "zustand";
import { logError } from "@/utils/logger";

/**
 * Renderer mirror of which plugins are currently disabled, so plugin-gated UI
 * (builtin view slots, plugin-owned settings panels) can drop out live when a
 * plugin is toggled in Preferences. Source of truth is `plugin.list()` in
 * main; refreshed on every `plugin:provenance-changed` broadcast — the same
 * signal PluginsTab/usePluginManager follow. Not persisted.
 *
 * Until the first snapshot lands, the disabled set is empty — unknown state
 * treats plugins as enabled, matching the pre-gating behavior (and the main
 * process independently gates plugin-backed IPC, so a brief optimistic render
 * cannot reach a disabled plugin's data).
 */
interface PluginRuntimeState {
  disabledPluginIds: ReadonlySet<string>;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;

async function pullDisabledSet(set: (state: Partial<PluginRuntimeState>) => void): Promise<void> {
  try {
    const list = await window.electron.plugin.list();
    set({
      disabledPluginIds: new Set(list.filter((p) => p.disabled).map((p) => p.manifest.name)),
    });
  } catch (err) {
    logError("Failed to load plugin disabled state", err);
  }
}

export const usePluginRuntimeStore = create<PluginRuntimeState>((set) => ({
  disabledPluginIds: new Set<string>(),
  init: () => {
    if (initialized) return;
    initialized = true;

    // Consumed from many leaf components (toolbar pills, banners, tooltips,
    // slot hooks), so tolerate a partially-stubbed bridge instead of pushing
    // a plugin-namespace mock into every component test. Absent bridge ⇒ the
    // disabled set stays empty (plugins read as enabled), matching prod
    // optimism before the first snapshot.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onProvenanceChanged !== "function" || typeof plugin.list !== "function") {
      return;
    }

    unsubscribe = plugin.onProvenanceChanged(() => {
      void pullDisabledSet(set);
    });
    void pullDisabledSet(set);
  },
}));

export const GITHUB_PLUGIN_ID = "daintree.github";

/**
 * Live GitHub plugin enable state for gating GitHub-shaped UI (stats pills,
 * health cards, token banner, tooltips). Initializes the mirror on first
 * mount; until the snapshot lands the plugin reads as enabled, matching the
 * registry-side optimism — main independently rejects gated IPC if it's
 * actually off.
 */
export function useGitHubPluginEnabled(): boolean {
  const disabledPluginIds = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const init = usePluginRuntimeStore((s) => s.init);
  useEffect(() => init(), [init]);
  return !disabledPluginIds.has(GITHUB_PLUGIN_ID);
}

/** Test-only: reset the module-level init guard between cases. */
export function _resetPluginRuntimeStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
}
