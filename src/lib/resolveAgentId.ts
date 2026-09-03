import type { CliAvailability } from "@shared/types";
import {
  BUILT_IN_AGENT_IDS,
  isAssistantOnlyAgentId,
  type BuiltInAgentId,
} from "@shared/config/agentIds";
import { isAgentLaunchable } from "../../shared/utils/agentAvailability";

/**
 * Resolve which agent to use given a user preference, an optional secondary
 * default, and the current CLI-availability map.  Returns the first usable
 * agent in priority order: defaultAgent → defaultSelection → registry order.
 *
 * Assistant-only agents are never returned, from any branch. This answers "which
 * agent would a launch spawn", and the Daintree Assistant has no PTY form to spawn —
 * `useAgentLauncher` refuses it outright — so naming it here hands every caller an id
 * that cannot be launched. It used to be FAVOURED above the registry order, from when
 * it was an installable CLI; once the engine went native that soft default only ever
 * misrouted. Which agent the assistant panel runs is a different setting entirely
 * (`helpPanelStore.preferredAgentId`), and `help.launchAgent` reads that one.
 */
export function getDefaultAgentId(
  defaultAgent: string | undefined,
  defaultSelection: string | undefined,
  availability: CliAvailability,
  selectedAgents?: Set<string>
): BuiltInAgentId | null {
  const isUsable = (id: string) =>
    !isAssistantOnlyAgentId(id) &&
    isAgentLaunchable(availability[id as keyof CliAvailability]) &&
    (!selectedAgents || selectedAgents.has(id));

  if (
    defaultAgent &&
    (BUILT_IN_AGENT_IDS as readonly string[]).includes(defaultAgent) &&
    isUsable(defaultAgent)
  ) {
    return defaultAgent as BuiltInAgentId;
  }

  if (
    defaultSelection &&
    (BUILT_IN_AGENT_IDS as readonly string[]).includes(defaultSelection) &&
    isUsable(defaultSelection)
  ) {
    return defaultSelection as BuiltInAgentId;
  }

  for (const agentId of BUILT_IN_AGENT_IDS) {
    if (isUsable(agentId)) {
      return agentId;
    }
  }

  return null;
}
