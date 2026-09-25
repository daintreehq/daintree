import { useEffect, useSyncExternalStore } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { LOCAL_HOST_ID, type HostId, type OperationId } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { useHostConnectionStore, isHostLinkUp } from "@/store/hostConnectionStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  getTerminalInputBlock,
  setHostInputBlock,
  setLeaseInputBlock,
  subscribeTerminalInputGate,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { ClientAppError } from "@/utils/clientAppError";
import { isUnknownOutcomeError, resolveUnknownOutcome } from "@/utils/resolveUnknownOutcome";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/** The remote host this view runs on, or null when it runs on this machine. */
export function getViewHostId(): HostId | null {
  if (typeof window === "undefined") return null;
  const id = window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id !== LOCAL_HOST_ID ? id : null;
}

/**
 * Who drives this view's project from another machine, or null when this view
 * may type. The host answers per view: `drivingHere` is true for every window
 * of the holder's machine, so only a holder elsewhere locks input.
 */
export function drivenElsewhereBy(lease: DriveLeaseView | null): string | null {
  const holder = lease?.holder ?? null;
  if (!holder || lease?.drivingHere) return null;
  return holder.clientName;
}

function hostLabel(): string {
  const state = useHostConnectionStore.getState();
  return state.hostName ?? state.hostId ?? "the host";
}

function publishHostInputBlock(): void {
  const state = useHostConnectionStore.getState();
  setHostInputBlock(
    isHostLinkUp(state) || state.connection === null
      ? null
      : { kind: "disconnected", hostName: hostLabel() }
  );
}

let resyncRunning: Promise<void> | null = null;
let resyncAgain = false;

/**
 * Refetch what this view shows from its host after the host dropped events on
 * their way here or the link came back fresh. Terminal output is not part of
 * this: it resumes on its own stream. Overlapping requests coalesce into one
 * follow-up pass.
 */
export function resyncFromHost(): Promise<void> {
  if (resyncRunning) {
    resyncAgain = true;
    return resyncRunning;
  }
  resyncRunning = (async () => {
    do {
      resyncAgain = false;
      await runResyncPass();
    } while (resyncAgain);
  })().finally(() => {
    resyncRunning = null;
  });
  return resyncRunning;
}

async function runResyncPass(): Promise<void> {
  const projectId = getViewWorkspaceId();
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["worktrees", () => window.electron.worktree.refresh()],
    [
      "worktree topology",
      () => window.electron.worktreePort.request("reconcile-topology", { force: true }),
    ],
    ["agent states", () => (projectId ? resyncAgentStates(projectId) : Promise.resolve())],
    [
      "plugins",
      async () => {
        const { usePluginRuntimeStore } = await import("@/store/pluginRuntimeStore");
        usePluginRuntimeStore.getState().refresh();
      },
    ],
    ["drive lease", () => refreshLease()],
  ];
  const results = await Promise.allSettled(steps.map(([, step]) => step()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn(`[HostConnection] Resync of ${steps[index]![0]} failed`, { error: result.reason });
    }
  });
}

/** Adopt the host's agent states where they are newer than what this view last applied. */
async function resyncAgentStates(projectId: string): Promise<void> {
  const infos = await window.electron.terminal.getForProject(projectId);
  const [{ usePanelStore }, { terminalInstanceService }] = await Promise.all([
    import("@/store/panelStore"),
    import("@/services/TerminalInstanceService"),
  ]);
  const store = usePanelStore.getState();
  for (const info of infos) {
    const panel = store.panelsById[info.id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting) continue;
    if (!info.agentState || typeof info.lastStateChange !== "number") continue;
    if (panel.lastStateChange && info.lastStateChange <= panel.lastStateChange) continue;
    terminalInstanceService.setAgentState(info.id, info.agentState);
    store.updateAgentState(
      info.id,
      info.agentState,
      undefined,
      info.lastStateChange,
      undefined,
      undefined,
      info.waitingReason
    );
  }
}

/** Bumped by every lease event and by teardown, so a slower lookup never overrides either. */
let leaseGeneration = 0;

async function refreshLease(): Promise<void> {
  const projectId = getViewWorkspaceId();
  const lease = window.electron?.driveLease;
  if (!projectId || !lease) return;
  const generation = leaseGeneration;
  let state: DriveLeaseView | null;
  try {
    state = await lease.get({ projectId });
  } catch {
    // Unsupported (no lease service yet) or unanswerable right now: nothing
    // says another frontend drives this project, so input stays with this one.
    state = null;
  }
  if (generation === leaseGeneration) applyLease(state);
}

function applyLease(lease: DriveLeaseView | null): void {
  const driver = drivenElsewhereBy(lease);
  setLeaseInputBlock(driver === null ? null : { kind: "driven-elsewhere", driverName: driver });
}

let syncRefs = 0;
let stopSync: (() => void) | null = null;

/**
 * Start following this view's host link and drive lease. Idempotent and
 * refcounted. A view on this machine makes no host calls at all; it follows
 * only the lease, and only where Remote Hosts exists.
 */
export function startHostConnectionSync(): () => void {
  syncRefs += 1;
  if (syncRefs === 1) stopSync = beginSync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    syncRefs -= 1;
    if (syncRefs === 0) {
      stopSync?.();
      stopSync = null;
    }
  };
}

function beginSync(): () => void {
  if (!isRemoteHostsSupported()) return () => {};
  const disposers: Array<() => void> = [];
  const hostId = getViewHostId();
  const projectId = getViewWorkspaceId();
  let disposed = false;

  if (window.electron?.driveLease && projectId) {
    disposers.push(
      window.electron.driveLease.onEvent((event: DriveLeaseEvent) => {
        if (event.type === "changed" && event.state.projectId === projectId) {
          leaseGeneration += 1;
          applyLease(event.state);
        }
      })
    );
    // A local view asks nothing up front: only a remote client taking over
    // can drive it from elsewhere, and that arrives as an event.
    if (hostId !== null) void refreshLease();
  }

  const remoteHosts = window.electron?.remoteHosts;
  if (hostId !== null && remoteHosts) {
    const store = useHostConnectionStore.getState();
    store.bindHost(hostId, null);
    disposers.push(
      useHostConnectionStore.subscribe((next, prev) => {
        if (
          next.connection !== prev.connection ||
          next.hostName !== prev.hostName ||
          next.hostId !== prev.hostId
        ) {
          publishHostInputBlock();
        }
        // After an explicit disconnect the Shell drops this view's endpoint, so
        // the next session has nothing to reopen and main has no view to tell.
        if (
          prev.connection?.status === "disconnected" &&
          prev.everConnected &&
          next.connection?.status === "connected"
        ) {
          void resyncFromHost();
        }
      })
    );
    disposers.push(
      remoteHosts.onEvent((event: RemoteHostsEvent) => {
        switch (event.type) {
          case "connection-changed":
            if (event.hostId === hostId) {
              useHostConnectionStore.getState().applyConnection(event.connection);
            }
            return;
          case "hosts-changed": {
            const entry = event.hosts.find((h) => h.descriptor.id === hostId);
            if (entry) useHostConnectionStore.getState().setHostName(entry.descriptor.name);
            return;
          }
          case "resync-required":
            if (event.hostId === hostId) void resyncFromHost();
            return;
          default:
            return;
        }
      })
    );
    void remoteHosts
      .getWindowHost()
      .then((info) => {
        if (disposed || info.hostId !== hostId) return;
        const current = useHostConnectionStore.getState();
        current.setHostName(info.descriptor?.name ?? null);
        // A connection-changed that landed while this was in flight is newer.
        if (current.connection === null) current.applyConnection(info.connection);
      })
      .catch((error: unknown) => {
        logWarn("[HostConnection] Couldn't read this window's host", { error });
      });
  }

  return () => {
    disposed = true;
    leaseGeneration += 1;
    for (const dispose of disposers.splice(0)) dispose();
    setHostInputBlock(null);
    setLeaseInputBlock(null);
    useHostConnectionStore.getState().reset();
  };
}

/** Mount-scoped {@link startHostConnectionSync}. */
export function useHostConnectionSync(): void {
  useEffect(() => startHostConnectionSync(), []);
}

/** Resolves once this view's host link is up; immediately for a local view. */
export function waitForHostConnected(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return aborted();
    if (isHostLinkUp(useHostConnectionStore.getState())) return resolve();
    const onAbort = () => {
      unsubscribe();
      aborted();
    };
    const unsubscribe = useHostConnectionStore.subscribe((state) => {
      if (!isHostLinkUp(state)) return;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunHostOperationOptions<T> {
  /**
   * The call's own result, rebuilt from what the host recorded when the answer
   * was lost but the operation succeeded.
   */
  fromResult: (result: unknown) => T;
  signal?: AbortSignal;
  /** Test seam; defaults to the real resolver. */
  resolve?: typeof resolveUnknownOutcome;
}

/**
 * Run a host mutation that carries an operation id. If the link drops before
 * it answers, the outcome is unknown rather than failed: the view says it is
 * checking with the host, asks what happened once the link is back, and
 * settles with the host's answer — the result when it succeeded, its error
 * when it failed. Only an outcome the host has no record of is an error here.
 */
export async function runHostOperation<T>(
  opId: OperationId | undefined,
  run: () => Promise<T>,
  options: RunHostOperationOptions<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!opId || !isUnknownOutcomeError(error)) throw error;
    const endCheck = useHostConnectionStore.getState().beginCheck();
    try {
      const outcome = await (options.resolve ?? resolveUnknownOutcome)(opId, {
        waitForConnected: waitForHostConnected,
        signal: options.signal,
      });
      switch (outcome.status) {
        case "succeeded":
          return options.fromResult(outcome.result);
        case "failed":
          throw new Error(outcome.error.message, { cause: error });
        case "cancelled":
          throw new ClientAppError("CANCELLED", "The operation was cancelled on the host");
        case "running":
          throw new ClientAppError(
            "OUTCOME_UNKNOWN",
            "The operation is still running on the host",
            `Still running on ${hostLabel()}. Check back shortly.`
          );
        case "unknown":
          throw new ClientAppError(
            "OUTCOME_UNKNOWN",
            "The host has no record of the operation",
            `${hostLabel()} has no record of this. Check whether it happened before trying again.`
          );
      }
    } finally {
      endCheck();
    }
  }
}

export function useHostConnection() {
  const hostId = useHostConnectionStore((s) => s.hostId);
  const hostName = useHostConnectionStore((s) => s.hostName);
  const connection = useHostConnectionStore((s) => s.connection);
  const lastSeenAt = useHostConnectionStore((s) => s.lastSeenAt);
  return { hostId, hostName: hostName ?? hostId, connection, lastSeenAt };
}

/** Why terminals in this view take no input right now, or null when they do. */
export function useTerminalInputBlock(): TerminalInputBlock | null {
  return useSyncExternalStore(subscribeTerminalInputGate, getTerminalInputBlock);
}

/** Ask the host link to try again now rather than on its backoff. */
export function reconnectHost(): void {
  const hostId = useHostConnectionStore.getState().hostId;
  if (hostId === null) return;
  safeFireAndForget(window.electron.remoteHosts.connect({ hostId }), {
    context: "Reconnecting to the window's host",
  });
}

export function _resetHostConnectionSyncForTesting(): void {
  stopSync?.();
  stopSync = null;
  syncRefs = 0;
  resyncRunning = null;
  resyncAgain = false;
}
