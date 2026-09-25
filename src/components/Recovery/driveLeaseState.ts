import { useEffect, useSyncExternalStore } from "react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { getDriveLeaseSnapshot, subscribeDriveLeaseSnapshot } from "@/services/terminal/inputGate";
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
const listeners = new Set<() => void>();

function setLease(next: DriveLeaseView | null): void {
  if (lease === next) return;
  lease = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLease(): DriveLeaseView | null {
  return lease;
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
  if (!isRemoteHostsSupported()) return () => {};
  const adopt = () => {
    const next = getDriveLeaseSnapshot();
    setLease(next !== null && next.projectId === getViewWorkspaceId() ? next : null);
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

export function _resetDriveLeaseBannerForTesting(): void {
  stopSync?.();
  stopSync = null;
  syncRefs = 0;
  lease = null;
  listeners.clear();
}
