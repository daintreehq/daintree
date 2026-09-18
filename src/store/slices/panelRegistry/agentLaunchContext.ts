import type { ActionContext } from "@shared/types/actions";
import { getActionContext } from "@/services/ActionService";
import { getWorktreeIdentityById } from "@/store/storeAccessors";

/**
 * Launch agents whose MCP session replays the context captured here (#12486).
 * Claude is the only one main binds to its launch workspace; the Daintree
 * Assistant keeps whatever its own caller supplies.
 */
const LAUNCH_CONTEXT_AGENT_IDS: ReadonlySet<string> = new Set(["claude"]);

/**
 * The `ActionContext` an agent pane's MCP session replays for its whole life
 * (#12486), the way a help session replays the one taken when it was opened
 * (#8317). Without it, a call from the pane reads the bound view's live
 * selection — so "current worktree" would mean whatever the user happens to be
 * looking at in that project, not the worktree the pane runs in.
 *
 * Taken from this view's live context, then pointed at the pane itself: the
 * worktree it was spawned into, not the one selected when it was launched (a
 * recipe or an MCP launch routinely targets another), and the pane as the
 * focused terminal, since a frozen "whatever was focused at launch" names a
 * terminal the agent has no relationship with. `isSettingsOpen` is dropped
 * because a snapshot of a dialog's visibility is wrong seconds later.
 *
 * Returns undefined for every other agent, so their spawn payload is unchanged.
 */
export function buildAgentLaunchContext(input: {
  launchAgentId: string | undefined;
  terminalId: string;
  title?: string;
  worktreeId?: string;
}): ActionContext | undefined {
  if (input.launchAgentId === undefined || !LAUNCH_CONTEXT_AGENT_IDS.has(input.launchAgentId)) {
    return undefined;
  }
  const { isSettingsOpen: _isSettingsOpen, ...live } = getActionContext();
  const context: ActionContext = {
    ...live,
    focusedTerminalId: input.terminalId,
    focusedTerminalKind: "terminal",
    focusedTerminalTitle: input.title,
  };
  if (input.worktreeId !== undefined) {
    const worktree = getWorktreeIdentityById(input.worktreeId);
    context.activeWorktreeId = input.worktreeId;
    context.activeWorktreeName = worktree?.name;
    context.activeWorktreePath = worktree?.path;
    context.activeWorktreeBranch = worktree?.branch;
    context.activeWorktreeIsMain = worktree?.isMainWorktree;
    context.focusedWorktreeId = input.worktreeId;
  }
  return context;
}
