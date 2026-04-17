export const ANALYTICS_EVENTS = [
  "onboarding_step_viewed",
  "onboarding_step_skipped",
  "onboarding_completed",
  "onboarding_abandoned",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
