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
  /** Where the spawn placed it. Nothing moves a pane no view holds but a close, which forgets it. */
  location: "grid" | "background";
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
 * Per project; the oldest go first. Closed ones are forgotten as they close,
 * so this is a bound on live panes no view holds, not on launches.
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
    location: placement.location === "background" ? "background" : "grid",
    ...(placement.worktreeId !== undefined ? { worktreeId: placement.worktreeId } : {}),
    heldBy: new Set(),
  });
  while (entries.size > MAX_PER_PROJECT) entries.delete(entries.keys().next().value!);
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

/** Closed, or gone from the pty-host: nothing is left to read for them here. */
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
