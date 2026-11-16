/**
 * The views showing host figures right now (the host switcher, the hosts
 * overview, a placement row), by WebContents id. This machine samples its own
 * load beside other hosts only while one does or a host is connected
 * (#17027). Kept in core, so a view that asks before Remote Hosts has started
 * is still counted once it has.
 */
const following = new Set<number>();
const listeners = new Set<() => void>();

export function setHostFiguresFollowed(webContentsId: number, followed: boolean): void {
  const before = following.size > 0;
  if (followed) following.add(webContentsId);
  else following.delete(webContentsId);
  const after = following.size > 0;
  if (after === before) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[HostFigures] Demand listener failed:", error);
    }
  }
}

export function areHostFiguresFollowed(): boolean {
  return following.size > 0;
}

/** Told when the first view starts following and when the last one stops. */
export function onHostFiguresDemandChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetHostFiguresDemandForTesting(): void {
  following.clear();
  listeners.clear();
}
