import { describe, expect, it } from "vitest";
import type {
  AgentUsageReading,
  ClaudeAgentUsageReading,
  CodexAgentUsageReading,
} from "../../types/ipc/agentUsage.js";
import { compareAgentUsage, isAgentUsagePastAttention, tightestAgentUsage } from "../agentUsage.js";

const NOW = 1_800_000_000_000;

function codex(overrides: Partial<CodexAgentUsageReading> = {}): CodexAgentUsageReading {
  return {
    agentId: "codex",
    accountNames: [],
    isDefault: true,
    windowDurationMins: 300,
    usedPercent: 40,
    resetsAt: NOW + 3_600_000,
    observedAt: NOW - 60_000,
    ...overrides,
  };
}

function claude(overrides: Partial<ClaudeAgentUsageReading> = {}): ClaudeAgentUsageReading {
  return {
    agentId: "claude",
    accountNames: [],
    isDefault: true,
    window: "weekly limit",
    statement: "used",
    usedPercent: 40,
    resetsAt: NOW + 3_600_000,
    observedAt: NOW - 60_000,
    ...overrides,
  };
}

describe("isAgentUsagePastAttention", () => {
  it("takes the threshold at 80% of the raw figure, not the rounded one", () => {
    expect(isAgentUsagePastAttention(codex({ usedPercent: 79.9 }))).toBe(false);
    expect(isAgentUsagePastAttention(codex({ usedPercent: 80 }))).toBe(true);
    expect(isAgentUsagePastAttention(claude({ usedPercent: 79.6 }))).toBe(false);
    expect(isAgentUsagePastAttention(claude({ statement: "over", usedPercent: 80 }))).toBe(true);
  });

  it("counts Claude Code's approaching and reached messages as past it", () => {
    expect(isAgentUsagePastAttention(claude({ statement: "approaching", usedPercent: null }))).toBe(
      true
    );
    expect(isAgentUsagePastAttention(claude({ statement: "reached", usedPercent: null }))).toBe(
      true
    );
  });
});

describe("compareAgentUsage", () => {
  it("never lets a low figure hide an approaching message", () => {
    const approaching = claude({ statement: "approaching", usedPercent: null });
    expect(compareAgentUsage(approaching, claude({ usedPercent: 12 }))).toBeGreaterThan(0);
    expect(compareAgentUsage(claude({ usedPercent: 85 }), approaching)).toBeGreaterThan(0);
    expect(
      compareAgentUsage(
        claude({ statement: "reached", usedPercent: null }),
        claude({ usedPercent: 99 })
      )
    ).toBeGreaterThan(0);
  });

  it("ranks the higher figure, then a floor above an exact equal figure", () => {
    expect(
      compareAgentUsage(codex({ usedPercent: 82 }), codex({ usedPercent: 81 }))
    ).toBeGreaterThan(0);
    expect(
      compareAgentUsage(claude({ statement: "over", usedPercent: 90 }), claude({ usedPercent: 90 }))
    ).toBeGreaterThan(0);
  });

  it("breaks a tie by the newer reading, then the shorter Codex window", () => {
    expect(
      compareAgentUsage(codex({ observedAt: NOW }), codex({ observedAt: NOW - 1 }))
    ).toBeGreaterThan(0);
    expect(
      compareAgentUsage(codex({ windowDurationMins: 300 }), codex({ windowDurationMins: 10080 }))
    ).toBeGreaterThan(0);
  });
});

describe("tightestAgentUsage", () => {
  it("keeps one reading per agent, in the order each agent first appears", () => {
    const readings: AgentUsageReading[] = [
      claude({ usedPercent: 20 }),
      codex({ usedPercent: 30 }),
      codex({ usedPercent: 85, windowDurationMins: 10080 }),
      claude({ statement: "approaching", usedPercent: null }),
    ];
    expect(tightestAgentUsage(readings, (r) => r, NOW)).toEqual([readings[3], readings[2]]);
  });

  it("drops a reading once its reset passes, so a runner-up shows", () => {
    const over = codex({ usedPercent: 95, resetsAt: NOW });
    const live = codex({ usedPercent: 10, windowDurationMins: 10080, resetsAt: null });
    expect(tightestAgentUsage([over, live], (r) => r, NOW)).toEqual([live]);
    expect(tightestAgentUsage([over], (r) => r, NOW)).toEqual([]);
  });
});
