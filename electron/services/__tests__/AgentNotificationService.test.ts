import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../shared/types/domain.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const notificationServiceMock = vi.hoisted(() => ({
  showWatchNotification: vi.fn(),
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
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: true,
      failedEnabled: true,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: true,
      failedEnabled: true,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: true,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: false,
      failedEnabled: true,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: true,
      failedEnabled: true,
      soundEnabled: true,
      soundFile: "chime.wav",
    });

    events.emit("agent:state-changed", makePayload("completed", "completed"));
    vi.advanceTimersByTime(5000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("plays sound when soundEnabled is true and a notification type is enabled", () => {
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: true,
      failedEnabled: false,
      soundEnabled: true,
      soundFile: "chime.wav",
    });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(playSoundMock).toHaveBeenCalled();
  });

  it("does not play sound when soundEnabled is false", () => {
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: true,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

    events.emit("agent:state-changed", makePayload("waiting"));

    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("fires only waiting notification when only waitingEnabled is true (mixed sequence)", () => {
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: true,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

    events.emit("agent:state-changed", makePayload("completed"));

    // Before debounce fires, disable all notifications
    storeMock.get.mockReturnValue({
      completedEnabled: false,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

    // Advance past the 2000ms completion debounce
    vi.advanceTimersByTime(3000);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("fires completion notification for watched terminal even after one-shot unwatch", () => {
    storeMock.get.mockReturnValue({
      completedEnabled: true,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
    });

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
});
