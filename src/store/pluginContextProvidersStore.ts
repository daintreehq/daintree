import { create } from "zustand";
import type { ContextProviderEntry } from "@shared/types/pluginContextProvider";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of the `@` context providers THIS view's project sees
 * (#13795): which prefix each plugin holds here, which it was refused, which
 * the user switched off. Main is the source of truth and decides who holds a
 * prefix; renderer state is per project view, so the module-level store is
 * already scoped to one project.
 *
 * Pulled, never pushed: on first use, when plugins come and go, and whenever
 * an `@` menu opens. A pull made before the view was bound to its project
 * answers for no project, and the next one corrects it. Sending never trusts
 * this mirror — main resolves every reference against its own registry — so a
 * stale snapshot can only cost a chip or a menu, never the wrong content.
 */
interface PluginContextProvidersState {
  entries: readonly ContextProviderEntry[];
  /**
   * The switch main last could not record — which plugin, and what was asked —
   * so settings can say so and Retry asks for the same thing again.
   */
  saveError: { pluginId: string; enabled: boolean } | null;
  init: () => void;
  refresh: () => void;
  /** Resolves `false` when main couldn't record it; `saveError` then holds the request. */
  setEnabled: (pluginId: string, enabled: boolean) => Promise<boolean>;
}

const EMPTY_ENTRIES: readonly ContextProviderEntry[] = [];

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Only the newest pull or write answers: a slow older one must not put back a
// snapshot the user has since changed.
let seq = 0;
// Writes alone, and answers from main that actually landed: a failed write is
// undone unless a newer write began or main's state arrived since it did. A
// pull that merely started, then failed, settles nothing.
let writes = 0;
let landed = 0;

function sameEntries(a: readonly ContextProviderEntry[], b: readonly ContextProviderEntry[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const usePluginContextProvidersStore = create<PluginContextProvidersState>((set, get) => {
  const commit = (entries: readonly ContextProviderEntry[]) => {
    // An unchanged list keeps its identity, so an `@` menu opening doesn't
    // rebuild the composer's chips for nothing.
    if (sameEntries(entries, get().entries)) return;
    set({ entries: entries.length > 0 ? entries : EMPTY_ENTRIES });
  };

  const pull = () => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getContextProviders !== "function") return;
    const pullSeq = ++seq;
    bridge
      .getContextProviders()
      .then((entries) => {
        if (pullSeq !== seq) return;
        landed++;
        commit(entries);
      })
      .catch((error: unknown) =>
        logWarn("[PluginContextProviders] Failed to read context providers", { error })
      );
  };

  return {
    entries: EMPTY_ENTRIES,
    saveError: null,

    init: () => {
      if (initialized) return;
      initialized = true;
      const plugin = window.electron?.plugin;
      const events = window.electron?.events;
      const offProvenance =
        typeof plugin?.onProvenanceChanged === "function"
          ? plugin.onProvenanceChanged(pull)
          : undefined;
      const offProjectPlugins =
        typeof events?.on === "function"
          ? events.on("plugin:project-plugins-changed", pull)
          : undefined;
      unsubscribe = () => {
        offProvenance?.();
        offProjectPlugins?.();
      };
      pull();
    },

    refresh: pull,

    // Optimistic, so the switch moves in the same render. A write main
    // refused is undone on the spot — unless a newer write or pull has landed
    // since — and main's answer is then read back to confirm it.
    setEnabled: async (pluginId, enabled) => {
      const bridge = window.electron?.plugin;
      if (typeof bridge?.setContextProvidersEnabled !== "function") return false;
      const before = get().entries;
      set({
        entries: before.map((entry) =>
          entry.pluginId !== pluginId
            ? entry
            : { ...entry, status: enabled ? "active" : "off", heldBy: undefined }
        ),
      });
      const writeSeq = ++seq;
      const write = ++writes;
      const landedAtStart = landed;
      try {
        const entries = await bridge.setContextProvidersEnabled(pluginId, enabled);
        if (writeSeq === seq) {
          landed++;
          commit(entries);
        }
        if (get().saveError?.pluginId === pluginId) set({ saveError: null });
        return true;
      } catch (error) {
        logWarn("[PluginContextProviders] Failed to save a context provider switch", { error });
        const superseded = write !== writes || landed !== landedAtStart;
        set({
          saveError: { pluginId, enabled },
          ...(superseded ? {} : { entries: before }),
        });
        pull();
        return false;
      }
    },
  };
});

/** The providers that hold their prefix here, i.e. what the composer offers. */
export function selectActiveContextProviders(
  entries: readonly ContextProviderEntry[]
): ContextProviderEntry[] {
  return entries.filter((entry) => entry.status === "active");
}

const INITIAL_STATE = usePluginContextProvidersStore.getState();

/** Test seam: restore the initial state and forget the one-time subscription. */
export function resetPluginContextProvidersStoreForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  seq = 0;
  writes = 0;
  landed = 0;
  usePluginContextProvidersStore.setState(INITIAL_STATE, true);
}
