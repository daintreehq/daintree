import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

/** What subscribed to per-project saves: the service hears every panel layout through here. */
const persistedListeners = vi.hoisted(
  () => new Set<(workspaceId: string, state: { terminals: unknown[] } | null) => void>()
);

const projectStoreMock = vi.hoisted(() => ({
  getEffectiveNotificationSettings: vi.fn(),
  getCurrentProjectId: vi.fn(() => null),
  getProjectState: vi.fn(async () => null),
  onProjectStatePersisted: vi.fn(
    (listener: (workspaceId: string, state: { terminals: unknown[] } | null) => void) => {
      persistedListeners.add(listener);
      return () => {
        persistedListeners.delete(listener);
      };
    }
  ),
}));

const notificationServiceMock = vi.hoisted(() => ({
  showWatchNotification: vi.fn(),
  showNativeNotification: vi.fn(),
  isWindowFocused: vi.fn(() => false),
  getUserPresence: vi.fn<() => "present" | "away" | "unknown">(() => "present"),
  closeNotificationsForPanel: vi.fn(),
  isOwnerViewFocused: vi.fn<(owner: number | undefined) => boolean>(() => false),
}));

const osDndServiceMock = vi.hoisted(() => ({
  getState: vi.fn<() => boolean | undefined>(() => undefined),
}));

const soundServiceMock = vi.hoisted(() => ({
  play: vi.fn(),
  playFile: vi.fn(),
  playPulse: vi.fn(),
  preview: vi.fn(),
  previewFile: vi.fn(),
  cancel: vi.fn(),
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

vi.mock("../OsDndService.js", () => ({
  getOsDndService: () => osDndServiceMock,
}));

import { events } from "../events.js";
import { agentNotificationService } from "../AgentNotificationService.js";
import { setPtyClientRef } from "../../window/serviceRefs.js";

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
  workingPulseEnabled: false,
  workingPulseSoundFile: "pulse.wav",
  uiFeedbackSoundEnabled: false,
  flashEnabled: true,
  quietHoursEnabled: false,
  quietHoursStartMin: 22 * 60,
  quietHoursEndMin: 6 * 60,
  quietHoursWeekdays: [] as number[],
} satisfies NotificationSettings;

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

/** Stand-in for a project view's webContents id — the renderer that owns the watched panels. */
const OWNER = 101;

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
      kind: "terminal",
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

describe("AgentNotificationService – all-clear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    osDndServiceMock.getState.mockReturnValue(undefined);
    projectStoreMock.getEffectiveNotificationSettings.mockReturnValue(DEFAULT_SETTINGS);
    mockTerminals([]);
    setPtyClientRef(null);
    agentNotificationService.initialize();
  });

  afterEach(() => {
    agentNotificationService.dispose();
    setPtyClientRef(null);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  type HostTerminal = { id: string; agentState?: string; isExited?: boolean; projectId?: string };

  /** Restart the service against a PTY host whose terminal list answers when told to. */
  function seedFromPtyHost() {
    let answer!: (terminals: HostTerminal[], degraded?: boolean) => void;
    agentNotificationService.dispose();
    setPtyClientRef({
      getAllTerminalsWithCompletenessAsync: () =>
        new Promise((resolve) => {
          answer = (terminals, degraded = false) => resolve({ terminals, degraded });
        }),
      getTerminalProjectId: () => null,
    } as never);
    agentNotificationService.initialize();
    return (terminals: HostTerminal[], degraded?: boolean) => answer(terminals, degraded);
  }

  it("fires all-clear when 2 agents go working then both complete", () => {
    const emitSpy = vi.spyOn(events, "emit");

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
    expect(emitSpy).toHaveBeenCalledWith("agent:all-clear", {
      timestamp: expect.any(Number),
      shouldFlash: true,
    });

    emitSpy.mockRestore();
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

  it("does not play sound when soundEnabled is false, but still flashes (#12185: independent toggles)", () => {
    const emitSpy = vi.spyOn(events, "emit");
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
    expect(emitSpy).toHaveBeenCalledWith("agent:all-clear", {
      timestamp: expect.any(Number),
      shouldFlash: true,
    });
    emitSpy.mockRestore();
  });

  it("does not flash when flashEnabled is false, but still plays the sound (#12185: independent toggles)", () => {
    const emitSpy = vi.spyOn(events, "emit");
    projectStoreMock.getEffectiveNotificationSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      flashEnabled: false,
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
    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    expect(emitSpy).toHaveBeenCalledWith("agent:all-clear", {
      timestamp: expect.any(Number),
      shouldFlash: false,
    });
    emitSpy.mockRestore();
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
    const emitSpy = vi.spyOn(events, "emit");
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
    // Silence alone cannot prove the timer died — a suppressed cue is silent
    // too. The event is unconditional, so its absence is the real proof.
    expect(emitSpy).not.toHaveBeenCalledWith("agent:all-clear", expect.anything());
    emitSpy.mockRestore();
  });

  it("re-checks active count after debounce to prevent false fires", async () => {
    // The startup seed is the one way an agent becomes active without an
    // event: its answer landing inside the debounce must hold the all-clear.
    const answer = seedFromPtyHost();

    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");

    answer([{ id: "term-3", agentState: "working" }]);
    await vi.advanceTimersByTimeAsync(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("ignores a legacy terminal entry still marked active from an old session", () => {
    // `appState.terminals` is a pre-multi-project record nothing live writes:
    // an entry there left `working` must not hold the all-clear back.
    mockTerminals([
      { id: "term-stale", agentState: "working" },
      { id: "term-1", agentState: "idle" },
      { id: "term-2", agentState: "idle" },
    ]);
    agentNotificationService.dispose();
    agentNotificationService.initialize();

    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "working", "term-2");
    vi.advanceTimersByTime(600);

    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
  });

  describe("agents already working at startup", () => {
    function runTwoAgents() {
      emitStateChange("working", "idle", "term-1");
      emitStateChange("working", "idle", "term-2");
      emitStateChange("completed", "working", "term-1");
      emitStateChange("completed", "working", "term-2");
    }

    it("holds the all-clear while an agent the PTY host reports working is still at it", async () => {
      seedFromPtyHost()([{ id: "term-early", agentState: "working" }]);
      await vi.advanceTimersByTimeAsync(0);

      runTwoAgents();
      await vi.advanceTimersByTimeAsync(600);
      expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");

      emitStateChange("completed", "working", "term-early");
      await vi.advanceTimersByTimeAsync(600);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });

    it("lets an event that landed while the seed was in flight outrank its answer", async () => {
      const answer = seedFromPtyHost();
      runTwoAgents();
      // The host's answer is older than both completions, and an exited
      // terminal's last state is not activity.
      answer([
        { id: "term-1", agentState: "working" },
        { id: "term-2", agentState: "working" },
        { id: "term-gone", agentState: "working", isExited: true },
      ]);
      await vi.advanceTimersByTimeAsync(600);

      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });

    it.each([
      ["before", true],
      ["after", false],
    ])(
      "counts a seeded agent toward the peak when it answers %s one new agent starts",
      async (_order, answerFirst) => {
        const answer = seedFromPtyHost();
        const seed = () => answer([{ id: "term-early", agentState: "working" }]);
        if (answerFirst) {
          seed();
          await vi.advanceTimersByTimeAsync(0);
        }
        emitStateChange("working", "idle", "term-1");
        if (!answerFirst) {
          seed();
          await vi.advanceTimersByTimeAsync(0);
        }
        emitStateChange("completed", "working", "term-1");
        emitStateChange("completed", "working", "term-early");
        await vi.advanceTimersByTimeAsync(600);

        expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
        expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
      }
    );

    it("holds an all-clear that comes due while the seed is in flight until it answers", async () => {
      const answer = seedFromPtyHost();
      runTwoAgents();
      await vi.advanceTimersByTimeAsync(600);
      expect(soundServiceMock.play).not.toHaveBeenCalled();

      answer([{ id: "term-idle", agentState: "idle" }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });

    it("drops the held all-clear when the seed finds an agent still working, until it finishes", async () => {
      const answer = seedFromPtyHost();
      runTwoAgents();
      await vi.advanceTimersByTimeAsync(600);
      answer([{ id: "term-early", agentState: "working" }]);
      await vi.advanceTimersByTimeAsync(600);
      expect(soundServiceMock.play).not.toHaveBeenCalled();

      emitStateChange("completed", "working", "term-early");
      await vi.advanceTimersByTimeAsync(600);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });

    it("drops the held all-clear when the host could not fully answer", async () => {
      const answer = seedFromPtyHost();
      runTwoAgents();
      await vi.advanceTimersByTimeAsync(600);
      answer([], true);
      await vi.advanceTimersByTimeAsync(600);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
    });

    it("ignores a seed answer that arrives after the service restarted", async () => {
      const staleAnswer = seedFromPtyHost();
      const answer = seedFromPtyHost();
      staleAnswer([{ id: "term-old", agentState: "working" }]);
      await vi.advanceTimersByTimeAsync(0);

      runTwoAgents();
      answer([]);
      await vi.advanceTimersByTimeAsync(600);

      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });
  });

  it("fires for working and directing agent states", () => {
    mockTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "directing" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("directing", "idle", "term-2");

    mockTerminals([
      { id: "term-1", agentState: "completed" },
      { id: "term-2", agentState: "completed" },
    ]);
    emitStateChange("completed", "working", "term-1");
    emitStateChange("completed", "directing", "term-2");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
  });

  it("does not play sound or flash when master enabled toggle is false", () => {
    const emitSpy = vi.spyOn(events, "emit");
    projectStoreMock.getEffectiveNotificationSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      enabled: false,
      soundEnabled: true,
      flashEnabled: true,
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
    expect(emitSpy).toHaveBeenCalledWith("agent:all-clear", {
      timestamp: expect.any(Number),
      shouldFlash: false,
    });
    emitSpy.mockRestore();
  });

  it("does not fire when peak concurrent never reaches 2 (sequential single-agent sessions)", () => {
    // First agent works and completes (peak = 1)
    mockTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");

    mockTerminals([{ id: "term-1", agentState: "completed" }]);
    emitStateChange("completed", "working", "term-1");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");

    // Second agent works and completes (peak still = 1, never reached 2)
    mockTerminals([{ id: "term-2", agentState: "working" }]);
    emitStateChange("working", "idle", "term-2");

    mockTerminals([{ id: "term-2", agentState: "completed" }]);
    emitStateChange("completed", "working", "term-2");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  it("does not fire for single-agent session after reset (stale-state protection)", () => {
    // First, trigger a multi-agent all-clear (this resets the state)
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

    // After reset, a single-agent session should NOT fire all-clear
    // because peakConcurrentWorking starts at 0 and only reaches 1
    mockTerminals([{ id: "term-3", agentState: "working" }]);
    emitStateChange("working", "idle", "term-3");

    mockTerminals([{ id: "term-3", agentState: "completed" }]);
    emitStateChange("completed", "working", "term-3");

    vi.advanceTimersByTime(600);
    expect(soundServiceMock.play).not.toHaveBeenCalledWith("all-clear");
  });

  describe("suppression chain", () => {
    /** Two agents work then both complete — the standard all-clear trigger, undebounced. */
    function runTwoAgentSession(a = "term-1", b = "term-2"): void {
      mockTerminals([
        { id: a, agentState: "working" },
        { id: b, agentState: "working" },
      ]);
      emitStateChange("working", "idle", a);
      emitStateChange("working", "idle", b);

      mockTerminals([
        { id: a, agentState: "completed" },
        { id: b, agentState: "completed" },
      ]);
      emitStateChange("completed", "working", a);
      emitStateChange("completed", "working", b);
    }

    function countAllClearEvents(calls: readonly unknown[][]): number {
      return calls.filter((call) => call[0] === "agent:all-clear").length;
    }

    /** The `shouldFlash` verdict carried on the (first) emitted all-clear event. */
    function allClearShouldFlash(calls: readonly unknown[][]): boolean | undefined {
      const call = calls.find((c) => c[0] === "agent:all-clear");
      return (call?.[1] as { shouldFlash?: boolean } | undefined)?.shouldFlash;
    }

    it("suppresses the sound during scheduled quiet hours but still emits the event", () => {
      // Monday 23:00 falls inside the 22:00 -> 06:00 window
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      projectStoreMock.getEffectiveNotificationSettings.mockReturnValue({
        ...DEFAULT_SETTINGS,
        quietHoursEnabled: true,
      });
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
      expect(countAllClearEvents(emitSpy.mock.calls)).toBe(1);
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(false);
      emitSpy.mockRestore();
    });

    it("plays the sound outside the quiet-hours window", () => {
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      projectStoreMock.getEffectiveNotificationSettings.mockReturnValue({
        ...DEFAULT_SETTINGS,
        quietHoursEnabled: true,
      });
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(true);
      emitSpy.mockRestore();
    });

    it("suppresses the sound during a session mute but still emits the event", () => {
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      agentNotificationService.setSessionMuteUntil(Date.now() + 60 * 60 * 1000);
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
      expect(countAllClearEvents(emitSpy.mock.calls)).toBe(1);
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(false);
      emitSpy.mockRestore();
    });

    it("plays the sound when the session mute expires before the debounce fires", () => {
      // Suppression is read at fire time, not schedule time: the mute is still
      // active when the timer is armed and lapses during the 500ms window.
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      agentNotificationService.setSessionMuteUntil(Date.now() + 250);
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(true);
      emitSpy.mockRestore();
    });

    it("suppresses the sound when OS Do-Not-Disturb turns on during the debounce", () => {
      // The mirror of the case above — a snapshot taken at schedule time would
      // wrongly play here.
      osDndServiceMock.getState.mockReturnValue(false);
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(499);
      osDndServiceMock.getState.mockReturnValue(true);
      vi.advanceTimersByTime(1);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
      expect(countAllClearEvents(emitSpy.mock.calls)).toBe(1);
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(false);
      emitSpy.mockRestore();
    });

    it("suppresses the sound while OS Do-Not-Disturb is active but still emits the event", () => {
      osDndServiceMock.getState.mockReturnValue(true);
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
      expect(countAllClearEvents(emitSpy.mock.calls)).toBe(1);
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(false);
      emitSpy.mockRestore();
    });

    it("plays the sound when OS Do-Not-Disturb is explicitly inactive", () => {
      osDndServiceMock.getState.mockReturnValue(false);
      const emitSpy = vi.spyOn(events, "emit");

      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
      expect(allClearShouldFlash(emitSpy.mock.calls)).toBe(true);
      emitSpy.mockRestore();
    });

    it("never raises an OS notification for the all-clear, suppressed or not", () => {
      osDndServiceMock.getState.mockReturnValue(true);
      runTwoAgentSession();
      vi.advanceTimersByTime(600);
      expect(soundServiceMock.play).not.toHaveBeenCalled();

      osDndServiceMock.getState.mockReturnValue(undefined);
      runTwoAgentSession();
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
      expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    });

    it("drops the suppressed sound rather than replaying it once suppression lifts", () => {
      osDndServiceMock.getState.mockReturnValue(true);
      runTwoAgentSession();
      vi.advanceTimersByTime(600);
      expect(soundServiceMock.play).not.toHaveBeenCalled();

      osDndServiceMock.getState.mockReturnValue(false);
      vi.advanceTimersByTime(5000);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
    });

    it("resets peak tracking after a suppressed all-clear", () => {
      osDndServiceMock.getState.mockReturnValue(true);
      runTwoAgentSession();
      vi.advanceTimersByTime(600);
      osDndServiceMock.getState.mockReturnValue(false);

      // A single-agent session must not inherit the previous session's peak.
      mockTerminals([{ id: "term-3", agentState: "working" }]);
      emitStateChange("working", "idle", "term-3");
      mockTerminals([{ id: "term-3", agentState: "completed" }]);
      emitStateChange("completed", "working", "term-3");
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).not.toHaveBeenCalled();
    });

    it("fires again for the next two-agent session after a suppressed all-clear", () => {
      osDndServiceMock.getState.mockReturnValue(true);
      runTwoAgentSession();
      vi.advanceTimersByTime(600);
      osDndServiceMock.getState.mockReturnValue(false);

      emitStateChange("working", "idle", "term-3");
      emitStateChange("working", "idle", "term-4");
      emitStateChange("completed", "working", "term-3");
      emitStateChange("completed", "working", "term-4");
      vi.advanceTimersByTime(600);

      expect(soundServiceMock.play).toHaveBeenCalledTimes(1);
      expect(soundServiceMock.play).toHaveBeenCalledWith("all-clear");
    });
  });
});

describe("AgentNotificationService adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.clearAllMocks();
    osDndServiceMock.getState.mockReturnValue(undefined);
    mockStore();
    agentNotificationService.initialize();
    agentNotificationService.syncWatchedPanels(OWNER, ["term-1"]);
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
      "Agent is waiting for input",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      { silent: true, ownerWebContentsId: OWNER, closeWithPanels: ["term-1"], category: "waiting" }
    );
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
  });

  it("SAME_TARGET_COMPLETION_DEBOUNCE_FIRES_ONCE", () => {
    mockStore({ completedEnabled: true, soundEnabled: true });

    events.emit("agent:state-changed", makePayload("completed", "working"));
    vi.advanceTimersByTime(1000);
    events.emit("agent:state-changed", makePayload("completed", "directing"));
    vi.advanceTimersByTime(2001);

    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
    expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
      "Agent finished",
      "Agent finished its task",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      { silent: true, ownerWebContentsId: OWNER, category: "completed" }
    );
    expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
  });

  it("DISPOSE_DURING_STAGGERED_QUEUE_DROPS_PENDING", () => {
    const internal = agentNotificationService as unknown as AgentNotificationServiceInternal;
    internal.notificationQueue.push(
      {
        title: "Agent finished",
        body: "Agent finished its task",
        terminalId: "term-1",
        agentId: "agent-1",
        worktreeId: "wt-1",
        triggerSound: true,
        soundFile: "complete.wav",
      },
      {
        title: "Agent finished",
        body: "Agent finished its task",
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

  it("WAITING_AND_COMPLETION_SAME_TARGET_KEEP_ORDER", () => {
    mockStore({ waitingEnabled: true, completedEnabled: true, soundEnabled: false });

    events.emit("agent:state-changed", makePayload("waiting", "working"));
    vi.advanceTimersByTime(200);

    events.emit("agent:state-changed", makePayload("completed", "waiting"));
    vi.advanceTimersByTime(2001);

    expect(notificationServiceMock.showWatchNotification.mock.calls.map((call) => call[0])).toEqual(
      ["Agent waiting", "Agent finished"]
    );
    expect(notificationServiceMock.showWatchNotification).toHaveBeenNthCalledWith(
      1,
      "Agent waiting",
      "Agent is waiting for input",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      { silent: true, ownerWebContentsId: OWNER, closeWithPanels: ["term-1"], category: "waiting" }
    );
    expect(notificationServiceMock.showWatchNotification).toHaveBeenNthCalledWith(
      2,
      "Agent finished",
      "Agent finished its task",
      expect.objectContaining({ panelId: "term-1" }),
      "notification:watch-navigate",
      { silent: true, ownerWebContentsId: OWNER, category: "completed" }
    );
  });
});
