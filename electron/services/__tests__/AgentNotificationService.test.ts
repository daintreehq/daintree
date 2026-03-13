import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../shared/types/domain.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const notificationServiceMock = vi.hoisted(() => ({
  showWatchNotification: vi.fn(),
  showNativeNotification: vi.fn(),
  isWindowFocused: vi.fn(() => false),
}));

const playSoundMock = vi.hoisted(() => vi.fn(() => ({ cancel: vi.fn() })));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../NotificationService.js", () => ({
  notificationService: notificationServiceMock,
}));

vi.mock("../../utils/soundPlayer.js", () => ({
  playSound: playSoundMock,
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

import { events } from "../events.js";
import { agentNotificationService } from "../AgentNotificationService.js";

const DEFAULT_NOTIFICATION_SETTINGS = {
  completedEnabled: false,
  waitingEnabled: false,
  failedEnabled: false,
  soundEnabled: false,
  soundFile: "chime.wav",
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

    events.emit("agent:state-changed", makePayload("failed"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("does not fire notifications for unwatched terminals", () => {
    mockStore({ completedEnabled: true, waitingEnabled: true, failedEnabled: true });

    // Clear watched set — no terminals are watched
    agentNotificationService.syncWatchedPanels([]);

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(1000);

    events.emit("agent:state-changed", makePayload("failed"));
    vi.advanceTimersByTime(1000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("does not fire notifications when terminalId is absent in payload", () => {
    mockStore({ completedEnabled: true, waitingEnabled: true, failedEnabled: true });

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

  it("fires a notification when failed is enabled", () => {
    mockStore({ failedEnabled: true });

    events.emit("agent:state-changed", makePayload("failed"));
    vi.advanceTimersByTime(1000);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent failed",
      expect.stringContaining("error"),
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });

  it("does not fire notifications for same-state transitions", () => {
    mockStore({
      completedEnabled: true,
      waitingEnabled: true,
      failedEnabled: true,
      soundEnabled: true,
    });

    events.emit("agent:state-changed", makePayload("completed", "completed"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("plays sound when soundEnabled is true and a notification type is enabled", () => {
    mockStore({ waitingEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(playSoundMock).toHaveBeenCalled();
  });

  it("does not play sound when soundEnabled is false", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("fires only waiting notification when only waitingEnabled is true (mixed sequence)", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("completed"));
    vi.advanceTimersByTime(5000);

    events.emit("agent:state-changed", makePayload("waiting", "completed"));
    vi.advanceTimersByTime(1000);

    events.emit("agent:state-changed", makePayload("failed", "waiting"));
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
  });
});
