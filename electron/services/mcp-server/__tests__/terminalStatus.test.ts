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
    /** Ids the pty-host reports live for the bound workspace. Defaults to every record. */
    inventory?: string[];
    /** Main-side spawn ledger. Ids absent from it read as untracked (`null`). */
    owners?: Record<string, string>;
  } = {}
) {
  const byId = new Map(records.map((r) => [r["id"] as string, r]));
  return {
    ptyClient: {
      getTerminalProjectId: vi.fn((id: string) => opts.owners?.[id] ?? null),
      getTerminalsForProjectAsync: vi.fn(
        async () => opts.inventory ?? records.map((r) => r["id"] as string)
      ),
      getTerminalAsync: vi.fn(async (id: string) => byId.get(id) ?? null),
      getSerializedStateAsync: vi.fn(async (id: string) => opts.serialized?.[id] ?? null),
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
    expect(result.unavailableFields).toEqual(["armed", "lastCheckResult", "exitCode"]);
    expect(result.terminals[0]).toMatchObject({
      terminalId: "t-1",
      agentId: "claude",
      agentState: "working",
      lastTransitionAt: 2000,
      spawnedAt: 1000,
    });
    expect(result.terminals[0]).not.toHaveProperty("armed");
    expect(result.terminals[0]).not.toHaveProperty("lastCheckResult");
    expect(result.terminals[0]).not.toHaveProperty("exitCode");
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
      error: "Terminal not found or status unavailable",
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
      error: "Terminal not found or status unavailable",
    });
  });

  it("never routes a terminal RPC for an id outside the workspace inventory", async () => {
    // The rows would read the same either way. The latency need not: the pty
    // fabric shards by owning project, so a `get-terminal` for a foreign id
    // lands on its owner's shard and an unknown one lands on the default.
    // Scoping to the inventory first means a foreign id is never routed.
    const d = deps([record({ id: "mine" }), record({ id: "theirs", projectId: "ws-other" })], {
      inventory: ["mine"],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["mine", "theirs"],
    });

    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledTimes(1);
    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledWith("mine");
    expect(result.terminals[1]?.error).toBe("Terminal not found or status unavailable");
  });

  it("still answers for a trashed terminal the inventory has already dropped", async () => {
    // `TerminalRegistry.getForProject` excludes trash, but a caller may
    // legitimately poll a terminal during its recovery window — and the
    // renderer's explicit-id path answers for it. The main-side spawn ledger
    // places it without an inventory round trip.
    const d = deps([record({ id: "binned", isTrashed: true })], {
      inventory: [],
      owners: { binned: WORKSPACE },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["binned"] });

    expect(result.terminals[0]?.error).toBeUndefined();
    expect(result.terminals[0]?.terminalId).toBe("binned");
  });

  it("skips the inventory round trip when the ledger places every id", async () => {
    const d = deps([record({ id: "a" })], { owners: { a: WORKSPACE } });

    await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["a"] });

    expect(d.ptyClient.getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });

  it("never routes an id the ledger places in another workspace", async () => {
    // Settled without the inventory: a non-null foreign owner is an answer, so
    // the id is neither looked up nor put to the inventory.
    const d = deps([record({ id: "theirs", projectId: "ws-other" })], {
      owners: { theirs: "ws-other" },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["theirs"] });

    expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(d.ptyClient.getTerminalsForProjectAsync).not.toHaveBeenCalled();
    expect(result.terminals[0]?.error).toBe("Terminal not found or status unavailable");
  });

  it("answers every row unavailable when the inventory read fails", async () => {
    // `PtyClient` folds a failed inventory to `[]`, and nothing was observed —
    // so every row says so rather than claiming the terminals are gone.
    const d = deps([record({ id: "a" })], { inventory: [] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["a"] });

    expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(result.terminals[0]?.error).toBe("Terminal not found or status unavailable");
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

  it("never reports an exitCode, even for an agent that has finished", async () => {
    // Main does cache exit metadata, but `AgentAvailabilityStore` keys it by
    // agent *type* ("claude"), not by spawn — several terminals share one id
    // and only the most recent is mapped back. Joining through it would report
    // whichever same-type terminal exited last, which for a fleet of identical
    // agents is wrong far more often than right. `agentState` still says the
    // run finished, and how.
    const result = await buildViewlessTerminalStatus(
      deps([
        record({ id: "a", agentState: "exited" }),
        record({ id: "b", agentState: "completed" }),
      ]),
      WORKSPACE,
      { terminalIds: ["a", "b"] }
    );

    expect(result.terminals.map((t) => t.agentState)).toEqual(["exited", "completed"]);
    for (const entry of result.terminals) expect(entry).not.toHaveProperty("exitCode");
    expect(result.unavailableFields).toContain("exitCode");
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
