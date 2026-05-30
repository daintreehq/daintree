import type { AgentSettings } from "@shared/types/agentSettings";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentToolbarVisible } from "@shared/utils/agentPinned";

/** Minimal shape needed to order an agent against the toolbar pin state. */
export interface PinnableAgent {
  id: string;
  availability?: AgentAvailabilityState;
}

/**
 * Splits and orders agents the way both the dock and grid context menus
 * present them: toolbar-pinned agents first (in toolbar `leftButtons` order),
 * then the remaining agents in their incoming order.
 *
 * "Pinned to toolbar" follows the tri-state resolver `isAgentToolbarVisible`
 * (explicit pin wins, then live CLI availability) so the menu grouping always
 * matches what the toolbar actually shows. `leftButtons` supplies the order
 * only — an agent visible in the toolbar but absent from `leftButtons` (e.g.
 * explicitly pinned but never dragged into the rail) sorts to the end of the
 * pinned group via a stable sort.
 *
 * Returns the concatenated array plus `pinnedCount` so callers can render a
 * separator + labels between the two groups without re-deriving the split.
 */
export function sortAgentsByToolbarPin<T extends PinnableAgent>(
  agents: ReadonlyArray<T>,
  leftButtons: readonly string[],
  agentSettings: AgentSettings | null | undefined
): { sorted: T[]; pinnedCount: number } {
  const order = new Map<string, number>();
  for (let i = 0; i < leftButtons.length; i++) {
    const id = leftButtons[i]!;
    if (!order.has(id)) order.set(id, i);
  }

  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const agent of agents) {
    if (isAgentToolbarVisible(agentSettings?.agents?.[agent.id], agent.availability)) {
      pinned.push(agent);
    } else {
      unpinned.push(agent);
    }
  }

  pinned.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  return { sorted: [...pinned, ...unpinned], pinnedCount: pinned.length };
}
