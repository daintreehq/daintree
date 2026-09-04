import type { AgentSettings } from "@shared/types/agentSettings";
import type { AgentAvailabilityState } from "@shared/types";
import type { ToolbarPinnedState } from "@shared/types/toolbar";
import { isAgentButtonOnToolbar } from "@shared/utils/agentPinned";
import { isLauncherItemOnToolbar, launcherItemToolbarButtonId } from "@shared/types/toolbar";
import { isBuiltInAgentId } from "@shared/config/agentIds";

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
 * "Pinned to toolbar" follows `isAgentButtonOnToolbar` — the same resolver the
 * launcher's pin affordance reads — so the band an agent sits under and the pin
 * icon on its row can never contradict each other. It deliberately is NOT
 * `isAgentToolbarVisible`: that one resolves an unset pin to "the binary is
 * installed", which stopped meaning "has a toolbar button" when #11680 dropped
 * the `LAUNCHABLE_AGENT_IDS` spread from `DEFAULT_LEFT_BUTTONS`. Under the old
 * predicate a fresh profile's installed-but-unpositioned agent landed under
 * "Pinned" wearing an unfilled pin.
 *
 * Both side arrays decide the position, because either one renders a button;
 * `leftButtons` supplies the order only — an agent on the toolbar but absent
 * from it (explicitly pinned, never positioned) sorts to the end of the pinned
 * group via a stable sort.
 *
 * Built-in agents and everything else answer the same question from different
 * stores. A built-in reads `agentSettingsStore` through `isAgentButtonOnToolbar`;
 * a plugin or user-defined agent has no entry there and reads the explicit
 * `true` its launcher-item pin writes into `pinnedButtons` (#12217). Before
 * that they could not be pinned at all and were hard-coded into the unpinned
 * group — which would now put a filled pin icon on a row sitting under "Other".
 *
 * Returns the concatenated array plus `pinnedCount` so callers can render a
 * separator + labels between the two groups without re-deriving the split.
 */
export function sortAgentsByToolbarPin<T extends PinnableAgent>(
  agents: ReadonlyArray<T>,
  leftButtons: readonly string[],
  agentSettings: AgentSettings | null | undefined,
  // Required rather than defaulted: a caller that forgets it would silently
  // demote every right-side agent out of the pinned group, and there is no
  // value of this argument that is safe to guess.
  rightButtons: readonly string[],
  // Required for the same reason, one store over: omitting it would put every
  // pinned plugin or user-defined agent back under "Other" wearing a filled
  // pin, which is the contradiction this argument exists to prevent.
  pinnedButtons: ToolbarPinnedState
): { sorted: T[]; pinnedCount: number } {
  const order = new Map<string, number>();
  for (let i = 0; i < leftButtons.length; i++) {
    const id = leftButtons[i]!;
    if (!order.has(id)) order.set(id, i);
  }
  const positioned = new Set<string>([...leftButtons, ...rightButtons]);

  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const agent of agents) {
    const onToolbar = isBuiltInAgentId(agent.id)
      ? isAgentButtonOnToolbar(
          agentSettings?.agents?.[agent.id],
          agent.availability,
          positioned.has(agent.id)
        )
      : isLauncherItemOnToolbar(launcherItemToolbarButtonId("agent", agent.id), pinnedButtons);
    if (onToolbar) {
      pinned.push(agent);
    } else {
      unpinned.push(agent);
    }
  }

  pinned.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  return { sorted: [...pinned, ...unpinned], pinnedCount: pinned.length };
}
