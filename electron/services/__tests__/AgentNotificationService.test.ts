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

const DEFAULT_NOTIFICATION_SETTINGS = {
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
    vi.advanceTimersByTime(200);

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
    vi.advanceTimersByTime(200);

    expect(soundServiceMock.playFile).toHaveBeenCalled();
  });

  it("does not play sound when soundEnabled is false", () => {
    mockStore({ waitingEnabled: true });

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(200);

    expect(soundServiceMock.playFile).not.toHaveBeenCalled();
  });

  it("plays waitingSoundFile for waiting events", () => {
    mockStore({ waitingEnabled: true, soundEnabled: true, waitingSoundFile: "ping.wav" });

    events.emit("agent:state-changed", makePayload("waiting"));
    vi.advanceTimersByTime(200);

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
    vi.advanceTimersByTime(200);

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

  describe("burst coalescing", () => {
    function makePayloadFor(
      terminalId: string,
      agentId: string,
      state: AgentState,
      previousState: AgentState = "working"
    ) {
      return {
        state,
        previousState,
        worktreeId: "wt-1",
        terminalId,
        agentId,
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      };
    }

    function makeMultiTerminalAppState(count: number) {
      return {
        activeWorktreeId: "wt-1",
        terminals: Array.from({ length: count }, (_, i) => ({
          id: `term-${i + 1}`,
          kind: "agent",
          agentId: `agent-${i + 1}`,
          title: `Agent ${i + 1}`,
          location: "dock" as const,
          worktreeId: "wt-1",
        })),
      };
    }

    it("coalesces multiple simultaneous waiting events into one notification", () => {
      const appState = makeMultiTerminalAppState(3);
      mockStore({ waitingEnabled: true, soundEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2", "term-3"]);

      events.emit("agent:state-changed", makePayloadFor("term-1", "agent-1", "waiting"));
      events.emit("agent:state-changed", makePayloadFor("term-2", "agent-2", "waiting"));
      events.emit("agent:state-changed", makePayloadFor("term-3", "agent-3", "waiting"));
      vi.advanceTimersByTime(200);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agents waiting",
        "3 agents waiting for input",
        expect.any(Object),
        "notification:watch-navigate",
        true
      );
      expect(soundServiceMock.playFile).toHaveBeenCalledTimes(1);
    });

    it("shows single-agent message for one waiting event after burst window", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(200);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent waiting",
        expect.stringContaining("agent-1 is waiting for input"),
        expect.any(Object),
        "notification:watch-navigate",
        true
      );
    });

    it("produces separate notifications for events in different burst windows", () => {
      const appState = makeMultiTerminalAppState(2);
      mockStore({ waitingEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2"]);

      events.emit("agent:state-changed", makePayloadFor("term-1", "agent-1", "waiting"));
      vi.advanceTimersByTime(200); // first burst flushes

      events.emit("agent:state-changed", makePayloadFor("term-2", "agent-2", "waiting"));
      vi.advanceTimersByTime(200); // second burst flushes

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(2);
    });

    it("coalesces simultaneous completion debounces into one notification", () => {
      const appState = makeMultiTerminalAppState(3);
      mockStore({ completedEnabled: true, soundEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2", "term-3"]);

      // All 3 agents complete at the same time
      events.emit("agent:state-changed", makePayloadFor("term-1", "agent-1", "completed"));
      events.emit("agent:state-changed", makePayloadFor("term-2", "agent-2", "completed"));
      events.emit("agent:state-changed", makePayloadFor("term-3", "agent-3", "completed"));

      // Advance past the 2000ms debounce + 0ms flush timer
      vi.advanceTimersByTime(2001);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agents completed",
        "3 agents finished their tasks",
        expect.any(Object),
        "notification:watch-navigate",
        true
      );
    });

    it("groups escalation notifications for multiple waiting dock terminals", () => {
      const appState = makeMultiTerminalAppState(3);
      mockStore({ waitingEnabled: true, soundEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2", "term-3"]);

      events.emit("agent:state-changed", makePayloadFor("term-1", "agent-1", "waiting"));
      events.emit("agent:state-changed", makePayloadFor("term-2", "agent-2", "waiting"));
      events.emit("agent:state-changed", makePayloadFor("term-3", "agent-3", "waiting"));

      // Advance past burst window + escalation delay
      vi.advanceTimersByTime(180_000);

      // Exactly one grouped escalation notification, not 3
      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.showNativeNotification).toHaveBeenCalledWith(
        "Agents still waiting",
        "3 agents have been waiting for input"
      );
    });

    it("dispose clears waiting burst timer", () => {
      mockStore({ waitingEnabled: true });

      events.emit("agent:state-changed", makePayload("waiting"));
      agentNotificationService.dispose();
      vi.advanceTimersByTime(300);

      expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    });

    it("dispose clears completion burst timer", () => {
      mockStore({ completedEnabled: true });

      events.emit("agent:state-changed", makePayload("completed"));
      vi.advanceTimersByTime(2000); // debounce fires, pushes to burst buffer
      agentNotificationService.dispose();
      vi.advanceTimersByTime(100); // 0ms flush timer would have fired

      expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    });
  });

  describe("working pulse", () => {
    it("does not start pulse when workingPulseEnabled is false", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: false });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(30_000);

      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
    });

    it("does not start pulse when soundEnabled is false", () => {
      mockStore({ soundEnabled: false, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(30_000);

      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
    });

    it("does not start pulse for unwatched grid terminal", () => {
      mockStore(
        { soundEnabled: true, workingPulseEnabled: true },
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
      agentNotificationService.syncWatchedPanels([]);

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(30_000);

      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
    });

    it("starts pulse after 10s for a watched terminal in working state", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));

      // Before 10s — no pulse yet
      vi.advanceTimersByTime(9_999);
      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();

      // At 10s — first pulse fires
      vi.advanceTimersByTime(1);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);
      expect(soundServiceMock.playPulse).toHaveBeenCalledWith("pulse.wav", expect.any(Number));
    });

    it("passes a random detune within ±15 cents on each pulse", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      // Each tick consumes Math.random() twice: first for detune, then for
      // jitter. Providing a fixed [detune, jitter] pair per tick pins both
      // the formula (detune = rand*30 - 15) and the call order contract.
      const randomSpy = vi.spyOn(Math, "random");
      try {
        randomSpy
          .mockReturnValueOnce(0) // tick 1 detune → -15
          .mockReturnValueOnce(0.5) // tick 1 jitter
          .mockReturnValueOnce(0.5) // tick 2 detune → 0
          .mockReturnValueOnce(0.5) // tick 2 jitter
          .mockReturnValueOnce(0.999) // tick 3 detune → 14.97
          .mockReturnValueOnce(0.5); // tick 3 jitter

        events.emit("agent:state-changed", makePayload("working", "idle"));
        vi.advanceTimersByTime(10_000);
        expect(soundServiceMock.playPulse).toHaveBeenLastCalledWith("pulse.wav", -15);

        vi.advanceTimersByTime(10_000);
        expect(soundServiceMock.playPulse).toHaveBeenLastCalledWith("pulse.wav", 0);

        vi.advanceTimersByTime(10_000);
        const lastCall = soundServiceMock.playPulse.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe("pulse.wav");
        expect(lastCall?.[1]).toBeCloseTo(14.97, 2);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it("starts pulse for docked terminal with escalation enabled", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });
      agentNotificationService.syncWatchedPanels([]);

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);

      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);
    });

    it("fires recurring pulses at ~8-10s intervals", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      // Advance past max interval to guarantee next pulse
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(3);
    });

    it("stops pulse immediately when agent leaves working state", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      // Agent transitions to completed
      events.emit("agent:state-changed", makePayload("completed", "working"));
      soundServiceMock.playPulse.mockClear();

      vi.advanceTimersByTime(30_000);
      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
      expect(soundServiceMock.cancelPulse).toHaveBeenCalled();
    });

    it("stops pulse on acknowledgeWorkingPulse", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      agentNotificationService.acknowledgeWorkingPulse("term-1");
      soundServiceMock.playPulse.mockClear();

      vi.advanceTimersByTime(30_000);
      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
    });

    it("stops pulse on dispose", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);

      agentNotificationService.dispose();
      soundServiceMock.playPulse.mockClear();

      vi.advanceTimersByTime(30_000);
      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();
      expect(soundServiceMock.cancelPulse).toHaveBeenCalled();
    });

    it("restarts fresh 10s delay when agent re-enters working", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      // Leave working, re-enter
      events.emit("agent:state-changed", makePayload("completed", "working"));
      soundServiceMock.playPulse.mockClear();

      events.emit("agent:state-changed", makePayload("working", "completed"));

      // 9s after re-entry — not yet
      vi.advanceTimersByTime(9_000);
      expect(soundServiceMock.playPulse).not.toHaveBeenCalled();

      // 10s after re-entry — fires
      vi.advanceTimersByTime(1_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);
    });

    it("stops recurring pulse if settings change to disabled mid-interval", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      // Disable pulse mid-interval
      mockStore({ soundEnabled: true, workingPulseEnabled: false });
      vi.advanceTimersByTime(10_000);

      // Should not have fired again (guard check in tick)
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);
    });

    it("does not start pulse for same-state working→working", () => {
      mockStore({ soundEnabled: true, workingPulseEnabled: true });

      events.emit("agent:state-changed", makePayload("working", "idle"));
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);

      // Same-state transition — early-return in handleStateChanged
      events.emit("agent:state-changed", makePayload("working", "working"));
      soundServiceMock.playPulse.mockClear();

      // Should continue existing pulse, not restart
      vi.advanceTimersByTime(10_000);
      expect(soundServiceMock.playPulse).toHaveBeenCalledTimes(1);
    });
  });

  describe("agent:spawned UI feedback sound", () => {
    it("plays agent-spawned sound when uiFeedbackSoundEnabled is true", () => {
      mockStore({ uiFeedbackSoundEnabled: true });

      // Advance past boot grace period so the sound is not suppressed
      vi.advanceTimersByTime(10_000);

      events.emit("agent:spawned", {
        terminalId: "term-1",
        agentId: "claude",
        type: "claude",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      expect(soundServiceMock.play).toHaveBeenCalledWith("agent-spawned");
    });

    it("does not play agent-spawned sound when uiFeedbackSoundEnabled is false", () => {
      mockStore({ uiFeedbackSoundEnabled: false });

      vi.advanceTimersByTime(10_000);

      events.emit("agent:spawned", {
        terminalId: "term-1",
        agentId: "claude",
        type: "claude",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      expect(soundServiceMock.play).not.toHaveBeenCalled();
    });

    it("suppresses agent-spawned sound during boot grace period", () => {
      mockStore({ uiFeedbackSoundEnabled: true });

      // Emit immediately after initialization (within boot grace)
      events.emit("agent:spawned", {
        terminalId: "term-1",
        agentId: "claude",
        type: "claude",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      expect(soundServiceMock.play).not.toHaveBeenCalled();
    });
  });

  // #5139 follow-up: backend-emitted events no longer carry worktreeId.
  // Main-side consumers (AgentNotificationService) resolve it from persisted
  // renderer state (appState.terminals) so notification context carries the
  // correct worktreeId for click-to-navigate. Without this resolution,
  // makeContext would ship worktreeId: undefined to the renderer.
  describe("worktreeId fallback from appState (issue #5139)", () => {
    function payloadWithoutWorktreeId(state: AgentState, previousState: AgentState = "working") {
      return {
        state,
        previousState,
        terminalId: "term-1",
        agentId: "agent-1",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      };
    }

    it("resolves worktreeId from appState.terminals when the payload omits it (completion)", () => {
      mockStore(
        { completedEnabled: true },
        {
          activeWorktreeId: "wt-A",
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "Claude",
              location: "dock",
              worktreeId: "wt-B",
            },
          ],
        }
      );

      events.emit("agent:state-changed", payloadWithoutWorktreeId("completed"));
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent completed",
        expect.stringContaining("finished"),
        expect.objectContaining({ worktreeId: "wt-B" }),
        "notification:watch-navigate",
        true
      );
    });

    it("resolves worktreeId from appState.terminals when the payload omits it (waiting)", () => {
      mockStore(
        { waitingEnabled: true },
        {
          activeWorktreeId: "wt-A",
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "Claude",
              location: "dock",
              worktreeId: "wt-B",
            },
          ],
        }
      );

      events.emit("agent:state-changed", payloadWithoutWorktreeId("waiting"));
      vi.advanceTimersByTime(500);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent waiting",
        expect.stringContaining("waiting"),
        expect.objectContaining({ worktreeId: "wt-B" }),
        "notification:watch-navigate",
        true
      );
    });

    it("prefers an explicit worktreeId in the payload over the appState fallback", () => {
      mockStore(
        { completedEnabled: true },
        {
          activeWorktreeId: "wt-A",
          terminals: [
            {
              id: "term-1",
              kind: "agent",
              agentId: "agent-1",
              title: "Claude",
              location: "dock",
              worktreeId: "wt-stale",
            },
          ],
        }
      );

      events.emit("agent:state-changed", {
        ...payloadWithoutWorktreeId("completed"),
        worktreeId: "wt-fresh",
      });
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent completed",
        expect.any(String),
        expect.objectContaining({ worktreeId: "wt-fresh" }),
        "notification:watch-navigate",
        true
      );
    });

    it("degrades to undefined worktreeId when the terminal is not found in appState", () => {
      mockStore(
        { completedEnabled: true },
        {
          activeWorktreeId: "wt-A",
          // No terminal entry for term-1 — e.g., event arrives after delete.
          terminals: [],
        }
      );

      events.emit("agent:state-changed", payloadWithoutWorktreeId("completed"));
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent completed",
        expect.any(String),
        expect.objectContaining({ worktreeId: undefined }),
        "notification:watch-navigate",
        true
      );
    });
  });

  // #5773 — Runtime-detected agents (plain terminals where an agent CLI was
  // detected at runtime, no persisted launch-time agentId) never fire
  // agent:spawned. Spawn grace must be seeded from agent:detected so startup
  // "waiting" states don't immediately produce notification sounds.
  describe("agent:detected spawn grace (#5773)", () => {
    it("seeds spawn grace from agent:detected so waiting sound is suppressed within grace window", () => {
      mockStore({ waitingEnabled: true, soundEnabled: true });
      // Advance past boot grace so only spawn grace matters
      vi.advanceTimersByTime(10_000);

      events.emit("agent:detected", {
        terminalId: "term-1",
        agentType: "claude",
        processName: "claude",
        timestamp: Date.now(),
      });

      // Within the 5s spawn grace window, a waiting event should not trigger sound
      events.emit("agent:state-changed", {
        state: "waiting" as const,
        previousState: "working" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      vi.advanceTimersByTime(200);

      expect(soundServiceMock.playFile).not.toHaveBeenCalled();
    });

    it("does not seed grace when agent:detected lacks agentType (non-agent process)", () => {
      mockStore({ waitingEnabled: true, soundEnabled: true });
      vi.advanceTimersByTime(10_000);

      // Non-agent process detection (npm/docker/etc.) — no agentType
      events.emit("agent:detected", {
        terminalId: "term-1",
        processIconId: "npm",
        processName: "npm",
        timestamp: Date.now(),
      });

      events.emit("agent:state-changed", {
        state: "waiting" as const,
        previousState: "working" as const,
        terminalId: "term-1",
        agentId: "agent-1",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      vi.advanceTimersByTime(200);

      // No grace was seeded; waiting sound fires normally
      expect(soundServiceMock.playFile).toHaveBeenCalled();
    });

    it("spawn grace expires after SPAWN_GRACE_PERIOD_MS — waiting sound resumes", () => {
      mockStore({ waitingEnabled: true, soundEnabled: true });
      vi.advanceTimersByTime(10_000);

      events.emit("agent:detected", {
        terminalId: "term-1",
        agentType: "claude",
        processName: "claude",
        timestamp: Date.now(),
      });

      // Advance past the 5s spawn grace
      vi.advanceTimersByTime(6_000);

      events.emit("agent:state-changed", {
        state: "waiting" as const,
        previousState: "working" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      vi.advanceTimersByTime(200);

      expect(soundServiceMock.playFile).toHaveBeenCalled();
    });

    it("completion key is per-terminal — two runtime-detected terminals with same agent type both notify", () => {
      // Two plain terminals both detect "claude" as their agent. Before the
      // fix, both completion debounces shared the key "claude" and the
      // second would cancel the first. Now the key is terminalId-first.
      const appState = {
        activeWorktreeId: "wt-1",
        terminals: [
          {
            id: "term-1",
            kind: "terminal",
            agentId: "claude",
            title: "Terminal 1",
            location: "dock",
            worktreeId: "wt-1",
          },
          {
            id: "term-2",
            kind: "terminal",
            agentId: "claude",
            title: "Terminal 2",
            location: "dock",
            worktreeId: "wt-1",
          },
        ],
      };
      mockStore({ completedEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2"]);

      events.emit("agent:state-changed", {
        state: "completed" as const,
        previousState: "working" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      events.emit("agent:state-changed", {
        state: "completed" as const,
        previousState: "working" as const,
        terminalId: "term-2",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });

      // Advance past the 2s completion debounce + 0ms flush timer
      vi.advanceTimersByTime(2001);

      // Both completions should be captured (grouped into one "Agents completed"
      // burst rather than silently dropping one).
      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agents completed",
        "2 agents finished their tasks",
        expect.any(Object),
        "notification:watch-navigate",
        true
      );
    });

    it("grace key is per-terminal — one terminal's interaction doesn't clear a sibling's grace", () => {
      const appState = {
        activeWorktreeId: "wt-1",
        terminals: [
          {
            id: "term-1",
            kind: "terminal",
            agentId: "claude",
            title: "Terminal 1",
            location: "dock",
            worktreeId: "wt-1",
          },
          {
            id: "term-2",
            kind: "terminal",
            agentId: "claude",
            title: "Terminal 2",
            location: "dock",
            worktreeId: "wt-1",
          },
        ],
      };
      mockStore({ waitingEnabled: true, soundEnabled: true }, appState);
      agentNotificationService.syncWatchedPanels(["term-1", "term-2"]);
      vi.advanceTimersByTime(10_000);

      // Both terminals detect "claude" — each seeds its own grace entry
      events.emit("agent:detected", {
        terminalId: "term-1",
        agentType: "claude",
        processName: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:detected", {
        terminalId: "term-2",
        agentType: "claude",
        processName: "claude",
        timestamp: Date.now(),
      });

      // Term-1 transitions waiting→working (user interacted), clearing ITS grace
      events.emit("agent:state-changed", {
        state: "waiting" as const,
        previousState: "idle" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      events.emit("agent:state-changed", {
        state: "working" as const,
        previousState: "waiting" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });

      // Term-2 hits waiting — its grace is still active, so no sound should fire
      soundServiceMock.playFile.mockClear();
      events.emit("agent:state-changed", {
        state: "waiting" as const,
        previousState: "working" as const,
        terminalId: "term-2",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      vi.advanceTimersByTime(200);

      expect(soundServiceMock.playFile).not.toHaveBeenCalled();
    });

    it("handles state-changed payload whose agentId is the detected type (no persisted agentId)", () => {
      mockStore({ completedEnabled: true });

      // Runtime-detected agent: agentId on the event carries detectedAgentType
      events.emit("agent:state-changed", {
        state: "completed" as const,
        previousState: "working" as const,
        terminalId: "term-1",
        agentId: "claude",
        timestamp: Date.now(),
        trigger: "heuristic" as const,
        confidence: 1,
      });
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent completed",
        expect.stringContaining("claude"),
        expect.objectContaining({ panelId: "term-1" }),
        "notification:watch-navigate",
        true
      );
    });
  });

  describe("quiet hours suppression", () => {
    it("scheduled quiet hours suppresses completion watch notifications", () => {
      const realDate = global.Date;
      // Monday 23:00 falls inside 22:00 → 06:00 quiet window
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      mockStore({
        completedEnabled: true,
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
        quietHoursWeekdays: [],
      } as unknown as Partial<typeof DEFAULT_NOTIFICATION_SETTINGS>);

      events.emit("agent:state-changed", makePayload("completed"));
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
      global.Date = realDate;
    });

    it("session mute suppresses completion watch notifications", () => {
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      mockStore({ completedEnabled: true });
      agentNotificationService.setSessionMuteUntil(Date.now() + 60 * 60 * 1000);

      events.emit("agent:state-changed", makePayload("completed"));
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
    });

    it("session mute expires — notifications resume after the timestamp", () => {
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      mockStore({ completedEnabled: true });
      agentNotificationService.setSessionMuteUntil(Date.now() + 1000);

      vi.advanceTimersByTime(2000);
      agentNotificationService.setSessionMuteUntil(0); // simulate renderer clearing

      events.emit("agent:state-changed", makePayload("completed"));
      vi.advanceTimersByTime(5000);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalled();
    });

    it("scheduled quiet hours does not suppress waiting alerts", () => {
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      mockStore({
        waitingEnabled: true,
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
        quietHoursWeekdays: [],
      } as unknown as Partial<typeof DEFAULT_NOTIFICATION_SETTINGS>);

      events.emit("agent:state-changed", makePayload("waiting"));
      vi.advanceTimersByTime(500);

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "Agent waiting",
        expect.any(String),
        expect.any(Object),
        "notification:watch-navigate",
        true
      );
    });
  });
});
