import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const notificationServiceMock = vi.hoisted(() => ({
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

function makePayload(state: string, previousState = "working") {
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

    expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
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

    expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
      "Agent completed",
      expect.stringContaining("finished")
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

    expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
      "Agent waiting",
      expect.stringContaining("waiting for input")
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

    expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
      "Agent failed",
      expect.stringContaining("error")
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

    expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
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
});
