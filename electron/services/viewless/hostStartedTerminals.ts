/**
 * Terminals main started for a project through a viewless action (#14473).
 *
 * A window already showing the project when one of these spawned never adopts
 * it: hydration does, the next time a view opens the project. So the window's
 * panel store can't answer `terminal.list` or `terminal.getStatus` for it, and
 * the MCP bridge reads it off the pty-host instead. Only ever a hint of where
 * to look: what a read reports still comes from the pty-host itself.
 */

export interface HostStartedTerminal {
  id: string;
  /**
   * Where the spawn placed it. Nothing moves a pane no view holds but a
   * scheduled run's done policy (#15982), or a close, which forgets it.
   */
  location: "grid" | "dock" | "background";
  worktreeId?: string;
  /** The views seen holding it, which answer for it themselves. */
  heldBy: ReadonlySet<number>;
}

interface Entry {
  location: HostStartedTerminal["location"];
  worktreeId?: string;
  heldBy: Set<number>;
}

/**
 * Per project. Closed ones are forgotten as main closes them, and nothing a
 * read says is taken as a terminal being gone (a failed read and a missing
 * terminal are worded alike), so past the bound the oldest a view already
 * answers for go first, then the oldest of all.
 */
const MAX_PER_PROJECT = 256;

const started = new Map<string, Map<string, Entry>>();

export function noteHostStartedTerminal(
  projectId: string,
  terminalId: string,
  placement: { location?: string; worktreeId?: string }
): void {
  let entries = started.get(projectId);
  if (!entries) {
    entries = new Map();
    started.set(projectId, entries);
  }
  entries.delete(terminalId);
  entries.set(terminalId, {
    location:
      placement.location === "background" || placement.location === "dock"
        ? placement.location
        : "grid",
    ...(placement.worktreeId !== undefined ? { worktreeId: placement.worktreeId } : {}),
    heldBy: new Set(),
  });
  while (entries.size > MAX_PER_PROJECT) {
    let evict = entries.keys().next().value!;
    for (const [id, entry] of entries) {
      if (entry.heldBy.size > 0) {
        evict = id;
        break;
      }
    }
    entries.delete(evict);
  }
}

export function hostStartedTerminals(projectId: string): HostStartedTerminal[] {
  return [...(started.get(projectId) ?? [])].map(([id, entry]) => ({ id, ...entry }));
}

/** A view answered for these itself: it holds them, and goes on answering for them. */
export function noteHeldByView(projectId: string, terminalIds: Iterable<string>, viewId: number) {
  const entries = started.get(projectId);
  if (!entries) return;
  for (const id of terminalIds) entries.get(id)?.heldBy.add(viewId);
}

/** Moved by main to the background (#15982); the views that answer for it still do. */
export function noteHostStartedTerminalBackgrounded(projectId: string, terminalId: string): void {
  const entry = started.get(projectId)?.get(terminalId);
  if (entry) entry.location = "background";
}

/** Closed by main: nothing is left to read for them here. */
export function forgetHostStartedTerminals(projectId: string, terminalIds: Iterable<string>): void {
  const entries = started.get(projectId);
  if (!entries) return;
  for (const id of terminalIds) entries.delete(id);
  if (entries.size === 0) started.delete(projectId);
}

/** @internal Tests only. */
export function _resetHostStartedTerminalsForTesting(): void {
  started.clear();
}
