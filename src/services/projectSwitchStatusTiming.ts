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

interface ArmedSwitch {
  switchId: string;
  timer: ReturnType<typeof setTimeout>;
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
    timer: setTimeout(() => expire(entry), Math.max(0, deadlineAt - Date.now())),
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
      state.version !== prev.version
    ) {
      check(entry);
    }
  });
  // Fires at once when the port is already up — a warm switch reuses it and
  // never re-attaches, so its store is judged as it stands.
  const offReady = window.electron.worktreePort.onReady(() => check(entry));
  entry.unwatch = () => {
    offStore();
    offReady();
  };
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
  if (!window.electron.worktreePort.isReady()) return;
  const state = store.getState();
  if (!state.isInitialized) return;
  const statusCount = countStatuses(state);
  if (statusCount !== state.worktrees.size) return;

  entry.inFlight = true;
  entry.dirty = false;
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
        if (accepted) {
          disarm();
        } else if (entry.dirty) {
          // Refused as stale. Re-judge only if something moved meanwhile;
          // otherwise the next store change or port attach will.
          check(entry);
        }
      },
      () => {
        if (armed !== entry) return;
        entry.inFlight = false;
        if (entry.dirty) check(entry);
      }
    );
}

function expire(entry: ArmedSwitch): void {
  if (armed !== entry) return;
  const state = store?.getState();
  if (state && window.electron.worktreePort.isReady()) {
    void window.electron.worktreePort
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
