import type { CliAvailability } from "@shared/types";
import { isAgentInstalled, isAgentLaunchable } from "../../../shared/utils/agentAvailability";

/**
 * Compute the set of agent IDs visible in the grid's right-click launch menu.
 *
 * Returns `undefined` while availability is not yet probed — the menu treats
 * `undefined` as "show all" and must not filter to an empty Set during the
 * initial detection race. Once `isAvailabilityInitialized` flips true, the
 * set contains every agent the local machine has installed (state `"ready"`
 * or `"installed"`), regardless of pin state (issue #5117).
 */
export function computeGridSelectedAgentIds(
  isAvailabilityInitialized: boolean,
  agentAvailability: CliAvailability | undefined,
  agentIds: readonly string[]
): Set<string> | undefined {
  if (!isAvailabilityInitialized || !agentAvailability) return undefined;
  return new Set(agentIds.filter((id) => isAgentInstalled(agentAvailability[id])));
}

/**
 * Whether a specific grid agent row should be launchable (enables the menu item).
 * `"terminal"` is always launchable (plain shell). Other agents are launchable
 * only when the probe says the CLI is `"ready"`. Before the first probe lands,
 * treat everything as launchable — matches the show-all contract used by
 * `computeGridSelectedAgentIds`.
 */
export function computeGridCanLaunch(
  id: string,
  isAvailabilityInitialized: boolean,
  agentAvailability: CliAvailability | undefined
): boolean {
  if (id === "terminal") return true;
  if (!isAvailabilityInitialized || !agentAvailability) return true;
  return isAgentLaunchable(agentAvailability[id]);
}
