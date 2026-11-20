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

  it("names a default login by the name its own host gave it, and an account's reading never (#17080)", () => {
    const named = describeAgentUsage(
      { ...codex({ defaultLoginName: "Work" }), hostId: "h1", hostName: "Studio" },
      "Codex",
      NOW
    );
    expect(named.text).toMatch(/^Codex 82% · Work · Studio/);
    expect(named.detail[1]).toBe("Work · default login on Studio");
    const aliased = describeAgentUsage(
      claude({ defaultLoginName: "Home", accountNames: ["Personal"] }),
      "Claude",
      NOW
    );
    expect(aliased.text).toBe("Claude 40% · Home, Personal");
    expect(aliased.detail[1]).toBe("Home · default login · Personal");
    const account = describeAgentUsage(
      codex({ isDefault: false, accountNames: ["Lab"], defaultLoginName: "Work" }),
      "Codex",
      NOW
    );
    expect(account.text).toMatch(/^Codex 82% · Lab$/);
    expect(account.detail[1]).toBe("Lab");
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

  it("takes the tone at exactly 80%", () => {
    expect(describeAgentUsage(codex({ usedPercent: 80 }), "Codex", NOW).attention).toBe(true);
  });

  it("names every account on a login, and the host a reading came from", () => {
    const line = describeAgentUsage(
      {
        ...codex({ accountNames: ["Work", "Team"], isDefault: false }),
        hostId: "h1",
        hostName: "Studio",
      },
      "Codex",
      NOW
    );
    expect(line.text).toBe("Codex 82% · Work, Team · Studio");
    expect(line.detail[1]).toBe("Work, Team on Studio");
  });

  it("turns stale just past the five-minute cadence and its slack, not before", () => {
    const edge = 7 * 60_000;
    expect(describeAgentUsage(codex({ observedAt: NOW - edge }), "Codex", NOW).stale).toBe(false);
    expect(describeAgentUsage(codex({ observedAt: NOW - edge - 1 }), "Codex", NOW).stale).toBe(
      true
    );
  });

  it("words a used figure as printed, with the age in the detail and not the row", () => {
    const line = describeAgentUsage(claude({ usedPercent: 85.6 }), "Claude", NOW);
    expect(line.text).toBe("Claude 85%");
    expect(line.row).toBe("85%");
    expect(line.detail[0]).toBe("Weekly limit 85% used");
    expect(line.detail[2]).toBe("Printed in a terminal 12m ago");
  });

  it("keeps the agent, login and machine out of the dense row, and the reset in", () => {
    const resetsAt = new Date(2026, 10, 18, 15, 40).getTime();
    const named = describeAgentUsage(
      {
        ...claude({ defaultLoginName: "Home", accountNames: ["Personal"], resetsAt }),
        hostId: "h1",
        hostName: "Studio",
      },
      "Claude",
      NOW
    );
    expect(named.row).toMatch(/^40% · resets \S/);
    expect(named.row).not.toMatch(/Claude|Home|Personal|Studio/);
    expect(named.text).toMatch(/^Claude 40% · Home, Personal · Studio · resets /);
    expect(describeAgentUsage(codex(), "Codex", NOW).row).toBe("82%");
  });

  it("words every Claude Code statement and a stale Codex reading in the dense row", () => {
    const resetsAt = new Date(2026, 10, 18, 15, 40).getTime();
    const row = (readout: AgentUsageReadout) => describeAgentUsage(readout, "X", NOW).row;
    expect(row(claude({ statement: "approaching", usedPercent: null }))).toBe("Near limit");
    expect(row(claude({ statement: "reached", usedPercent: null }))).toBe("Limit reached");
    expect(row(claude({ statement: "over", usedPercent: 90 }))).toBe("Over 90%");
    expect(row(codex({ observedAt: NOW - 20 * 60_000 }))).toBe("82% · stale");
    expect(row(codex({ observedAt: NOW - 20 * 60_000, resetsAt }))).toMatch(
      /^82% · stale · resets \S/
    );
    // The window stays in the text and the detail the row drops it from.
    const approaching = describeAgentUsage(
      claude({ statement: "approaching", usedPercent: null }),
      "Claude",
      NOW
    );
    expect(approaching.text).toBe("Claude approaching weekly limit");
    expect(approaching.detail[0]).toBe("Approaching weekly limit");
  });
});
