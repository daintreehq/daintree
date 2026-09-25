let open = false;
let hosts = 0;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  open = next;
  for (const listener of [...listeners]) listener();
}

/** Open the hosts overview in this view. False when nothing is mounted to show it. */
export function requestHostsOverview(): boolean {
  if (hosts === 0) return false;
  publish(true);
  return true;
}

export function closeHostsOverview(): void {
  if (open) publish(false);
}

export function isHostsOverviewOpen(): boolean {
  return open;
}

export function subscribeHostsOverview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The overview's host announces itself so a request with none mounted is refused. */
export function registerHostsOverviewHost(): () => void {
  hosts += 1;
  return () => {
    hosts = Math.max(0, hosts - 1);
    if (hosts === 0) publish(false);
  };
}

export function _resetHostsOverviewRequestsForTesting(): void {
  open = false;
  hosts = 0;
  listeners.clear();
}
