import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../shared/types/agent.js";

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

const trackEventMock = vi.hoisted(() => vi.fn());

const broadcastMock = vi.hoisted(() => vi.fn());

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../TelemetryService.js", () => ({
  trackEvent: trackEventMock,
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastMock,
}));

import { events } from "../events.js";
import { activationFunnelService } from "../ActivationFunnelService.js";
import { CHANNELS } from "../../ipc/channels.js";

function setTerminals(terminals: Array<{ id: string; agentState?: string }>) {
  storeMock._data["appState"] = { activeWorktreeId: "wt-1", terminals };
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

function emitCompleted(terminalId = "term-1", exitCode = 0, duration = 12_000) {
  events.emit("agent:completed", {
    agentId: `agent-${terminalId}`,
    exitCode,
    duration,
    terminalId,
    worktreeId: "wt-1",
    timestamp: Date.now(),
  });
}

function seedOnboardingDefaults() {
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
    migratedFromLocalStorage: false,
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
}

describe("ActivationFunnelService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
    setTerminals([]);
    seedOnboardingDefaults();
    // Initialize with appLaunchMs set 2.5s before "now" so time_to_first is
    // computable, and advance past the 8s boot grace window.
    const now = Date.now();
    activationFunnelService.initialize({ appLaunchMs: now - 2_500 });
    vi.advanceTimersByTime(8_500);
  });

  afterEach(() => {
    activationFunnelService.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fires activation_first_agent_task_started exactly once with time_to_first_agent_task_ms", () => {
    setTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");

    expect(trackEventMock).toHaveBeenCalledWith(
      "activation_first_agent_task_started",
      expect.objectContaining({
        time_to_first_agent_task_ms: expect.any(Number),
      })
    );
    const payload = trackEventMock.mock.calls.find(
      (c) => c[0] === "activation_first_agent_task_started"
    )![1] as { time_to_first_agent_task_ms: number };
    expect(payload.time_to_first_agent_task_ms).toBeGreaterThanOrEqual(2_500);

    trackEventMock.mockClear();
    // Second task start — guard blocks second fire
    emitStateChange("idle", "working", "term-1");
    emitStateChange("working", "idle", "term-1");
    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_agent_task_started")
    ).toBeUndefined();
  });

  it("persists firstAgentTaskStartedAt and timeToFirstAgentTaskMs to activationFunnel", () => {
    setTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");

    const funnel = storeMock._data["activationFunnel"] as {
      firstAgentTaskStartedAt?: number;
      timeToFirstAgentTaskMs?: number;
    };
    expect(funnel.firstAgentTaskStartedAt).toBeGreaterThan(0);
    expect(funnel.timeToFirstAgentTaskMs).toBeGreaterThanOrEqual(2_500);
  });

  it("fires activation_first_agent_task_completed exactly once when agent completes with exitCode 0", () => {
    emitCompleted("term-1", 0, 12_345);
    expect(trackEventMock).toHaveBeenCalledWith("activation_first_agent_task_completed", {
      duration_ms: 12_345,
      exit_code: 0,
    });

    trackEventMock.mockClear();
    emitCompleted("term-2", 0, 7_000);
    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_agent_task_completed")
    ).toBeUndefined();
  });

  it("ignores non-zero exit codes for activation_first_agent_task_completed", () => {
    emitCompleted("term-1", 1, 5_000);
    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_agent_task_completed")
    ).toBeUndefined();
    expect(storeMock._data["activationFunnel"]).toBeUndefined();
  });

  it("fires activation_first_parallel_agents when 2 agents become active and marks checklist", () => {
    // First agent working — just fires first_agent_task_started; parallel count is 1 so no parallel fire yet.
    setTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");

    trackEventMock.mockClear();
    broadcastMock.mockClear();

    // Second agent becomes active — now parallel count is 2.
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-2");

    expect(trackEventMock).toHaveBeenCalledWith("activation_first_parallel_agents", {
      agent_count: 2,
    });

    const onboarding = storeMock._data["onboarding"] as {
      checklist: { items: { ranSecondParallelAgent: boolean } };
    };
    expect(onboarding.checklist.items.ranSecondParallelAgent).toBe(true);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.ONBOARDING_CHECKLIST_PUSH,
      expect.objectContaining({
        items: expect.objectContaining({ ranSecondParallelAgent: true }),
      })
    );
  });

  it("does not fire activation_first_parallel_agents twice", () => {
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-1");
    emitStateChange("working", "idle", "term-2");

    trackEventMock.mockClear();

    // Additional active transitions shouldn't re-fire.
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
      { id: "term-3", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-3");

    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_parallel_agents")
    ).toBeUndefined();
  });

  it("reconciles parallel-agents milestone after boot grace when agents were already active at launch", () => {
    // Reset: simulate a relaunch where two agents are already in `working`
    // state from a prior session (no state-change events will fire for them).
    activationFunnelService.dispose();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
    seedOnboardingDefaults();
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    const now = Date.now();
    activationFunnelService.initialize({ appLaunchMs: now - 500 });
    trackEventMock.mockClear();
    broadcastMock.mockClear();

    // Advance past the boot grace window + reconcile timer delay (8100ms)
    vi.advanceTimersByTime(8_200);

    expect(trackEventMock).toHaveBeenCalledWith("activation_first_parallel_agents", {
      agent_count: 2,
    });
    const onboarding = storeMock._data["onboarding"] as {
      checklist: { items: { ranSecondParallelAgent: boolean } };
    };
    expect(onboarding.checklist.items.ranSecondParallelAgent).toBe(true);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.ONBOARDING_CHECKLIST_PUSH,
      expect.objectContaining({
        items: expect.objectContaining({ ranSecondParallelAgent: true }),
      })
    );
  });

  it("does not re-fire a persisted activation_first_parallel_agents milestone across re-initialize", () => {
    // Seed a persisted milestone from a prior session.
    storeMock._data["activationFunnel"] = { firstParallelAgentsAt: 1_700_000_000_000 };
    // Fresh service — re-initialize path must honor the persisted guard.
    activationFunnelService.dispose();
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
    ]);
    trackEventMock.mockClear();
    broadcastMock.mockClear();
    const now = Date.now();
    activationFunnelService.initialize({ appLaunchMs: now - 500 });
    vi.advanceTimersByTime(8_500);

    // Assert BEFORE any mockClear — catches a reconcile fire that would
    // otherwise be erased by cleanup between phases of the test.
    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_parallel_agents")
    ).toBeUndefined();
    expect(
      broadcastMock.mock.calls.find((c) => c[0] === CHANNELS.ONBOARDING_CHECKLIST_PUSH)
    ).toBeUndefined();
    expect(
      (storeMock._data["activationFunnel"] as { firstParallelAgentsAt: number })
        .firstParallelAgentsAt
    ).toBe(1_700_000_000_000);

    // A fresh state-change event should also respect the persisted guard.
    setTerminals([
      { id: "term-1", agentState: "working" },
      { id: "term-2", agentState: "working" },
      { id: "term-3", agentState: "working" },
    ]);
    emitStateChange("working", "idle", "term-3");

    expect(
      trackEventMock.mock.calls.find((c) => c[0] === "activation_first_parallel_agents")
    ).toBeUndefined();
  });

  it("suppresses all activation events during the 8-second boot grace window", () => {
    // Reset to immediately after initialize (still inside boot grace)
    activationFunnelService.dispose();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
    setTerminals([]);
    seedOnboardingDefaults();
    const now = Date.now();
    activationFunnelService.initialize({ appLaunchMs: now - 100 });
    // Do NOT advance past boot grace
    trackEventMock.mockClear();

    setTerminals([{ id: "term-1", agentState: "working" }]);
    emitStateChange("working", "idle", "term-1");
    emitCompleted("term-1", 0, 5_000);

    expect(trackEventMock).not.toHaveBeenCalled();
    expect(storeMock._data["activationFunnel"]).toBeUndefined();
  });
});
