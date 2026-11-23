import { describe, expect, it } from "vitest";
import type {
  AgentUsageReading,
  ClaudeAgentUsageReading,
  CodexAgentUsageReading,
} from "../../types/ipc/agentUsage.js";
import {
  AGENT_USAGE_SHOWN_FOR_MS,
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

  it("drops a reading once it has gone unobserved too long, so a fresher looser one shows (#18159)", () => {
    const seen = NOW - AGENT_USAGE_SHOWN_FOR_MS;
    const old = claude({ usedPercent: 99, resetsAt: NOW + 86_400_000, observedAt: seen });
    const fresh = claude({ usedPercent: 10, resetsAt: NOW + 86_400_000 });
    expect(tightestAgentUsage([old, fresh], (r) => r, NOW - 1)).toEqual([old]);
    expect(tightestAgentUsage([old, fresh], (r) => r, NOW)).toEqual([fresh]);
    expect(tightestAgentUsage([old], (r) => r, NOW)).toEqual([]);
    // Observed again, the same limit shows for another full span.
    const again = { ...old, observedAt: NOW - 1 };
    expect(tightestAgentUsage([again, fresh], (r) => r, NOW + AGENT_USAGE_SHOWN_FOR_MS - 2)).toEqual(
      [again]
    );
  });

  it("ages out a reading that names no reset as well", () => {
    const open = codex({ resetsAt: null, observedAt: NOW - AGENT_USAGE_SHOWN_FOR_MS });
    expect(tightestAgentUsage([open], (r) => r, NOW)).toEqual([]);
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

  it("never lets an aged-out tight reading keep a fresher one from being sent (#18159)", () => {
    const old = claude({
      usedPercent: 99,
      resetsAt: NOW + 86_400_000,
      observedAt: NOW - AGENT_USAGE_SHOWN_FOR_MS - 1,
    });
    const fresh = claude({ window: "5-hour limit", usedPercent: 20, resetsAt: NOW + 3_600_000 });
    expect(agentUsageWithSuccessors([old, fresh], NOW)).toEqual([fresh]);
  });

  it("sends what takes over when a winner ages out before its reset", () => {
    const weekly = codex({
      usedPercent: 95,
      windowDurationMins: 10080,
      resetsAt: NOW + 86_400_000,
      observedAt: NOW - AGENT_USAGE_SHOWN_FOR_MS + 60_000,
    });
    // Resets after the weekly ages out, though long before the weekly's reset.
    const fiveHour = codex({ usedPercent: 30, resetsAt: NOW + 3_600_000 });
    // Ages out before the weekly does, so it can't take over from it.
    const older = codex({
      usedPercent: 60,
      resetsAt: null,
      observedAt: NOW - AGENT_USAGE_SHOWN_FOR_MS + 30_000,
    });
    expect(agentUsageWithSuccessors([weekly, older, fiveHour], NOW)).toEqual([weekly, fiveHour]);
  });

  it("sends a winner that names no reset with what outlasts its age-out", () => {
    const open = claude({ statement: "approaching", usedPercent: null, resetsAt: null });
    const later = claude({ usedPercent: 10, resetsAt: null, observedAt: NOW });
    expect(agentUsageWithSuccessors([open, later], NOW)).toEqual([open, later]);
  });

  it("never sends a successor that ends with the winner, even on an equal rank", () => {
    const winner = codex({ usedPercent: 70, resetsAt: NOW + 1_000 });
    const sameEnd = codex({ usedPercent: 70, resetsAt: NOW + 1_000, windowDurationMins: 10080 });
    const longer = codex({ usedPercent: 20, resetsAt: NOW + 2_000 });
    expect(agentUsageWithSuccessors([winner, sameEnd, longer], NOW)).toEqual([winner, longer]);
  });

  it("sends a winner alone when nothing it outranks is shown longer", () => {
    const open = claude({ statement: "approaching", usedPercent: null, resetsAt: null });
    expect(agentUsageWithSuccessors([open, claude({ usedPercent: 10 })], NOW)).toEqual([open]);
    const only = codex({ resetsAt: NOW + 1_000 });
    expect(agentUsageWithSuccessors([only], NOW)).toEqual([only]);
  });
});
