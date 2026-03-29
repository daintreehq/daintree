import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../shared/types/agent.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getEffectiveNotificationSettings: vi.fn(),
  getCurrentProjectId: vi.fn(() => null),
}));

const notificationServiceMock = vi.hoisted(() => ({
  showWatchNotification: vi.fn(),
  showNativeNotification: vi.fn(),
  isWindowFocused: vi.fn(() => false),
}));

const soundServiceMock = vi.hoisted(() => ({
  play: vi.fn(),
  playFile: vi.fn(),
  preview: vi.fn(),
  previewFile: vi.fn(),
  cancel: vi.fn(),
  getVariants: vi.fn(() => []),
  getVariantCount: vi.fn(() => 1),
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../NotificationService.js", () => ({
  notificationService: notificationServiceMock,
}));

vi.mock("../SoundService.js", () => ({
  soundService: soundServiceMock,
}));

import { events } from "../events.js";
import { agentNotificationService } from "../AgentNotificationService.js";

const DEFAULT_NOTIFICATION_SETTINGS = {
  completedEnabled: false,
  waitingEnabled: false,
  soundEnabled: false,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: true,
  waitingEscalationDelayMs: 180_000,
};

const DEFAULT_APP_STATE = {
  activeWorktreeId: "wt-1",
  terminals: [
    {
      id: "term-1",
      kind: "agent",
      agentId: "agent-1",
      title: "Claude Agent",
      location: "dock",
      worktreeId: "wt-1",
    },
  ],
};

function mockStore(
  notifOverrides: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS> = {},
  appStateOverrides: Partial<typeof DEFAULT_APP_STATE> = {}
) {
  const notifSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...notifOverrides };
  const appState = { ...DEFAULT_APP_STATE, ...appStateOverrides };
  storeMock.get.mockImplementation((key: string) => {
    if (key === "notificationSettings") return notifSettings;
    if (key === "appState") return appState;
    return undefined;
  });
  projectStoreMock.getEffectiveNotificationSettings.mockReturnValue(notifSettings);
}

function makePayload(state: AgentState, previousState: AgentState = "working") {
  return {
    state,
    previousState,
    worktreeId: "wt-1",
    terminalId: "term-1",
    agentId: "agent-1",
    timestamp: Date.now(),
    trigger: "heuristic" as const,
    confidence: 1,
  };
}

describe("AgentNotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    agentNotificationService.initialize();
    // Register the test terminal as watched so gate passes by default
    agentNotificationService.syncWatchedPanels(["term-1"]);
  });

  afterEach(() => {
    agentNotificationService.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not fire any notifications when all settings are disabled (default)", () => {
    mockStore();

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    expect(soundServiceMock.playFile).not.toHaveBeenCalled();
  });

  it("does not fire notifications for unwatched terminals", () => {
    mockStore({ completedEnabled: true, waitingEnabled: true });

    // Clear watched set — no terminals are watched
    agentNotificationService.syncWatchedPanels([]);

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(1000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    expect(soundServiceMock.playFile).not.toHaveBeenCalled();
  });

  it("does not fire notifications when terminalId is absent in payload", () => {
    mockStore({ completedEnabled: true, waitingEnabled: true });

    // Payload without terminalId — cannot check watched membership
    const payloadNoId = {
      state: "completed" as const,
      previousState: "working" as const,
      worktreeId: "wt-1",
      agentId: "agent-1",
      timestamp: Date.now(),
      trigger: "heuristic" as const,
      confidence: 1,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events.emit("agent:state-changed", payloadNoId as any);
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("fires a notification when completed is enabled", () => {
    mockStore({ completedEnabled: true });

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent completed",
      expect.stringContaining("finished"),
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });

  it("fires a notification when waiting is enabled", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent waiting",
      expect.stringContaining("waiting for input"),
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });

  it("does not fire notifications for same-state transitions", () => {
    mockStore({
      completedEnabled: true,
      waitingEnabled: true,
      soundEnabled: true,
    });

    events.emit("agent:state-changed", makePayload("completed", "completed"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("plays sound when soundEnabled is true and a notification type is enabled", () => {
    mockStore({ waitingEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(soundServiceMock.playFile).toHaveBeenCalled();
  });

  it("does not play sound when soundEnabled is false", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(soundServiceMock.playFile).not.toHaveBeenCalled();
  });

  it("plays waitingSoundFile for waiting events", () => {
    mockStore({ waitingEnabled: true, soundEnabled: true, waitingSoundFile: "ping.wav" });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(soundServiceMock.playFile).toHaveBeenCalledWith(expect.stringContaining("ping.wav"));
  });

  it("plays completedSoundFile for completion events", () => {
    mockStore({ completedEnabled: true, soundEnabled: true, completedSoundFile: "chime.wav" });

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    expect(soundServiceMock.playFile).toHaveBeenCalledWith(expect.stringContaining("chime.wav"));
  });

  it("plays escalationSoundFile for escalation events", () => {
    mockStore({
      waitingEnabled: true,
      soundEnabled: true,
      escalationSoundFile: "error.wav",
    });

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(180_000);

    // The first call is the waiting sound, the second is escalation
    const escalationCall = soundServiceMock.playFile.mock.calls.find((call: string[]) =>
      call[0].includes("error.wav")
    );
    expect(escalationCall).toBeDefined();
  });

  it("fires only waiting notification when only waitingEnabled is true (mixed sequence)", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    events.emit("agent:state-changed", makePayload("waiting", "completed"));
    vi.advanceTimersByTime(1000);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent waiting",
      expect.stringContaining("waiting for input"),
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });

  it("does not fire stale completion notification after completedEnabled is disabled", () => {
    // Start with completedEnabled=true so the timer is scheduled
    mockStore({ completedEnabled: true });

    events.emit("agent:state-changed", makePayload("completed"));

    // Before debounce fires, disable all notifications
    mockStore();

    // Advance past the 2000ms completion debounce
    vi.advanceTimersByTime(3000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("fires completion notification for watched terminal even after one-shot unwatch", () => {
    mockStore({ completedEnabled: true });

    // Agent state changes — watched status is snapshotted here
    events.emit("agent:state-changed", makePayload("completed"));

    // Simulate one-shot unwatch: renderer removes the terminal from watched set
    // (this happens before the 2s debounce fires)
    agentNotificationService.syncWatchedPanels([]);

    // Advance past the 2000ms debounce — should still fire because isWatched was captured at event time
    vi.advanceTimersByTime(3000);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent completed",
      expect.stringContaining("finished"),
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });

  describe("waiting escalation", () => {
    it("fires native notification after escalation delay for docked waiting agent", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
        "Agent still waiting",
        expect.stringContaining("has been waiting")
      );
    });

    it("does not fire escalation before delay elapses", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(179_999);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("cancels escalation when agent leaves waiting state", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(60_000);

      // Agent goes back to working
      events.emit("agent:state-changed", makePayload("working", "waiting"));
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("cancels escalation on acknowledgeWaiting", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(60_000);

      agentNotificationService.acknowledgeWaiting("term-1");
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("does not fire escalation when waitingEscalationEnabled is false", () => {
      mockStore({ waitingEnabled: true, waitingEscalationEnabled: false });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(300_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("does not fire escalation when waitingEnabled is false", () => {
      mockStore({ waitingEscalationEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(300_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("does not fire escalation for grid (non-dock) terminals", () => {
      mockStore(
        { waitingEnabled: true },
        {
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "Claude Agent",
              location: "grid",
              worktreeId: "wt-1",
            },
          ],
        }
      );

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(300_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("uses terminal title in escalation notification", () => {
      mockStore(
        { waitingEnabled: true },
        {
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "My Custom Agent",
              location: "dock",
              worktreeId: "wt-1",
            },
          ],
        }
      );

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
        "Agent still waiting",
        "My Custom Agent has been waiting for input"
      );
    });

    it("fires only once per waiting session", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(1);

      // Additional time passes — no second notification
      vi.advanceTimersByTime(180_000);
      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(1);
    });

    it("fires fresh escalation on re-entering waiting state", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(180_000);
      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(1);

      // Agent leaves waiting, then re-enters
      events.emit("agent:state-changed", makePayload("working", "waiting"));
      events.emit("agent:state-changed", makePayload("waiting", "working"));
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(2);
    });

    it("does not fire if settings changed to disabled before timer fires", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(60_000);

      // User disables escalation mid-wait
      mockStore({ waitingEnabled: true, waitingEscalationEnabled: false });
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("dispose clears escalation timers", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      agentNotificationService.dispose();
      vi.advanceTimersByTime(300_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("does not fire if terminal moved from dock to grid before timer fires", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(60_000);

      // Terminal moved to grid mid-wait
      mockStore(
        { waitingEnabled: true },
        {
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "Claude Agent",
              location: "grid",
              worktreeId: "wt-1",
            },
          ],
        }
      );
      vi.advanceTimersByTime(180_000);

      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("resets timer from zero on rapid waiting-working-waiting toggle", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(120_000); // 2min into first wait

      // Leave and re-enter waiting
      events.emit("agent:state-changed", makePayload("working", "waiting"));
      events.emit("agent:state-changed", makePayload("waiting", "working"));

      // 120_000ms from re-entry — should NOT fire yet (threshold is 180_000)
      vi.advanceTimersByTime(120_000);
      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();

      // 60_000ms more — now 180_000 from re-entry, should fire
      vi.advanceTimersByTime(60_000);
      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(1);
    });
  });
});
