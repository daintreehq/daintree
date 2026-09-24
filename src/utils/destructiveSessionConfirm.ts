import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { CLOSE_CONFIRM_AGENT_STATES, coerceAgentState } from "@shared/types/agent";
import { isAgentTerminal } from "@/utils/terminalType";
import { isPtyPanel } from "@shared/types/panel";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import type { DestructivePreviewGroup } from "@/store/terminalPendingDestructiveActionStore";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through until the rest of the renderer
// migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * True when a terminal is an agent terminal AND is currently in an
 * agent-state that represents in-flight work that would be lost on
 * kill/restart. Mirrors the gate at `shared/types/agent.CLOSE_CONFIRM_AGENT_STATES`
 * ("working" only — "waiting"/"directing" are agent-paused states where
 * stopping is non-disruptive).
 *
 * Used to gate the confirm dialogs for `terminal.kill`, `terminal.restart`,
 * and their bulk siblings: bare PTY terminals stay D0 (no confirm), agent
 * terminals only confirm while truly mid-work.
 */
export function terminalHasRunningAgentSession(terminal: CarrierPanel | undefined | null): boolean {
  if (!terminal) return false;
  if (!isAgentTerminal(terminal)) return false;
  const state = coerceAgentState(isPtyPanel(terminal) ? terminal.agentState : undefined);
  return state !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(state);
}

/**
 * Filter a list of terminals down to those with a running agent session.
 * Used by bulk actions to decide whether to confirm before mutating.
 */
export function collectRunningAgentTerminals(
  terminals: ReadonlyArray<CarrierPanel>
): CarrierPanel[] {
  return terminals.filter((t) => terminalHasRunningAgentSession(t));
}

/**
 * Display name for a live worktree, as the sidebar card names it: the branch,
 * or the folder name for a detached HEAD. `undefined` when the id is not in the
 * current view's worktree map (a deleted worktree, or no view mounted yet).
 */
export function resolveWorktreeDisplayName(worktreeId: string | undefined): string | undefined {
  if (!worktreeId) return undefined;
  const worktree = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId);
  if (!worktree) return undefined;
  return worktree.branch ?? worktree.name;
}

/**
 * The preview a bulk destructive confirm shows: the terminals it will touch,
 * grouped by worktree, with the groups and terminals holding a working agent
 * listed first and everything else in the order it first appears. Groups whose worktree can't be named
 * are titled by `fallbackWorktreeTitle` rather than dropped — the list has to
 * account for every target the count claims.
 */
export function buildDestructivePreview(
  terminals: ReadonlyArray<CarrierPanel>,
  resolveWorktreeTitle: (
    worktreeId: string | undefined
  ) => string | undefined = resolveWorktreeDisplayName,
  fallbackWorktreeTitle = "Other terminals"
): DestructivePreviewGroup[] {
  const groups = new Map<string, DestructivePreviewGroup>();
  for (const terminal of terminals) {
    const worktreeId = terminal.worktreeId ?? "";
    let group = groups.get(worktreeId);
    if (!group) {
      group = {
        worktreeId,
        worktreeTitle: resolveWorktreeTitle(terminal.worktreeId) ?? fallbackWorktreeTitle,
        terminals: [],
      };
      groups.set(worktreeId, group);
    }
    group.terminals.push({
      terminalId: terminal.id,
      terminalTitle: terminal.title,
      hasRunningAgent: terminalHasRunningAgentSession(terminal),
    });
  }
  const hasWork = (group: DestructivePreviewGroup) =>
    group.terminals.some((t) => t.hasRunningAgent);
  for (const group of groups.values()) {
    group.terminals.sort((a, b) => Number(b.hasRunningAgent) - Number(a.hasRunningAgent));
  }
  // Live work leads the list: groups holding a working agent come first.
  return [...groups.values()].sort((a, b) => Number(hasWork(b)) - Number(hasWork(a)));
}
