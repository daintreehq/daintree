import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDeep = (key: string): any => {
    if (!key.includes(".")) return data[key];
    const parts = key.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = data;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };
  const setDeep = (key: string, value: unknown): void => {
    if (!key.includes(".")) {
      data[key] = value;
      return;
    }
    const parts = key.split(".");
    const last = parts.pop()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = data;
    for (const p of parts) {
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[last] = value;
  };
  return {
    get: vi.fn(getDeep),
    set: vi.fn(setDeep),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

const setOnboardingCompleteTagMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/TelemetryService.js", () => ({
  setOnboardingCompleteTag: setOnboardingCompleteTagMock,
}));

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
    checklist: {
      dismissed: false,
      celebrationShown: false,
      items: {
        openedProject: false,
        launchedAgent: false,
        createdWorktree: false,
        ranSecondParallelAgent: false,
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
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: {
          openedProject: false,
          launchedAgent: false,
          createdWorktree: false,
          ranSecondParallelAgent: false,
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
      "onboarding.seenAgentIds",
      expect.arrayContaining(["claude", "codex", "gemini"])
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
    expect(storeMock.set).toHaveBeenCalledWith("onboarding.welcomeCardDismissed", true);
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

  it("dismissSetupBanner flips the flag and returns the updated state", () => {
    registerOnboardingHandlers();
    seedOnboarding({ setupBannerDismissed: false });
    const dismiss = getHandler("onboarding:dismiss-setup-banner");
    const result = dismiss(null) as { setupBannerDismissed: boolean };
    expect(result.setupBannerDismissed).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("onboarding.setupBannerDismissed", true);
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

  it("complete handler stamps the onboarding_complete Sentry tag with true", () => {
    registerOnboardingHandlers();
    seedOnboarding();
    const complete = getHandler("onboarding:complete");
    setOnboardingCompleteTagMock.mockClear();
    complete(null);
    expect(setOnboardingCompleteTagMock).toHaveBeenCalledWith(true);
  });
});
