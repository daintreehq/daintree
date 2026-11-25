import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

// The real helper consults the global agent store for help terminals, which
// needs a live main process. The flag on the record is the part under test,
// and a help terminal the store marks is named here by id.
const helpTerminalIds = vi.hoisted(() => new Set<string>());
vi.mock("../../assistantTerminal.js", () => ({
  isAssistantTerminalRecord: (
    t: { id?: string; isAssistantTerminal?: boolean } | null | undefined
  ) => t?.isAssistantTerminal === true || (t?.id !== undefined && helpTerminalIds.has(t.id)),
}));

import {
  buildViewlessTerminalStatus,
  isAgentPaneInWorkspace,
  viewlessStatusArgsAreAnswerable,
} from "../terminalStatus.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { TerminalSubmissionRecord } from "../../../../shared/types/terminalSubmission.js";

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
    /** Per-terminal submission ledger, keyed by terminal id then token. */
    submissions?: Record<string, Record<string, TerminalSubmissionRecord | undefined>>;
    /** The bound project's saved panels (#18171), or the error reading them throws. */
    layout?: Record_[] | Error;
    /** What a strict inventory read throws. */
    inventoryError?: Error;
  } = {}
) {
  const byId = new Map(records.map((r) => [r["id"] as string, r]));
  return {
    getProjectState: vi.fn(async (_projectId: string) => {
      if (opts.layout instanceof Error) throw opts.layout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { terminals: (opts.layout ?? []) as any[] };
    }),
    ptyClient: {
      getTerminalProjectId: vi.fn((id: string) => opts.owners?.[id] ?? null),
      // Mirrors `PtyClient`: only a strict read rejects; otherwise a failure folds to `[]`.
      getTerminalsForProjectAsync: vi.fn(
        async (_projectId: string, options?: { strict?: boolean }) => {
          if (opts.inventoryError) {
            if (options?.strict === true) throw opts.inventoryError;
            return [];
          }
          return opts.inventory ?? records.map((r) => r["id"] as string);
        }
      ),
      getTerminalAsync: vi.fn(async (id: string, submissionToken?: string) => {
        const found = byId.get(id);
        if (found === undefined) return null;
        // Mirrors `mapTerminalInfo`: the record only carries a `submission`
        // when the query named a token, and only if the host had one.
        const ledger = opts.submissions?.[id];
        return {
          ...found,
          submission:
            submissionToken === undefined ? undefined : (ledger?.[submissionToken] ?? undefined),
        };
      }),
      getSerializedStateAsync: vi.fn(async (id: string) => opts.serialized?.[id] ?? null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

// What admits the assistant's read of a pane it did not create (#12883): the
// host's record, never the spawn tracking that a pending duplicate rewrites.
describe("isAgentPaneInWorkspace", () => {
  it("admits a pane of the workspace, including one whose PTY exited", async () => {
    const d = deps([record({ id: "pane" }), record({ id: "exited", hasPty: false })]);

    expect(await isAgentPaneInWorkspace(d.ptyClient, "pane", WORKSPACE)).toBe(true);
    expect(await isAgentPaneInWorkspace(d.ptyClient, "exited", WORKSPACE)).toBe(true);
    expect(d.ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
  });

  it.each([
    ["another workspace's terminal", record({ id: "x", projectId: "ws-other" })],
    ["a dev-preview PTY", record({ id: "x", kind: "dev-preview" })],
    ["the assistant's terminal", record({ id: "x", isAssistantTerminal: true })],
  ])("refuses %s", async (_label, hidden) => {
    expect(await isAgentPaneInWorkspace(deps([hidden]).ptyClient, "x", WORKSPACE)).toBe(false);
  });

  it("refuses an unknown terminal, and without a pty client", async () => {
    expect(await isAgentPaneInWorkspace(deps([]).ptyClient, "x", WORKSPACE)).toBe(false);
    expect(await isAgentPaneInWorkspace(null, "x", WORKSPACE)).toBe(false);
  });
});

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
    // Counted on the pty-host record, so this surface reports it straight
    // through; an older record without one stays absent rather than zero
    // (#12535).
    expect(result.terminals[0]).not.toHaveProperty("agentIncarnation");
    expect(result.terminals[0]).not.toHaveProperty("armed");
    expect(result.terminals[0]).not.toHaveProperty("lastCheckResult");
    expect(result.terminals[0]).not.toHaveProperty("exitCode");
  });

  it("reports the observed session count off the record (#12535)", async () => {
    // Zero is a reading — no relaunch observed in this pty generation — and it
    // has to survive the builder rather than be dropped as falsy.
    const zero = await buildViewlessTerminalStatus(
      deps([record({ agentIncarnation: 0 })]),
      WORKSPACE,
      {
        terminalIds: ["t-1"],
      }
    );
    expect(zero.terminals[0]?.agentIncarnation).toBe(0);

    const relaunched = await buildViewlessTerminalStatus(
      deps([record({ agentIncarnation: 2 })]),
      WORKSPACE,
      { terminalIds: ["t-1"] }
    );
    expect(relaunched.terminals[0]?.agentIncarnation).toBe(2);
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
    // Each carries a live `hasPty` so the exact-equality assertion below is
    // actually load-bearing for it: a regression that copied the flag onto a
    // rejected row would otherwise be invisible, and it would confirm to a
    // bound session that an id it has no route to exists.
    ["another workspace's terminal", record({ id: "x", projectId: "ws-other", hasPty: true })],
    ["a dev-preview PTY", record({ id: "x", kind: "dev-preview", hasPty: true })],
    ["the assistant's terminal", record({ id: "x", isAssistantTerminal: true, hasPty: true })],
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
    // The second argument is the optional submission token (#12337); this call
    // named none, so the routing claim is unchanged.
    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledWith("mine", undefined);
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
    // A non-null foreign owner is an answer, so the id is never looked up.
    // The bound project's own reads still run, as they do for an unknown id,
    // so the two cannot be told apart by what the call costs (#18171).
    const d = deps([record({ id: "theirs", projectId: "ws-other" })], {
      owners: { theirs: "ws-other" },
      inventory: [],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["theirs"] });

    expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(d.ptyClient.getTerminalsForProjectAsync).toHaveBeenCalledWith(WORKSPACE, {
      strict: true,
    });
    expect(d.getProjectState).toHaveBeenCalledWith(WORKSPACE);
    expect(result.terminals[0]?.error).toBe("Terminal not found or status unavailable");
  });

  describe("the global Assistant a project's assistant named (#16410)", () => {
    const globalRecord = (overrides: Record_ = {}) =>
      record({
        id: "g",
        projectId: GLOBAL_ASSISTANT_ID,
        isAssistantTerminal: true,
        agentState: "waiting",
        lastHandback: {
          message: "Use studio-02",
          observedAt: 5,
          submissionToken: "mine",
          truncated: false,
        },
        ...overrides,
      });

    it("reads its status outside the workspace, and only where the global's own run is", async () => {
      const d = deps([globalRecord()], { owners: { g: GLOBAL_ASSISTANT_ID } });
      const read = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g"] },
        new Set(["g"]),
        new Set(["g"])
      );
      expect(read.terminals[0]).toMatchObject({ terminalId: "g", agentState: "waiting" });

      // Not admitted, it is any other workspace's id: never looked up.
      const unnamed = deps([globalRecord()], { owners: { g: GLOBAL_ASSISTANT_ID } });
      const refused = await buildViewlessTerminalStatus(unnamed, WORKSPACE, {
        terminalIds: ["g"],
      });
      expect(unnamed.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
      expect(refused.terminals[0]?.error).toBe("Terminal not found or status unavailable");
    });

    it("reads both global sessions named in one call, and only those admitted (#18142)", async () => {
      const d = deps([globalRecord(), globalRecord({ id: "g2", agentState: "working" })], {
        owners: { g: GLOBAL_ASSISTANT_ID, g2: GLOBAL_ASSISTANT_ID },
      });
      const both = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g", "g2"] },
        new Set(["g", "g2"]),
        new Set(["g", "g2"])
      );
      expect(both.terminals.map((t) => [t.terminalId, t.agentState])).toEqual([
        ["g", "waiting"],
        ["g2", "working"],
      ]);

      const one = await buildViewlessTerminalStatus(
        deps([globalRecord(), globalRecord({ id: "g2" })], {
          owners: { g: GLOBAL_ASSISTANT_ID, g2: GLOBAL_ASSISTANT_ID },
        }),
        WORKSPACE,
        { terminalIds: ["g", "g2"] },
        new Set(["g", "g2"]),
        new Set(["g"])
      );
      expect(one.terminals[1]?.error).toBe("Terminal not found or status unavailable");
    });

    it("never discloses a record the backend places elsewhere, whatever the ledger said", async () => {
      const d = deps([globalRecord({ projectId: "ws-other" })], {
        owners: { g: GLOBAL_ASSISTANT_ID },
      });
      const result = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g"] },
        new Set(["g"]),
        new Set(["g"])
      );
      expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledTimes(1);
      expect(result.terminals[0]?.error).toBe("Terminal not found or status unavailable");
    });

    it("keeps the screen its submission captured out of the answer, and the rest in", async () => {
      const d = deps([globalRecord()], {
        owners: { g: GLOBAL_ASSISTANT_ID },
        submissions: {
          g: {
            mine: {
              token: "mine",
              phase: "pty_written",
              output: { text: "the person's conversation", lineCount: 1, truncated: false },
            } as never,
          },
        },
      });
      const result = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g"], submissionToken: "mine" },
        new Set(["g"]),
        new Set(["g"])
      );
      expect(result.terminals[0]?.submission).toMatchObject({
        token: "mine",
        phase: "pty_written",
      });
      expect(JSON.stringify(result)).not.toContain("the person's conversation");
    });

    it("never admits another workspace's terminal under the global's id", async () => {
      const d = deps([globalRecord({ projectId: "ws-other" })], { owners: { g: "ws-other" } });
      const result = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g"] },
        new Set(["g"]),
        new Set(["g"])
      );
      expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
      expect(result.terminals[0]?.error).toBe("Terminal not found or status unavailable");
    });

    it("shows its handback only to the send that asked for it", async () => {
      const read = (submissionToken?: string) =>
        buildViewlessTerminalStatus(
          deps([globalRecord()], { owners: { g: GLOBAL_ASSISTANT_ID } }),
          WORKSPACE,
          { terminalIds: ["g"], ...(submissionToken ? { submissionToken } : {}) },
          new Set(["g"]),
          new Set(["g"])
        );
      expect((await read("mine")).terminals[0]?.lastHandback?.message).toBe("Use studio-02");
      expect((await read("theirs")).terminals[0]?.lastHandback).toBeUndefined();
      expect((await read()).terminals[0]?.lastHandback).toBeUndefined();
    });

    it("never reads its screen", async () => {
      const d = deps([globalRecord()], {
        owners: { g: GLOBAL_ASSISTANT_ID },
        serialized: { g: { data: "the person's conversation" } },
      });
      const result = await buildViewlessTerminalStatus(
        d,
        WORKSPACE,
        { terminalIds: ["g"], includeOutput: true },
        new Set(["g"]),
        new Set(["g"])
      );
      expect(d.ptyClient.getSerializedStateAsync).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("the person's conversation");
      expect(result.terminals[0]).toMatchObject({ terminalId: "g", agentState: "waiting" });
      expect(result.terminals[0]?.error).toBeUndefined();
    });
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
    // Main caches exit metadata per terminal in `AgentAvailabilityStore`, but
    // this answer is built from the pty-host record and does not splice in a
    // field from that separately-fed copy. `agentState` still says the run
    // finished, and how.
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

  it("reports hasPty off the pty-host record, independently of agentState (#12336)", async () => {
    // The point of the field: a pane that exits cleanly is deliberately
    // preserved, so its record outlives its process. `false` here is the
    // lifecycle fact an orchestrator could not get from `agentState`, which is
    // a passive heuristic, or from `exitCode`, which this surface cannot see.
    //
    // The pairings are deliberately crossed. With `true`/working and
    // `false`/completed, an implementation that derived the flag from
    // `agentState` would pass — and reporting a finished agent's surviving
    // keep-open shell as having no PTY is the exact interpretation this field
    // exists to avoid.
    const result = await buildViewlessTerminalStatus(
      deps([
        record({ id: "kept-open", hasPty: true, agentState: "completed" }),
        record({ id: "killed", hasPty: false, agentState: "working" }),
      ]),
      WORKSPACE,
      { terminalIds: ["kept-open", "killed"] }
    );

    expect(result.terminals.map((t) => t.hasPty)).toEqual([true, false]);
    // The states must survive intact too, or the crossing proves nothing.
    expect(result.terminals.map((t) => t.agentState)).toEqual(["completed", "working"]);
    for (const entry of result.terminals) expect(entry.error).toBeUndefined();
  });

  it("reports each terminal's own output-progress time, even for one agent type (#12428)", async () => {
    // Two terminals running the same agent must not share a reading — the
    // point is to single out the one whose screen stopped moving.
    const result = await buildViewlessTerminalStatus(
      deps([
        record({ id: "moving", lastOutputChangeAt: 9000 }),
        record({ id: "still", lastOutputChangeAt: 3000 }),
        record({ id: "never" }),
      ]),
      WORKSPACE,
      { terminalIds: ["moving", "still", "never"] }
    );

    expect(result.terminals.map((t) => t.lastOutputChangeAt)).toEqual([9000, 3000, undefined]);
    // Unobserved is absent, not a time — and not a field this surface lacks.
    expect(result.terminals[2]).not.toHaveProperty("lastOutputChangeAt");
    expect(result.unavailableFields).not.toContain("lastOutputChangeAt");
  });

  it("reports each terminal's last typed-input time and never lists it as unavailable (#12718)", async () => {
    const result = await buildViewlessTerminalStatus(
      deps([
        record({ id: "typed", lastStateChange: 1000, lastTypedInputAt: 2000 }),
        record({ id: "untouched", lastStateChange: 1000 }),
        // Reported raw: an input before the settle is not dropped or reinterpreted.
        record({ id: "earlier", lastStateChange: 1000, lastTypedInputAt: 500 }),
      ]),
      WORKSPACE,
      { terminalIds: ["typed", "untouched", "earlier"], includeOutput: {} }
    );

    expect(result.terminals[0]).toMatchObject({ lastTransitionAt: 1000, lastTypedInputAt: 2000 });
    // No write observed is absent, not a time.
    expect(result.terminals[1]).not.toHaveProperty("lastTypedInputAt");
    expect(result.terminals[2]?.lastTypedInputAt).toBe(500);
    expect(result.unavailableFields).not.toContain("lastTypedInputAt");
  });

  it("reports each terminal's own handback and never lists it as unavailable (#12488)", async () => {
    const handback = { message: "shipped", observedAt: 4_000, truncated: false };
    const result = await buildViewlessTerminalStatus(
      deps([record({ id: "asked", lastHandback: handback }), record({ id: "plain" })]),
      WORKSPACE,
      { terminalIds: ["asked", "plain"] }
    );

    expect(result.terminals[0]?.lastHandback).toEqual(handback);
    expect(result.terminals[1]).not.toHaveProperty("lastHandback");
    expect(result.unavailableFields).not.toContain("lastHandback");
  });

  it("reports a working pane's update footer off the host record (#17905)", async () => {
    const updateInstalled = { observedAt: 4_000, namesRestart: false };
    const result = await buildViewlessTerminalStatus(
      deps([
        record({ id: "seen", agentState: "working", detectedAgentId: "claude", updateInstalled }),
        record({ id: "plain" }),
      ]),
      WORKSPACE,
      { terminalIds: ["seen", "plain"] }
    );

    expect(result.terminals[0]).toMatchObject({ agentState: "working", updateInstalled });
    expect(result.terminals[0]).not.toHaveProperty("waitingReason");
    expect(result.terminals[1]).not.toHaveProperty("updateInstalled");
  });

  it("keeps hasPty through the output attachment, in both polarities", async () => {
    // `recentOutput` is assigned onto the entry after `buildEntry` returns, so
    // the two must not clobber each other.
    const result = await buildViewlessTerminalStatus(
      deps([record({ id: "a", hasPty: true }), record({ id: "b", hasPty: false })], {
        serialized: { a: { data: "out-a\n" }, b: null },
      }),
      WORKSPACE,
      { terminalIds: ["a", "b"], includeOutput: {} }
    );

    expect(result.terminals[0]).toMatchObject({ hasPty: true, recentOutput: "out-a" });
    expect(result.terminals[1]).toMatchObject({ hasPty: false, recentOutput: null });
  });

  it("omits hasPty rather than inventing an exit when the record has none", async () => {
    // `mapTerminalInfo` always computes it, but the response type admits
    // `undefined` and a failed read folds to a missing record. Defaulting to
    // `false` would report an exit main never observed — the same mistake
    // `unavailableFields` exists to prevent. Checked on the serialized payload
    // too: an explicit `hasPty: undefined` drops on the wire while still
    // satisfying an in-memory property check.
    const result = await buildViewlessTerminalStatus(deps([record({ id: "old" })]), WORKSPACE, {
      terminalIds: ["old"],
    });

    expect(result.terminals[0]).not.toHaveProperty("hasPty");
    expect(JSON.parse(JSON.stringify(result.terminals[0]))).not.toHaveProperty("hasPty");
  });

  it("reads no scrollback unless output was asked for", async () => {
    const d = deps([record()], { serialized: { "t-1": { data: "hello\n" } } });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["t-1"] });

    expect(d.ptyClient.getSerializedStateAsync).not.toHaveBeenCalled();
    expect(result.terminals[0]).not.toHaveProperty("recentOutput");
  });

  it("reads the input box by the agent the record reports, as the view's answer does (#16189)", async () => {
    const screen =
      "⏺ Done.\r\n────────\r\n❯ \x1b[2mopen the PR\x1b[22m\r\n────────\r\n  ? for shortcuts";
    const typed = "⏺ Done.\r\n────────\r\n❯ open the PR\r\n────────\r\n  ? for shortcuts";
    const result = await buildViewlessTerminalStatus(
      deps(
        [
          // Detection outranks the launch, as the entry's own `agentId` does.
          record({ id: "detected", launchAgentId: "gemini", detectedAgentId: "claude" }),
          record({ id: "typed" }),
          record({ id: "gemini", launchAgentId: "gemini" }),
          record({ id: "gone" }),
        ],
        {
          serialized: {
            detected: { data: screen },
            typed: { data: typed },
            gemini: { data: screen },
            gone: null,
          },
        }
      ),
      WORKSPACE,
      { terminalIds: ["detected", "typed", "gemini", "gone"], includeOutput: {} }
    );

    const [detected, typedEntry, gemini, gone] = result.terminals;
    expect(detected?.inputLine).toEqual({ state: "suggestion", text: "open the PR" });
    expect(detected?.recentOutput).toContain("\n❯ [suggested by Claude Code: open the PR]\n");
    expect(typedEntry?.inputLine).toEqual({ state: "typed", text: "open the PR" });
    expect(typedEntry?.recentOutput).toContain("\n❯ open the PR\n");
    // An agent with no declared rule reads as unknown, its tail as drawn.
    expect(gemini?.inputLine).toEqual({ state: "unknown", text: "" });
    expect(gemini?.recentOutput).toContain("\n❯ open the PR\n");
    // No screen was read, so there is no box to report.
    expect(gone?.recentOutput).toBeNull();
    expect(gone).not.toHaveProperty("inputLine");
  });

  it("tails the requested number of lines when output is asked for", async () => {
    const d = deps([record()], { serialized: { "t-1": { data: "one\ntwo\nthree\n" } } });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      includeOutput: { lines: 2 },
    });

    expect(result.terminals[0]?.recentOutput).toBe("two\nthree");
    expect(result.terminals[0]?.recentOutputTruncated).toBe(true);
  });

  it("fits busy tails under the response cap, keeping each one's newest lines (#12450)", async () => {
    const ids = ["t-1", "t-2", "t-3"];
    const linesFor = (id: string) =>
      Array.from({ length: 50 }, (_, i) => `${id} row ${i} `.padEnd(600, "│"));
    const d = deps(
      ids.map((id) => record({ id })),
      { serialized: Object.fromEntries(ids.map((id) => [id, { data: linesFor(id).join("\n") }])) }
    );
    // A repeated id is its own row and spends its own share; an unknown one is
    // an error-only row that must not grow output fields.
    const requested = ["t-1", "t-2", "t-1", "missing", "t-3"];

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: requested,
      includeOutput: { lines: 50 },
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
    expect(result.terminals.map((t) => t.terminalId)).toEqual(requested);
    expect(d.ptyClient.getSerializedStateAsync).toHaveBeenCalledTimes(3);
    const missing = result.terminals[3]!;
    expect(missing.error).toBeDefined();
    expect(missing).not.toHaveProperty("recentOutput");
    expect(missing).not.toHaveProperty("recentOutputTruncated");
    for (const entry of result.terminals.filter((t) => t.terminalId !== "missing")) {
      const lines = linesFor(entry.terminalId);
      expect(entry.recentOutput).not.toBe("");
      const kept = (entry.recentOutput as string).split("\n");
      expect(kept).toEqual(lines.slice(-kept.length));
      expect(entry.recentOutputTruncated).toBe(true);
    }
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

describe("buildViewlessTerminalStatus submission correlation (#12337)", () => {
  const owners = { "t-1": WORKSPACE };

  it("rejects a malformed submissionToken rather than answering without one", async () => {
    for (const token of ["", 42, "x".repeat(129)]) {
      await expect(
        buildViewlessTerminalStatus(deps([record()], { owners }), WORKSPACE, {
          terminalIds: ["t-1"],
          submissionToken: token,
        })
      ).rejects.toBeInstanceOf(McpError);
    }
  });

  it("carries the record for the token it was asked about", async () => {
    const d = deps([record()], {
      owners,
      submissions: { "t-1": { "tok-1": { token: "tok-1", phase: "pty_written", at: 4242 } } },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      submissionToken: "tok-1",
    });

    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledWith("t-1", "tok-1");
    expect(result.terminals[0]?.submission).toEqual({
      token: "tok-1",
      phase: "pty_written",
      at: 4242,
    });
  });

  it("leaves out where a cancelled line stopped, which only main reads (#18157)", async () => {
    const d = deps([record()], {
      owners,
      submissions: {
        "t-1": { "tok-1": { token: "tok-1", phase: "cancelled", at: 4242, cancelledAt: "enter" } },
      },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      submissionToken: "tok-1",
    });

    expect(result.terminals[0]?.submission).toEqual({
      token: "tok-1",
      phase: "cancelled",
      at: 4242,
    });
  });

  it("forwards the output observation the pty-host derived (#12478)", async () => {
    const d = deps([record()], {
      owners,
      submissions: {
        "t-1": {
          "tok-1": {
            token: "tok-1",
            phase: "pty_written",
            at: 4242,
            outputChangeAfterWriteAt: 9000,
          },
        },
      },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      submissionToken: "tok-1",
    });

    expect(result.terminals[0]?.submission).toEqual({
      token: "tok-1",
      phase: "pty_written",
      at: 4242,
      outputChangeAfterWriteAt: 9000,
    });
  });

  it("reports unknown when the terminal was read and holds no such record", async () => {
    const d = deps([record()], { owners, submissions: { "t-1": {} } });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1"],
      submissionToken: "tok-missing",
    });

    // The record WAS read, so absence is evidence. Omitting the field instead
    // would be indistinguishable from never having asked.
    expect(result.terminals[0]?.submission).toEqual({ token: "tok-missing", phase: "unknown" });
  });

  it("omits the record entirely on an entry the surface could not read", async () => {
    const d = deps([record()], { owners, inventory: ["t-1"] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["t-1", "t-missing"],
      submissionToken: "tok-1",
    });

    // "This terminal holds no record" and "this terminal could not be read" are
    // different claims; only the first is `unknown`.
    expect(result.terminals[1]?.error).toBeDefined();
    expect(result.terminals[1]?.submission).toBeUndefined();
  });

  it("adds nothing when no token was named", async () => {
    const d = deps([record()], {
      owners,
      submissions: { "t-1": { "tok-1": { token: "tok-1", phase: "pty_written" } } },
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["t-1"] });

    expect(result.terminals[0]?.submission).toBeUndefined();
  });
});

// A pane restore held never spawned, so the pty-host has no record of it; the
// saved layout is what `terminal.list` reads it from, and status reads it too.
describe("buildViewlessTerminalStatus for a pane restore held (#18171)", () => {
  const NOT_FOUND = "Terminal not found or status unavailable";

  function heldSnapshot(overrides: Record_ = {}): Record_ {
    return {
      id: "held",
      kind: "terminal",
      launchAgentId: "mistral",
      title: "Mistral",
      cwd: "/repo",
      location: "grid",
      restoreRecovery: { reason: "host-ended-uncleanly" },
      restoreProvenance: {
        at: 5_000,
        disposition: "resume",
        lastSeen: { agentState: "waiting", at: 4_000 },
      },
      ...overrides,
    };
  }

  it("answers a held pane with its hold, no process and no error", async () => {
    const d = deps([], { inventory: [], layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(result.terminals).toEqual([
      {
        terminalId: "held",
        agentId: "mistral",
        agentState: null,
        hasPty: false,
        restored: {
          at: 5_000,
          disposition: "held",
          heldReason: "host-ended-uncleanly",
          lastSeen: { agentState: "waiting", at: 4_000 },
        },
      },
    ]);
    expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(d.getProjectState).toHaveBeenCalledWith(WORKSPACE);
  });

  it("reports each pane's own hold, not one summary for all", async () => {
    const d = deps([], {
      inventory: [],
      layout: [
        heldSnapshot(),
        heldSnapshot({
          id: "other",
          launchAgentId: "codex",
          restoreRecovery: { reason: "resume-deferred" },
          restoreProvenance: { at: 9_000, disposition: "fresh" },
        }),
      ],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["other", "held"],
    });

    expect(result.terminals[0]).toEqual({
      terminalId: "other",
      agentId: "codex",
      agentState: null,
      hasPty: false,
      restored: { at: 9_000, disposition: "held", heldReason: "resume-deferred" },
    });
    expect(result.terminals[1]?.restored?.heldReason).toBe("host-ended-uncleanly");
  });

  it("judges a legacy agent kind as hydration does, and a null marker as no hold", async () => {
    const d = deps([], {
      inventory: [],
      layout: [
        heldSnapshot({ id: "legacy", kind: "agent" }),
        heldSnapshot({ id: "nulled", restoreRecovery: null }),
      ],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["legacy", "nulled"],
    });

    expect(result.terminals[0]).toMatchObject({ terminalId: "legacy", hasPty: false });
    expect(result.terminals[0]?.restored?.disposition).toBe("held");
    expect(result.terminals[1]?.error).toBe(NOT_FOUND);
  });

  it("reports no process and no restore record for a hold saved before provenance was", async () => {
    const d = deps([], {
      inventory: [],
      layout: [heldSnapshot({ restoreProvenance: undefined })],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(result.terminals[0]).toEqual({
      terminalId: "held",
      agentId: "mistral",
      agentState: null,
      hasPty: false,
    });
  });

  it("reads no layout when the ledger places every id", async () => {
    const d = deps([record({ id: "a" })], { owners: { a: WORKSPACE }, layout: [heldSnapshot()] });

    await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["a"] });

    expect(d.getProjectState).not.toHaveBeenCalled();
  });

  it("reads no layout when the inventory places every id the ledger didn't", async () => {
    const d = deps([record({ id: "a" })], { inventory: ["a"], layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["a"] });

    expect(result.terminals[0]?.agentState).toBe("working");
    expect(d.getProjectState).not.toHaveBeenCalled();
  });

  it("keeps request order and duplicates beside live rows, reading the layout once", async () => {
    const d = deps([record({ id: "live" })], {
      owners: { live: WORKSPACE },
      inventory: [],
      layout: [heldSnapshot()],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["held", "live", "missing", "held"],
    });

    expect(
      result.terminals.map((t) => [t.terminalId, t.agentState, t.restored?.disposition, t.error])
    ).toEqual([
      ["held", null, "held", undefined],
      ["live", "working", undefined, undefined],
      ["missing", null, undefined, NOT_FOUND],
      ["held", null, "held", undefined],
    ]);
    expect(d.getProjectState).toHaveBeenCalledTimes(1);
  });

  it("prefers a live record the ledger places, without reading the project at all", async () => {
    const d = deps([record({ id: "held", agentState: "working", hasPty: true })], {
      owners: { held: WORKSPACE },
      inventory: [],
      layout: [heldSnapshot()],
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(result.terminals[0]).toMatchObject({ agentState: "working", hasPty: true });
    expect(result.terminals[0]?.restored).toBeUndefined();
    expect(d.ptyClient.getTerminalsForProjectAsync).not.toHaveBeenCalled();
    expect(d.getProjectState).not.toHaveBeenCalled();
  });

  it("prefers a live or exited record the inventory places over a stale hold", async () => {
    const d = deps(
      [
        record({ id: "held", agentState: "working", hasPty: true }),
        record({ id: "gone", agentState: "exited", hasPty: false }),
      ],
      { inventory: ["held", "gone"], layout: [heldSnapshot(), heldSnapshot({ id: "gone" })] }
    );

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["held", "gone"],
    });

    expect(result.terminals[0]).toMatchObject({ agentState: "working", hasPty: true });
    expect(result.terminals[1]).toMatchObject({ agentState: "exited", hasPty: false });
    for (const entry of result.terminals) expect(entry.restored).toBeUndefined();
  });

  it.each([
    ["the ledger", { owners: { held: WORKSPACE } }],
    ["the inventory", { inventory: ["held"] }],
  ])("keeps the generic row for a record %s places but can't read", async (_l, opts) => {
    const d = deps([], { ...opts, layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(d.ptyClient.getTerminalAsync).toHaveBeenCalledWith("held", undefined);
    expect(result.terminals[0]).toEqual({
      terminalId: "held",
      agentId: null,
      agentState: null,
      error: NOT_FOUND,
    });
  });

  it("reads no layout when the inventory failed, so a silent shard cannot pass for a hold", async () => {
    const d = deps([], { inventoryError: new Error("shard silent"), layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(result.terminals[0]?.error).toBe(NOT_FOUND);
    expect(d.getProjectState).not.toHaveBeenCalled();
  });

  it("keeps live rows and the generic row when the layout read fails", async () => {
    const d = deps([record({ id: "live" })], {
      owners: { live: WORKSPACE },
      inventory: [],
      layout: new Error("disk"),
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["live", "held"],
    });

    expect(result.terminals[0]?.agentState).toBe("working");
    expect(result.terminals[0]?.error).toBeUndefined();
    expect(result.terminals[1]?.error).toBe(NOT_FOUND);
  });

  it.each([
    ["this project", WORKSPACE],
    ["another project", "ws-other"],
  ])("drops the hold when a spawn in %s takes the id mid-read", async (_label, owner) => {
    const d = deps([record({ id: "live" })], {
      owners: { live: WORKSPACE },
      inventory: [],
      layout: [heldSnapshot()],
      serialized: { live: { data: "$ ok" } },
    });
    // Taken while a live sibling's screen is still being read, after the
    // layout has already answered with the hold.
    d.ptyClient.getSerializedStateAsync.mockImplementation(async (id: string) => {
      d.ptyClient.getTerminalProjectId.mockImplementation((asked: string) =>
        asked === "held" ? owner : asked === "live" ? WORKSPACE : null
      );
      return id === "live" ? { data: "$ ok" } : null;
    });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["live", "held"],
      includeOutput: true,
    });

    expect(result.terminals[1]).toEqual({
      terminalId: "held",
      agentId: null,
      agentState: null,
      error: NOT_FOUND,
    });
  });

  it("answers a foreign id exactly as an unknown one, with the same reads", async () => {
    const foreign = deps([], {
      owners: { x: "ws-other" },
      inventory: [],
      // The layout cannot vouch for an id the ledger gives to another project.
      layout: [heldSnapshot({ id: "x" })],
    });
    const unknown = deps([], { inventory: [], layout: [] });

    const a = await buildViewlessTerminalStatus(foreign, WORKSPACE, { terminalIds: ["x"] });
    const b = await buildViewlessTerminalStatus(unknown, WORKSPACE, { terminalIds: ["x"] });

    expect(a).toEqual(b);
    for (const d of [foreign, unknown]) {
      expect(d.ptyClient.getTerminalsForProjectAsync.mock.calls).toEqual([
        [WORKSPACE, { strict: true }],
      ]);
      expect(d.getProjectState.mock.calls).toEqual([[WORKSPACE]]);
      expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["a panel with no hold", heldSnapshot({ restoreRecovery: undefined })],
    ["a non-PTY panel", heldSnapshot({ kind: "browser" })],
  ])("keeps the generic row for %s", async (_label, snapshot) => {
    const d = deps([], { inventory: [], layout: [snapshot] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

    expect(result.terminals[0]?.error).toBe(NOT_FOUND);
  });

  it.each([
    ["an admitted assistant", new Set(["held"]), undefined],
    ["an admitted global session", undefined, new Set(["held"])],
  ])("never answers %s from the layout", async (_label, assistants, globals) => {
    const d = deps([], { inventory: [], layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(
      d,
      WORKSPACE,
      { terminalIds: ["held"] },
      assistants,
      globals
    );

    expect(result.terminals[0]?.error).toBe(NOT_FOUND);
  });

  it("never answers a help terminal from the layout", async () => {
    helpTerminalIds.add("held");
    try {
      const d = deps([], { inventory: [], layout: [heldSnapshot()] });

      const result = await buildViewlessTerminalStatus(d, WORKSPACE, { terminalIds: ["held"] });

      expect(result.terminals[0]?.error).toBe(NOT_FOUND);
    } finally {
      helpTerminalIds.delete("held");
    }
  });

  it("reads neither screen nor submission for a held pane", async () => {
    const d = deps([], { inventory: [], layout: [heldSnapshot()] });

    const result = await buildViewlessTerminalStatus(d, WORKSPACE, {
      terminalIds: ["held"],
      includeOutput: true,
      submissionToken: "tok",
    });

    expect(result.terminals[0]).toMatchObject({ hasPty: false, recentOutput: null });
    expect(result.terminals[0]?.submission).toBeUndefined();
    expect(result.terminals[0]?.error).toBeUndefined();
    expect(d.ptyClient.getSerializedStateAsync).not.toHaveBeenCalled();
    expect(d.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });
});
