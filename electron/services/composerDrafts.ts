/**
 * Which terminals' hybrid inputs hold text (#16282), as each view last said.
 * A view reports its whole set of draft keys (`{projectId}:{terminalId}` or a
 * bare terminal id, as the renderer's draft store keys them) whenever a draft
 * appears or empties, and a view that closes takes its drafts with it. A
 * terminal has a draft while any view says so. It lives outside Decisions'
 * own modules because the IPC handler that records it loads at startup, and
 * Decisions loads only once it is on.
 */
export class ComposerDrafts {
  private readonly byView = new Map<string, ReadonlySet<string>>();
  private readonly clearedListeners = new Set<() => void>();

  /** Replace what `viewId` holds; a key gone from any view tells the listeners. */
  report(viewId: string, keys: readonly string[]): void {
    const before = this.byView.get(viewId);
    const after = new Set(keys);
    if (after.size === 0) this.byView.delete(viewId);
    else this.byView.set(viewId, after);
    if (before !== undefined && [...before].some((key) => !after.has(key))) this.notifyCleared();
  }

  dropView(viewId: string): void {
    const before = this.byView.get(viewId);
    if (before === undefined) return;
    this.byView.delete(viewId);
    this.notifyCleared();
  }

  hasDraft(terminalId: string): boolean {
    const suffix = `:${terminalId}`;
    for (const keys of this.byView.values()) {
      for (const key of keys) {
        if (key === terminalId || key.endsWith(suffix)) return true;
      }
    }
    return false;
  }

  /** Called whenever a draft empties or its view goes; returns the unsubscribe. */
  onCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener);
    return () => {
      this.clearedListeners.delete(listener);
    };
  }

  private notifyCleared(): void {
    for (const listener of [...this.clearedListeners]) {
      try {
        listener();
      } catch (err) {
        console.error("[Decisions] A composer-cleared listener failed:", err);
      }
    }
  }
}

export const composerDrafts = new ComposerDrafts();
