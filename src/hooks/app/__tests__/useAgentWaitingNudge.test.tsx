// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const onboardingMock = {
  get: vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1,
      completed: true,
      currentStep: null as string | null,
      agentSetupIds: [] as string[],
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [] as string[],
      welcomeCardDismissed: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    })
  ),
  markWaitingNudgeSeen: vi.fn(() => Promise.resolve()),
};

const notificationMock = {
  getSettings: vi.fn(() =>
    Promise.resolve({
      enabled: true,
      waitingEnabled: false,
      completedEnabled: false,
      soundEnabled: false,
      waitingEscalationEnabled: false,
      waitingEscalationMinutes: 5,
    })
  ),
  setSettings: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    onboarding: onboardingMock,
    notification: notificationMock,
  },
});

type Terminal = { id: string; agentState?: string };
let storeSubscribers: Array<
  (state: { panelsById: Record<string, Terminal>; panelIds: string[] }) => void
> = [];
let storeState: { panelsById: Record<string, Terminal>; panelIds: string[] } = {
  panelsById: {},
  panelIds: [],
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => storeState,
    subscribe: (
      fn: (state: { panelsById: Record<string, Terminal>; panelIds: string[] }) => void
    ) => {
      storeSubscribers.push(fn);
      return () => {
        storeSubscribers = storeSubscribers.filter((s) => s !== fn);
      };
    },
  },
}));

const removeNotificationMock = vi.fn();
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: Object.assign(
    (selector: (s: { removeNotification: typeof removeNotificationMock }) => unknown) =>
      selector({ removeNotification: removeNotificationMock }),
    {
      getState: () => ({ removeNotification: removeNotificationMock }),
      subscribe: () => () => {},
    }
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notifyMock = vi.fn<(payload: any) => string>(() => "notif-123");
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

import { useAgentWaitingNudge } from "../useAgentWaitingNudge";

function emitStoreUpdate(terminals: Terminal[]) {
  storeState = {
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  };
  storeSubscribers.forEach((fn) => fn(storeState));
}

describe("useAgentWaitingNudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeSubscribers = [];
    storeState = { panelsById: {}, panelIds: [] };
    notifyMock.mockReturnValue("notif-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fire when waitingNudgeSeen is true", async () => {
    onboardingMock.get.mockResolvedValueOnce({
      schemaVersion: 1,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: true,
      seenAgentIds: [],
      welcomeCardDismissed: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not fire when onboarding is not completed", async () => {
    onboardingMock.get.mockResolvedValueOnce({
      schemaVersion: 1,
      completed: false,
      currentStep: "themeSelection",
      agentSetupIds: [],
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
      welcomeCardDismissed: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not fire when waitingEnabled is already true", async () => {
    notificationMock.getSettings.mockResolvedValueOnce({
      enabled: true,
      waitingEnabled: true,
      completedEnabled: false,
      soundEnabled: false,
      waitingEscalationEnabled: false,
      waitingEscalationMinutes: 5,
    });

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires on first agent waiting transition when eligible", async () => {
    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    expect(onboardingMock.markWaitingNudgeSeen).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    const payload = notifyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.placement).toBe("grid-bar");
    expect(payload.duration).toBe(0);
    expect(payload.type).toBe("info");
  });

  it("does not fire a second time for another agent", async () => {
    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });
    act(() => {
      emitStoreUpdate([
        { id: "t1", agentState: "waiting" },
        { id: "t2", agentState: "waiting" },
      ]);
    });

    expect(notifyMock).toHaveBeenCalledOnce();
  });

  it("fires immediately if agent is already waiting at mount", async () => {
    storeState = {
      panelsById: { t1: { id: "t1", agentState: "waiting" } },
      panelIds: ["t1"],
    };

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    expect(notifyMock).toHaveBeenCalledOnce();
    expect(onboardingMock.markWaitingNudgeSeen).toHaveBeenCalledOnce();
  });

  it("Enable action calls setSettings and removes notification", async () => {
    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    const payload = notifyMock.mock.calls[0]![0] as {
      actions: Array<{ label: string; onClick: () => void }>;
    };
    const enableAction = payload.actions.find((a) => a.label === "Enable Notifications")!;

    act(() => {
      enableAction.onClick();
    });

    expect(notificationMock.setSettings).toHaveBeenCalledWith({ waitingEnabled: true });
    expect(removeNotificationMock).toHaveBeenCalledWith("notif-123");
  });

  it("No Thanks action removes notification without enabling", async () => {
    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    const payload = notifyMock.mock.calls[0]![0] as {
      actions: Array<{ label: string; onClick: () => void }>;
    };
    const noThanks = payload.actions.find((a) => a.label === "No Thanks")!;

    act(() => {
      noThanks.onClick();
    });

    expect(notificationMock.setSettings).not.toHaveBeenCalled();
    expect(removeNotificationMock).toHaveBeenCalledWith("notif-123");
  });

  it("cleans up notification on unmount", async () => {
    const { unmount } = renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    unmount();
    expect(removeNotificationMock).toHaveBeenCalledWith("notif-123");
  });

  it("does not fire when isStateLoaded is false", async () => {
    renderHook(() => useAgentWaitingNudge(false));
    await act(async () => {});

    expect(onboardingMock.get).not.toHaveBeenCalled();
  });

  it("handles hydrate failure gracefully", async () => {
    onboardingMock.get.mockRejectedValueOnce(new Error("IPC failed"));

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not call removeNotification with null when notify returns empty", async () => {
    notifyMock.mockReturnValue("");

    const { unmount } = renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([{ id: "t1", agentState: "waiting" }]);
    });

    removeNotificationMock.mockClear();
    unmount();
    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("fires only once when two agents transition to waiting in same update", async () => {
    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    act(() => {
      emitStoreUpdate([
        { id: "t1", agentState: "waiting" },
        { id: "t2", agentState: "waiting" },
      ]);
    });

    expect(notifyMock).toHaveBeenCalledOnce();
    expect(onboardingMock.markWaitingNudgeSeen).toHaveBeenCalledOnce();
  });

  it("does not double-fire when agent already waiting at mount then another transitions", async () => {
    storeState = {
      panelsById: { t1: { id: "t1", agentState: "waiting" } },
      panelIds: ["t1"],
    };

    renderHook(() => useAgentWaitingNudge(true));
    await act(async () => {});

    expect(notifyMock).toHaveBeenCalledOnce();

    act(() => {
      emitStoreUpdate([
        { id: "t1", agentState: "waiting" },
        { id: "t2", agentState: "waiting" },
      ]);
    });

    expect(notifyMock).toHaveBeenCalledOnce();
  });
});
