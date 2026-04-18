export const ANALYTICS_EVENTS = [
  "onboarding_step_viewed",
  "onboarding_step_skipped",
  "onboarding_completed",
  "onboarding_abandoned",
  "activation_first_agent_task_started",
  "activation_first_agent_task_completed",
  "activation_first_parallel_agents",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
