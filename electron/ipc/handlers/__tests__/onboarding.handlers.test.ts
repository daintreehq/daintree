import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { registerOnboardingHandlers } from "../onboarding.js";

function getHandler(channel: string) {
  return ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
    _e: unknown,
    ...args: unknown[]
  ) => unknown;
}

function seedOnboarding(partial: Record<string, unknown> = {}) {
  storeMock._data["onboarding"] = {
    schemaVersion: 1,
    completed: false,
    currentStep: null,
    agentSetupIds: [],
    firstRunToastSeen: false,
    newsletterPromptSeen: false,
    waitingNudgeSeen: false,
    seenAgentIds: [],
    welcomeCardDismissed: false,
    setupBannerDismissed: false,
    migratedFromLocalStorage: false,
    checklist: {
      dismissed: false,
      celebrationShown: false,
      items: {
        openedProject: false,
        launchedAgent: false,
        createdWorktree: false,
        subscribedNewsletter: false,
      },
    },
    ...partial,
  };
}

describe("registerOnboardingHandlers — discovery IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
  });

  it("get normalizes missing seenAgentIds, welcomeCardDismissed, and setupBannerDismissed to defaults", () => {
    registerOnboardingHandlers();
    // Raw store intentionally missing the new fields (pre-existing state).
    storeMock._data["onboarding"] = {
      schemaVersion: 1,
      completed: false,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      migratedFromLocalStorage: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: {
          openedProject: false,
          launchedAgent: false,
          createdWorktree: false,
          subscribedNewsletter: false,
        },
      },
    };
    const get = getHandler("onboarding:get");
    const state = get(null) as {
      seenAgentIds: string[];
      welcomeCardDismissed: boolean;
      setupBannerDismissed: boolean;
    };
    expect(state.seenAgentIds).toEqual([]);
    expect(state.welcomeCardDismissed).toBe(false);
    expect(state.setupBannerDismissed).toBe(false);
  });

  it("get filters out non-string values from seenAgentIds", () => {
    registerOnboardingHandlers();
    seedOnboarding({ seenAgentIds: ["claude", 42, null, "codex"] });
    const get = getHandler("onboarding:get");
    const state = get(null) as { seenAgentIds: string[] };
    expect(state.seenAgentIds).toEqual(["claude", "codex"]);
  });

  it("markAgentsSeen adds new ids, dedupes against existing seen set", () => {
    registerOnboardingHandlers();
    seedOnboarding({ seenAgentIds: ["claude"] });
    const mark = getHandler("onboarding:mark-agents-seen");
    const result = mark(null, ["codex", "claude", "gemini"]) as {
      seenAgentIds: string[];
    };
    expect(result.seenAgentIds.sort()).toEqual(["claude", "codex", "gemini"]);
    expect(storeMock.set).toHaveBeenCalledWith(
      "onboarding",
      expect.objectContaining({
        seenAgentIds: expect.arrayContaining(["claude", "codex", "gemini"]),
      })
    );
  });

  it("markAgentsSeen is idempotent and skips the persist when already seen", () => {
    registerOnboardingHandlers();
    seedOnboarding({ seenAgentIds: ["claude"] });
    const mark = getHandler("onboarding:mark-agents-seen");
    storeMock.set.mockClear();
    const result = mark(null, ["claude"]) as { seenAgentIds: string[] };
    expect(result.seenAgentIds).toEqual(["claude"]);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("markAgentsSeen with empty payload does not write to the store", () => {
    registerOnboardingHandlers();
    seedOnboarding({ seenAgentIds: [] });
    const mark = getHandler("onboarding:mark-agents-seen");
    storeMock.set.mockClear();
    mark(null, []);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("markAgentsSeen ignores non-array payloads and non-string ids", () => {
    registerOnboardingHandlers();
    seedOnboarding({ seenAgentIds: [] });
    const mark = getHandler("onboarding:mark-agents-seen");

    const resultA = mark(null, "not-an-array") as { seenAgentIds: string[] };
    expect(resultA.seenAgentIds).toEqual([]);

    const resultB = mark(null, [42, null, "claude"]) as { seenAgentIds: string[] };
    expect(resultB.seenAgentIds).toEqual(["claude"]);
  });

  it("dismissWelcomeCard flips the flag and returns the updated state", () => {
    registerOnboardingHandlers();
    seedOnboarding({ welcomeCardDismissed: false });
    const dismiss = getHandler("onboarding:dismiss-welcome-card");
    const result = dismiss(null) as { welcomeCardDismissed: boolean };
    expect(result.welcomeCardDismissed).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith(
      "onboarding",
      expect.objectContaining({ welcomeCardDismissed: true })
    );
  });

  it("dismissWelcomeCard is idempotent once dismissed", () => {
    registerOnboardingHandlers();
    seedOnboarding({ welcomeCardDismissed: true });
    const dismiss = getHandler("onboarding:dismiss-welcome-card");
    const result = dismiss(null) as { welcomeCardDismissed: boolean };
    expect(result.welcomeCardDismissed).toBe(true);
  });

  it("get treats completed onboarding as implicit setupBannerDismissed (upgrade path)", () => {
    registerOnboardingHandlers();
    // Pre-#5131 completed state: no setupBannerDismissed field, completed=true.
    seedOnboarding({ completed: true });
    delete (storeMock._data["onboarding"] as Record<string, unknown>).setupBannerDismissed;
    const get = getHandler("onboarding:get");
    const state = get(null) as { completed: boolean; setupBannerDismissed: boolean };
    expect(state.completed).toBe(true);
    expect(state.setupBannerDismissed).toBe(true);
  });

  it("get keeps setupBannerDismissed false when onboarding is incomplete", () => {
    registerOnboardingHandlers();
    seedOnboarding({ completed: false });
    delete (storeMock._data["onboarding"] as Record<string, unknown>).setupBannerDismissed;
    const get = getHandler("onboarding:get");
    const state = get(null) as { completed: boolean; setupBannerDismissed: boolean };
    expect(state.completed).toBe(false);
    expect(state.setupBannerDismissed).toBe(false);
  });

  it("migrate sets setupBannerDismissed: true when all legacy keys are complete", () => {
    storeMock._data["privacy"] = { hasSeenPrompt: true };
    registerOnboardingHandlers();
    seedOnboarding({ migratedFromLocalStorage: false });
    const migrate = getHandler("onboarding:migrate");
    const result = migrate(null, {
      agentSelectionDismissed: true,
      agentSetupComplete: true,
      firstRunToastSeen: true,
    }) as { completed: boolean; setupBannerDismissed: boolean };
    expect(result.completed).toBe(true);
    expect(result.setupBannerDismissed).toBe(true);
  });

  it("migrate leaves setupBannerDismissed false when legacy state is partial", () => {
    storeMock._data["privacy"] = { hasSeenPrompt: false };
    registerOnboardingHandlers();
    seedOnboarding({ migratedFromLocalStorage: false });
    const migrate = getHandler("onboarding:migrate");
    const result = migrate(null, {
      agentSelectionDismissed: true,
      agentSetupComplete: false,
      firstRunToastSeen: true,
    }) as { completed: boolean; setupBannerDismissed: boolean };
    expect(result.completed).toBe(false);
    expect(result.setupBannerDismissed).toBe(false);
  });

  it("dismissSetupBanner flips the flag and returns the updated state", () => {
    registerOnboardingHandlers();
    seedOnboarding({ setupBannerDismissed: false });
    const dismiss = getHandler("onboarding:dismiss-setup-banner");
    const result = dismiss(null) as { setupBannerDismissed: boolean };
    expect(result.setupBannerDismissed).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith(
      "onboarding",
      expect.objectContaining({ setupBannerDismissed: true })
    );
  });

  it("dismissSetupBanner is idempotent once dismissed", () => {
    registerOnboardingHandlers();
    seedOnboarding({ setupBannerDismissed: true });
    const dismiss = getHandler("onboarding:dismiss-setup-banner");
    const result = dismiss(null) as { setupBannerDismissed: boolean };
    expect(result.setupBannerDismissed).toBe(true);
  });

  it("cleanup removes discovery handlers", () => {
    const cleanup = registerOnboardingHandlers();
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("onboarding:mark-agents-seen");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("onboarding:dismiss-welcome-card");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("onboarding:dismiss-setup-banner");
  });
});
