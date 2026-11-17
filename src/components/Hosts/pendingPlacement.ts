import type {
  HostConnectionState,
  HostId,
  HostListEntry,
  PendingHostPlacement,
} from "@shared/types/remoteHosts";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { requestHostSwitch } from "@/components/HostSwitch/hostSwitchRequests";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import { requestHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { closeSettingsThen } from "@/components/Settings/settingsCloseRequests";
import { logWarn } from "@/utils/logger";

export type PlacementRequest = Omit<PendingHostPlacement, "requestedAt" | "failure">;

const keyOf = (hostId: HostId, placement: PendingHostPlacement) =>
  `${hostId}\n${placement.requestedAt}`;

/**
 * Placements this view asked for since it loaded. One found otherwise was
 * asked for before a restart, or in another window: the switch dialog asks
 * before it moves this one.
 */
const askedHere = new Set<string>();
/** Placements this view has handed to the switch dialog, so a late list never hands one twice. */
const handedOff = new Set<string>();
/** Placements waiting for Settings to close before they are handed over. */
const resuming = new Set<string>();

export function isUsableConnection(state: HostConnectionState): boolean {
  return state.status === "connected" || state.status === "driven-elsewhere";
}

/** Keep a worktree waiting for the host's setup, replacing whatever waited there before. */
export async function holdPlacement(
  hostId: HostId,
  request: PlacementRequest,
  now: number = Date.now()
): Promise<PendingHostPlacement> {
  const placement: PendingHostPlacement = { ...request, requestedAt: now };
  askedHere.add(keyOf(hostId, placement));
  await remoteHostsClient.update({ hostId, pendingPlacement: placement });
  return placement;
}

export async function cancelPlacement(hostId: HostId): Promise<void> {
  await remoteHostsClient.update({ hostId, pendingPlacement: null });
}

/**
 * Record why setup stopped; the placement stays pending. Main keeps it only
 * while this is still the placement waiting there.
 */
export async function notePlacementFailure(
  hostId: HostId,
  placement: PendingHostPlacement,
  message: string,
  now: number = Date.now()
): Promise<void> {
  const { failure: _previous, ...rest } = placement;
  await remoteHostsClient.update({
    hostId,
    pendingPlacement: { ...rest, failure: { message, at: now } },
  });
}

/** Open the host's setup again; finishing it carries on with the placement. */
export function retryPlacementSetup(hostId: HostId): void {
  requestHostUpdate(hostId, "setup");
  openHostsSettingsTab();
}

/** The host a worktree is waiting on, with its placement; null when it waits on none. */
export function placementForWorktree(
  hosts: readonly HostListEntry[],
  projectId: string | null,
  worktreeId: string
): { host: HostListEntry; placement: PendingHostPlacement } | null {
  if (projectId === null) return null;
  for (const host of hosts) {
    const placement = host.descriptor.pendingPlacement;
    if (placement?.projectId === projectId && placement.worktreeId === worktreeId) {
      return { host, placement };
    }
  }
  return null;
}

/** The first of this project's placements whose host is ready for it now, or null. */
export function placementReadyToResume(
  hosts: readonly HostListEntry[],
  projectId: string
): { hostId: HostId; placement: PendingHostPlacement } | null {
  for (const host of hosts) {
    const placement = host.descriptor.pendingPlacement;
    const hostId = host.descriptor.id;
    if (
      placement?.projectId === projectId &&
      isUsableConnection(host.connection) &&
      !isHostSetupOpen(hostId) &&
      !handedOff.has(keyOf(hostId, placement)) &&
      !resuming.has(keyOf(hostId, placement))
    ) {
      return { hostId, placement };
    }
  }
  return null;
}

/**
 * Carry a placement on into the switch dialog, on the branch its worktree
 * has checked out, and stop holding it: the dialog owns it from here.
 * Settings closes first, the way its own Close does, so the switch dialog
 * never opens under it; `stillReady` is asked again once it has, and a
 * placement that is no longer ready stays held for the next try.
 */
export function resumePlacement(
  hostId: HostId,
  placement: PendingHostPlacement,
  stillReady: () => boolean
): void {
  const key = keyOf(hostId, placement);
  if (handedOff.has(key) || resuming.has(key)) return;
  resuming.add(key);
  closeSettingsThen((closed) => {
    resuming.delete(key);
    if (!closed || !stillReady()) return;
    const requestId = requestHostSwitch({
      toHostId: hostId,
      projectId: placement.projectId,
      worktreePath: placement.worktreePath,
      askFirst: placement.askFirst === true || !askedHere.has(key),
    });
    if (requestId === null) return;
    handedOff.add(key);
    askedHere.delete(key);
    cancelPlacement(hostId).catch((error: unknown) => {
      logWarn("[Hosts] Couldn't clear a placement handed to the switch dialog", { error });
    });
  });
}

const setupOpen = new Map<HostId, number>();
const setupListeners = new Set<() => void>();
let setupVersion = 0;

function publishSetup(): void {
  setupVersion += 1;
  for (const listener of [...setupListeners]) listener();
}

/**
 * A setup dialog for this host is open: a link that comes up mid-install
 * (an update reconnects it) isn't the end of setup. Release is idempotent.
 */
export function holdHostSetup(hostId: HostId): () => void {
  setupOpen.set(hostId, (setupOpen.get(hostId) ?? 0) + 1);
  publishSetup();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (setupOpen.get(hostId) ?? 1) - 1;
    if (count > 0) setupOpen.set(hostId, count);
    else setupOpen.delete(hostId);
    publishSetup();
  };
}

export function isHostSetupOpen(hostId: HostId): boolean {
  return setupOpen.has(hostId);
}

export function hostSetupVersion(): number {
  return setupVersion;
}

export function subscribeHostSetup(listener: () => void): () => void {
  setupListeners.add(listener);
  return () => {
    setupListeners.delete(listener);
  };
}

export function _resetPendingPlacementsForTesting(): void {
  askedHere.clear();
  handedOff.clear();
  resuming.clear();
  setupOpen.clear();
  setupListeners.clear();
  setupVersion = 0;
}
