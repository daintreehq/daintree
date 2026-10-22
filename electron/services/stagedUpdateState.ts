import type { StagedHostUpdate } from "../../shared/types/ipc/remoteHosts.js";

/**
 * The update this process's updater downloaded and installs when it next
 * quits, as Host mode records it for setup on another machine to read. A leaf
 * with no imports: AutoUpdaterService writes it, the host's status reads it,
 * and neither loads the other.
 */

let current: StagedHostUpdate | null = null;
const listeners = new Set<() => void>();

export function getStagedUpdate(): StagedHostUpdate | null {
  return current;
}

export function setStagedUpdate(next: StagedHostUpdate | null): void {
  if (
    current === next ||
    (current &&
      next &&
      current.version === next.version &&
      current.installsOnQuit === next.installsOnQuit &&
      current.ready === next.ready)
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[stagedUpdate] change listener threw:", error);
    }
  }
}

export function onStagedUpdateChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetStagedUpdateForTesting(): void {
  current = null;
  listeners.clear();
}
