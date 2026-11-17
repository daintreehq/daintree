import { useEffect, useSyncExternalStore } from "react";
import {
  currentHostSwitchRequest,
  subscribeHostSwitchRequests,
} from "@/components/HostSwitch/hostSwitchRequests";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useProjectStore } from "@/store/projectStore";
import { useCloudHosts } from "./cloud/cloudHostsState";
import {
  cloudSetupReady,
  cloudSetupVersion,
  disarmCloudSetup,
  subscribeCloudSetup,
} from "./cloudWorktreePlacement";
import { useHostList } from "./hostList";
import {
  hostSetupVersion,
  isHostSetupOpen,
  retryPlacementSetup,
  subscribeHostSetup,
} from "./pendingPlacement";

const subscribeObservable = (listener: () => void) =>
  subscribeProjectViewObservability(() => listener());

/**
 * Opens a new machine's setup once the machine runs, for a worktree this view
 * asked a machine for. Once only per placement, and only while the
 * worktree's project view can be seen with no setup or switch under way:
 * finishing setup then carries the worktree on to the machine. Mounted only
 * while a placement is armed, so a view that never asked follows nothing.
 */
export function CloudPlacementSetup() {
  const { snapshot } = useCloudHosts();
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
  const armedVersion = useSyncExternalStore(subscribeCloudSetup, cloudSetupVersion, () => 0);

  useEffect(() => {
    if (projectId === null || getViewHostId() !== null) return;
    const { ready, stale } = cloudSetupReady(hosts, snapshot, projectId, isHostSetupOpen);
    for (const hostId of stale) disarmCloudSetup(hostId);
    if (!ready || !observable || switching) return;
    // Opened after the commit, as the switch resume is: a StrictMode replay
    // cancels this pass before anything is claimed.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!disarmCloudSetup(ready.hostId, ready.requestedAt)) return;
      retryPlacementSetup(ready.hostId);
    });
    return () => {
      cancelled = true;
    };
  }, [hosts, snapshot, projectId, observable, switching, setupVersion, armedVersion]);

  return null;
}
