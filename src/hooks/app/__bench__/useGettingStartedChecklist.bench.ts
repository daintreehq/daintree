// @vitest-environment jsdom
import { bench, describe, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { activityWrites, focusWrites, measureCalls, seedPanels } from "./panelSubscriberFixture";

vi.mock("@/store/panelStore", async () => ({
  usePanelStore: (await import("./panelSubscriberFixture")).benchPanelStore,
}));
vi.mock("@shared/types/panel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/types/panel")>()),
  isPtyPanel: (await import("./panelSubscriberFixture")).countingIsPtyPanel,
}));
vi.mock("../../useElectron", () => ({ isElectronAvailable: () => true }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(() => null, {
    getState: () => ({ currentProject: null }),
    subscribe: () => () => {},
  }),
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: new Map() }),
    subscribe: () => () => {},
  }),
}));
vi.mock("@/clients/onboardingClient", () => ({
  getOnboardingState: () => Promise.resolve({ completed: true }),
}));
vi.mock("../useAgentDiscoveryOnboarding", () => ({
  useAgentDiscoveryOnboarding: () => ({ setupBannerDismissed: true }),
}));

import { useGettingStartedChecklist } from "../useGettingStartedChecklist";

Object.assign(window, {
  electron: {
    onboarding: {
      getChecklist: () =>
        Promise.resolve({
          items: {
            openedProject: true,
            launchedAgent: false,
            createdWorktree: false,
            ranSecondParallelAgent: false,
          },
          dismissed: false,
          celebrationShown: false,
        }),
      markChecklistItem: () => Promise.resolve(),
      dismissChecklist: () => Promise.resolve(),
    },
  },
});

seedPanels(false);
renderHook(() => useGettingStartedChecklist(true));
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

process.stderr.write(
  `[checklist] isPtyPanel calls — 1000 activity writes: ${measureCalls(activityWrites)}, 1000 focus writes: ${measureCalls(focusWrites)}\n`
);

describe("useGettingStartedChecklist subscriber (50 shell panels, agent items incomplete)", () => {
  bench("1000 updateActivity writes", activityWrites);
  bench("1000 focus-only writes", focusWrites);
});
