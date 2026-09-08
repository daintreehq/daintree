import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

// The real helper consults the global agent store for help terminals, which
// needs a live main process. The flag on the record is the part under test.
vi.mock("../../assistantTerminal.js", () => ({
  isAssistantTerminalRecord: (t: { isAssistantTerminal?: boolean } | null | undefined) =>
    t?.isAssistantTerminal === true,
}));

import { buildViewlessTerminalStatus, viewlessStatusArgsAreAnswerable } from "../terminalStatus.js";

const WORKSPACE = "ws-1";

type Record_ = Record<string, unknown>;

function record(overrides: Record_ = {}): Record_ {
  return {
    id: "t-1",
    projectId: WORKSPACE,
    kind: "terminal",
    cwd: "/repo",
    spawnedAt: 1000,
    agentState: "working",
    lastStateChange: 2000,
    launchAgentId: "claude",
    ...overrides,
  };
}

function deps(
  records: Record_[],
  opts: {
    serialized?: Record<string, { data: string } | null>;
    agentIdFor?: Record<string, string>;
    exitCodes?: Record<string, number | null>;
  } = {}
) {
  const byId = new Map(records.map((r) => [r["id"] as string, r]));
  return {
    ptyClient: {
      getTerminalAsync: vi.fn(async (id: string) => byId.get(id) ?? null),
      getSerializedStateAsync: vi.fn(async (id: string) => opts.serialized?.[id] ?? null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    availability: {
      getAgentIdForTerminal: (id: string) => opts.agentIdFor?.[id],
      getExitCode: (agentId: string) => opts.exitCodes?.[agentId],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe("viewlessStatusArgsAreAnswerable", () => {
  it.each([
    [undefined, false],
    [null, false],
    [{}, false],
    [{ terminalIds: [] }, false],
    [{ location: "grid" }, false],
    [{ terminalIds: ["t-1"] }, true],
  ])("reads %j as %s", (args, expected) => {
    expect(viewlessStatusArgsAreAnswerable(args)).toBe(expected);
  });
});

describe("buildViewlessTerminalStatus arguments", () => {
  it.each([
    [undefined],
    [{}],
    [{ terminalIds: [] }],
    [{ terminalIds: ["ok", ""] }],
    [{ terminalIds: [1] }],
    [{ terminalIds: new Array(257).fill("t") }],
  ])("rejects %j with an McpError rather than a partial answer", async (args) => {
    await expect(buildViewlessTerminalStatus(deps([]), WORKSPACE, args)).rejects.toBeInstanceOf(
      McpError
    );
  });

  it("rejects a malformed includeOutput", async () => {
    await expect(
      buildViewlessTerminalStatus(deps([]), WORKSPACE, {
        terminalIds: ["t-1"],
        includeOutput: { lines: "20" },
      })
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe("buildViewlessTerminalStatus results", () => {
  it("declares its source and what it could not observe", async () => {
    const result = await buildViewlessTerminalStatus(deps([record()]), WORKSPACE, {
      terminalIds: ["t-1"],
    });

    expect(result.source).toBe("pty");
    // Reported as unobservable rather than defaulted: `armed: false` would be
    // an interpretation main has no evidence for.
    expect(result.unavailableFields).toEqual(["armed", "lastCheckResult"]);
    expect(result.terminals[0]).toMatchObject({
      terminalId: "t-1",
      agentId: "claude",
      agentState: "working",
      lastTransitionAt: 2000,
      spawnedAt: 1000,
    });
    expect(result.terminals[0]).not.toHaveProperty("armed");
    expect(result.terminals[0]).not.toHaveProperty("lastCheckResult");
  });

  it("prefers the detected agent over the launch agent, matching the renderer", async () => {
    const result = await buildViewlessTerminalStatus(
      deps([record({ launchAgentId: "claude", detectedAgentId: "codex" })]),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );

    expect(result.terminals[0]?.agentId).toBe("codex");
  });

  it("answers one row per requested id, in order, including duplicates", async () => {
    const d = deps([record({ id: "a" }), record({ id: "b" })]);

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["b", "a", "b"],
    });

    expect(result.terminals.map((t) => t.terminalId)).toEqual(["b", "a", "b"]);
    // One backend read per distinct id, not per mention.
    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("reports an unknown id as an error row without failing the call", async () => {
    const result = await buildViewlessTerminalStatus(deps([record({ id: "a" })]), WORKSPACE, {
      terminalIds: ["a", "missing"],
    });

    expect(result.terminals[0]?.error).toBeUndefined();
    expect(result.terminals[1]).toEqual({
      terminalId: "missing",
      agentId: null,
      agentState: null,
      error: "Terminal not found",
    });
  });

  it.each([
    ["another workspace's terminal", record({ id: "x", projectId: "ws-other" })],
    ["a dev-preview PTY", record({ id: "x", kind: "dev-preview" })],
    ["the assistant's terminal", record({ id: "x", isAssistantTerminal: true })],
  ])("hides %s behind the same not-found answer", async (_label, hidden) => {
    // A bound session must not be able to confirm an id it has no route to, and
    // tooling-internal PTYs never report state to an MCP caller — so all three
    // read identically to "no such terminal".
    const result = await buildViewlessTerminalStatus(deps([hidden]), WORKSPACE, {
      terminalIds: ["x"],
    });

    expect(result.terminals[0]).toEqual({
      terminalId: "x",
      agentId: null,
      agentState: null,
      error: "Terminal not found",
    });
  });

  it("carries waitingReason only while the agent is actually waiting", async () => {
    const waiting = await buildViewlessTerminalStatus(
      deps([record({ agentState: "waiting", waitingReason: "permission" })]),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );
    const working = await buildViewlessTerminalStatus(
      deps([record({ agentState: "working", waitingReason: "permission" })]),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );

    expect(waiting.terminals[0]?.waitingReason).toBe("permission");
    expect(working.terminals[0]?.waitingReason).toBeUndefined();
  });

  it("omits exitCode while the agent is still running", async () => {
    // Absence means "still running" in the published schema, so a running
    // terminal must not carry a code — including a null one.
    const result = await buildViewlessTerminalStatus(
      deps([record({ agentState: "working" })], {
        agentIdFor: { "t-1": "agent-1" },
        exitCodes: { "agent-1": 0 },
      }),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );

    expect(result.terminals[0]).not.toHaveProperty("exitCode");
  });

  it.each([
    ["a clean finish", 0],
    ["a failure", 1],
    ["a signal kill with no numeric code", null],
  ])("reports %s once the agent has exited", async (_label, code) => {
    const result = await buildViewlessTerminalStatus(
      deps([record({ agentState: "exited" })], {
        agentIdFor: { "t-1": "agent-1" },
        exitCodes: { "agent-1": code },
      }),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );

    expect(result.terminals[0]?.exitCode).toBe(code);
  });

  it("joins exit metadata through the terminal's own ledger entry", async () => {
    // Two terminals of the same agent kind: the code must follow the per-spawn
    // ledger id, never the agent kind on the record.
    const result = await buildViewlessTerminalStatus(
      deps([record({ id: "a", agentState: "exited" }), record({ id: "b", agentState: "exited" })], {
        agentIdFor: { a: "agent-a", b: "agent-b" },
        exitCodes: { "agent-a": 0, "agent-b": 137 },
      }),
      WORKSPACE,
      { terminalIds: ["a", "b"] }
    );

    expect(result.terminals.map((t) => t.exitCode)).toEqual([0, 137]);
  });

  it("leaves exitCode absent when the ledger never saw the terminal", async () => {
    const result = await buildViewlessTerminalStatus(
      deps([record({ agentState: "exited" })]),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );

    expect(result.terminals[0]).not.toHaveProperty("exitCode");
  });

  it("reads no scrollback unless output was asked for", async () => {
    const d = deps([record()], { serialized: { "t-1": { data: "hello\n" } } });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["t-1"] });

    expect(d.ptyClient.getSerializedStateAsync).not.toHaveBeenCalled();
    expect(result.terminals[0]).not.toHaveProperty("recentOutput");
  });

  it("tails the requested number of lines when output is asked for", async () => {
    const d = deps([record()], { serialized: { "t-1": { data: "one\ntwo\nthree\n" } } });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      includeOutput: { lines: 2 },
    });

    expect(result.terminals[0]?.recentOutput).toBe("two\nthree");
  });

  it("strips ANSI by default and keeps it on request", async () => {
    const data = "\u001b[31mred\u001b[0m\n";
    const stripped = await buildViewlessTerminalStatus(
      deps([record()], { serialized: { "t-1": { data } } }),
      WORKSPACE,
      { terminalIds: ["t-1"], includeOutput: {} }
    );
    const raw = await buildViewlessTerminalStatus(
      deps([record()], { serialized: { "t-1": { data } } }),
      WORKSPACE,
      { terminalIds: ["t-1"], includeOutput: { stripAnsi: false } }
    );

    expect(stripped.terminals[0]?.recentOutput).toBe("red");
    expect(raw.terminals[0]?.recentOutput).toContain("\u001b[31m");
  });

  it("reports null output rather than failing when the snapshot is unavailable", async () => {
    const result = await buildViewlessTerminalStatus(
      deps([record()], { serialized: { "t-1": null } }),
      WORKSPACE,
      { terminalIds: ["t-1"], includeOutput: {} }
    );

    expect(result.terminals[0]?.recentOutput).toBeNull();
    expect(result.terminals[0]?.agentState).toBe("working");
  });

  it("never reads scrollback for a terminal it refused to resolve", async () => {
    const d = deps([record({ id: "x", projectId: "ws-other" })]);

    await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["x"],
      includeOutput: {},
    });

    expect(d.ptyClient.getSerializedStateAsync).not.toHaveBeenCalled();
  });
});
