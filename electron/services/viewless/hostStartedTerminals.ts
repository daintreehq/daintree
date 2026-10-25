/**
 * Terminals main started for a project through a viewless action (#14473).
 *
 * A window already showing the project when one of these spawned never adopts
 * it: hydration does, the next time a view opens the project. So the window's
 * panel store can't answer `terminal.list` or `terminal.getStatus` for it, and
 * the MCP bridge reads it off the pty-host instead. Only ever a hint of where
 * to look: what a read reports still comes from the pty-host itself.
 */

/** Per project; the oldest go first, and a forgotten one is only a terminal the view must hold. */
const MAX_PER_PROJECT = 256;

const started = new Map<string, Set<string>>();

export function noteHostStartedTerminal(projectId: string, terminalId: string): void {
  let ids = started.get(projectId);
  if (!ids) {
    ids = new Set();
    started.set(projectId, ids);
  }
  ids.delete(terminalId);
  ids.add(terminalId);
  while (ids.size > MAX_PER_PROJECT) ids.delete(ids.values().next().value!);
}

export function hostStartedTerminalIds(projectId: string): string[] {
  return [...(started.get(projectId) ?? [])];
}

/** Ones a view now holds, or the pty-host no longer does: nothing is left to read for them here. */
export function forgetHostStartedTerminals(projectId: string, terminalIds: Iterable<string>): void {
  const ids = started.get(projectId);
  if (!ids) return;
  for (const id of terminalIds) ids.delete(id);
  if (ids.size === 0) started.delete(projectId);
}

/** @internal Tests only. */
export function _resetHostStartedTerminalsForTesting(): void {
  started.clear();
}
