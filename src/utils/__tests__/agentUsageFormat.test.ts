import { describe, expect, it } from "vitest";
import type {
  AgentUsageReadout,
  ClaudeAgentUsageReading,
  CodexAgentUsageReading,
} from "@shared/types/ipc/agentUsage";
import { describeAgentUsage } from "../agentUsageFormat";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();

function codex(overrides: Partial<CodexAgentUsageReading> = {}): AgentUsageReadout {
  return {
    hostId: "local",
    hostName: null,
    reading: {
      agentId: "codex",
      accountNames: [],
      isDefault: true,
      windowDurationMins: 300,
      usedPercent: 82.7,
      resetsAt: null,
      observedAt: NOW - 60_000,
      ...overrides,
    },
  };
}

function claude(overrides: Partial<ClaudeAgentUsageReading> = {}): AgentUsageReadout {
  return {
    hostId: "local",
    hostName: null,
    reading: {
      agentId: "claude",
      accountNames: [],
      isDefault: true,
      window: "weekly limit",
      statement: "used",
      usedPercent: 40,
      resetsAt: null,
      observedAt: NOW - 12 * 60_000,
      ...overrides,
    },
  };
}

describe("describeAgentUsage", () => {
  it("names the agent, the figure and the reset, leaving an unnamed default login out of the row", () => {
    const resetsAt = new Date(2026, 10, 18, 15, 40).getTime();
    const line = describeAgentUsage(codex({ resetsAt }), "Codex", NOW);
    expect(line.text).toMatch(/^Codex 82% · resets \S/);
    expect(line.attention).toBe(true);
    expect(line.stale).toBe(false);
    expect(line.detail[0]).toMatch(/^5-hour limit 82% used · resets /);
    expect(line.detail[1]).toBe("Default profile");
    expect(line.detail[2]).toBe("Read from Codex 1m ago");
  });

  it("names the account and the host a reading is from", () => {
    const line = describeAgentUsage(
      {
        ...codex({ accountNames: ["Work"], isDefault: false }),
        hostId: "vps",
        hostName: "Build VPS",
      },
      "Codex",
      NOW
    );
    expect(line.text).toBe("Codex 82% · Work · Build VPS");
    expect(line.detail[1]).toBe("Work on Build VPS");
  });

  it("floors the figure, so one shown as 80% always carries the attention tone", () => {
    const line = describeAgentUsage(codex({ usedPercent: 79.9 }), "Codex", NOW);
    expect(line.text).toBe("Codex 79%");
    expect(line.attention).toBe(false);
  });

  it("marks a Codex reading that missed its five-minute read as stale, never a Claude Code one", () => {
    expect(describeAgentUsage(codex({ observedAt: NOW - 4 * 60_000 }), "Codex", NOW).stale).toBe(
      false
    );
    const stale = describeAgentUsage(codex({ observedAt: NOW - 20 * 60_000 }), "Codex", NOW);
    expect(stale.stale).toBe(true);
    expect(stale.text).toBe("Stale · Codex 82%");
    expect(describeAgentUsage(claude({ observedAt: NOW - 3_600_000 }), "Claude", NOW).stale).toBe(
      false
    );
  });

  it("words what Claude Code printed as it said it, with how long ago", () => {
    const approaching = describeAgentUsage(
      claude({ statement: "approaching", usedPercent: null }),
      "Claude",
      NOW
    );
    expect(approaching.text).toBe("Claude approaching weekly limit");
    expect(approaching.attention).toBe(true);
    expect(approaching.detail).toEqual([
      "Approaching weekly limit",
      "Default login",
      "Printed in a terminal 12m ago",
    ]);
    expect(
      describeAgentUsage(claude({ statement: "reached", usedPercent: null }), "Claude", NOW).text
    ).toBe("Claude weekly limit reached");
    const over = describeAgentUsage(claude({ statement: "over", usedPercent: 90 }), "Claude", NOW);
    expect(over.text).toBe("Claude over 90%");
    expect(over.detail[0]).toBe("Weekly limit over 90% used");
    const low = describeAgentUsage(claude({ isDefault: false }), "Claude", NOW);
    expect(low.attention).toBe(false);
    expect(low.detail[1]).toBe("Other config folder");
  });
});
