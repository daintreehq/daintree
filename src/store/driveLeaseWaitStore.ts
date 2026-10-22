import { create } from "zustand";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { getDriveLeaseSnapshot, subscribeDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { logInfo } from "@/utils/logger";

/**
 * Terminal launches held while another screen has control of their project
 * (#13913): the host refuses a spawn from a view that doesn't drive, so a
 * restore that ran while this view watched would otherwise fail for good.
 * Each continues, with the launch it was given, once this view drives, whether
 * it took control or the lease passed to it. Per project view, like the
 * panels it holds and the lease it follows.
 */
interface DriveLeaseWaitState {
  /** Panes whose spawn waits for control, for their pane chrome. */
  heldPanelIds: Record<string, true>;
}

export const useDriveLeaseWaitStore = create<DriveLeaseWaitState>(() => ({
  heldPanelIds: {},
}));

export interface DriveLeaseHold {
  /** The project whose lease the launch waits on. */
  projectId: string;
  /** Continue the held launch. */
  resume: () => void;
  /** True once nothing wants the launch any more (pane removed, superseded). */
  isStale?: () => boolean;
  /** True while the launch should keep waiting whatever the lease (pane in the trash). */
  isDeferred?: () => boolean;
}

const holds = new Map<string, DriveLeaseHold>();
let stopFollowing: (() => void) | null = null;

/** This view drives the project, or nobody does: a spawn for it goes through. */
export function drivesProject(lease: DriveLeaseView | null, projectId: string): boolean {
  return lease?.projectId === projectId && lease.drivingHere;
}

/** The lease says another screen has control of the project, so the host refuses a spawn for it. */
export function watchesProject(lease: DriveLeaseView | null, projectId: string): boolean {
  return lease?.projectId === projectId && !lease.drivingHere;
}

function setPanelHeld(panelId: string, held: boolean): void {
  useDriveLeaseWaitStore.setState((state) => {
    if (held === (state.heldPanelIds[panelId] === true)) return state;
    const heldPanelIds = { ...state.heldPanelIds };
    if (held) heldPanelIds[panelId] = true;
    else delete heldPanelIds[panelId];
    return { heldPanelIds };
  });
}

/**
 * `resuming` leaves the pane marked held: its launch is queued, not started,
 * and the mark keeps a restart off it until the launch clears it itself.
 */
function take(panelId: string, resuming = false): DriveLeaseHold | undefined {
  const hold = holds.get(panelId);
  if (!hold) return undefined;
  holds.delete(panelId);
  if (!resuming) setPanelHeld(panelId, false);
  if (holds.size === 0 && stopFollowing !== null) {
    stopFollowing();
    stopFollowing = null;
  }
  return hold;
}

/**
 * Continue every launch this view may now make. In insertion order, so a
 * restore resumes in the order it was laid out; the startup queue then starts
 * them one at a time as it always does.
 */
export function releaseDriveLeaseHolds(): void {
  const lease = getDriveLeaseSnapshot();
  for (const [panelId, hold] of [...holds]) {
    if (holds.get(panelId) !== hold) continue;
    if (hold.isStale?.()) {
      take(panelId);
      continue;
    }
    if (hold.isDeferred?.() || !drivesProject(lease, hold.projectId)) continue;
    take(panelId, true)?.resume();
  }
}

/** Hold a launch until this view drives its project. A second hold for the same pane replaces the first. */
export function holdForDriveLease(panelId: string, hold: DriveLeaseHold): void {
  holds.set(panelId, hold);
  setPanelHeld(panelId, true);
  if (stopFollowing === null) stopFollowing = subscribeDriveLeaseSnapshot(releaseDriveLeaseHolds);
  logInfo("[DriveLeaseWait] Launch held: another screen has control of the project", {
    panelId,
  });
}

/**
 * End a pane's hold without continuing its launch, as when the terminal it
 * would have started turned up on the host by another way. True when the
 * pane was held.
 */
export function cancelDriveLeaseHold(panelId: string): boolean {
  return take(panelId) !== undefined;
}

/** Mark a launch on its way after control arrived, so a restart stays off it until it settles. */
export function markPanelDriveLeaseLaunch(panelId: string): void {
  setPanelHeld(panelId, true);
}

/** Called by a released launch once its spawn has an answer, whatever it was. */
export function clearPanelDriveLeaseMark(panelId: string): void {
  setPanelHeld(panelId, false);
}

export function isHeldForDriveLease(panelId: string): boolean {
  return useDriveLeaseWaitStore.getState().heldPanelIds[panelId] === true;
}

export function resetDriveLeaseHoldsForTesting(): void {
  holds.clear();
  stopFollowing?.();
  stopFollowing = null;
  useDriveLeaseWaitStore.setState({ heldPanelIds: {} });
}
