import { describe, expect, it } from "vitest";
import type { ProjectStatusAnswer } from "../linkMethods.js";
import { fitProjectStatuses, redactStatusEntry } from "../projectStatusRead.js";

const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2";

describe("redactStatusEntry (#16191)", () => {
  it("redacts everything read off a screen and keeps every state and time", () => {
    const entry = {
      terminalId: "t-1",
      agentId: "claude",
      agentState: "waiting",
      lastTransitionAt: 3,
      recentOutput: `token ${TOKEN}`,
      recentOutputTruncated: true,
      lastHandback: { message: `done, ${TOKEN}`, observedAt: 2, truncated: false },
      lastCheckResult: {
        command: `curl -H "Authorization: Bearer ${TOKEN}"`,
        passed: false,
        ranAt: 1,
        failureSummary: `401 for ${TOKEN}`,
        truncated: false,
      },
    };
    const redacted = redactStatusEntry(entry);
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(redacted).toMatchObject({
      terminalId: "t-1",
      agentState: "waiting",
      lastTransitionAt: 3,
      recentOutputTruncated: true,
      lastHandback: { observedAt: 2, truncated: false },
      lastCheckResult: { passed: false, ranAt: 1 },
    });
    // The entry it was given is left as it was.
    expect(entry.recentOutput).toContain(TOKEN);
    // Nulls stay null; nothing absent is added.
    const bare = redactStatusEntry({
      terminalId: "t-2",
      agentId: null,
      agentState: null,
      recentOutput: null,
      lastHandback: { message: null, observedAt: 1, truncated: false },
    });
    expect(bare).toEqual({
      terminalId: "t-2",
      agentId: null,
      agentState: null,
      recentOutput: null,
      lastHandback: { message: null, observedAt: 1, truncated: false },
    });
  });
});

describe("fitProjectStatuses (#16191)", () => {
  it("cuts only tails, fairly across every project's terminals, to fit what the host sends", () => {
    const project = (projectId: string, count: number): ProjectStatusAnswer => ({
      status: "done",
      projectId,
      result: {
        terminals: Array.from({ length: count }, (_, index) => ({
          terminalId: `${projectId}-${index}`,
          agentId: "claude",
          agentState: "working",
          recentOutput: "y".repeat(40_000),
        })),
        source: "pty",
        unavailableFields: [],
      },
      complete: true,
      omitted: 0,
    });
    const answers = [
      project("p1", 1),
      { status: "failed" as const, projectId: "p2", reason: "timeout" as const },
      project("p3", 5),
    ];
    const fitted = fitProjectStatuses(answers, 100_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(100_000);
    const tails = fitted.flatMap((answer) =>
      answer.status === "done" && answer.result
        ? answer.result.terminals.map((terminal) => (terminal.recentOutput as string).length)
        : []
    );
    expect(tails).toHaveLength(6);
    expect(Math.max(...tails) - Math.min(...tails)).toBeLessThanOrEqual(1);
    expect(fitted[1]).toEqual(answers[1]);
    // Under the cap, nothing changes.
    expect(fitProjectStatuses(answers, Number.MAX_SAFE_INTEGER)).toEqual(answers);
  });
});
