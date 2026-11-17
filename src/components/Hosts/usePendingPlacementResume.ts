import { useEffect, useSyncExternalStore } from "react";
import {
  currentHostSwitchRequest,
  subscribeHostSwitchRequests,
} from "@/components/HostSwitch/hostSwitchRequests";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useProjectStore } from "@/store/projectStore";
import { getHostListSnapshot, useHostList } from "./hostList";
import {
  hostSetupVersion,
  isHostSetupOpen,
  isUsableConnection,
  placementReadyToResume,
  resumePlacement,
  subscribeHostSetup,
} from "./pendingPlacement";

const subscribeObservable = (listener: () => void) =>
  subscribeProjectViewObservability(() => listener());

/**
 * Carries a worktree waiting on a host's setup into the switch dialog once
 * that host is usable: setup finished here, or the host came up after a
 * restart. Only the worktree's own project view does it, while it can be
 * seen, with no setup dialog open for the host and no switch already under
 * way. Call it after the view's switch dialog host has registered, so the
 * request finds one on the first pass.
 */
export function usePendingPlacementResume(): void {
  const { hosts } = useHostList();
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const observable = useSyncExternalStore(
    subscribeObservable,
    isProjectViewObservable,
    () => false
  );
  const switching = useSyncExternalStore(
    subscribeHostSwitchRequests,
    () => currentHostSwitchRequest() !== null,
    () => false
  );
  const setupVersion = useSyncExternalStore(subscribeHostSetup, hostSetupVersion, () => 0);

  useEffect(() => {
    // A window on another host has no local worktree to place.
    if (projectId === null || !observable || switching || getViewHostId() !== null) return;
    const ready = placementReadyToResume(hosts, projectId);
    if (!ready) return;
    // Handed over after the commit: a StrictMode replay unregisters the dialog
    // host in between, which would dismiss a request made in this pass.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      // Asked again once Settings has closed: the host, the placement and this view may have moved on.
      resumePlacement(ready.hostId, ready.placement, () => {
        const entry = getHostListSnapshot().hosts.find(
          (host) => host.descriptor.id === ready.hostId
        );
        return (
          entry?.descriptor.pendingPlacement?.requestedAt === ready.placement.requestedAt &&
          isUsableConnection(entry.connection) &&
          !isHostSetupOpen(ready.hostId) &&
          currentHostSwitchRequest() === null &&
          isProjectViewObservable()
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [hosts, projectId, observable, switching, setupVersion]);
}
