import type { Migration } from "../StoreMigrations.js";

export const migration005: Migration = {
  version: 5,
  description: "Add getting-started checklist; dismiss for users who already completed onboarding",
  up: (store) => {
    const onboarding = store.get("onboarding") as
      | {
          completed?: boolean;
          checklist?: { dismissed: boolean; items: Record<string, boolean> };
          [key: string]: unknown;
        }
      | undefined;

    if (!onboarding) {
      console.log("[Migration 005] No onboarding state found, skipping");
      return;
    }

    if (onboarding.checklist) {
      console.log("[Migration 005] Checklist already exists, skipping");
      return;
    }

    const dismissed = onboarding.completed === true;
    const checklist = {
      dismissed,
      items: {
        openedProject: dismissed,
        launchedAgent: dismissed,
        createdWorktree: dismissed,
      },
    };

    console.log(
      `[Migration 005] Adding checklist (dismissed=${dismissed}) for user with completed=${onboarding.completed}`
    );
    store.set("onboarding", { ...onboarding, checklist });
  },
};
