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
  isAnyHostSetupOpen,
  isHostSetupOpen,
  retryPlacementSetup,
  subscribeHostSetup,
} from "./pendingPlacement";

/**
 * How long a setup asked for here may take to open before another machine's
 * setup is asked for: Settings holds one request, and a second one sent before
 * the first dialog took its own hold would replace it.
 */
const SETUP_HANDOFF_MS = 5_000;
let lastAsked: { hostId: string; at: number } | null = null;

function handingOff(): boolean {
  if (!lastAsked) return false;
  if (isHostSetupOpen(lastAsked.hostId) || Date.now() - lastAsked.at >= SETUP_HANDOFF_MS) {
    lastAsked = null;
    return false;
  }
  return true;
}

export function _resetCloudPlacementSetupForTesting(): void {
  lastAsked = null;
}

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
    // Asked first, so a setup seen open ends the handoff even while it stays open.
    const handoff = handingOff();
    const { ready, stale } = cloudSetupReady(
      hosts,
      snapshot,
      projectId,
      isHostSetupOpen,
      handoff || isAnyHostSetupOpen()
    );
    for (const hostId of stale) disarmCloudSetup(hostId);
    if (!ready || !observable || switching) return;
    // Opened after the commit, as the switch resume is: a StrictMode replay
    // cancels this pass before anything is claimed.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!disarmCloudSetup(ready.hostId, ready.requestedAt)) return;
      retryPlacementSetup(ready.hostId);
      lastAsked = { hostId: ready.hostId, at: Date.now() };
    });
    return () => {
      cancelled = true;
    };
  }, [hosts, snapshot, projectId, observable, switching, setupVersion, armedVersion]);

  return null;
}
