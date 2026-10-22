import { create } from "zustand";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of the launch entries plugins contribute to THIS view's
 * project (#13788), plus the plugin groups the project hides from its
 * launcher. Main is the source of truth for both; renderer state is per
 * project view, so this module-level store is already scoped to one project.
 *
 * Entries arrive the way toolbar buttons do — a pull on first use as a safety
 * net, a push as the authority, and a late pull dropped once a push has
 * landed. Nothing is ever swept against them: a pin whose entry is gone simply
 * renders nothing (see `buildLauncherToolbarCatalog`).
 */
interface PluginLaunchEntriesState {
  entries: readonly PluginLaunchEntryConfig[];
  /** Plugin instance ids whose launcher group this project hides. */
  hiddenPluginIds: readonly string[];
  /** The last hide or show main could not record, so a surface can say so. */
  saveError: string | null;
  init: () => void;
  setGroupHidden: (pluginId: string, hidden: boolean) => Promise<void>;
}

const EMPTY_ENTRIES: readonly PluginLaunchEntryConfig[] = [];
const EMPTY_IDS: readonly string[] = [];

/**
 * A command target outside the entry's own plugin namespace is dropped here as
 * well as refused at the manifest gate, so a forged or stale snapshot can't
 * turn a launcher row into a dispatch of someone else's action. The same rule
 * as `isOwnPluginAction`, spelled out so this store stays clear of the action
 * id tables that module reaches.
 */
function acceptEntries(entries: readonly PluginLaunchEntryConfig[]): PluginLaunchEntryConfig[] {
  return entries.filter(
    (entry) =>
      entry.target.type !== "command" ||
      (entry.pluginId.length > 0 && entry.target.actionId.startsWith(`${entry.pluginId}.`))
  );
}

let initialized = false;

export const usePluginLaunchEntriesStore = create<PluginLaunchEntriesState>((set) => {
  const readHidden = () => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getHiddenLaunchGroups !== "function") return;
    bridge
      .getHiddenLaunchGroups()
      .then((ids) => set({ hiddenPluginIds: ids.length > 0 ? ids : EMPTY_IDS }))
      .catch((error: unknown) =>
        logWarn("[PluginLaunchEntries] Failed to read hidden launcher groups", { error })
      );
  };

  return {
    entries: EMPTY_ENTRIES,
    hiddenPluginIds: EMPTY_IDS,
    saveError: null,

    init: () => {
      if (initialized) return;
      const bridge = typeof window !== "undefined" ? window.electron?.plugin : undefined;
      if (typeof bridge?.launchEntries !== "function") return;
      initialized = true;
      let pushReceived = false;

      bridge
        .launchEntries()
        .then((entries) => {
          if (pushReceived) return;
          set({ entries: acceptEntries(entries) });
        })
        .catch((error: unknown) =>
          logWarn("[PluginLaunchEntries] Failed to fetch initial launch entries", { error })
        );

      bridge.onLaunchEntriesChanged?.((payload) => {
        pushReceived = true;
        set({ entries: acceptEntries(payload.entries) });
        // A view is bound to its project when main replays its snapshot to it,
        // which is this push. A read made before that answered for no project,
        // so it is made again now rather than trusted.
        readHidden();
      });

      readHidden();
    },

    setGroupHidden: async (pluginId, hidden) => {
      const bridge = window.electron?.plugin;
      if (typeof bridge?.setLaunchGroupHidden !== "function") return;
      try {
        const ids = await bridge.setLaunchGroupHidden(pluginId, hidden);
        set({ hiddenPluginIds: ids.length > 0 ? ids : EMPTY_IDS, saveError: null });
      } catch (error) {
        logWarn("[PluginLaunchEntries] Failed to save a launcher group", { error });
        set({ saveError: pluginId });
      }
    },
  };
});

const INITIAL_STATE = usePluginLaunchEntriesStore.getState();

/** Test seam: restore the initial state and forget the one-time subscription. */
export function resetPluginLaunchEntriesStoreForTests(): void {
  initialized = false;
  usePluginLaunchEntriesStore.setState(INITIAL_STATE, true);
}
