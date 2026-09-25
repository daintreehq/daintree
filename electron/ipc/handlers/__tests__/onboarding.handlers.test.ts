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

  describe("tour", () => {
    const PLUGIN_TOUR = "acme.tools.welcome";
    const OTHER_PLUGIN_TOUR = "other.plugin.welcome";

    type TourView = { tours: Record<string, Record<string, unknown>>; tourMuted: boolean };
    const read = () => getHandler("onboarding:get")(null) as TourView;

    it("has no tour progress for stores written before tours existed", () => {
      registerOnboardingHandlers();
      seedOnboarding();
      expect(read()).toMatchObject({ tours: {}, tourMuted: false });
    });

    it("drops malformed persisted tour fields", () => {
      registerOnboardingHandlers();
      seedOnboarding({
        tours: {
          daintree: { completed: "yes", dismissed: "no", muted: true, lastChapter: 2.7 },
          [PLUGIN_TOUR]: "garbage",
        },
        tourMuted: "yes",
      });
      const state = read();
      expect(state.tours).toEqual({
        daintree: { completed: false, dismissed: false, lastChapter: 2 },
        [PLUGIN_TOUR]: { completed: false, dismissed: false, lastChapter: 0 },
      });
      expect(state.tourMuted).toBe(false);
    });

    it("never exposes the legacy single-tour record", () => {
      registerOnboardingHandlers();
      seedOnboarding({ tour: { completed: true, dismissed: true, muted: true, lastChapter: 3 } });
      expect("tour" in read()).toBe(false);
    });

    it("remembers a dismissed invitation for that tour only", () => {
      registerOnboardingHandlers();
      seedOnboarding();
      getHandler("onboarding:tour-dismiss-invite")(null, PLUGIN_TOUR);
      const { tours } = read();
      expect(tours[PLUGIN_TOUR]).toMatchObject({ dismissed: true });
      expect(tours.daintree).toBeUndefined();
    });

    it("keeps completion sticky while recording the last chapter", () => {
      registerOnboardingHandlers();
      seedOnboarding();
      const progress = getHandler("onboarding:tour-set-progress");
      progress(null, "daintree", { completed: true, lastChapter: 5 });
      const after = progress(null, "daintree", { completed: false, lastChapter: 1 });
      expect(after).toEqual({ completed: true, dismissed: false, lastChapter: 1 });
    });

    it("keeps each tour's progress separate, including dotted plugin ids", () => {
      registerOnboardingHandlers();
      seedOnboarding();
      const progress = getHandler("onboarding:tour-set-progress");
      progress(null, "daintree", { lastChapter: 2 });
      progress(null, PLUGIN_TOUR, { completed: true, lastChapter: 4 });
      progress(null, OTHER_PLUGIN_TOUR, { lastChapter: 1 });
      expect(read().tours).toEqual({
        daintree: { completed: false, dismissed: false, lastChapter: 2 },
        [PLUGIN_TOUR]: { completed: true, dismissed: false, lastChapter: 4 },
        [OTHER_PLUGIN_TOUR]: { completed: false, dismissed: false, lastChapter: 1 },
      });
      // Written as one flat map, not split into nested objects at the dots.
      const persisted = (storeMock._data["onboarding"] as { tours: Record<string, unknown> }).tours;
      expect(Object.keys(persisted).sort()).toEqual(
        ["daintree", OTHER_PLUGIN_TOUR, PLUGIN_TOUR].sort()
      );
    });

    it("ignores writes without a usable tour id", () => {
      registerOnboardingHandlers();
      seedOnboarding();
      getHandler("onboarding:tour-set-progress")(null, "", { completed: true });
      getHandler("onboarding:tour-set-progress")(null, { completed: true });
      getHandler("onboarding:tour-dismiss-invite")(null);
      expect(read().tours).toEqual({});
    });

    it("keeps one mute preference across every tour", () => {
      registerOnboardingHandlers();
      seedOnboarding({
        tours: { daintree: { completed: false, dismissed: false, lastChapter: 1 } },
      });
      expect(getHandler("onboarding:tour-set-muted")(null, true)).toBe(true);
      const state = read();
      expect(state.tourMuted).toBe(true);
      expect(state.tours.daintree).toEqual({ completed: false, dismissed: false, lastChapter: 1 });
    });
  });
});
