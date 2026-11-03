import { describe, expect, it } from "vitest";
import { createLocalMcpRelay } from "../localMcpRelay.js";
import { readProjectStatuses, redactStatusEntry } from "../projectStatusRead.js";

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
      error: `read failed: ${TOKEN}`,
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

describe("readProjectStatuses (#16191)", () => {
  const read = (overrides: Partial<Parameters<typeof readProjectStatuses>[0]> = {}) =>
    readProjectStatuses(
      {
        getStatus: async () => ({
          status: "done",
          result: {
            isError: false,
            structured: { terminals: [], source: "pty", unavailableFields: [] },
            text: null,
          },
        }),
        readAgents: async () => ({
          coverage: "ok",
          observedAt: 1,
          complete: true,
          omitted: 0,
          entries: [],
        }),
        hasProject: async (projectId) => projectId !== "gone",
        ...overrides,
      },
      [{ projectId: "gone" }, { projectId: "empty" }],
      null,
      1_000
    );

  it("never reads a project the machine doesn't have as one with no agents", async () => {
    await expect(read()).resolves.toEqual([
      { status: "refused", projectId: "gone", reason: "no-project" },
      { status: "done", projectId: "empty", result: null, complete: true, omitted: 0 },
    ]);
  });

  it("answers a project whose checks throw as one whose agents couldn't be listed, never failing the rest", async () => {
    await expect(
      read({
        hasProject: async (projectId) => {
          if (projectId === "gone") throw new Error("store down");
          return true;
        },
        readAgents: async (projectId) => {
          if (projectId === "empty") throw new Error("pty host down");
          throw new Error("unreachable");
        },
      })
    ).resolves.toEqual([
      { status: "failed", projectId: "gone", reason: "agents-unread" },
      { status: "failed", projectId: "empty", reason: "agents-unread" },
    ]);
  });
});

describe("createLocalMcpRelay status (#16191)", () => {
  it("redacts this machine's screens as a host's are, through the gates its calls meet", async () => {
    const opened: string[] = [];
    const listed: Array<string | undefined> = [];
    const relay = createLocalMcpRelay({
      machineName: () => "this-mac",
      hasProject: async (projectId) => projectId === "p1",
      readAgents: async (options) => {
        listed.push(options.projectId);
        return { coverage: "ok", observedAt: 1, complete: true, omitted: 0, entries: [] };
      },
      openSession: async (spec) => {
        opened.push(spec.projectId);
        return {
          isOpen: () => true,
          callTool: async () => {
            const result = {
              terminals: [
                {
                  terminalId: "t-1",
                  agentId: "claude",
                  agentState: "waiting",
                  recentOutput: `token ${TOKEN}`,
                },
              ],
              source: "pty",
              unavailableFields: [],
            };
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          },
          close: () => {},
        };
      },
      receiveNotices: () => {},
      receiveApproval: async () => {
        throw new Error("never asked");
      },
    });
    const answers = await relay.status({
      helpSessionId: "help-1",
      tier: "core",
      global: true,
      projects: [
        { projectId: "p1", terminalIds: ["t-1"] },
        { projectId: "p9", terminalIds: ["t-9"] },
        // One it doesn't have, named without terminals: never one with no agents.
        { projectId: "p8" },
      ],
      includeOutput: { lines: 10, stripAnsi: true },
      runMs: 5_000,
    });
    relay.dispose();
    expect(opened).toEqual(["p1"]);
    expect(JSON.stringify(answers)).not.toContain(TOKEN);
    expect(answers).toMatchObject([
      {
        status: "done",
        projectId: "p1",
        result: { terminals: [{ recentOutput: "token [redacted]" }] },
      },
      { status: "refused", projectId: "p9", reason: "no-project" },
      { status: "refused", projectId: "p8", reason: "no-project" },
    ]);
    expect(listed).toEqual([]);
  });
});
