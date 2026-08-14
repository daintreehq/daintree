import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompletionAcknowledgementService,
  COMPLETION_ACK_DWELL_MS,
} from "../CompletionAcknowledgementService.js";
import type { ProjectStatusMap } from "../../../shared/types/ipc/project.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";

const BASE = 1_700_000_000_000;
const TICK = 1_000;

function entry(overrides: Partial<ProjectStatusMap[string]>): ProjectStatusMap[string] {
  return {
    processCount: 1,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

describe("CompletionAcknowledgementService", () => {
  let now: number;
  let observed: string | null;
  let statusMap: ProjectStatusMap;
  let stamps: Array<{ projectId: string; seenUpTo: number }>;
  let refreshes: number;
  let service: CompletionAcknowledgementService;

  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      now += TICK;
      service.sample();
    }
  };

  beforeEach(() => {
    now = BASE;
    observed = null;
    statusMap = {};
    stamps = [];
    refreshes = 0;
    service = new CompletionAcknowledgementService({
      getObservedProjectId: () => observed,
      getStatusMap: () => statusMap,
      markSeen: (projectId, seenUpTo) => stamps.push({ projectId, seenUpTo }),
      onAcknowledged: () => refreshes++,
      now: () => now,
    });
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
  });

  it("stamps the latest unacknowledged completion after a continuous dwell", () => {
    const completedAt = BASE - 60_000;
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: completedAt,
      }),
    };
    observed = "alpha";

    tick(); // first sight starts the dwell
    tick(); // 1s — under the dwell
    expect(stamps).toHaveLength(0);
    tick(); // 2s — dwell satisfied
    expect(stamps).toEqual([{ projectId: "alpha", seenUpTo: completedAt }]);
    expect(refreshes).toBe(1);
  });

  it("never acknowledges without an observed project", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    observed = null;
    tick(30);
    expect(stamps).toHaveLength(0);
  });

  it("a sub-dwell glance never clears review work", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    // Look at alpha for one tick, bounce to beta, come back.
    observed = "alpha";
    tick();
    observed = "beta";
    tick();
    observed = "alpha";
    tick(); // dwell restarted — 0s continuous
    tick(); // 1s
    expect(stamps).toHaveLength(0);
    tick(); // 2s continuous this time
    expect(stamps).toHaveLength(1);
  });

  it("losing window focus resets the dwell", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    observed = "alpha";
    tick();
    observed = null; // app blurred
    tick();
    observed = "alpha";
    tick();
    tick();
    expect(stamps).toHaveLength(0);
    tick();
    expect(stamps).toHaveLength(1);
  });

  it("a completion landing mid-dwell gets its own two seconds", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    observed = "alpha";
    tick(); // dwell starts
    // A second agent finishes right now.
    statusMap = {
      alpha: entry({
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 2,
        latestUnacknowledgedCompletionAt: now,
      }),
    };
    const freshCompletionAt = now;
    tick(); // 1s after the fresh completion
    expect(stamps).toHaveLength(0);
    tick(); // 2s after it
    expect(stamps).toEqual([{ projectId: "alpha", seenUpTo: freshCompletionAt }]);
  });

  it("does nothing when the observed project has nothing unacknowledged", () => {
    statusMap = {
      alpha: entry({ completedAgentCount: 2, unacknowledgedCompletedAgentCount: 0 }),
    };
    observed = "alpha";
    tick(10);
    expect(stamps).toHaveLength(0);
    expect(refreshes).toBe(0);
  });

  it("holds the stamp under disk pressure and retries once writes resume", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    observed = "alpha";
    setWritesSuppressed(true);
    tick(5);
    expect(stamps).toHaveLength(0);
    setWritesSuppressed(false);
    tick();
    expect(stamps).toHaveLength(1);
  });

  it("a later completion re-enters after an acknowledgement", () => {
    const firstAt = BASE - 60_000;
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: firstAt,
      }),
    };
    observed = "alpha";
    tick(3);
    expect(stamps).toEqual([{ projectId: "alpha", seenUpTo: firstAt }]);

    // The stamp cleared the entry; a newer completion arrives later.
    statusMap = { alpha: entry({ completedAgentCount: 1, unacknowledgedCompletedAgentCount: 0 }) };
    tick(5);
    const secondAt = now;
    statusMap = {
      alpha: entry({
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: secondAt,
      }),
    };
    tick(); // 1s after second completion
    expect(stamps).toHaveLength(1);
    tick(); // 2s
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toEqual({ projectId: "alpha", seenUpTo: secondAt });
  });

  it("dwell requirement uses continuous observation, not cumulative", () => {
    statusMap = {
      alpha: entry({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: BASE - 60_000,
      }),
    };
    // Alternate every tick — cumulative time on alpha far exceeds the dwell,
    // continuous time never does.
    for (let i = 0; i < 10; i++) {
      observed = i % 2 === 0 ? "alpha" : "beta";
      tick();
    }
    expect(stamps).toHaveLength(0);
  });

  it("dwell constant matches the sampling reality (sanity)", () => {
    // Guards against the dwell accidentally dropping below the sample interval
    // — the "continuous" guarantee needs at least two observations.
    expect(COMPLETION_ACK_DWELL_MS).toBeGreaterThanOrEqual(2 * TICK);
  });
});
