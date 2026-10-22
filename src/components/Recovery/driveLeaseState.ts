import { useEffect, useState, useSyncExternalStore } from "react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { isEitherRemoteRoleSupported } from "@/lib/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  getDriveLeaseSnapshot,
  getDriveLeaseSnapshotReceivedAt,
  subscribeDriveLeaseSnapshot,
} from "@/services/terminal/inputGate";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/**
 * Which drive-lease banner this view shows:
 * - `taken-from-host`: this is a window on the host's own screen and a remote
 *   client drives the project ("Being driven from greg-mbp" · Take back).
 * - `driven-elsewhere`: this is a remote client and someone else drives the
 *   project ("studio-01 is being driven from greg-mbp" · Take over).
 */
export type DriveLeaseBannerState =
  | { kind: "taken-from-host"; projectId: string; driverName: string }
  | {
      kind: "driven-elsewhere";
      projectId: string;
      driverName: string;
      /** The host's own screen drives it, not another client. */
      driverIsHostScreen: boolean;
    };

/** Pure: the banner a lease view calls for, or null when this view drives. */
export function selectDriveLeaseBanner(
  lease: DriveLeaseView | null,
  isRemoteView: boolean
): DriveLeaseBannerState | null {
  const holder = lease?.holder ?? null;
  if (!lease || !holder || lease.drivingHere) return null;
  if (!isRemoteView && lease.viewerIsHostLocal && !holder.isHostLocal) {
    return { kind: "taken-from-host", projectId: lease.projectId, driverName: holder.clientName };
  }
  if (isRemoteView) {
    return {
      kind: "driven-elsewhere",
      projectId: lease.projectId,
      driverName: holder.clientName,
      driverIsHostScreen: holder.isHostLocal,
    };
  }
  return null;
}

let lease: DriveLeaseView | null = null;
/**
 * What was left of the away controller's grace when the lease landed here. The
 * host sends a duration, not a time, so it is counted down by this machine's
 * clock from that moment.
 */
let away: { receivedAt: number; ms: number } | null = null;
const listeners = new Set<() => void>();

/** Who controls the project, as the banner names them; null when this view has control. */
function controllerOf(view: DriveLeaseView | null): { key: string; name: string } | null {
  const state = selectDriveLeaseBanner(view, getViewHostId() !== null);
  const holder = view?.holder;
  if (state === null || !holder) return null;
  // Compared by device, not by name: two machines can share a name, and a
  // rename isn't a change of control.
  const key = holder.isHostLocal ? "host-screen" : holder.clientId;
  if (state.kind === "driven-elsewhere" && state.driverIsHostScreen) {
    const host = useHostConnectionStore.getState();
    return { key, name: `${host.hostName ?? host.hostId ?? "The host"}'s own screen` };
  }
  return { key, name: state.driverName };
}

/**
 * Say a change of control once per window, whichever banner holds the slot
 * and whoever caused it: the banner and the panes' strips stay quiet, since a
 * higher-priority banner can hide this one and every pane would repeat it.
 */
function announceControlChange(prev: DriveLeaseView | null, next: DriveLeaseView | null): void {
  if (next === null) return;
  const sameProject = prev !== null && prev.projectId === next.projectId;
  const before = sameProject ? controllerOf(prev) : null;
  const after = controllerOf(next);
  const announce = useAnnouncerStore.getState().announce;
  if (after?.key === before?.key) {
    // The same controller going away or coming back: said once each, never
    // per second of the countdown.
    const wasAway = prev?.holderAwayMs !== undefined;
    const isAway = next.holderAwayMs !== undefined;
    if (after !== null && wasAway !== isAway) {
      announce(isAway ? `${after.name} is away` : `${after.name} is back`, "polite");
    }
    return;
  }
  if (after !== null) {
    announce(
      sameProject ? `Control moved to ${after.name}` : `${after.name} has control of this project`,
      "polite"
    );
  } else if (before !== null && next.drivingHere) {
    announce("You have control of this project", "polite");
  }
}

function setLease(next: DriveLeaseView | null, receivedAt = Date.now()): void {
  if (lease === next) return;
  announceControlChange(lease, next);
  lease = next;
  away = next?.holderAwayMs === undefined ? null : { receivedAt, ms: next.holderAwayMs };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLease(): DriveLeaseView | null {
  return lease;
}

function getAway(): { receivedAt: number; ms: number } | null {
  return away;
}

/** Set the lease outright, bypassing the view's own project check. For the preview harness and tests. */
export function seedDriveLeaseView(view: DriveLeaseView | null): void {
  setLease(view);
}

let syncRefs = 0;
let stopSync: (() => void) | null = null;

/**
 * Mirrors the lease the input gate was set from. The host-connection sync owns
 * the IPC: the lease events, the up-front lookup (a remote view always, a view
 * on this machine only once remote hosts are in use) and the refresh after a
 * reconnect. One source means the banner, the chip and the gate never disagree
 * about who drives, and nobody asks the host twice.
 */
function beginSync(): () => void {
  if (!isEitherRemoteRoleSupported()) return () => {};
  const adopt = () => {
    const next = getDriveLeaseSnapshot();
    setLease(
      next !== null && next.projectId === getViewWorkspaceId() ? next : null,
      getDriveLeaseSnapshotReceivedAt()
    );
  };
  // Nothing to adopt yet leaves a seeded lease (preview, tests) in place.
  if (getDriveLeaseSnapshot() !== null) adopt();
  const off = subscribeDriveLeaseSnapshot(adopt);
  return () => {
    off();
    setLease(null);
  };
}

/** Follow this view's drive lease while mounted. Refcounted; a no-op where Remote Hosts doesn't exist. */
export function useDriveLeaseSync(): void {
  useEffect(() => {
    syncRefs += 1;
    if (syncRefs === 1) stopSync = beginSync();
    return () => {
      syncRefs -= 1;
      if (syncRefs === 0) {
        stopSync?.();
        stopSync = null;
      }
    };
  }, []);
}

export function useDriveLeaseView(): DriveLeaseView | null {
  return useSyncExternalStore(subscribe, getLease, getLease);
}

export function useDriveLeaseBanner(): DriveLeaseBannerState | null {
  const view = useDriveLeaseView();
  return selectDriveLeaseBanner(view, getViewHostId() !== null);
}

/**
 * Whole seconds until the away controller's grace runs out and control passes
 * on, ticking while the view can be seen; null while the controller is there.
 * Never below 1: the handover itself is what ends the countdown.
 */
export function useDriveLeaseAwaySeconds(): number | null {
  const current = useSyncExternalStore(subscribe, getAway, getAway);
  const [now, setNow] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000, current !== null);
  if (current === null) return null;
  // A tick from before this lease landed counts as the moment it landed.
  const elapsed = Math.max(0, now - current.receivedAt);
  return Math.max(1, Math.ceil((current.ms - elapsed) / 1000));
}

export function _resetDriveLeaseBannerForTesting(): void {
  stopSync?.();
  stopSync = null;
  syncRefs = 0;
  lease = null;
  away = null;
  listeners.clear();
}
