import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isScheduleAssistantAgentId, SCHEDULE_ASSISTANT_NAME } from "@shared/utils/scheduledRuns";

/** A schedule's agent as people know it: an agent's name, or the Daintree Assistant (#16169). */
export function scheduleAgentName(agentId: string): string {
  if (isScheduleAssistantAgentId(agentId)) return SCHEDULE_ASSISTANT_NAME;
  return getEffectiveAgentConfig(agentId)?.name ?? agentId;
}
