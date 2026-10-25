import { describe, expect, it } from "vitest";
import {
  AGENT_DIRECTORY_BYTES_MAX,
  AGENT_DIRECTORY_LABEL_MAX,
  cutAgentLabel,
  fitAgentDirectory,
  type AgentDirectory,
  type AgentDirectoryLiveEntry,
} from "../agentDirectory.js";

function entry(index: number): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "worker",
    subject: {
      hostId: "local",
      scope: { kind: "project", projectId: "p" },
      terminalId: `terminal-${index}`,
      incarnation: 1,
    },
    agentId: "claude",
    agentState: "idle",
    waitingReason: null,
    since: null,
    label: "x".repeat(AGENT_DIRECTORY_LABEL_MAX),
    attached: null,
    handback: null,
  };
}

describe("fitAgentDirectory", () => {
  it("keeps what fits the byte budget and counts the rest as omitted", () => {
    const directory: AgentDirectory = {
      coverage: "ok",
      observedAt: 1,
      complete: true,
      omitted: 2,
      entries: Array.from({ length: 256 }, (_, index) => entry(index)),
    };
    const fitted = fitAgentDirectory(directory);

    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(
      AGENT_DIRECTORY_BYTES_MAX
    );
    expect(fitted.entries.length).toBeLessThan(256);
    expect(fitted.entries.length + fitted.omitted).toBe(258);
    expect(fitted.entries[0]).toEqual(directory.entries[0]);
  });

  it("returns a directory that already fits unchanged", () => {
    const directory: AgentDirectory = {
      coverage: "ok",
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [entry(0)],
    };
    expect(fitAgentDirectory(directory)).toBe(directory);
  });

  it("stays within every budget as its omitted count gains digits", () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const directory: AgentDirectory = {
      coverage: "ok",
      observedAt: 1,
      complete: true,
      omitted: 9,
      entries: Array.from({ length: 120 }, (_, index) => entry(index)),
    };
    for (let budget = 200; budget <= bytes(directory); budget += 37) {
      const fitted = fitAgentDirectory(directory, budget);
      expect(bytes(fitted)).toBeLessThanOrEqual(
        Math.max(budget, bytes({ ...fitted, entries: [] }))
      );
      expect(fitted.entries.length + fitted.omitted).toBe(129);
    }
  });

  it("keeps an entry that fits its budget exactly", () => {
    const one: AgentDirectory = {
      coverage: "ok",
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [entry(0), entry(1)],
    };
    const first = { ...one, omitted: 1, entries: [entry(0)] };
    const budget = new TextEncoder().encode(JSON.stringify(first)).length;
    expect(fitAgentDirectory(one, budget)).toEqual(first);
  });
});

describe("cutAgentLabel", () => {
  it("collapses whitespace, cuts long labels and drops empty ones", () => {
    expect(cutAgentLabel("  a \n b ")).toBe("a b");
    expect(cutAgentLabel("y".repeat(500))?.length).toBe(AGENT_DIRECTORY_LABEL_MAX);
    expect(cutAgentLabel("   ")).toBeNull();
    expect(cutAgentLabel(undefined)).toBeNull();
  });
});
