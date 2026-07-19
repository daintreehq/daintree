import { create } from "zustand";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { usePanelStore } from "./panelStore";
import { logError } from "@/utils/logger";

/**
 * Owns the single panel currently presented as a modal dialog.
 *
 * The panel record itself lives in the normal panel registry under
 * `location: "dialog"` so panel components (which read their own state from
 * `panelsById`) render unmodified inside the dialog. This store only holds the
 * pointer to it, plus the lifecycle operations the host needs.
 *
 * Lifecycle ownership is deliberate: open/close/promote are driven from here
 * (and from the host's handlers), never from the presented component's own
 * mount/unmount effects. React 19 StrictMode double-invokes effects in dev, so
 * an effect-owned record would be destroyed and recreated on every mount.
 */
interface PanelDialogState {
  /** Panel id currently presented as a dialog, or null when closed. */
  panelId: string | null;
  /**
   * Monotonic open counter. `Number(panelId != null)` would stay `1` across
   * back-to-back opens while a dialog is already open, so an ErrorBoundary
   * keyed on it would never reset for the next file (#9918).
   */
  requestSeq: number;
  /**
   * Create an ephemeral panel and present it as a dialog. Returns the new
   * panel id immediately — minted synchronously, before `addPanel` resolves,
   * so a close or a superseding open during the in-flight window still has an
   * id to act on (#6953). Returns null if the panel could not be created.
   */
  openPanelDialog: (options: AddPanelOptions) => Promise<string | null>;
  /** Close the dialog and remove its ephemeral panel. */
  closePanelDialog: () => void;
  /**
   * Drop the pointer if `removedId` is the panel currently presented. Called
   * when a panel is removed by something other than this store, so a dangling
   * id can't survive a teardown the dialog didn't initiate.
   */
  reconcileRemovedPanel: (removedId: string) => void;
  /**
   * Promote the dialog's panel into the grid, keeping the same panel id, and
   * close the dialog. Returns false (leaving the dialog open) if the promotion
   * was refused — e.g. the panel limit is reached.
   */
  promoteToGrid: () => boolean;
}

export const usePanelDialogStore = create<PanelDialogState>((set, get) => ({
  panelId: null,
  requestSeq: 0,

  openPanelDialog: async (options) => {
    const previousPanelId = get().panelId;
    // Mint the id up front and publish it before the first await: the host
    // renders against it, and a close arriving mid-flight must be able to
    // target this panel rather than a null pointer.
    const requestedId = options.requestedId ?? `${options.kind}-${crypto.randomUUID()}`;

    set((state) => ({ panelId: requestedId, requestSeq: state.requestSeq + 1 }));

    // A second open supersedes the first — drop the previous ephemeral record
    // so dialog panels can't accumulate in the registry.
    if (previousPanelId && previousPanelId !== requestedId) {
      usePanelStore.getState().removePanel(previousPanelId);
    }

    let created: string | null = null;
    try {
      created = await usePanelStore.getState().addPanel({
        ...options,
        requestedId,
        location: "dialog",
        // The three ephemeral guarantees ride on this one flag: the persistence
        // filter drops it from every snapshot (so it is never restored), and
        // the shared panel count skips it (so it never consumes a limit slot).
        excludeFromPersistence: true,
        // Dialog panels are uncounted by definition, so the limit gate that
        // would reject them does not apply. Promotion re-checks the ceiling.
        bypassLimits: true,
      });
    } catch (error) {
      logError("[panelDialogStore] failed to open panel dialog", error);
    }

    if (!created) {
      // Clear the reservation on every failure path so the host doesn't render
      // a dialog around a panel that never materialized.
      set((state) => (state.panelId === requestedId ? { panelId: null } : state));
      return null;
    }

    // Ownership re-check: `addPanel` can yield before it commits the record
    // (PTY-backed kinds await a spawn), so a close or a superseding open may
    // have run while this one was in flight. The record it just committed would
    // then be an orphan no host points at — remove it rather than leak it.
    if (get().panelId !== requestedId) {
      usePanelStore.getState().removePanel(created);
      return null;
    }
    return created;
  },

  closePanelDialog: () => {
    const { panelId } = get();
    if (!panelId) return;
    set({ panelId: null });
    // removePanel, never trashPanel: an ephemeral panel must not linger under
    // the trash TTL where it could be restored into the grid.
    usePanelStore.getState().removePanel(panelId);
  },

  reconcileRemovedPanel: (removedId) => {
    // Something outside the dialog removed our panel (worktree teardown, a bulk
    // action, orphan cleanup). The host already renders nothing without a
    // record; clear the pointer so the store agrees rather than holding a
    // dangling id that a later close/promote would act on.
    if (get().panelId !== removedId) return;
    set({ panelId: null });
  },

  promoteToGrid: () => {
    const { panelId } = get();
    if (!panelId) return false;
    const promoted = usePanelStore.getState().promoteDialogPanelToGrid(panelId);
    if (!promoted) return false;
    // Drop the pointer without removing the panel — it now lives in the grid.
    set({ panelId: null });
    usePanelStore.getState().activateTerminal(panelId);
    return true;
  },
}));
