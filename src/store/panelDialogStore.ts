import { create } from "zustand";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { usePanelStore } from "./panelStore";
import { logError } from "@/utils/logger";

/**
 * Owns the panels currently presented as modal dialogs.
 *
 * Each panel record lives in the normal panel registry under
 * `location: "dialog"` so panel components (which read their own state from
 * `panelsById`) render unmodified inside the dialog. This store only holds the
 * pointers to them, plus the lifecycle operations the host needs.
 *
 * Lifecycle ownership is deliberate: open/close/promote are driven from here
 * (and from the host's handlers), never from the presented component's own
 * mount/unmount effects. React 19 StrictMode double-invokes effects in dev, so
 * an effect-owned record would be destroyed and recreated on every mount.
 */
interface PanelDialogState {
  /**
   * Panels presented as dialogs, bottom-first. The last entry is the topmost
   * (focused) dialog; an empty stack means no dialog is open.
   *
   * A stack rather than a single pointer because a dialog-presented panel can
   * itself open one: the review hub drills into a per-file diff, and the old
   * single slot removed the review record to make room, tearing down the whole
   * staging surface (draft, selection, filters) mid-review (#11243). Ordinary
   * opens still supersede — only an explicit `pushPanelDialog` layers.
   */
  dialogStack: string[];
  /**
   * Monotonic open counter. Stack depth would stay `1` across back-to-back
   * opens while a dialog is already open, so an ErrorBoundary keyed on it
   * would never reset for the next file (#9918). Shared by every frame, which
   * is harmless: the boundary only re-keys while it is actually erroring.
   */
  requestSeq: number;
  /**
   * Create an ephemeral panel and present it as a dialog, replacing any dialogs
   * already open. Returns the new panel id immediately — minted synchronously,
   * before `addPanel` resolves, so a close or a superseding open during the
   * in-flight window still has an id to act on (#6953). Returns null if the
   * panel could not be created.
   */
  openPanelDialog: (options: AddPanelOptions) => Promise<string | null>;
  /**
   * Layer a dialog above `expectedParentId` instead of replacing it, keeping the
   * parent's component — and therefore all of its local state — mounted.
   *
   * `expectedParentId` must still be the topmost entry: the caller decided to
   * layer based on a render-time view of the stack, and by the time this runs
   * the user may have closed it or another surface may have superseded it.
   * Layering onto a stale parent would resurrect a dead surface, so a mismatch
   * refuses the push and returns null.
   */
  pushPanelDialog: (options: AddPanelOptions, expectedParentId: string) => Promise<string | null>;
  /** Close the topmost dialog and remove its ephemeral panel. */
  closePanelDialog: () => void;
  /**
   * Close a specific dialog by id, wherever it sits in the stack, and remove its
   * ephemeral panel. A no-op if that id isn't presented — the owner may have
   * already lost it, and blind-popping the top would tear down someone else's
   * dialog.
   */
  closePanelDialogById: (panelId: string) => void;
  /**
   * Drop `removedId` from the stack wherever it appears. Called when a panel is
   * removed by something other than this store, so a dangling id can't survive
   * a teardown the dialog didn't initiate. Removing a suspended parent leaves
   * the dialogs above it alone.
   */
  reconcileRemovedPanel: (removedId: string) => void;
  /**
   * Promote the topmost dialog's panel into the grid, keeping the same panel id,
   * and pop it — revealing whatever dialog sat beneath. Returns false (leaving
   * the stack untouched) if the promotion was refused — e.g. the panel limit is
   * reached.
   */
  promoteToGrid: () => boolean;
}

/** Topmost presented panel id, or null when no dialog is open. */
export const selectTopDialogPanelId = (state: PanelDialogState): string | null =>
  state.dialogStack[state.dialogStack.length - 1] ?? null;

export const usePanelDialogStore = create<PanelDialogState>((set, get) => ({
  dialogStack: [],
  requestSeq: 0,

  openPanelDialog: async (options) => {
    const supersededIds = get().dialogStack;
    // Mint the id up front and publish it before the first await: the host
    // renders against it, and a close arriving mid-flight must be able to
    // target this panel rather than an empty stack.
    const requestedId = options.requestedId ?? `${options.kind}-${crypto.randomUUID()}`;

    set((state) => ({ dialogStack: [requestedId], requestSeq: state.requestSeq + 1 }));

    // A plain open supersedes everything already presented — drop those
    // ephemeral records so dialog panels can't accumulate in the registry.
    for (const supersededId of supersededIds) {
      if (supersededId !== requestedId) usePanelStore.getState().removePanel(supersededId);
    }

    return commitDialogPanel(options, requestedId, set, get);
  },

  pushPanelDialog: async (options, expectedParentId) => {
    const { dialogStack } = get();
    // Compare-and-swap on the top of the stack: layering onto a parent that has
    // since been closed or superseded would re-present a surface the user is
    // done with.
    if (dialogStack[dialogStack.length - 1] !== expectedParentId) return null;

    const requestedId = options.requestedId ?? `${options.kind}-${crypto.randomUUID()}`;

    // A caller-supplied id already on the stack would sit there twice, giving
    // the host duplicate React keys — which silently breaks the instance
    // preservation layering exists for — and leaving a dangling entry behind
    // when one copy is closed.
    if (dialogStack.includes(requestedId)) return null;

    set((state) => ({
      dialogStack: [...state.dialogStack, requestedId],
      requestSeq: state.requestSeq + 1,
    }));

    return commitDialogPanel(options, requestedId, set, get);
  },

  closePanelDialog: () => {
    const { dialogStack } = get();
    const topId = dialogStack[dialogStack.length - 1];
    if (!topId) return;
    set((state) => ({ dialogStack: state.dialogStack.slice(0, -1) }));
    // removePanel, never trashPanel: an ephemeral panel must not linger under
    // the trash TTL where it could be restored into the grid.
    usePanelStore.getState().removePanel(topId);
  },

  closePanelDialogById: (panelId) => {
    if (!get().dialogStack.includes(panelId)) return;
    set((state) => ({ dialogStack: state.dialogStack.filter((id) => id !== panelId) }));
    usePanelStore.getState().removePanel(panelId);
  },

  reconcileRemovedPanel: (removedId) => {
    // Something outside the dialog removed our panel (worktree teardown, a bulk
    // action, orphan cleanup). The host already renders nothing without a
    // record; drop the entry so the store agrees rather than holding a dangling
    // id that a later close/promote would act on.
    if (!get().dialogStack.includes(removedId)) return;
    set((state) => ({ dialogStack: state.dialogStack.filter((id) => id !== removedId) }));
  },

  promoteToGrid: () => {
    const { dialogStack } = get();
    const topId = dialogStack[dialogStack.length - 1];
    if (!topId) return false;
    const promoted = usePanelStore.getState().promoteDialogPanelToGrid(topId);
    if (!promoted) return false;
    // Pop without removing the panel — it now lives in the grid, and whatever
    // dialog sat beneath it is revealed again.
    set((state) => ({ dialogStack: state.dialogStack.filter((id) => id !== topId) }));
    usePanelStore.getState().activateTerminal(topId);
    return true;
  },
}));

/**
 * Create the ephemeral panel record behind a reservation already published on
 * the stack, and reconcile the reservation with whatever happened while
 * `addPanel` was in flight. Shared by open (replace) and push (layer) so both
 * inherit the same failure and ownership handling.
 */
async function commitDialogPanel(
  options: AddPanelOptions,
  requestedId: string,
  set: (updater: (state: PanelDialogState) => Partial<PanelDialogState>) => void,
  get: () => PanelDialogState
): Promise<string | null> {
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
    // Clear the reservation on every failure path so the host doesn't render a
    // dialog around a panel that never materialized. Filter rather than pop:
    // another dialog may have been layered on top while this one was in flight.
    set((state) => ({ dialogStack: state.dialogStack.filter((id) => id !== requestedId) }));
    return null;
  }

  // Ownership re-check: `addPanel` can yield before it commits the record
  // (PTY-backed kinds await a spawn), so a close or a superseding open may
  // have run while this one was in flight. The record it just committed would
  // then be an orphan no host points at — remove it rather than leak it.
  if (!get().dialogStack.includes(requestedId)) {
    usePanelStore.getState().removePanel(created);
    return null;
  }
  return created;
}
