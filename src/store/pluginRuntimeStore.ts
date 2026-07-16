import { create } from "zustand";
import { logError } from "@/utils/logger";

/**
 * Renderer mirror of live plugin runtime state: which plugins are disabled, so
 * plugin-gated UI (builtin view slots, plugin-owned settings panels) can drop
 * out live when a plugin is toggled in Preferences, plus the per-plugin
 * metadata diagnostics surfaces need synchronously (`pluginMetaById`). Source
 * of truth is `plugin.list()` in main; refreshed on every
 * `plugin:provenance-changed` broadcast — the same signal
 * PluginsTab/usePluginManager follow. Not persisted.
 *
 * Until the first snapshot lands, the disabled set is empty — unknown state
 * treats plugins as enabled, matching the pre-gating behavior (and the main
 * process independently gates plugin-backed IPC, so a brief optimistic render
 * cannot reach a disabled plugin's data). Metadata reads fail the other way:
 * an absent entry reads as non-dev, so a plugin's diagnostics are redacted
 * until its dev-mode flag is positively known (#11207).
 */
/** Per-plugin facts diagnostics surfaces need at render time. */
export interface PluginRuntimeMeta {
  /**
   * The plugin loads from a directory outside the managed plugins dir — i.e.
   * whoever is looking at it is looking at their own build.
   */
  devMode: boolean;
  /** `manifest.displayName` when the manifest declares one, else the plugin id. */
  displayName: string;
}

interface PluginRuntimeState {
  disabledPluginIds: ReadonlySet<string>;
  /**
   * Keyed by plugin id (`manifest.name`). An absent entry means "no snapshot
   * yet", not "no such plugin" — read it as non-dev, the conservative default.
   */
  pluginMetaById: ReadonlyMap<string, PluginRuntimeMeta>;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Monotonic pull sequence: rapid provenance events can interleave list()
// round-trips, and a slow older response must not overwrite a newer set.
let pullSeq = 0;

async function pullPluginRuntimeSnapshot(
  set: (state: Partial<PluginRuntimeState>) => void
): Promise<void> {
  const seq = ++pullSeq;
  try {
    const list = await window.electron.plugin.list();
    if (seq !== pullSeq) return;
    const disabledPluginIds = new Set<string>();
    const pluginMetaById = new Map<string, PluginRuntimeMeta>();
    for (const p of list) {
      const id = p.manifest.name;
      if (p.disabled) disabledPluginIds.add(id);
      pluginMetaById.set(id, {
        devMode: p.devMode,
        displayName: p.manifest.displayName ?? id,
      });
    }
    // One commit: a consumer must never read a plugin's dev-mode flag from a
    // different snapshot than the disabled set it renders against.
    set({ disabledPluginIds, pluginMetaById });
  } catch (err) {
    logError("Failed to load plugin runtime state", err);
  }
}

export const usePluginRuntimeStore = create<PluginRuntimeState>((set) => ({
  disabledPluginIds: new Set<string>(),
  pluginMetaById: new Map<string, PluginRuntimeMeta>(),
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
      void pullPluginRuntimeSnapshot(set);
    });
    void pullPluginRuntimeSnapshot(set);
  },
}));

/** Test-only: reset the module-level init guard between cases. */
export function _resetPluginRuntimeStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  usePluginRuntimeStore.setState({
    disabledPluginIds: new Set<string>(),
    pluginMetaById: new Map<string, PluginRuntimeMeta>(),
  });
}
