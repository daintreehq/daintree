import { panelKindHasPty } from "../../shared/config/panelKindRegistry.js";
import type { ProjectState } from "../../shared/types/project.js";

/**
 * Extract the working directories of restorable PTY panels from saved project
 * state, in pool-warm priority order. On session restore each panel spawns at
 * its own worktree cwd, so the pty-host must pre-warm these (not just the
 * project root) for the first terminal to hit the pool (#9774).
 *
 * Filtered to plain shell panels — agent/command panels set `options.shell`/
 * `options.args` at spawn, which disqualifies them from the pool regardless
 * (#7961), so warming their cwds would only burn slots. Ordering: panels in the
 * active worktree first, then by `lastActiveAt` descending, so the cwd of the
 * panel the user is most likely to see first is warmed first. Exact cwd strings
 * are preserved (no normalization) to match the `acquireByKey` lookup (#5102).
 */
export function extractRestorePanelCwds(state: ProjectState | null): string[] {
  if (!state || !Array.isArray(state.terminals)) return [];

  const candidates = state.terminals.filter(
    (panel) =>
      typeof panel.cwd === "string" &&
      panel.cwd.trim() !== "" &&
      panelKindHasPty(panel.kind ?? "terminal") &&
      !panel.command &&
      !panel.launchAgentId
  );

  const activeWorktreeId = state.activeWorktreeId;
  candidates.sort((a, b) => {
    const aActive = activeWorktreeId !== undefined && a.worktreeId === activeWorktreeId;
    const bActive = activeWorktreeId !== undefined && b.worktreeId === activeWorktreeId;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  });

  const seen = new Set<string>();
  const cwds: string[] = [];
  for (const panel of candidates) {
    const cwd = panel.cwd as string;
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    cwds.push(cwd);
  }
  return cwds;
}
