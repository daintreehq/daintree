import { useMemo } from "react";
import { getAssistantSupportedAgentIds } from "@/config/agents";
// Through the barrel, as the panel reads it: its suites mock `@/store` wholesale
// with the availability they test against.
import { useCliAvailabilityStore } from "@/store";
import { isAgentInstalled } from "@shared/utils/agentAvailability";

/**
 * The agents that can run the Daintree Assistant here: wired for it at the
 * stable tier, and installed. Empty until CLI availability has real data, so
 * nothing offers — or auto-launches — a choice it can't yet stand behind.
 */
export function useAssistantAgentChoices(): string[] {
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);
  const availability = useCliAvailabilityStore((s) => s.availability);
  return useMemo(() => {
    if (!hasRealData) return [];
    return getAssistantSupportedAgentIds().filter((id) => isAgentInstalled(availability[id]));
  }, [hasRealData, availability]);
}
