import type { Migration } from "../StoreMigrations.js";

interface ChecklistLike {
  dismissed?: boolean;
  celebrationShown?: boolean;
  items?: Record<string, unknown>;
  [key: string]: unknown;
}

interface OnboardingLike {
  checklist?: ChecklistLike;
  [key: string]: unknown;
}

export const migration015: Migration = {
  version: 15,
  description:
    "Replace subscribedNewsletter checklist item with ranSecondParallelAgent (issue #5132)",
  up: (store) => {
    const onboardingRaw = store.get("onboarding") as OnboardingLike | undefined;
    if (!onboardingRaw || !onboardingRaw.checklist) {
      return;
    }

    const checklist = onboardingRaw.checklist;
    const items = { ...(checklist.items ?? {}) } as Record<string, unknown>;

    const hadNewsletter = "subscribedNewsletter" in items;
    if (hadNewsletter) {
      delete items.subscribedNewsletter;
    }

    if (typeof items.ranSecondParallelAgent !== "boolean") {
      items.ranSecondParallelAgent = false;
    }

    const nextChecklist = { ...checklist, items };
    store.set("onboarding", { ...onboardingRaw, checklist: nextChecklist } as never);
  },
};
