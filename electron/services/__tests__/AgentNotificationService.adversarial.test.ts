import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";

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
  playPulse: vi.fn(),
  cancelPulse: vi.fn(),
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

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  completedEnabled: false,
  waitingEnabled: false,
  soundEnabled: false,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: true,
  waitingEscalationDelayMs: 180_000,
  workingPulseEnabled: false,
  workingPulseSoundFile: "pulse.wav",
  uiFeedbackSoundEnabled: false,
};

const DEFAULT_APP_STATE = {
  activeWorktreeId: "wt-1",
  terminals: [
    {
      id: "term-1",
      kind: "agent",
      agentId: "agent-1",
      title: "Claude Agent",
      location: "dock" as const,
      worktreeId: "wt-1",
    },
  ],
};

interface PendingNotificationInternal {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
  soundFile?: string;
}

interface AgentNotificationServiceInternal {
  completionBurstBuffer: PendingNotificationInternal[];
  completionBurstSoundFile?: string;
  completionBurstTimer: ReturnType<typeof setTimeout> | null;
  drainQueue: () => void;
  notificationQueue: PendingNotificationInternal[];
  staggerTimer: ReturnType<typeof setTimeout> | null;
}

function mockStore(
  notifOverrides: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS> = {},
  appStateOverrides: Partial<typeof DEFAULT_APP_STATE> = {}
): void {
  const notifSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...notifOverrides };
  const appState = { ...DEFAULT_APP_STATE, ...appStateOverrides };
  storeMock.get.mockImplementation((key: string) => {
    if (key === "notificationSettings") return notifSettings;
    if (key === "appState") return appState;
    return undefined;
  });
  projectStoreMock.getEffectiveNotificationSettings.mockReturnValue(notifSettings);
}

function makePayload(
  state: AgentState,
  previousState: AgentState,
  overrides: Partial<{
    worktreeId: string;
    terminalId: string;
    agentId: string;
    waitingReason: WaitingReason;
  }> = {}
) {
  const payload: {
    state: AgentState;
    previousState: AgentState;
    worktreeId: string;
    terminalId: string;
    agentId: string;
    timestamp: number;
    trigger: "heuristic";
    confidence: number;
    waitingReason?: WaitingReason;
  } = {
    state,
    previousState,
    worktreeId: overrides.worktreeId ?? "wt-1",
    terminalId: overrides.terminalId ?? "term-1",
    agentId: overrides.agentId ?? "agent-1",
    timestamp: Date.now(),
    trigger: "heuristic" as const,
    confidence: 1,
  };
  if (overrides.waitingReason !== undefined) {
    payload.waitingReason = overrides.waitingReason;
  }
  return payload;
}

describe("AgentNotificationService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.clearAllMocks();
    mockStore();
    agentNotificationService.initialize();
    agentNotificationService.syncWatchedPanels(["term-1"]);
  });

  afterEach(() => {
    agentNotificationService.dispose();
    vi.useRealTimers();
  });

  it("SAME_TARGET_WAITING_BURST_DEDUPES", () => {
    mockStore({ waitingEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting", "working"));
    events.emit("agent:state-changed", makePayload("waiting", "working"));
    vi.advanceTimersByTime(200);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent waiting",
      "agent-1 is waiting for input",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
  });

  it("SAME_TARGET_COMPLETION_DEBOUNCE_FIRES_ONCE", () => {
    mockStore({ completedEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("completed", "working"));
    vi.advanceTimersByTime(1000);
    events.emit("agent:state-changed", makePayload("completed", "running"));
    vi.advanceTimersByTime(2001);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent completed",
      "agent-1 finished its task",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
  });

  it("DISPOSE_DURING_STAGGERED_QUEUE_DROPS_PENDING", () => {
    const internal = agentNotificationService as unknown as AgentNotificationServiceInternal;
    internal.notificationQueue.push(
      {
        title: "Agent completed",
        body: "agent-1 finished its task",
        terminalId: "term-1",
        agentId: "agent-1",
        worktreeId: "wt-1",
        triggerSound: true,
        soundFile: "complete.wav",
      },
      {
        title: "Agent completed",
        body: "agent-2 finished its task",
        terminalId: "term-2",
        agentId: "agent-2",
        worktreeId: "wt-2",
        triggerSound: true,
        soundFile: "complete.wav",
      }
    );

    internal.drainQueue();
    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
    expect(internal.staggerTimer).not.toBeNull();

    agentNotificationService.dispose();
    vi.advanceTimersByTime(500);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
  });

  it("DISPOSE_BEFORE_ZERO_MS_COMPLETION_FLUSH", () => {
    mockStore({ completedEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("completed", "working"));
    vi.advanceTimersByTime(2000);
    agentNotificationService.dispose();
    vi.advanceTimersByTime(1);

    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    expect(soundServiceMock.playFile).not.toHaveBeenCalled();
  });

  it("WAITING_AND_COMPLETION_SAME_TARGET_KEEP_ORDER", () => {
    mockStore({ waitingEnabled: true, completedEnabled: true, soundEnabled: false });

    events.emit("agent:state-changed", makePayload("waiting", "working"));
    vi.advanceTimersByTime(200);

    events.emit("agent:state-changed", makePayload("completed", "waiting"));
    vi.advanceTimersByTime(2001);

    expect(notificationServiceMock.showWatchNotification.mock.calls.map((call) => call[0])).toEqual(
      ["Agent waiting", "Agent completed"]
    );
    expect(notificationServiceMock.showWatchNotification).toHaveBeenNthCalledWith(
      1,
      "Agent waiting",
      "agent-1 is waiting for input",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
    expect(notificationServiceMock.showWatchNotification).toHaveBeenNthCalledWith(
      2,
      "Agent completed",
      "agent-1 finished its task",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      true
    );
  });
});
