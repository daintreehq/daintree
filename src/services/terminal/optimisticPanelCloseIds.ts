// The panels whose close is hidden but not yet committed. `optimisticPanelClose`
// owns every write; the set lives here, with no imports, so a reader outside the
// close path (a cross-worktree move choosing where focus goes) can ask about it
// without pulling the coordinator, and the store barrel it reads through, into
// its own module graph.

const EMPTY: ReadonlySet<string> = new Set<string>();
let closingIds: ReadonlySet<string> = EMPTY;

export function getClosingIds(): ReadonlySet<string> {
  return closingIds;
}

export function replaceClosingIds(next: ReadonlySet<string>): void {
  closingIds = next.size === 0 ? EMPTY : next;
}

export function isOptimisticallyClosing(id: string): boolean {
  return closingIds.has(id);
}
