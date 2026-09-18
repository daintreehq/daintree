import type { WorktreeViewStore, WorktreeViewStoreApi } from "@/store/createWorktreeStore";

/**
 * The switched-to view's half of main's `projectswitch.status-timing` record
 * (#12461): the moment every worktree in this view's store first carries a
 * status — when the last "Checking status…" label clears — reported back over
 * the worktree port so it queues behind the statuses the host already sent.
 *
 * Armed only by main's `project:on-switch`, which names the switch and its
 * deadline. Nothing here subscribes to anything while unarmed, so ordinary
 * `worktree-update` traffic never pays for it.
 */

/**
 * How soon a refused or failed report is judged again when nothing in the
 * store moves. A load that settles without emitting anything — a folder with
 * no repository, or a host that finishes installing monitors this view already
 * has — would otherwise leave a refused view waiting out its whole deadline.
 */
const REFUSED_RETRY_MS = 500;

interface ArmedSwitch {
  switchId: string;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout>;
  retry: ReturnType<typeof setTimeout> | null;
  unwatch: (() => void) | null;
  inFlight: boolean;
  /** The store or port changed while a report was in flight. */
  dirty: boolean;
}

let installed = false;
let store: WorktreeViewStoreApi | null = null;
let armed: ArmedSwitch | null = null;

/** Registered from the entry module so it is listening before main's first send. */
export function installProjectSwitchStatusTiming(): void {
  if (installed) return;
  installed = true;
  window.electron.project.onSwitch((payload) => {
    if (!payload?.switchId || typeof payload.statusTimingDeadlineAt !== "number") return;
    armSwitchStatusTiming(payload.switchId, payload.statusTimingDeadlineAt);
  });
}

export function armSwitchStatusTiming(switchId: string, deadlineAt: number): void {
  disarm();
  const entry: ArmedSwitch = {
    switchId,
    deadlineAt,
    timer: setTimeout(() => expire(entry), Math.max(0, deadlineAt - Date.now())),
    retry: null,
    unwatch: null,
    inFlight: false,
    dirty: false,
  };
  armed = entry;
  watch(entry);
}

/** The view's worktree store; a switch can arrive before the provider mounts. */
export function attachSwitchStatusTimingStore(next: WorktreeViewStoreApi): () => void {
  if (armed) unwatch(armed);
  store = next;
  if (armed) watch(armed);
  return () => {
    if (store !== next) return;
    if (armed) unwatch(armed);
    store = null;
  };
}

function watch(entry: ArmedSwitch): void {
  if (!store || entry.unwatch) return;
  const offStore = store.subscribe((state, prev) => {
    if (
      state.worktrees !== prev.worktrees ||
      state.isInitialized !== prev.isInitialized ||
      state.isReconnecting !== prev.isReconnecting ||
      state.version !== prev.version
    ) {
      check(entry);
    }
  });
  // `onReady` also fires at once when the port is already up. That call is
  // skipped: a check that finishes the switch then would run before there is
  // an unwatch to call, leaving both listeners behind. Later calls are
  // deferred because the port client walks its live callback list, so
  // unregistering from inside one would skip the provider's own ready
  // handler — the one that starts hydration.
  let wired = false;
  const offReady = window.electron.worktreePort.onReady(() => {
    if (wired) queueMicrotask(() => check(entry));
  });
  entry.unwatch = () => {
    offStore();
    offReady();
  };
  wired = true;
  // A warm switch reuses its port and never re-attaches, so the store is
  // judged as it stands.
  check(entry);
}

function unwatch(entry: ArmedSwitch): void {
  entry.unwatch?.();
  entry.unwatch = null;
}

function disarm(): void {
  const entry = armed;
  if (!entry) return;
  armed = null;
  clearTimeout(entry.timer);
  if (entry.retry !== null) clearTimeout(entry.retry);
  unwatch(entry);
}

function countStatuses(state: WorktreeViewStore): number {
  let count = 0;
  for (const worktree of state.worktrees.values()) {
    if (worktree.worktreeChanges != null) count++;
  }
  return count;
}

function check(entry: ArmedSwitch): void {
  if (armed !== entry || !store) return;
  if (entry.inFlight) {
    entry.dirty = true;
    return;
  }
  // A view that only arrives after its deadline has timed out, whatever its
  // store says now.
  if (Date.now() >= entry.deadlineAt) {
    expire(entry);
    return;
  }
  if (!window.electron.worktreePort.isReady()) return;
  const state = store.getState();
  // Reconnecting means the rows were last described by a host whose port has
  // since closed; updates from its successor can land before the snapshot
  // that replaces them, and a stale row still looks like it has a status.
  if (!state.isInitialized || state.isReconnecting) return;
  const statusCount = countStatuses(state);
  if (statusCount !== state.worktrees.size) return;

  entry.inFlight = true;
  entry.dirty = false;
  if (entry.retry !== null) {
    clearTimeout(entry.retry);
    entry.retry = null;
  }
  window.electron.worktreePort
    .request("report-switch-status-timing", {
      switchId: entry.switchId,
      epoch: state.version.epoch,
      appliedAt: Date.now(),
      worktreeCount: state.worktrees.size,
      statusCount,
    })
    .then(
      ({ accepted }) => {
        if (armed !== entry) return;
        entry.inFlight = false;
        if (accepted) disarm();
        else judgeAgain(entry);
      },
      () => {
        if (armed !== entry) return;
        entry.inFlight = false;
        judgeAgain(entry);
      }
    );
}

/**
 * After a refused or failed report: at once if the store moved meanwhile,
 * otherwise after a pause, since a host can settle without changing the store.
 */
function judgeAgain(entry: ArmedSwitch): void {
  if (entry.dirty) {
    check(entry);
    return;
  }
  entry.retry = setTimeout(() => {
    entry.retry = null;
    check(entry);
  }, REFUSED_RETRY_MS);
}

function expire(entry: ArmedSwitch): void {
  if (armed !== entry) return;
  const state = store?.getState();
  if (state && window.electron.worktreePort.isReady()) {
    window.electron.worktreePort
      .request("report-switch-status-timing", {
        switchId: entry.switchId,
        epoch: state.version.epoch,
        appliedAt: null,
        worktreeCount: state.worktrees.size,
        statusCount: countStatuses(state),
      })
      .catch(() => {});
  }
  disarm();
}

/** Test-only reset. */
export function resetProjectSwitchStatusTimingForTesting(): void {
  disarm();
  store = null;
  installed = false;
}
