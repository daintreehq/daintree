let pending: Promise<void> | null = null;

/**
 * Records this view's reread of the host's CLI check after it heard that the
 * copy an agent launches changed (#16399). Kept apart from the store so launch
 * code can wait on it wherever the store itself is stood in for.
 */
export function trackCliHostSync(run: Promise<void>): void {
  pending = run;
  void run.finally(() => {
    if (pending === run) pending = null;
  });
}

/**
 * Settles once the reread recorded last has landed. A launch waits on it, so it
 * never starts the copy this view held before the change.
 */
export function whenCliHostSynced(): Promise<void> {
  return pending ?? Promise.resolve();
}

export function resetCliHostSync(): void {
  pending = null;
}
