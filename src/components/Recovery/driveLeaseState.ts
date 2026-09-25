import { useEffect, useSyncExternalStore } from "react";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { logWarn } from "@/utils/logger";

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
/** Bumped by every event and teardown, so a slower lookup never overrides either. */
let generation = 0;

function setLease(next: DriveLeaseView | null): void {
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

/** Adopt a lease answer this view received directly (e.g. from its own takeover). */
export function applyDriveLeaseView(view: DriveLeaseView): void {
  if (view.projectId !== getViewWorkspaceId()) return;
  generation += 1;
  setLease(view);
}

/** Set the lease outright, bypassing the view's own project check. For the preview harness and tests. */
export function seedDriveLeaseView(view: DriveLeaseView | null): void {
  generation += 1;
  setLease(view);
}

let syncRefs = 0;
let stopSync: (() => void) | null = null;

function beginSync(): () => void {
  if (!isRemoteHostsSupported()) return () => {};
  const api = window.electron?.driveLease;
  const projectId = getViewWorkspaceId();
  if (!api || !projectId) return () => {};
  const off = api.onEvent((event: DriveLeaseEvent) => {
    if (event.type !== "changed" || event.state.projectId !== projectId) return;
    generation += 1;
    setLease(event.state);
  });
  // A view on this machine asks nothing up front: only a remote client taking
  // over can drive it from elsewhere, and that arrives as an event.
  if (getViewHostId() !== null) {
    const current = generation;
    api
      .get({ projectId })
      .then((view) => {
        if (current === generation) setLease(view);
      })
      .catch((error: unknown) => {
        logWarn("[DriveLease] Couldn't read the project's drive lease", { error });
      });
  }
  return () => {
    off();
    generation += 1;
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
  generation += 1;
  lease = null;
  listeners.clear();
}
