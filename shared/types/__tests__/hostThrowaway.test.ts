import { describe, expect, it } from "vitest";
import {
  HostThrowawayCallSchema,
  HostThrowawayRunSchema,
  HostThrowawayToolResultSchema,
  MAX_THROWAWAY_TIME_LIMIT_MS,
} from "../hostThrowaway.js";

const RUNNING = {
  runId: "run-1",
  agentId: "claude",
  startedAt: 1_000,
  ageMs: 500,
  timeLimitMs: null,
  expiresAt: null,
  state: "running",
  endedAt: null,
  endReason: null,
};

describe("throwaway tools (#14444)", () => {
  it("takes each tool with only its own arguments", () => {
    const valid = [
      { tool: "throwaway.launch", args: { agentId: "claude" } },
      { tool: "throwaway.launch", args: { agentId: "claude", timeLimitMs: 60_000 } },
      { tool: "throwaway.status", args: { runId: "run-1" } },
      { tool: "throwaway.output", args: { runId: "run-1", maxLines: 40 } },
      { tool: "throwaway.sendCommand", args: { runId: "run-1", command: "/usage" } },
      { tool: "throwaway.sendKeys", args: { runId: "run-1", keys: ["Escape"] } },
      { tool: "throwaway.close", args: { runId: "run-1" } },
    ];
    for (const call of valid) expect(HostThrowawayCallSchema.safeParse(call).success).toBe(true);
  });

  it("refuses anything that would reach past the run: folders, projects, other tools, other runs' shapes", () => {
    const invalid = [
      { tool: "agent.launch", args: { agentId: "claude" } },
      { tool: "throwaway.launch", args: { agentId: "claude", cwd: "/repo" } },
      { tool: "throwaway.launch", args: { agentId: "claude", worktreeId: "w" } },
      { tool: "throwaway.launch", args: { agentId: "claude", timeLimitMs: MAX_THROWAWAY_TIME_LIMIT_MS + 1 } },
      { tool: "throwaway.status", args: {} },
      { tool: "throwaway.status", args: { runId: "run-1", projectId: "p" } },
      { tool: "throwaway.sendCommand", args: { runId: "run-1", command: "" } },
      { tool: "throwaway.sendKeys", args: { runId: "run-1", keys: ["ctrl+c"] } },
      { tool: "throwaway.close", args: { terminalId: "t-1" } },
    ];
    for (const call of invalid) expect(HostThrowawayCallSchema.safeParse(call).success).toBe(false);
  });

  it("carries a run's time limit and deadline together, and an end only once it has ended", () => {
    const limited = { ...RUNNING, timeLimitMs: 60_000, expiresAt: 61_000 };
    const ended = { ...RUNNING, state: "closed", endedAt: 1_500, endReason: "close" };
    expect(HostThrowawayRunSchema.safeParse(RUNNING).success).toBe(true);
    expect(HostThrowawayRunSchema.safeParse(limited).success).toBe(true);
    expect(HostThrowawayRunSchema.safeParse(ended).success).toBe(true);

    expect(HostThrowawayRunSchema.safeParse({ ...RUNNING, timeLimitMs: 60_000 }).success).toBe(false);
    expect(HostThrowawayRunSchema.safeParse({ ...RUNNING, expiresAt: 61_000 }).success).toBe(false);
    expect(HostThrowawayRunSchema.safeParse({ ...ended, endedAt: null }).success).toBe(false);
    expect(HostThrowawayRunSchema.safeParse({ ...RUNNING, endReason: "exit" }).success).toBe(false);
  });

  it("answers each tool in its own shape, around the run", () => {
    expect(
      HostThrowawayToolResultSchema.safeParse({
        tool: "throwaway.output",
        run: RUNNING,
        content: "Current week: 12%",
        lineCount: 1,
        truncated: false,
      }).success
    ).toBe(true);
    expect(
      HostThrowawayToolResultSchema.safeParse({ tool: "throwaway.output", run: RUNNING }).success
    ).toBe(false);
    expect(
      HostThrowawayToolResultSchema.safeParse({ tool: "throwaway.close", run: RUNNING, closed: false })
        .success
    ).toBe(false);
  });
});
