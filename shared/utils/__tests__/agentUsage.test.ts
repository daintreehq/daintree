import { describe, expect, it } from "vitest";
import type {
  AgentUsageReading,
  ClaudeAgentUsageReading,
  CodexAgentUsageReading,
} from "../../types/ipc/agentUsage.js";
import {
  agentUsageWithSuccessors,
  compareAgentUsage,
  isAgentUsagePastAttention,
  tightestAgentUsage,
} from "../agentUsage.js";

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

describe("agent usage selection boundaries", () => {
  it("keeps an over floor under the threshold neutral, and puts exactly 80% above approaching", () => {
    expect(isAgentUsagePastAttention(claude({ statement: "over", usedPercent: 79 }))).toBe(false);
    const approaching = claude({ statement: "approaching", usedPercent: null });
    expect(compareAgentUsage(claude({ usedPercent: 80 }), approaching)).toBeGreaterThan(0);
    expect(compareAgentUsage(approaching, claude({ usedPercent: 80 }))).toBeLessThan(0);
    expect(
      compareAgentUsage(
        claude({ statement: "reached", usedPercent: null }),
        codex({ usedPercent: 100 })
      )
    ).toBeGreaterThan(0);
  });

  it("orders both ways, and takes the newer reading before the shorter window", () => {
    expect(compareAgentUsage(codex({ usedPercent: 81 }), codex({ usedPercent: 82 }))).toBeLessThan(
      0
    );
    expect(
      compareAgentUsage(
        codex({ windowDurationMins: 10080, observedAt: NOW }),
        codex({ windowDurationMins: 300, observedAt: NOW - 1 })
      )
    ).toBeGreaterThan(0);
  });

  it("keeps the first of two equal readings, and the winner over a weaker one after it", () => {
    const first = codex({ usedPercent: 70 });
    const tie = codex({ usedPercent: 70 });
    const weaker = codex({ usedPercent: 10 });
    expect(tightestAgentUsage([first, tie, weaker], (r) => r, NOW)[0]).toBe(first);
  });

  it("drops a reading whose reset is already behind", () => {
    expect(tightestAgentUsage([codex({ resetsAt: NOW - 1 })], (r) => r, NOW)).toEqual([]);
  });
});

describe("agentUsageWithSuccessors", () => {
  it("sends, beside each winner that resets, the tightest reading that outlasts it", () => {
    const fiveHour = codex({ usedPercent: 95, resetsAt: NOW + 1_000 });
    const weekly = codex({
      usedPercent: 85,
      windowDurationMins: 10080,
      resetsAt: NOW + 86_400_000,
    });
    const sooner = codex({ usedPercent: 90, windowDurationMins: 60, resetsAt: NOW + 500 });
    expect(agentUsageWithSuccessors([sooner, weekly, fiveHour], NOW)).toEqual([fiveHour, weekly]);
  });

  it("sends a winner alone when it names no reset, or nothing outlasts it", () => {
    const open = claude({ statement: "approaching", usedPercent: null, resetsAt: null });
    expect(agentUsageWithSuccessors([open, claude({ usedPercent: 10 })], NOW)).toEqual([open]);
    const only = codex({ resetsAt: NOW + 1_000 });
    expect(agentUsageWithSuccessors([only], NOW)).toEqual([only]);
  });
});
