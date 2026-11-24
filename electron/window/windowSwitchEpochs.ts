/**
 * Monotonic per-window workspace-switch epoch. Work a switch defers until
 * later (a failed swap's worktree restore, a cloned project's load) only runs
 * while its epoch is still the window's current one, so a newer switch, to a
 * project or to a scratch, is never clobbered by an older one's tail.
 */
const windowSwitchEpochs = new Map<number, number>();

/** Start a switch in `windowId`; every earlier switch's deferred work goes stale. */
export function beginWindowSwitch(windowId: number): number {
  const epoch = currentWindowSwitch(windowId) + 1;
  windowSwitchEpochs.set(windowId, epoch);
  return epoch;
}

/** The window's switch epoch now: 0 before its first switch. */
export function currentWindowSwitch(windowId: number): number {
  return windowSwitchEpochs.get(windowId) ?? 0;
}

export function isCurrentWindowSwitch(windowId: number, epoch: number): boolean {
  return currentWindowSwitch(windowId) === epoch;
}
