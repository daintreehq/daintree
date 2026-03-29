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

const DEFAULT_SETTINGS = {
  enabled: true,
  completedEnabled: false,
  waitingEnabled: false,
  soundEnabled: true,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: false,
  waitingEscalationDelayMs: 180_000,
};

function mockTerminals(terminals: Array<{ id: string; agentState?: string }>) {
  storeMock.get.mockImplementation((key: string) => {
    if (key === "appState") return { activeWorktreeId: "wt-1", terminals };
    return undefined;
  });
}

function emitStateChange(state: AgentState, previousState: AgentState, terminalId = "term-1") {
  events.emit("agent:state-changed", {
    state,
    previousState,
    worktreeId: "wt-1",
    terminalId,
    agentId: `agent-${terminalId}`,
    timestamp: Date.now(),
    trigger: "heuristic" as const,
    confidence: 1,
  });
}

describe("AgentNotificationService – all-clear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    projectStoreMock.getEffectiveNotificationSettings.mockReturnValue(DEFAULT_SETTINGS);
    mockTerminals([]);
    agentNotificationService.initialize();
  });

  afterEach(() => {
    agentNotificationService.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fires all-clear when 2 agents go working then both complete", () => {
    // Two agents start working
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "idle" },
    ]);
    emitStateChange("working", "idle", "term-1");

    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-2");

    // First agent completes — still one active
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("completed", "working", "term-1");

    // Second agent completes — all quiet
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-2");

    // Before debounce: no sound yet
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");

    // After debounce
    vi.advanceTimersByTime(500);
    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
  });

  it("does not fire for single-agent completions", () => {
    mockTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");

    mockTerminals([{ id: "term-1", agentState: "completed" }]);
    emitStateChange("completed", "working", "term-1");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("does not fire on startup when agents are already completed", () => {
    // Terminals already completed, never observed a working transition
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    // Simulate a state-changed event that might come in during startup
    emitStateChange("completed", "completed", "term-1");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("cancels debounce if a new agent starts working during the window", () => {
    // Two agents working
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    // Both complete
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");

    // Before debounce fires, a new agent starts
    vi.advanceTimersByTime(200);
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
      { id: "term-3", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-3");

    // After original debounce time passes
    vi.advanceTimersByTime(400);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("does not play sound when soundEnabled is false", () => {
    projectStoreMock.getEffectiveNotificationSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      soundEnabled: false,
    });

    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("resets after firing so next multi-agent session can fire again", () => {
    // First session: 2 agents work and complete
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");
    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");

    soundServiceMock.play.mockClear();

    // Second session: 2 agents work and complete again
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "completed", "term-1");
    emitStateChange("working", "completed", "term-2");

    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");
    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
  });

  it("dispose cancels pending all-clear timer", () => {
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");

    // Dispose before debounce fires
    agentNotificationService.dispose();

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("re-checks active count after debounce to prevent false fires", () => {
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    // Both complete
    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");

    // Simulate: by the time debounce fires, a terminal went back to working
    // (but without emitting a state-changed event through our handler)
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "completed" },
    ]);

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });
});
