import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface PilotState {
  isOpen: boolean;
  /**
   * Workspace ids the user has collapsed. Stored as the exception rather than
   * the rule so a newly-added project defaults to expanded — the opposite would
   * silently hide a project's agents the first time it appears.
   */
  collapsedWorkspaceIds: string[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  toggleWorkspaceCollapsed: (workspaceId: string) => void;
  isWorkspaceCollapsed: (workspaceId: string) => boolean;
}

/**
 * Open state and collapse memory for the fleet overview.
 *
 * A store rather than local state threaded through `App`: Pilot is opened from
 * the action registry, the project switcher and a keybinding, and none of those
 * has a natural prop path to a `useState` in the app shell.
 *
 * Only the collapse set persists. `isOpen` deliberately does not — a dialog
 * that reopens itself on next launch because it was open at quit is a surprise,
 * not a restored preference.
 */
/**
 * `localStorage`, proven writable — or a thrown error, which is what disables
 * persistence.
 *
 * The throw is deliberate: `createJSONStorage` only skips persistence when its
 * getter THROWS. Returning undefined instead yields a storage object whose
 * every write dereferences undefined, turning a missing-storage environment
 * into a crash on each state change.
 *
 * A `typeof` guard is not enough either. Node defines the global but leaves it
 * unusable without `--localstorage-file`, so it is present and fails on write —
 * and this store is imported transitively by the action registry, which
 * node-environment tests load.
 */
function assertWritableLocalStorage(): Storage {
  const probe = "__daintree_pilot_probe__";
  localStorage.setItem(probe, probe);
  localStorage.removeItem(probe);
  return localStorage;
}

export const usePilotStore = create<PilotState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      collapsedWorkspaceIds: [],
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      toggleWorkspaceCollapsed: (workspaceId) =>
        set((state) => ({
          collapsedWorkspaceIds: state.collapsedWorkspaceIds.includes(workspaceId)
            ? state.collapsedWorkspaceIds.filter((id) => id !== workspaceId)
            : [...state.collapsedWorkspaceIds, workspaceId],
        })),
      isWorkspaceCollapsed: (workspaceId) => get().collapsedWorkspaceIds.includes(workspaceId),
    }),
    {
      name: "daintree-pilot",
      storage: createJSONStorage(() => assertWritableLocalStorage()),
      partialize: (state) => ({ collapsedWorkspaceIds: state.collapsedWorkspaceIds }),
    }
  )
);
