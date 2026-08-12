import { isAgentBlocked } from "@shared/utils/agentAvailability";
import type { AgentAvailabilityState } from "@shared/types";

/**
 * Hint for an agent surface whose last probe came back unlaunchable. Shared by
 * the toolbar button, the searchable launcher and the dock/context menus so all
 * of them name the same outcome: activating still launches, and the recovery
 * panel — not Settings — is what opens (#11760).
 *
 * A leaf module rather than a helper inside `dockLaunchItems`: the toolbar
 * button would otherwise pull the whole launcher graph (panel registry,
 * recipes, notify) in behind one string.
 */
export function unavailableAgentHint(
  name: string,
  availability: AgentAvailabilityState | undefined
): string {
  return isAgentBlocked(availability)
    ? `${name} is blocked by endpoint security. Select to see recovery options`
    : `${name} needs setup. Select to see recovery options`;
}
