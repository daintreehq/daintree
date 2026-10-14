import { useEffect, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID, type HostId, type OperationId } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type {
  DriveLeaseEvent,
  DriveLeaseNavigation,
  DriveLeaseView,
} from "@shared/types/ipc/driveLease";
import { isEitherRemoteRoleSupported } from "@/lib/remoteHosts";
import { useHostConnectionStore, isHostLinkUp } from "@/store/hostConnectionStore";
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
import { logWarn } from "@/utils/logger";
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
/** A pass still owed the project state, because a request that asked for it was coalesced. */
let resyncProjectStateOwed = false;
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
  const isCurrent = () => generation === resyncGeneration && getViewWorkspaceId() === projectId;
  const lease = refreshLease();
  const terminals = projectId ? resyncHostTerminals(projectId, { isCurrent }) : Promise.resolve();
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
  if (projectState && projectId) {
    steps.push([
      "project state",
      async () => {
        // After the terminals, so the host's saved order also places the ones
        // just adopted; after the lease, to know whose layout wins.
        // And after the worktrees, so the saved active worktree can be found.
        await Promise.allSettled([terminals, lease, worktrees]);
        // A view that watches reads it back by following the driver, which
        // the lease just read has set going.
        if (!isCurrent() || watches(projectId)) return;
        await rehydrateHostProjectState(projectId, { isCurrent, authoritative: false });
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

/** Bumped by every lease event and by teardown, so a slower lookup never overrides either. */
let leaseGeneration = 0;
/** Bumped by every takeover and by teardown: only the latest takeover reads the host's state back. */
let takeOverGeneration = 0;

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
 * While another screen drives this view's project, show the panels it shows:
 * adopt the terminals the host runs, drop the ones it closed, and take the
 * driver's saved layout. Runs whenever this view starts watching and whenever
 * the host says the driver saved a different panel set. Nothing is written
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
    // ownership) this view already has stays until the host does answer.
    return;
  }
  if (generation === leaseGeneration) applyLease(state);
}

function applyLease(lease: DriveLeaseView): void {
  setDriveLeaseSnapshot(lease);
  noteLeaseNavigation(lease);
  if (!lease.drivingHere) void followHostPanels();
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
        }
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
  options: { ifLeaseId?: number | null } = {}
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
    // view watches, with Take over offered, and keeps what it holds.
    applyLease(view);
    return;
  }
  // The host's state is read back as authoritative below; a save held from
  // before the takeover must not land on top of it.
  dropDeferredHostOwnedWrites("this view took the project over");
  applyLease(view);
  // The previous driver's terminals and saved layout are the project's now;
  // this view's were stale while it was displaced. The terminals first, so the
  // saved order also places the ones just adopted.
  // Current while this view still drives the project: the host's own event
  // about this very takeover may land after its answer, and changes nothing.
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
  void (async () => {
    try {
      await resyncHostTerminals(projectId, { isCurrent, follow: true });
    } catch (error) {
      logWarn("[HostConnection] Couldn't read the host's terminals after taking over", { error });
    }
    if (!isCurrent()) return;
    try {
      await rehydrateHostProjectState(projectId, {
        isCurrent,
        authoritative: true,
        follow: true,
        keepActiveWorktree: navigation !== null,
      });
    } catch (error) {
      logWarn("[HostConnection] Couldn't read the project's saved state after taking over", {
        error,
      });
    }
    // Even without the saved state: what this view showed while displaced is
    // not where the driver was.
    if (navigation && isCurrent() && stillThisLease()) {
      await applyDriverNavigation(navigation, isCurrent);
      handedOver = isCurrent() && stillThisLease();
    }
  })()
    .catch((error: unknown) => {
      logWarn("[HostConnection] Couldn't move to where the driver was after taking over", {
        error,
      });
    })
    .finally(() => {
      // A later takeover settles for itself, and one overtaken by another
      // driver leaves the handoff to the lease as it now stands.
      if (generation === takeOverGeneration && handedOver && stillThisLease()) {
        handoffOwed = false;
      }
      settleTakeOver(settling, projectId);
    });
}

/**
 * Opening a host's project from here is taking it over: the sessions there are
 * this user's own, so the view takes the project as {@link takeOverDrive} does
 * (held saves dropped, the host's state read back as authoritative). Once per
 * view, not per sync mount (the layout remounts once after hydration), and
 * only until it succeeds; a machine that takes the project over later is
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
    await takeOverDrive(projectId, { ifLeaseId: holder?.leaseId ?? null });
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
          if (resyncPending) {
            resyncPending = false;
            // After an explicit disconnect the link that comes back is a new session.
            void resyncFromHost({ freshSession: true });
          } else if (!claimOutstanding && getLeaseInputBlock()?.kind === "lease-unknown") {
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
              void resyncFromHost({ freshSession: event.reason === "reconnected" });
              // A dropped event may have been the driver's panels changing.
              if (projectId && watches(projectId)) void followHostPanels();
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
    for (const dispose of disposers.splice(0)) dispose();
    driverNavigation = null;
    navigationLeaseId = undefined;
    handoffOwed = false;
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

/** The module's state as a reloaded view starts it: memory gone, sessionStorage kept. */
export function _reloadHostConnectionSyncForTesting(): void {
  stopSync?.();
  stopSync = null;
  syncRefs = 0;
  resyncRunning = null;
  resyncAgain = false;
  resyncProjectStateOwed = false;
  followRunning = null;
  followAgain = false;
  draftFollowRunning = null;
  draftFollowAgain = false;
  navigationRunning = null;
  navigationAgain = false;
  takeOversSettling.clear();
  handoffOwed = false;
  Object.assign(openClaim, { projectId: null, done: false, inFlight: false, owed: false });
}

export function _resetHostConnectionSyncForTesting(): void {
  _reloadHostConnectionSyncForTesting();
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(OPEN_CLAIM_KEY_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // No storage, nothing kept.
  }
}
