import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

/**
 * Plugins whose terminal link matchers the user switched off (#13798), keyed by
 * plugin instance id — `manifest.name` for an installed or builtin plugin, the
 * project-qualified key for a project one, which may share a manifest name with
 * an installed plugin. The choice is this machine's, never a repository's, and
 * it outlives the plugin being removed so a reinstall comes back switched off.
 */
export const PLUGIN_TERMINAL_LINKS_STORAGE_KEY = "daintree-plugin-terminal-links";

interface PluginTerminalLinkPreferencesPersistedState {
  disabled: Record<string, true>;
}

interface PluginTerminalLinkPreferencesState extends PluginTerminalLinkPreferencesPersistedState {
  setEnabled: (pluginId: string, enabled: boolean) => void;
}

function readDisabled(persisted: unknown): Record<string, true> | null {
  if (!persisted || typeof persisted !== "object" || !("disabled" in persisted)) return null;
  const { disabled } = persisted;
  if (!disabled || typeof disabled !== "object") return null;
  const clean: Record<string, true> = {};
  for (const [id, value] of Object.entries(disabled)) {
    if (value === true) clean[id] = true;
  }
  return clean;
}

// Every project view writes this key from its own V8 context; merge by the
// writer's delta so a stale view can't undo a switch a sibling just flipped.
function mergeDisabled({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<PluginTerminalLinkPreferencesPersistedState>) {
  return {
    ...incoming,
    state: {
      disabled: mergeRecordByWriterDelta(
        readDisabled(baseline?.state) ?? {},
        incoming.state.disabled,
        readDisabled(onDisk?.state) ?? {}
      ),
    },
  };
}

export const usePluginTerminalLinkPreferencesStore = create<PluginTerminalLinkPreferencesState>()(
  persist(
    (set) => ({
      disabled: {},
      setEnabled: (pluginId, enabled) =>
        set((s) => {
          if (enabled === !s.disabled[pluginId]) return s;
          const disabled = { ...s.disabled };
          if (enabled) delete disabled[pluginId];
          else disabled[pluginId] = true;
          return { disabled };
        }),
    }),
    {
      name: PLUGIN_TERMINAL_LINKS_STORAGE_KEY,
      version: 0,
      storage: createSafeJSONStorage<PluginTerminalLinkPreferencesPersistedState>({
        mergeOnWrite: mergeDisabled,
      }),
      partialize: (s) => ({ disabled: s.disabled }),
      merge: (persisted, current) => {
        const disabled = readDisabled(persisted);
        return disabled ? { ...current, disabled } : current;
      },
    }
  )
);

/** Whether `pluginId`'s terminal links are on: they are unless the user switched them off. */
export function arePluginTerminalLinksEnabled(pluginId: string): boolean {
  return usePluginTerminalLinkPreferencesStore.getState().disabled[pluginId] !== true;
}

// A persist store hydrates once per view, and a cached view would keep
// underlining a plugin's links after another view switched them off. Views
// share the storage partition, so the sibling's write arrives as a `storage`
// event.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== PLUGIN_TERMINAL_LINKS_STORAGE_KEY) return;
    void usePluginTerminalLinkPreferencesStore.persist.rehydrate();
  });
}

registerPersistedStore({
  storeId: "pluginTerminalLinkPreferencesStore",
  store: usePluginTerminalLinkPreferencesStore,
  persistedStateType: "{ disabled: Record<string, true> }",
});
