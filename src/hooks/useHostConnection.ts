import { useEffect, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID, type HostId, type OperationId } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { useHostConnectionStore, isHostLinkUp } from "@/store/hostConnectionStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { resyncHostTerminals } from "@/store/hostTerminalResync";
import {
  getLeaseInputBlock,
  getTerminalInputBlock,
  setDriveLeaseSnapshot,
  setHostInputBlock,
  setLeaseInputBlock,
  subscribeTerminalInputGate,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { ClientAppError } from "@/utils/clientAppError";
import { isUnknownOutcomeError, resolveUnknownOutcome } from "@/utils/resolveUnknownOutcome";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { primeHostPreviewCapability } from "@/components/FileViewer/filePreviewKinds";

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
 * Bumped by every resync request and by teardown. A pass applies what it read
 * only while this still matches, so an answer overtaken by a newer request
 * (or a closed sync) is dropped and the follow-up pass applies a fresh one.
 */
let resyncGeneration = 0;

/**
 * Refetch what this view shows from its host after the host dropped events on
 * their way here or the link came back fresh. Terminal output is not part of
 * this: it resumes on its own stream. Overlapping requests coalesce into one
 * follow-up pass.
 */
export function resyncFromHost(): Promise<void> {
  resyncGeneration += 1;
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
  const generation = resyncGeneration;
  const isCurrent = () => generation === resyncGeneration && getViewWorkspaceId() === projectId;
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["worktrees", () => window.electron.worktree.refresh()],
    [
      "worktree topology",
      () => window.electron.worktreePort.request("reconcile-topology", { force: true }),
    ],
    [
      "terminals",
      () => (projectId ? resyncHostTerminals(projectId, { isCurrent }) : Promise.resolve()),
    ],
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

/** Bumped by every lease event and by teardown, so a slower lookup never overrides either. */
let leaseGeneration = 0;

async function refreshLease(): Promise<void> {
  const projectId = getViewWorkspaceId();
  const lease = window.electron?.driveLease;
  if (!projectId || !lease) return;
  const generation = leaseGeneration;
  let state: DriveLeaseView;
  try {
    state = await lease.get({ projectId });
  } catch {
    // An unanswered lookup says nothing new: whatever block (or unknown
    // ownership) this view already has stays until the host does answer.
    return;
  }
  if (generation === leaseGeneration) applyLease(state);
}

function applyLease(lease: DriveLeaseView): void {
  setDriveLeaseSnapshot(lease);
  const driver = drivenElsewhereBy(lease);
  setLeaseInputBlock(
    driver === null
      ? null
      : {
          kind: "driven-elsewhere",
          driverName: driver,
          projectId: lease.projectId,
          hostLocal: lease.viewerIsHostLocal,
        }
  );
}

/**
 * A view on this machine can only be driven from elsewhere once a remote
 * client is attached here, which takes Host mode, or once this user runs
 * remote hosts at all. Neither is true for someone who never set up a host,
 * so they make no lease call. Where the namespace is absent (Windows) or the
 * answer fails, it counts as unused.
 */
async function remoteDrivingPossible(): Promise<boolean> {
  try {
    return (await window.electron?.remoteHosts?.isInUse?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Ask the host to hand this view's project to this view. The answer is
 * applied at once; the previous driver learns of it from its own lease event.
 */
export async function takeOverDrive(projectId: string): Promise<void> {
  const view = await window.electron.driveLease.takeOver({ projectId });
  leaseGeneration += 1;
  applyLease(view);
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

  // Fetched up front so the first preview this view builds already carries it.
  if (hostId !== null) void primeHostPreviewCapability();

  if (window.electron?.driveLease && projectId) {
    disposers.push(
      window.electron.driveLease.onEvent((event: DriveLeaseEvent) => {
        if (event.type === "changed" && event.state.projectId === projectId) {
          leaseGeneration += 1;
          applyLease(event.state);
        }
      })
    );
    if (hostId !== null) {
      // Until the host says who drives, a remote view could be typing over
      // someone else, so it starts read-only.
      setLeaseInputBlock({ kind: "lease-unknown", hostName: hostLabel() });
      void refreshLease();
    } else {
      void remoteDrivingPossible().then((possible) => {
        if (possible && !disposed) void refreshLease();
      });
    }
  }

  const remoteHosts = window.electron?.remoteHosts;
  if (hostId !== null && remoteHosts) {
    const store = useHostConnectionStore.getState();
    store.bindHost(hostId, null);
    // Set by an explicit disconnect and kept through the connecting states
    // that follow it, so the session that eventually comes up still resyncs.
    let resyncPending = false;
    disposers.push(
      useHostConnectionStore.subscribe((next, prev) => {
        if (
          next.connection !== prev.connection ||
          next.hostName !== prev.hostName ||
          next.hostId !== prev.hostId
        ) {
          publishHostInputBlock();
          if (getLeaseInputBlock()?.kind === "lease-unknown") {
            setLeaseInputBlock({ kind: "lease-unknown", hostName: hostLabel() });
          }
        }
        if (next.connection?.status === "disconnected" && next.everConnected) {
          resyncPending = true;
        }
        if (next.connection?.status === "connected" && prev.connection?.status !== "connected") {
          if (resyncPending) {
            resyncPending = false;
            void resyncFromHost();
          } else if (getLeaseInputBlock()?.kind === "lease-unknown") {
            void refreshLease();
          }
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
    resyncGeneration += 1;
    for (const dispose of disposers.splice(0)) dispose();
    setHostInputBlock(null);
    setLeaseInputBlock(null);
    setDriveLeaseSnapshot(null);
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
