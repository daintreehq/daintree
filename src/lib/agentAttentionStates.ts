import {
  getAttentionAgentState,
  type AttentionAgentState,
} from "@/components/Worktree/terminalStateConfig";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { AgentState } from "@shared/types";

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

/**
 * Per-agent pip state across panels in the active worktree: an entry for every
 * agent with a live session, valued with the state its pip should draw, or null
 * when none of its sessions wants the user. Runtime identity wins so a plain
 * shell that starts Claude/Codex is tracked under the same launcher entry;
 * launch intent is only a boot-window fallback before any detector result has
 * committed. Designed to run inside a useShallow selector (Map values are
 * primitives) so subscribers only re-render on real state transitions, not
 * every panelsById spread — see issue #7451.
 *
 * Lives here rather than beside either consumer: the toolbar's overflow menu and
 * the shared launcher both draw the same dot, and a second copy is how the two
 * start disagreeing about what "running" means.
 */
export function deriveAgentAttentionStates(
  panelsById: Record<string, PanelInstance>,
  panelIds: readonly string[],
  activeWorktreeId: string | null
): Map<string, AttentionAgentState | null> {
  const statesPerAgent = new Map<string, (AgentState | undefined)[]>();
  for (const pid of panelIds) {
    const p = panelsById[pid];
    if (
      !p ||
      !isPtyPanel(p) ||
      p.location === "trash" ||
      p.location === "background" ||
      p.location === "overlay"
    )
      continue;
    const agentId = getRuntimeOrBootAgentId(p);
    if (!agentId) continue;
    if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
    if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
    const arr = statesPerAgent.get(agentId) ?? [];
    arr.push(p.agentState);
    statesPerAgent.set(agentId, arr);
  }
  const result = new Map<string, AttentionAgentState | null>();
  for (const [agentId, states] of statesPerAgent) {
    result.set(agentId, getAttentionAgentState(states));
  }
  return result;
}
