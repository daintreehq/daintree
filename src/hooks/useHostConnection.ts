import { useEffect, useSyncExternalStore } from "react";
import {
  LOCAL_HOST_ID,
  type HostId,
  type HostPreviousEnd,
  type OperationId,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type {
  DriveLeaseEvent,
  DriveLeaseNavigation,
  DriveLeaseView,
} from "@shared/types/ipc/driveLease";
import { isEitherRemoteRoleSupported } from "@/lib/remoteHosts";
import {
  useHostConnectionStore,
  isHostLinkUp,
  waitForHostConnected,
} from "@/store/hostConnectionStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { resyncHostTerminals } from "@/store/hostTerminalResync";
import { refreshHostDrafts, rehydrateHostProjectState } from "@/store/hostProjectRehydrate";
import {
  applyDriverNavigation,
  startDriverNavigationReporter,
  type DriverNavigationReporter,
} from "@/store/hostDriverNavigation";
import { notifyHostResync } from "@/store/hostResyncSignal";
import {
  dropDeferredHostOwnedWrites,
  holdHostOwnedWrites,
  releaseHostOwnedWrites,
  setHostOwnedWriteFlushBarrier,
} from "@/store/persistence/hostOwnedWrites";
import {
  getDriveLeaseSnapshot,
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
import { logInfo, logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { primeHostPreviewCapability } from "@/components/FileViewer/filePreviewKinds";
import { watchHostConnectionAnnouncements } from "@/components/Recovery/hostConnectionAnnouncements";

/** The remote host this view runs on, or null when it runs on this machine. */
export function getViewHostId(): HostId | null {
  if (typeof window === "undefined") return null;
  const id = window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id !== LOCAL_HOST_ID ? id : null;
}

/**
 * Who drives this view's project from another machine, or null when this view
 * may type. The host answers per view: `drivingHere` is true only for the holder
 * endpoint (plus a Canopy viewer on its client and the host's own windows), so
 * any other holder locks input.
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
/** A pass still owed the project state, because a request that asked for it was coalesced. */
let resyncProjectStateOwed = false;
/**
 * The panes a host restart ended, by the restart key each was lost under,
 * held until the host says whether this view drives: it relaunches them, or
 * leaves them to the driver. `gathering` until the first resync after the
 * restart has looked: what later ones find gone ended since, not with the
 * restart. `previousEnd` is how the host recorded its previous process
 * ending, absent for a planned restart; `relaunched` and `held` count what
 * a relaunch cut short already brought back, so the notice once it is done
 * counts it all. `restart` names the restart they are about. Null when no
 * restart is owed that.
 */
interface RestartRecovery {
  lost: Map<string, number>;
  gathering: boolean;
  restart: number;
  previousEnd?: HostPreviousEnd;
  relaunched: number;
  held: number;
}
let restartRecovery: RestartRecovery | null = null;
/** Bumped by every host restart: only the latest one says how the host ended. */
let restartCount = 0;
/**
 * Bumped by teardown and when this view gives a restart's panes up: a
 * relaunch under way outlives the resyncs after it, which only re-read what
 * the host shows, but neither of those.
 */
let restartRecoveryGeneration = 0;
/**
 * Bumped by every resync request and by teardown. A pass applies what it read
 * only while this still matches, so an answer overtaken by a newer request
 * (or a closed sync) is dropped and the follow-up pass applies a fresh one.
 */
let resyncGeneration = 0;

export interface ResyncFromHostOptions {
  /**
   * The link came back on a fresh session, which knows nothing of the old
   * one: the host's saved project state (panels, layout, drafts) is read back
   * as well, not just what events would have carried.
   */
  freshSession?: boolean;
  /**
   * The host's process restarted in the gap, so the terminals it no longer
   * has ended with it: a view that drives brings them back as a cold launch
   * would, rather than leaving them exited.
   */
  hostRestarted?: boolean;
  /** With `hostRestarted`: how the host recorded its previous process ending, when uncleanly. */
  previousEnd?: HostPreviousEnd;
}

/**
 * Refetch what this view shows from its host after the host dropped events on
 * their way here or the link came back fresh. Terminal output is not part of
 * this: it resumes on its own stream. Overlapping requests coalesce into one
 * follow-up pass.
 */
export function resyncFromHost(options: ResyncFromHostOptions = {}): Promise<void> {
  resyncGeneration += 1;
  if (options.freshSession) resyncProjectStateOwed = true;
  if (options.hostRestarted) armRestartRecovery(options.previousEnd);
  if (resyncRunning) {
    resyncAgain = true;
    return resyncRunning;
  }
  resyncRunning = (async () => {
    do {
      resyncAgain = false;
      const projectState = resyncProjectStateOwed;
      resyncProjectStateOwed = false;
      await runResyncPass(projectState);
    } while (resyncAgain);
  })().finally(() => {
    resyncRunning = null;
  });
  return resyncRunning;
}

async function runResyncPass(projectState: boolean): Promise<void> {
  const projectId = getViewWorkspaceId();
  const generation = resyncGeneration;
  const readBacks = readBacksStarted;
  const follows = followGeneration;
  const isCurrent = () => generation === resyncGeneration && getViewWorkspaceId() === projectId;
  const lease = refreshLease();
  const recovery = restartRecovery?.gathering ? restartRecovery : null;
  const terminals = projectId
    ? resyncHostTerminals(projectId, {
        isCurrent,
        onLost: recovery ? recordRestartLoss : undefined,
      })
    : Promise.resolve();
  const worktrees = window.electron.worktree.refresh();
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["worktrees", () => worktrees],
    [
      "worktree topology",
      () => window.electron.worktreePort.request("reconcile-topology", { force: true }),
    ],
    ["terminals", () => terminals],
    [
      "plugins",
      async () => {
        const { usePluginRuntimeStore } = await import("@/store/pluginRuntimeStore");
        usePluginRuntimeStore.getState().refresh();
      },
    ],
    ["drive lease", () => lease],
    // Dev previews and anything else kept from host events refetch for themselves.
    ["event-fed state", async () => notifyHostResync()],
  ];
  if (projectId) {
    // A dropped event may have been the driver's panels changing. A follow
    // asked for since this pass began (the lease read finding a new driver)
    // already reads them.
    steps.push([
      "driver's panels",
      async () => {
        await Promise.allSettled([lease]);
        if (isCurrent() && watches(projectId) && follows === followGeneration) {
          void followHostPanels();
        }
      },
    ]);
  }
  if (projectState && projectId) {
    steps.push([
      "project state",
      async () => {
        // After the terminals, so the host's saved order also places the ones
        // just adopted; after the lease, to know whose layout wins.
        // And after the worktrees, so the saved active worktree can be found.
        await Promise.allSettled([terminals, lease, worktrees]);
        // A view that watches reads it back by following the driver, which
        // this pass sets going once the lease is read; one back over another
        // driver's state reads it back as authoritative instead.
        if (!isCurrent() || watches(projectId)) return;
        if (readBackOwed || readBacksStarted !== readBacks) return;
        await rehydrateHostProjectState(projectId, { isCurrent, authoritative: false });
      },
    ]);
  }
  if (recovery && projectId) {
    steps.push([
      "terminals a host restart ended",
      async () => {
        await Promise.allSettled([terminals, lease]);
        // A newer pass gathers in this one's place.
        if (!isCurrent() || restartRecovery !== recovery) return;
        recovery.gathering = false;
        settleRestartRecovery();
      },
    ]);
  }
  const results = await Promise.allSettled(steps.map(([, step]) => step()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn(`[HostConnection] Resync of ${steps[index]![0]} failed`, { error: result.reason });
    }
  });
  if (projectState && !isCurrent()) resyncProjectStateOwed = true;
}

/**
 * A pane the resync after a host restart found gone. Only while that resync
 * is still looking: a read still under way once it has looked reports what
 * ended since.
 */
function recordRestartLoss(id: string, restartKey: number): void {
  if (restartRecovery?.gathering) restartRecovery.lost.set(id, restartKey);
}

/**
 * The host restarted under this view. One that watched the project then has
 * nothing of its own to bring back: what it showed were the driver's.
 */
function armRestartRecovery(previousEnd: HostPreviousEnd | undefined): void {
  const projectId = getViewWorkspaceId();
  const before = leaseBeforeGap ?? getDriveLeaseSnapshot();
  if (projectId && before?.projectId === projectId && !before.drivingHere) return;
  restartCount += 1;
  restartRecovery ??= { lost: new Map(), gathering: true, restart: 0, relaunched: 0, held: 0 };
  restartRecovery.gathering = true;
  // This restart's word on the last end, and its own count of what came back.
  restartRecovery.restart = restartCount;
  restartRecovery.previousEnd = previousEnd;
  restartRecovery.relaunched = 0;
  restartRecovery.held = 0;
}

/** Said once a restart's relaunch has settled, and only when the host recorded an unclean end. */
function noticeRestart(projectId: string, recovery: RestartRecovery): void {
  const previousEnd = recovery.previousEnd;
  // A restart since has its own word, which this one's would replace.
  if (!previousEnd || recovery.restart !== restartCount) return;
  const { relaunched, held } = recovery;
  const host = { hostId: useHostConnectionStore.getState().hostId, hostName: hostLabel() };
  const generation = restartRecoveryGeneration;
  void import("@/store/hostRestartNotice")
    .then(({ noticeUncleanHostRestart }) => {
      if (generation !== restartRecoveryGeneration || recovery.restart !== restartCount) return;
      if (getViewWorkspaceId() !== projectId) return;
      noticeUncleanHostRestart(host, projectId, previousEnd, { relaunched, held });
    })
    .catch((error: unknown) => {
      logWarn("[HostConnection] Couldn't say how the host's restart went", { error });
    });
}

/**
 * Settle what a host restart ended once the host has said who drives: a view
 * that drives, over the state it drove before, brings those panes back the
 * way a cold launch does; one that watches gives them up to the driver at
 * once, for good, whatever it is still finding or relaunching. While the
 * answer is still owed (lost on its way, or a read-back of the host's state
 * under way) they wait for it.
 */
function settleRestartRecovery(): void {
  const projectId = getViewWorkspaceId();
  if (!projectId) return;
  const lease = getDriveLeaseSnapshot();
  if (lease?.projectId !== projectId || leaseBeforeGap !== undefined) return;
  const recovery = restartRecovery;
  if (!lease.drivingHere) {
    // A relaunch already on its way stops too, and what it leaves stays left.
    restartRecoveryGeneration += 1;
    restartRecovery = null;
    if (recovery && recovery.lost.size > 0) {
      logInfo("[HostConnection] Left the terminals a host restart ended to the project's driver", {
        projectId,
        count: recovery.lost.size,
      });
    }
    return;
  }
  if (!recovery || recovery.gathering || readBackOwed) return;
  restartRecovery = null;
  if (recovery.lost.size === 0) {
    // Nothing to bring back still leaves the user owed what happened there.
    noticeRestart(projectId, recovery);
    return;
  }
  const generation = restartRecoveryGeneration;
  const isCurrent = () =>
    generation === restartRecoveryGeneration && getViewWorkspaceId() === projectId;
  safeFireAndForget(
    (async () => {
      // All of them, should the relaunch not get as far as saying.
      let left: ReadonlyMap<string, number> = recovery.lost;
      try {
        const { relaunchTerminalsLostToHostRestart } = await import("@/store/hostRestartRecovery");
        const outcome = await relaunchTerminalsLostToHostRestart(projectId, recovery.lost, {
          isCurrent,
          drives: () => drivesSinceGap(projectId),
        });
        left = outcome.deferred;
        recovery.relaunched += outcome.relaunched;
        recovery.held += outcome.held;
      } finally {
        // Cut short by the link, or this view stopped driving on the way: the
        // host's next word settles what is left. One relaunched meanwhile no
        // longer shows its loss and is skipped then.
        if (left.size > 0 && isCurrent()) {
          // A restart since has its own word and count; otherwise this one's carry
          // over, onto a fresh record or one an older restart's relaunch left.
          restartRecovery ??= {
            lost: new Map(),
            gathering: false,
            restart: 0,
            relaunched: 0,
            held: 0,
          };
          const pending = restartRecovery;
          if (recovery.restart === restartCount && pending.restart !== restartCount) {
            pending.restart = recovery.restart;
            pending.previousEnd = recovery.previousEnd;
            pending.relaunched = recovery.relaunched;
            pending.held = recovery.held;
          }
          for (const [id, restartKey] of left) {
            if (!pending.lost.has(id)) pending.lost.set(id, restartKey);
          }
        }
      }
      // Reached only when the relaunch answered: one cut short tries again first.
      if (left.size === 0 && isCurrent()) noticeRestart(projectId, recovery);
    })(),
    { context: "Relaunching the terminals a host restart ended" }
  );
}

/** Bumped by every lease event and by teardown, so a slower lookup never overrides either. */
let leaseGeneration = 0;
/**
 * Bumped by every takeover, every read-back after a lost link and by teardown:
 * only the latest of them reads the host's state back.
 */
let takeOverGeneration = 0;

/**
 * The lease as this view last knew it when its link went down, until the host
 * answers again: whether the lease it gets back is of the same tenure tells a
 * blip from a project someone else may have driven meanwhile. Undefined while
 * this view sees every change.
 */
let leaseBeforeGap: DriveLeaseView | undefined;
/**
 * This view came back to drive over state someone else may have saved and
 * hasn't read the host's back yet; its own saves stay held until it has.
 */
let readBackOwed = false;
/** The lease a read-back in flight is for, so a second answer naming it starts no other. */
let readBackLeaseId: number | null | undefined = undefined;
/** Counts read-backs after a lost link, so a resync pass knows one started under it. */
let readBacksStarted = 0;
/** Bumped each time the link goes down: nothing begun before an outage settles what it holds. */
let gapGeneration = 0;
/** Asks the host again while an answer about a lost link is still owed and the link is up. */
let leaseRecheckTimer: ReturnType<typeof setTimeout> | null = null;
let leaseRecheckAttempt = 0;
const LEASE_RECHECK_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];

let followRunning: Promise<void> | null = null;
let followAgain = false;
/** Bumped by every follow request and by teardown, as {@link resyncGeneration} is for resyncs. */
let followGeneration = 0;

/** Where the driver last said it is, while this view watches; null when it hasn't said. */
let driverNavigation: DriveLeaseNavigation | null = null;
/**
 * The lease this view reports its navigation under: set once it drives and
 * has finished taking over, so its first report is never the state it had
 * while it watched. Undefined while it doesn't drive.
 */
let navigationLeaseId: number | null | undefined = undefined;
/**
 * Takeovers (and handoffs) still moving this view to where the previous driver
 * was: nothing is reported meanwhile.
 */
const takeOversSettling = new Set<symbol>();
/**
 * This view has watched since it last drove, so what it shows is the
 * driver's as it followed it, not yet a place of its own: once it drives, it
 * first moves to where the driver last was.
 */
let handoffOwed = false;
let navigationReporter: DriverNavigationReporter | null = null;
let navigationRunning: Promise<void> | null = null;
let navigationAgain = false;

function watches(projectId: string): boolean {
  const lease = getDriveLeaseSnapshot();
  return lease?.projectId === projectId && lease.drivingHere === false;
}

/**
 * The host has said since the link came back that this view drives
 * `projectId`, over the state it drove before: not merely that nobody said
 * otherwise.
 */
function drivesSinceGap(projectId: string): boolean {
  const lease = getDriveLeaseSnapshot();
  return (
    lease?.projectId === projectId &&
    lease.drivingHere === true &&
    leaseBeforeGap === undefined &&
    !readBackOwed
  );
}

/**
 * While another screen drives this view's project, show the panels it shows:
 * adopt the terminals the host runs, drop the ones it closed, and take the
 * driver's saved layout. Runs whenever this view starts watching, someone
 * else takes the project, the host says the driver saved a different panel
 * set, or a resync says events may have been dropped. Nothing is written
 * back: a watcher's saves of the host's project state are skipped. Overlapping
 * requests coalesce into one follow-up pass.
 */
function followHostPanels(): Promise<void> {
  followGeneration += 1;
  if (followRunning) {
    followAgain = true;
    return followRunning;
  }
  followRunning = (async () => {
    do {
      followAgain = false;
      await runFollowPass();
    } while (followAgain);
  })().finally(() => {
    followRunning = null;
  });
  return followRunning;
}

async function runFollowPass(): Promise<void> {
  const projectId = getViewWorkspaceId();
  if (syncRefs === 0 || !projectId || !watches(projectId)) return;
  const generation = followGeneration;
  const isCurrent = () =>
    generation === followGeneration && getViewWorkspaceId() === projectId && watches(projectId);
  // The terminals first, so the host's saved order also places the ones just
  // adopted; the layout is still worth taking if they couldn't be read.
  try {
    await resyncHostTerminals(projectId, { isCurrent, follow: true });
  } catch (error) {
    logWarn("[HostConnection] Couldn't read the host's terminals to follow the driver", { error });
  }
  if (!isCurrent()) return;
  try {
    await rehydrateHostProjectState(projectId, {
      isCurrent,
      authoritative: true,
      follow: true,
      keepActiveWorktree: driverNavigation !== null,
    });
  } catch (error) {
    logWarn("[HostConnection] Couldn't read the driver's layout to follow it", { error });
  }
  // The newest the driver has said, now that the panels it names are adopted.
  if (isCurrent()) await applyLatestDriverNavigation();
}

/**
 * Move to where the driver now is. A follow pass in flight applies the newest
 * when it ends, after adopting the panels it may name; otherwise it is applied
 * now, overlapping requests coalescing into one more.
 */
function followDriverNavigation(): Promise<void> {
  if (followRunning) return followRunning;
  if (navigationRunning) {
    navigationAgain = true;
    return navigationRunning;
  }
  navigationRunning = (async () => {
    do {
      navigationAgain = false;
      await applyLatestDriverNavigation();
    } while (navigationAgain);
  })().finally(() => {
    navigationRunning = null;
  });
  return navigationRunning;
}

async function applyLatestDriverNavigation(): Promise<void> {
  const projectId = getViewWorkspaceId();
  const navigation = driverNavigation;
  if (syncRefs === 0 || !projectId || !navigation || !watches(projectId)) return;
  try {
    await applyDriverNavigation(
      navigation,
      () => getViewWorkspaceId() === projectId && watches(projectId)
    );
  } catch (error) {
    logWarn("[HostConnection] Couldn't follow the driver's navigation", { error });
  }
}

/**
 * A watcher keeps where the driver is. A view that drives reports its own
 * navigation, the holder window at once (and again whenever the host restates
 * the lease, as after a dropped link, so the host is never left with less);
 * one still taking over waits until it has moved to where the driver was.
 */
function noteLeaseNavigation(lease: DriveLeaseView): void {
  if (!lease.drivingHere) {
    navigationLeaseId = undefined;
    handoffOwed = true;
    driverNavigation = lease.driverNavigation ?? null;
    return;
  }
  if (takeOversSettling.size > 0) return;
  const navigation = lease.driverNavigation;
  if (handoffOwed && navigation) {
    // It came to drive without taking over (the holder left, or another of
    // this machine's windows took it): it starts from where the driver was,
    // as a takeover does, before it says where it is.
    handoffOwed = false;
    const { projectId } = lease;
    const settling = Symbol("handoff");
    takeOversSettling.add(settling);
    const isCurrent = () =>
      getViewWorkspaceId() === projectId &&
      getDriveLeaseSnapshot()?.projectId === projectId &&
      getDriveLeaseSnapshot()?.drivingHere === true;
    void applyDriverNavigation(navigation, isCurrent)
      .catch((error: unknown) => {
        logWarn("[HostConnection] Couldn't move to where the driver was", { error });
      })
      .finally(() => settleTakeOver(settling, projectId));
    return;
  }
  handoffOwed = false;
  navigationLeaseId = lease.holder?.leaseId ?? null;
  if (lease.isHolderEndpoint) navigationReporter?.reportNow();
}

/**
 * A takeover or handoff is done with: reporting resumes under the lease as it
 * now stands, which may have moved on while it settled.
 */
function settleTakeOver(settling: symbol, projectId: string): void {
  takeOversSettling.delete(settling);
  const lease = getDriveLeaseSnapshot();
  if (syncRefs > 0 && lease?.projectId === projectId && getViewWorkspaceId() === projectId) {
    noteLeaseNavigation(lease);
  }
}

function mayReportNavigation(projectId: string, hostId: HostId | null): boolean {
  const lease = getDriveLeaseSnapshot();
  if (lease?.projectId !== projectId || !lease.drivingHere || takeOversSettling.size > 0) {
    return false;
  }
  if (navigationLeaseId !== (lease.holder?.leaseId ?? null)) return false;
  return hostId === null || isHostLinkUp(useHostConnectionStore.getState());
}

let draftFollowRunning: Promise<void> | null = null;
let draftFollowAgain = false;
/** Bumped by every draft follow request and by teardown, as {@link followGeneration} is. */
let draftFollowGeneration = 0;

/**
 * While another screen drives this view's project, show the drafts it is
 * typing: read the host's drafts back each time it says they changed. Nothing
 * is written back. Overlapping requests coalesce into one follow-up pass.
 */
function followHostDrafts(): Promise<void> {
  draftFollowGeneration += 1;
  if (draftFollowRunning) {
    draftFollowAgain = true;
    return draftFollowRunning;
  }
  draftFollowRunning = (async () => {
    do {
      draftFollowAgain = false;
      await runDraftFollowPass();
    } while (draftFollowAgain);
  })().finally(() => {
    draftFollowRunning = null;
  });
  return draftFollowRunning;
}

async function runDraftFollowPass(): Promise<void> {
  const projectId = getViewWorkspaceId();
  if (syncRefs === 0 || !projectId || !watches(projectId)) return;
  const generation = draftFollowGeneration;
  const isCurrent = () =>
    generation === draftFollowGeneration &&
    getViewWorkspaceId() === projectId &&
    watches(projectId);
  try {
    await refreshHostDrafts(projectId, { isCurrent });
  } catch (error) {
    logWarn("[HostConnection] Couldn't read the driver's drafts to follow them", { error });
  }
}

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
    // ownership) this view already has stays until the host does answer. One
    // still owed an answer about a lost link asks again.
    if (leaseBeforeGap !== undefined || readBackOwed) scheduleLeaseRecheck();
    return;
  }
  if (generation === leaseGeneration) applyLease(state);
}

/**
 * Ask the host again, backing off, while this view still owes an answer about
 * a lost link and the link is up: its saves stay held until one comes, and a
 * quiet link may never prompt another lookup on its own.
 */
function scheduleLeaseRecheck(): void {
  if (leaseRecheckTimer !== null || syncRefs === 0) return;
  const delays = LEASE_RECHECK_DELAYS_MS;
  const delay = delays[Math.min(leaseRecheckAttempt, delays.length - 1)];
  leaseRecheckAttempt += 1;
  leaseRecheckTimer = setTimeout(() => {
    leaseRecheckTimer = null;
    if (syncRefs === 0 || (leaseBeforeGap === undefined && !readBackOwed)) return;
    // A link that is down asks again once it is back.
    if (!isHostLinkUp(useHostConnectionStore.getState())) return;
    void refreshLease();
  }, delay);
}

function cancelLeaseRecheck(): void {
  if (leaseRecheckTimer !== null) clearTimeout(leaseRecheckTimer);
  leaseRecheckTimer = null;
  leaseRecheckAttempt = 0;
}

/**
 * The link to the host went down: until the host answers again this view
 * can't see the lease move, so its saves are held whatever the gate says.
 */
function noteLeaseOutOfSight(): void {
  // However often the link flaps before the host answers, what it is
  // compared with is the lease this view had when it first lost sight of it.
  const lease = leaseBeforeGap ?? getDriveLeaseSnapshot();
  // A lease never known is settled by the claim on open.
  if (lease === null) return;
  leaseBeforeGap = lease;
  // Nothing begun before the link went down answers for after it: not a
  // lookup, nor a read-back, which the host's next answer starts afresh.
  leaseGeneration += 1;
  gapGeneration += 1;
  readBackLeaseId = undefined;
  cancelLeaseRecheck();
  holdHostOwnedWrites();
}

/**
 * Whether `after` is the lease this view drove under before the link went
 * down, or one the host kept for its client meanwhile (a fresh session, a
 * Host restart). One that watched then never kept it.
 */
function keptThroughGap(before: DriveLeaseView, after: DriveLeaseView): boolean {
  const was = before.holder;
  const is = after.holder;
  if (!before.drivingHere || !was || !is) return false;
  // A Host that predates tenures: only the very same lease is sure to be a blip.
  if (was.tenureId === undefined || is.tenureId === undefined) {
    return was.leaseId === is.leaseId && was.endpointId === is.endpointId;
  }
  return was.tenureId === is.tenureId;
}

/**
 * What an answer from the host means to a view back from a lost link: what
 * it held goes out (it kept the project) or the gate skips it (someone else
 * drives), or it comes back to drive over someone else's state and reads the
 * host's back first. Nothing at all for a view that saw every change.
 */
function backFromGap(lease: DriveLeaseView): "none" | "release" | "read-back" {
  if (leaseBeforeGap === undefined && !readBackOwed) return "none";
  const before = leaseBeforeGap;
  leaseBeforeGap = undefined;
  if (!lease.drivingHere) {
    // It watches, following the driver's state as it is.
    readBackOwed = false;
    cancelLeaseRecheck();
    return "release";
  }
  if (!readBackOwed && before !== undefined && keptThroughGap(before, lease)) {
    cancelLeaseRecheck();
    return "release";
  }
  readBackOwed = true;
  const leaseId = lease.holder?.leaseId ?? null;
  if (readBackLeaseId === leaseId) return "none";
  logInfo("[HostConnection] Driving again after a lost link, maybe over another driver's state", {
    projectId: lease.projectId,
    leaseId,
    leaseIdBefore: before?.holder?.leaseId ?? null,
    watchedBefore: before?.drivingHere === false,
  });
  return "read-back";
}

/**
 * This view took the project over, and its takeover reads the host's state
 * back. Saves a lost link left held stay held until that read is done, as
 * they would for a read-back after the gap. Returns whether they are.
 */
function takeOverDuringGap(lease: DriveLeaseView): boolean {
  const held = leaseBeforeGap !== undefined || readBackOwed;
  leaseBeforeGap = undefined;
  readBackOwed = held;
  readBackLeaseId = held ? (lease.holder?.leaseId ?? null) : undefined;
  if (held) readBacksStarted += 1;
  return held;
}

/**
 * Back from a lost link to drive a project someone else may have driven
 * meanwhile: the host's state is read back as a takeover reads it, and this
 * view's saves stay held until it has been.
 */
function readBackAfterGap(lease: DriveLeaseView, settling: symbol): void {
  readBackLeaseId = lease.holder?.leaseId ?? null;
  readBacksStarted += 1;
  settleReadBack(
    readBackAsDriver(lease.projectId, lease, settling, "after the link came back", {
      refreshWorktrees: true,
    })
  );
}

/**
 * Once the host's state has been read back, what was held while it was read
 * goes: it carries the state from before. The hold ends too, unless the link
 * went down again meanwhile, when the host's next answer says what becomes of
 * what that outage holds. A read that failed is tried again.
 */
function settleReadBack(done: Promise<boolean>): void {
  const generation = takeOverGeneration;
  const gap = gapGeneration;
  void done.then((read) => {
    if (generation !== takeOverGeneration) return;
    readBackLeaseId = undefined;
    if (!readBackOwed) return;
    if (!read) {
      if (gap === gapGeneration) scheduleLeaseRecheck();
      return;
    }
    readBackOwed = false;
    const reason = "they were made before the host's state was read back";
    if (gap !== gapGeneration) {
      dropDeferredHostOwnedWrites(reason);
      return;
    }
    cancelLeaseRecheck();
    releaseHostOwnedWrites(reason);
    settleRestartRecovery();
  });
}

/**
 * Apply the host's word on the lease. A takeover's own answer says
 * `"take-over"`: it reads the host's state back itself (see
 * {@link takeOverDuringGap}).
 */
function applyLease(lease: DriveLeaseView, source: "answer" | "take-over" = "answer"): void {
  const back = source === "take-over" ? "none" : backFromGap(lease);
  const settling = back === "read-back" ? Symbol("read-back") : null;
  if (settling) {
    dropDeferredHostOwnedWrites(
      "the project may have been driven elsewhere while the link was down"
    );
    // Where it is gets said once it has moved to where the last driver was.
    takeOversSettling.add(settling);
    handoffOwed = true;
  }
  const followsAnew = watchesAnew(getDriveLeaseSnapshot(), lease);
  setDriveLeaseSnapshot(lease);
  noteLeaseNavigation(lease);
  // The same holder said again (its away state flipping, a lookup) leaves its
  // panels as they were: they change through panels-changed.
  if (followsAnew) void followHostPanels();
  else if (!lease.drivingHere) void followDriverNavigation();
  const driver = drivenElsewhereBy(lease);
  const driverIsHostScreen = lease.holder?.isHostLocal === true;
  setLeaseInputBlock(
    driver === null
      ? null
      : {
          kind: "driven-elsewhere",
          // The host's screen goes by the name this machine knows the host by,
          // as the window banner names it, not the name it reports itself.
          driverName: driverIsHostScreen ? hostDisplayName(driver) : driver,
          projectId: lease.projectId,
          hostLocal: lease.viewerIsHostLocal,
          driverIsHostScreen,
          driverAway: lease.holderAwayMs !== undefined,
        }
  );
  if (back === "release") releaseHostOwnedWrites();
  if (settling) readBackAfterGap(lease, settling);
  settleRestartRecovery();
}

/**
 * Whether `lease` has this view watching a driver it doesn't follow yet: it
 * starts watching, or someone else holds the project now.
 */
function watchesAnew(before: DriveLeaseView | null, lease: DriveLeaseView): boolean {
  if (lease.drivingHere) return false;
  if (before?.projectId !== lease.projectId || before.drivingHere) return true;
  return (
    before.holder?.leaseId !== lease.holder?.leaseId ||
    before.holder?.endpointId !== lease.holder?.endpointId
  );
}

function hostDisplayName(fallback: string): string {
  const host = useHostConnectionStore.getState();
  return host.hostName ?? host.hostId ?? fallback;
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
export async function takeOverDrive(
  projectId: string,
  options: {
    ifLeaseId?: number | null;
    /** False when nothing changes hands, so the state this view has is the host's already. */
    readBack?: boolean;
  } = {}
): Promise<void> {
  const settling = Symbol("take-over");
  takeOversSettling.add(settling);
  // Whatever this view showed before, a takeover starts from where the
  // driver was; an answer lost on the way leaves the lease event to say where.
  handoffOwed = true;
  let view: DriveLeaseView;
  try {
    view = await window.electron.driveLease.takeOver(
      options.ifLeaseId === undefined ? { projectId } : { projectId, ifLeaseId: options.ifLeaseId }
    );
  } catch (error) {
    // Its own event about the takeover may have landed meanwhile.
    settleTakeOver(settling, projectId);
    throw error;
  }
  leaseGeneration += 1;
  if (!view.drivingHere) {
    takeOversSettling.delete(settling);
    // A conditional claim the host turned down: someone took it first. This
    // view watches, with Take control offered, and keeps what it holds.
    applyLease(view);
    return;
  }
  const heldForGap = takeOverDuringGap(view);
  // Saves a lost link left held still wait on a read of the host's state.
  const readBack = options.readBack !== false || heldForGap;
  // The host's state is read back as authoritative below; a save held from
  // before the takeover must not land on top of it.
  if (readBack) dropDeferredHostOwnedWrites("this view took the project over");
  applyLease(view, "take-over");
  if (!readBack) {
    // Only an older read-back is overtaken; this view still moves to where the
    // last driver was before it says where it is.
    takeOverGeneration += 1;
    settleTakeOver(settling, projectId);
    return;
  }
  // The previous driver's terminals and saved layout are the project's now;
  // this view's were stale while it was displaced.
  const done = readBackAsDriver(projectId, view, settling, "after taking over", {
    refreshWorktrees: heldForGap,
  });
  if (heldForGap) settleReadBack(done);
}

/**
 * Read the project back as the driver before this view left it, once it
 * drives under `view`: the host's terminals first, so the saved order also
 * places the ones just adopted, then its saved state as authoritative, then
 * where that driver was. Resolves whether everything was read (the
 * terminals, the worktrees when asked, the saved state); this view reports
 * its own navigation only once `settling` is let go, at the end.
 */
function readBackAsDriver(
  projectId: string,
  view: DriveLeaseView,
  settling: symbol,
  occasion: string,
  options: { refreshWorktrees?: boolean } = {}
): Promise<boolean> {
  // Current while this view still drives the project: the host's own event
  // about this very lease may land after the answer, and changes nothing.
  const generation = ++takeOverGeneration;
  const isCurrent = () =>
    generation === takeOverGeneration &&
    getViewWorkspaceId() === projectId &&
    getDriveLeaseSnapshot()?.projectId === projectId &&
    getDriveLeaseSnapshot()?.drivingHere === true;
  // Where the previous driver was: this view starts from it, and reports its
  // own navigation only once it has moved there.
  const navigation = view.driverNavigation ?? null;
  const leaseId = view.holder?.leaseId ?? null;
  // Lost and won back meanwhile, the project's navigation is a later driver's.
  const stillThisLease = () => (getDriveLeaseSnapshot()?.holder?.leaseId ?? null) === leaseId;
  let handedOver = navigation === null;
  let read = false;
  return (async () => {
    // The saved active worktree may be one the last driver made meanwhile,
    // which this view only learns of from the refresh.
    const worktrees = options.refreshWorktrees
      ? window.electron.worktree.refresh().then(
          () => true,
          (error: unknown) => {
            logWarn(`[HostConnection] Couldn't refresh the worktrees ${occasion}`, { error });
            return false;
          }
        )
      : Promise.resolve(true);
    let terminalsRead = false;
    try {
      await resyncHostTerminals(projectId, {
        isCurrent,
        follow: true,
        // Read back after a host restart, the panes it finds gone are what the restart ended.
        onLost: recordRestartLoss,
      });
      terminalsRead = true;
    } catch (error) {
      logWarn(`[HostConnection] Couldn't read the host's terminals ${occasion}`, { error });
    }
    const worktreesRead = await worktrees;
    if (!isCurrent()) return;
    try {
      await rehydrateHostProjectState(projectId, {
        isCurrent,
        authoritative: true,
        follow: true,
        keepActiveWorktree: navigation !== null,
      });
      // Without the terminals, the panels a later save sends would miss the
      // ones the last driver opened; without the worktrees, its active one.
      read = terminalsRead && worktreesRead && isCurrent();
    } catch (error) {
      logWarn(`[HostConnection] Couldn't read the project's saved state ${occasion}`, { error });
    }
    // Even without the saved state: what this view showed while displaced is
    // not where the driver was.
    if (navigation && isCurrent() && stillThisLease()) {
      await applyDriverNavigation(navigation, isCurrent);
      handedOver = isCurrent() && stillThisLease();
    }
  })()
    .catch((error: unknown) => {
      logWarn(`[HostConnection] Couldn't move to where the driver was ${occasion}`, { error });
    })
    .then(() => {
      // A later takeover settles for itself, and one overtaken by another
      // driver leaves the handoff to the lease as it now stands.
      if (generation === takeOverGeneration && handedOver && stillThisLease()) {
        handoffOwed = false;
      }
      settleTakeOver(settling, projectId);
      return read;
    });
}

/**
 * Opening a host's project from here is taking it over: the sessions there are
 * this user's own, so the view takes the project as {@link takeOverDrive} does
 * (held saves dropped, the host's state read back as authoritative), when it
 * changes hands at all. Once per view, not per sync mount, and only until it
 * succeeds; a machine that takes the project over later is
 * offered back through the banner, never fought for.
 *
 * A finished claim is also kept in sessionStorage, which belongs to the view's
 * WebContents and outlives a reload or a renderer crash: a reloaded view is
 * the same opening, so it must not take back a project the host's own screen
 * took from it meanwhile. A newly opened view starts with none.
 */
const openClaim = { projectId: null as string | null, done: false, inFlight: false, owed: false };

const OPEN_CLAIM_KEY_PREFIX = "daintree:host-open-claim:";

function readClaimedOnOpen(projectId: string): boolean {
  try {
    return window.sessionStorage.getItem(OPEN_CLAIM_KEY_PREFIX + projectId) === "done";
  } catch {
    return false;
  }
}

function recordClaimedOnOpen(projectId: string): void {
  try {
    window.sessionStorage.setItem(OPEN_CLAIM_KEY_PREFIX + projectId, "done");
  } catch {
    // Without storage a reload claims again, as before.
  }
}

function openClaimOutstanding(projectId: string): boolean {
  if (openClaim.projectId !== projectId) return !readClaimedOnOpen(projectId);
  return !openClaim.done;
}

function claimOpenedProject(projectId: string, isLive: () => boolean): void {
  if (openClaim.projectId !== projectId) {
    const done = readClaimedOnOpen(projectId);
    Object.assign(openClaim, { projectId, done, inFlight: false, owed: false });
  }
  if (openClaim.done || !isLive()) return;
  // A link that came up while an attempt was out gets one more once it settles.
  if (openClaim.inFlight) {
    openClaim.owed = true;
    return;
  }
  openClaim.inFlight = true;
  openClaim.owed = false;
  void claimUnlessAnotherMachineDrives(projectId)
    .then(
      () => {
        openClaim.done = true;
        recordClaimedOnOpen(projectId);
      },
      async (error: unknown) => {
        logWarn("[HostConnection] Couldn't take the project over on open", { error });
        if (isLive()) await refreshLease();
      }
    )
    .finally(() => {
      openClaim.inFlight = false;
      if (!openClaim.done && openClaim.owed && isLive()) claimOpenedProject(projectId, isLive);
    });
}

/**
 * Takes the project unless someone else is using it: nobody holding it, an idle
 * host screen holding it, or another window of this machine holding it is
 * taken. A second laptop driving it, or the host's own screen while someone is
 * using it there, is not silently taken from: this view opens read-only with
 * "Take control" offered instead. A lease event landing while the lease is
 * read means the read is stale, so it is read again before anything is taken.
 * Settles either way, so the claim isn't retried.
 */
async function claimUnlessAnotherMachineDrives(projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = leaseGeneration;
    const lease = await window.electron.driveLease.get({ projectId });
    if (generation !== leaseGeneration) continue;
    const holder = lease.holder;
    const anotherMachine =
      holder !== null &&
      !lease.drivingHere &&
      !holder.isHostLocal &&
      lease.heldByThisClient !== true;
    const hostScreenBusy =
      lease.hostScreenInUse === true && (holder === null || holder.isHostLocal);
    if (anotherMachine || hostScreenBusy) {
      leaseGeneration += 1;
      applyLease(lease);
      return;
    }
    // Only from the holder just read: another Shell opening the project at
    // the same moment may have taken it since, and isn't taken from in turn.
    // Nobody holding it, or this view already doing so, hands over nothing
    // the boot read didn't show; another of this machine's windows may have
    // saved since.
    await takeOverDrive(projectId, {
      ifLeaseId: holder?.leaseId ?? null,
      readBack: holder !== null && !lease.drivingHere,
    });
    return;
  }
  // The lease kept moving while it was read: leave it to the events, which
  // already describe it, rather than take it on a stale read.
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
  if (!isEitherRemoteRoleSupported()) return () => {};
  const disposers: Array<() => void> = [];
  const hostId = getViewHostId();
  const projectId = getViewWorkspaceId();
  let disposed = false;
  const isLive = () => !disposed;

  // Fetched up front so the first preview this view builds already carries it.
  if (hostId !== null) void primeHostPreviewCapability();
  // Each change of the link is said once for the window, never by its banner or panes.
  if (hostId !== null) disposers.push(watchHostConnectionAnnouncements(hostId));

  // Saves held while the link was down go out only after the lease is re-read
  // and any resync in flight (a fresh session's rehydrate) has finished.
  disposers.push(
    setHostOwnedWriteFlushBarrier(async () => {
      await refreshLease();
      if (resyncRunning) await resyncRunning;
    })
  );

  if (window.electron?.driveLease && projectId) {
    disposers.push(
      window.electron.driveLease.onEvent((event: DriveLeaseEvent) => {
        if (event.type === "changed" && event.state.projectId === projectId) {
          leaseGeneration += 1;
          applyLease(event.state);
        } else if (event.type === "panels-changed" && event.projectId === projectId) {
          if (watches(projectId)) void followHostPanels();
        } else if (event.type === "drafts-changed" && event.projectId === projectId) {
          if (watches(projectId)) void followHostDrafts();
        } else if (event.type === "navigation-changed" && event.projectId === projectId) {
          if (!watches(projectId)) return;
          driverNavigation = event.navigation;
          void followDriverNavigation();
        }
      })
    );
    const reporter = startDriverNavigationReporter({
      mayReport: () => mayReportNavigation(projectId, hostId),
      send: (navigation) => {
        const leaseId = getDriveLeaseSnapshot()?.holder?.leaseId ?? null;
        window.electron.driveLease
          .reportNavigation({ projectId, leaseId, navigation })
          .catch((error: unknown) => {
            logWarn("[HostConnection] Couldn't tell the host where this view is", { error });
          });
      },
    });
    navigationReporter = reporter;
    disposers.push(() => {
      reporter.dispose();
      if (navigationReporter === reporter) navigationReporter = null;
    });
    if (hostId !== null) {
      // Until the host says who drives, a remote view could be typing over
      // someone else, so it starts read-only.
      setLeaseInputBlock({ kind: "lease-unknown", hostName: hostLabel() });
      // Once, at open (or when the link first comes up, if it was down); a
      // machine that takes it over later is offered back through the banner,
      // never fought for.
      claimOpenedProject(projectId, isLive);
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
          // Down from up, or first seen down by a view that already knows the lease.
          const wasUp = isHostLinkUp(prev) || prev.connection === null;
          if (wasUp && !isHostLinkUp(next) && next.connection !== null) noteLeaseOutOfSight();
        }
        if (next.connection?.status === "connected" && prev.connection?.status !== "connected") {
          const { buildMismatch, handshake: remoteBuild } = next.connection;
          if (buildMismatch) {
            // Loaded on use: a matching build never pays for the notice.
            safeFireAndForget(
              import("@/components/Hosts/buildMismatchNotice").then(({ noticeBuildMismatch }) =>
                noticeBuildMismatch(hostId, hostLabel(), buildMismatch, remoteBuild)
              ),
              { context: "Warning about a host's different build" }
            );
          }
          const claimOutstanding = projectId !== null && openClaimOutstanding(projectId);
          // A fresh session, including the one after an explicit disconnect, is
          // resynced when main says so (`resync-required`), never from here too:
          // a second request would discard the first pass's reads.
          if (
            !claimOutstanding &&
            (getLeaseInputBlock()?.kind === "lease-unknown" ||
              leaseBeforeGap !== undefined ||
              readBackOwed)
          ) {
            // Whether this view kept the project decides what becomes of its held saves.
            void refreshLease();
          }
          // A view whose claim on open hasn't gone through yet makes it now.
          if (claimOutstanding) claimOpenedProject(projectId, isLive);
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
            if (event.hostId === hostId) {
              void resyncFromHost({
                freshSession: event.reason === "reconnected" || event.reason === "host-restarted",
                hostRestarted: event.reason === "host-restarted",
                ...(event.reason === "host-restarted" &&
                  event.previousEnd && { previousEnd: event.previousEnd }),
              });
            }
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
    followGeneration += 1;
    draftFollowGeneration += 1;
    takeOverGeneration += 1;
    restartRecoveryGeneration += 1;
    restartRecovery = null;
    for (const dispose of disposers.splice(0)) dispose();
    driverNavigation = null;
    navigationLeaseId = undefined;
    handoffOwed = false;
    // Held while the host hadn't said whether this view still drives: never
    // let out unconfirmed as the gates open below.
    const unconfirmed = readBackOwed || leaseBeforeGap !== undefined;
    leaseBeforeGap = undefined;
    readBackOwed = false;
    readBackLeaseId = undefined;
    cancelLeaseRecheck();
    releaseHostOwnedWrites(
      unconfirmed ? "the host never confirmed this view kept the project" : undefined
    );
    setHostInputBlock(null);
    setLeaseInputBlock(null);
    setDriveLeaseSnapshot(null);
    useHostConnectionStore.getState().reset();
  };
}

/** Mount-scoped {@link startHostConnectionSync}, while `enabled`. */
export function useHostConnectionSync(enabled = true): void {
  useEffect(() => (enabled ? startHostConnectionSync() : undefined), [enabled]);
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

/**
 * The host this view's link is down to, or null while it is up (or the view
 * is local): what anything waiting on control waits for first.
 */
export function useLinkDownHost(): string | null {
  const block = useTerminalInputBlock();
  return block?.kind === "disconnected" ? block.hostName : null;
}

/** Ask the host link to try again now, starting over if an attempt is stuck. */
export function reconnectHost(): void {
  const hostId = useHostConnectionStore.getState().hostId;
  if (hostId === null) return;
  safeFireAndForget(window.electron.remoteHosts.connect({ hostId, restart: true }), {
    context: "Reconnecting to the window's host",
  });
}

/** The module's state as a reloaded view starts it: memory gone, sessionStorage kept. */
export function _reloadHostConnectionSyncForTesting(): void {
  stopSync?.();
  stopSync = null;
  syncRefs = 0;
  resyncRunning = null;
  resyncAgain = false;
  resyncProjectStateOwed = false;
  restartRecovery = null;
  restartRecoveryGeneration += 1;
  followRunning = null;
  followAgain = false;
  draftFollowRunning = null;
  draftFollowAgain = false;
  navigationRunning = null;
  navigationAgain = false;
  takeOversSettling.clear();
  handoffOwed = false;
  leaseBeforeGap = undefined;
  readBackOwed = false;
  readBackLeaseId = undefined;
  readBacksStarted = 0;
  cancelLeaseRecheck();
  Object.assign(openClaim, { projectId: null, done: false, inFlight: false, owed: false });
}

/** The panes a host restart ended that this view still holds to relaunch, or null. */
export function _restartLossesForTesting(): ReadonlyMap<string, number> | null {
  return restartRecovery?.lost ?? null;
}

export function _resetHostConnectionSyncForTesting(): void {
  _reloadHostConnectionSyncForTesting();
  try {
    // storage-key: daintree:host-open-claim:
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(OPEN_CLAIM_KEY_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // No storage, nothing kept.
  }
}
