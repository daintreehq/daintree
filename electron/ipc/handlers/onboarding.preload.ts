import type { IpcInvokeMap } from "../../types/index.js";

export const ONBOARDING_METHOD_CHANNELS = {
  get: "onboarding:get",
  setStep: "onboarding:set-step",
  complete: "onboarding:complete",
  markToastSeen: "onboarding:mark-toast-seen",
  markNewsletterSeen: "onboarding:mark-newsletter-seen",
  markWaitingNudgeSeen: "onboarding:mark-waiting-nudge-seen",
  markAgentsSeen: "onboarding:mark-agents-seen",
  recordAgentFirstSeen: "onboarding:record-agent-first-seen",
  dismissWelcomeCard: "onboarding:dismiss-welcome-card",
  dismissSetupBanner: "onboarding:dismiss-setup-banner",
  getChecklist: "onboarding:checklist-get",
  dismissChecklist: "onboarding:checklist-dismiss",
  markChecklistItem: "onboarding:checklist-mark-item",
  markChecklistCelebrationShown: "onboarding:checklist-mark-celebration-shown",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ONBOARDING_METHOD_CHANNELS;

export type OnboardingPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildOnboardingPreloadBindings(invoke: Invoker): OnboardingPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ONBOARDING_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ONBOARDING_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as OnboardingPreloadBindings;
}
