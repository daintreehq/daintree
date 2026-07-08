import { describe, expect, it } from "vitest";
import type { WorkerResourceSnapshot } from "../../types/workerGovernance.js";
import {
  ANALYSIS_SESSION_IDLE_TRIM_MS,
  WORKER_CRASH_LOOP_LIMIT,
  canDisposeIdlePluginWorker,
  decideWorkerAction,
  shouldTrimAnalysisSession,
} from "../workerGovernancePolicy.js";

const NOW = 1_000_000_000;
const HOUR = 60 * 60_000;

function snapshot(overrides: Partial<WorkerResourceSnapshot> = {}): WorkerResourceSnapshot {
  return {
    kind: "analysis-pool",
    id: "worker-0",
    pid: null,
    threadId: 1,
    alive: true,
    activeSessionCount: 0,
    queueDepth: 0,
    lastActivityAt: NOW - HOUR,
    memory: null,
    eligibility: { trim: false, dispose: false, restart: false },
    state: "running",
    ...overrides,
  };
}

describe("decideWorkerAction", () => {
  it("never acts on a dead worker — recovery belongs to the subsystem", () => {
    const decision = decideWorkerAction(
      snapshot({ alive: false, eligibility: { trim: true, dispose: true, restart: true } }),
      { now: NOW, memoryPressure: true }
    );
    expect(decision.action).toBe("none");
  });

  it("disposes an eligible worker only when idle with no queue and no sessions", () => {
    const eligible = { trim: false, dispose: true, restart: false };
    expect(
      decideWorkerAction(snapshot({ eligibility: eligible }), {
        now: NOW,
        memoryPressure: false,
      }).action
    ).toBe("dispose");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible, queueDepth: 1 }), {
        now: NOW,
        memoryPressure: true,
      }).action
    ).toBe("none");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible, activeSessionCount: 2 }), {
        now: NOW,
        memoryPressure: true,
      }).action
    ).toBe("none");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible, lastActivityAt: NOW - 1000 }), {
        now: NOW,
        memoryPressure: true,
      }).action
    ).toBe("none");
  });

  it("treats unknown activity as active — no dispose without a timestamp", () => {
    const decision = decideWorkerAction(
      snapshot({
        eligibility: { trim: false, dispose: true, restart: false },
        lastActivityAt: null,
      }),
      { now: NOW, memoryPressure: true }
    );
    expect(decision.action).toBe("none");
  });

  it("never restarts unless the subsystem explicitly opted in", () => {
    // No subsystem in this codebase sets restart eligibility (Electron
    // worker-churn crash) — an idle, empty worker must still come back "none".
    const decision = decideWorkerAction(
      snapshot({ eligibility: { trim: true, dispose: false, restart: false } }),
      { now: NOW, memoryPressure: false }
    );
    expect(decision.action).toBe("none");
  });

  it("blocks restart during cooldown and under crash-looping", () => {
    const eligible = { trim: false, dispose: false, restart: true };
    expect(
      decideWorkerAction(snapshot({ eligibility: eligible }), {
        now: NOW,
        memoryPressure: false,
      }).action
    ).toBe("restart");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible }), {
        now: NOW,
        memoryPressure: false,
        lastRestartAt: NOW - 1000,
      }).action
    ).toBe("none");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible }), {
        now: NOW,
        memoryPressure: false,
        recentCrashCount: WORKER_CRASH_LOOP_LIMIT,
      }).action
    ).toBe("none");
  });

  it("never restarts a worker with in-flight work even past cooldown", () => {
    const decision = decideWorkerAction(
      snapshot({ eligibility: { trim: false, dispose: false, restart: true }, queueDepth: 3 }),
      { now: NOW, memoryPressure: true }
    );
    expect(decision.action).toBe("none");
  });

  it("trims an eligible worker only under memory pressure", () => {
    const eligible = { trim: true, dispose: false, restart: false };
    expect(
      decideWorkerAction(snapshot({ eligibility: eligible, activeSessionCount: 4 }), {
        now: NOW,
        memoryPressure: true,
      }).action
    ).toBe("trim");

    expect(
      decideWorkerAction(snapshot({ eligibility: eligible, activeSessionCount: 4 }), {
        now: NOW,
        memoryPressure: false,
      }).action
    ).toBe("none");
  });

  it("prefers dispose over trim when both apply", () => {
    const decision = decideWorkerAction(
      snapshot({ eligibility: { trim: true, dispose: true, restart: false } }),
      { now: NOW, memoryPressure: true }
    );
    expect(decision.action).toBe("dispose");
  });
});

describe("shouldTrimAnalysisSession", () => {
  const base = {
    lastInputTime: NOW - HOUR,
    lastOutputTime: NOW - HOUR,
    scrollbackLines: 10_000,
    minScrollbackLines: 1_000,
    now: NOW,
  };

  it("trims a long-idle session with no active agent", () => {
    expect(shouldTrimAnalysisSession(base)).toBe(true);
    expect(shouldTrimAnalysisSession({ ...base, agentState: "idle" })).toBe(true);
    expect(shouldTrimAnalysisSession({ ...base, agentState: "completed" })).toBe(true);
    expect(shouldTrimAnalysisSession({ ...base, agentState: "exited" })).toBe(true);
  });

  it("protects every active agent state regardless of idle time", () => {
    expect(shouldTrimAnalysisSession({ ...base, agentState: "working" })).toBe(false);
    expect(shouldTrimAnalysisSession({ ...base, agentState: "waiting" })).toBe(false);
    expect(shouldTrimAnalysisSession({ ...base, agentState: "directing" })).toBe(false);
  });

  it("uses the most recent of input and output as the activity edge", () => {
    expect(
      shouldTrimAnalysisSession({ ...base, lastInputTime: NOW - 1000, lastOutputTime: NOW - HOUR })
    ).toBe(false);
    expect(
      shouldTrimAnalysisSession({ ...base, lastOutputTime: NOW - 1000, lastInputTime: NOW - HOUR })
    ).toBe(false);
  });

  it("respects the idle threshold boundary", () => {
    const edge = NOW - ANALYSIS_SESSION_IDLE_TRIM_MS;
    expect(shouldTrimAnalysisSession({ ...base, lastInputTime: edge, lastOutputTime: edge })).toBe(
      true
    );
    expect(
      shouldTrimAnalysisSession({ ...base, lastInputTime: edge + 1, lastOutputTime: edge + 1 })
    ).toBe(false);
  });

  it("skips sessions already at or below the trim floor", () => {
    expect(shouldTrimAnalysisSession({ ...base, scrollbackLines: 1_000 })).toBe(false);
    expect(shouldTrimAnalysisSession({ ...base, scrollbackLines: 500 })).toBe(false);
  });
});

describe("canDisposeIdlePluginWorker", () => {
  const idle = {
    isBuiltin: false,
    devMode: false,
    panelContributionCount: 0,
    mcpServerContributionCount: 0,
    startupActivation: false,
    eventSubscriptionCount: 0,
    imperativeActionCount: 0,
    pendingInvokeCount: 0,
    pendingHostCallCount: 0,
    managedProcessCount: 0,
    fsWatcherCount: 0,
    lastActivityAt: NOW - HOUR,
    now: NOW,
  };

  it("allows a fully idle prod user plugin", () => {
    expect(canDisposeIdlePluginWorker(idle).ok).toBe(true);
  });

  it("rejects every live surface a dead worker would break", () => {
    expect(canDisposeIdlePluginWorker({ ...idle, isBuiltin: true }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, devMode: true }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, panelContributionCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, mcpServerContributionCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, startupActivation: true }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, eventSubscriptionCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, imperativeActionCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, pendingInvokeCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, pendingHostCallCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, managedProcessCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, fsWatcherCount: 1 }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, lastActivityAt: null }).ok).toBe(false);
    expect(canDisposeIdlePluginWorker({ ...idle, lastActivityAt: NOW - 1000 }).ok).toBe(false);
  });

  it("honors a caller-supplied idle threshold", () => {
    expect(
      canDisposeIdlePluginWorker({ ...idle, lastActivityAt: NOW - 5_000, idleDisposeMs: 4_000 }).ok
    ).toBe(true);
  });
});
