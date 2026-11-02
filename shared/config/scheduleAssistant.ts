/**
 * A schedule's agent can be the project's Daintree Assistant (#16169) instead
 * of a worker agent. It's stored in `launch.agentId` under this id, kept apart
 * from agent ids by its colon as the global Assistant's id is. The Assistant's
 * own CLI is the one its settings pick at launch, recorded on each run as
 * `resume.agentId`.
 */
export const SCHEDULE_ASSISTANT_AGENT_ID = "daintree:assistant";

export const SCHEDULE_ASSISTANT_NAME = "Daintree Assistant";

export function isScheduleAssistantAgentId(agentId: string | null | undefined): boolean {
  return agentId === SCHEDULE_ASSISTANT_AGENT_ID;
}
