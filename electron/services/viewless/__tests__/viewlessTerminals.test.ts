import { describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { CHANNELS } from "../../../ipc/channels.js";
import type { ProjectState } from "../../../../shared/types/project.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, makePty, PROJECT, request } from "./viewlessTestDeps.js";

function savedState(terminals: ProjectState["terminals"], extra: Partial<ProjectState> = {}) {
  return { projectId: PROJECT.id, sidebarWidth: 350, terminals, ...extra };
}

type ListResult = {
  terminals: Array<Record<string, unknown> & { id: string }>;
  panelLimit: { count: number; tier: string };
};

describe("terminal.list with no frontend", () => {
  it("lists the saved layout joined with live processes, then live terminals it never recorded", async () => {
    const pty = makePty({
      "t-agent": {
        kind: "terminal",
        title: "Claude: tests",
        worktreeId: "/repo-wt/a",
        detectedAgentId: "claude",
        agentState: "working",
      },
      "t-orphan": { kind: "terminal", title: "zsh" },
    });
    const { deps } = makeDeps(
      { getPtyReader: () => pty },
      {
        state: savedState([
          {
            id: "t-agent",
            kind: "terminal",
            title: "Claude",
            location: "dock",
            worktreeId: "/repo-wt/old",
          },
          // A saved state is a restart hint, never an observation.
          {
            id: "t-dead",
            kind: "terminal",
            title: "Old shell",
            location: "grid",
            agentState: "working",
          },
        ]),
      }
    );

    const result = await executeViewlessAction(request("terminal.list", {}), deps);

    const { terminals } = (result as { result: ListResult }).result;
    expect(terminals.map((t) => t.id)).toEqual(["t-agent", "t-dead", "t-orphan"]);
    expect(terminals[0]).toMatchObject({
      title: "Claude: tests",
      location: "dock",
      // A live move wins over stale filing.
      worktreeId: "/repo-wt/a",
      agentId: "claude",
      agentState: "working",
      isFocused: false,
      isInputLocked: false,
    });
    expect(terminals[1]).toMatchObject({ agentState: null, title: "Old shell" });
  });

  it("never lists or counts the assistant's own terminal", async () => {
    const pty = makePty({ "t-help": { kind: "terminal", isAssistantTerminal: true } });
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(request("terminal.list", {}), deps);

    expect((result as { result: ListResult }).result.terminals).toEqual([]);
    expect((result as { result: ListResult }).result.panelLimit.count).toBe(0);
  });

  it("lists a terminal only the project inventory can place, one spawned unstamped", async () => {
    const pty = makePty({ "t-legacy": { kind: "terminal" } });
    pty.getAllTerminalsAsync.mockResolvedValue([{ id: "t-legacy", kind: "terminal" }]);
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(request("terminal.list", {}), deps);

    expect((result as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual([
      "t-legacy",
    ]);
    expect((result as { result: ListResult }).result.panelLimit.count).toBe(1);
  });

  it("lists only this project's terminals", async () => {
    const pty = makePty({ "t-1": { kind: "terminal" } });
    pty.getAllTerminalsAsync.mockResolvedValue([
      { id: "t-1", projectId: PROJECT.id, kind: "terminal" },
      { id: "t-other", projectId: "proj-2", kind: "terminal" },
    ]);
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(request("terminal.list", {}), deps);

    expect((result as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual(["t-1"]);
  });

  it("leaves trashed terminals out unless asked for the trash", async () => {
    const pty = makePty({
      "t-1": { kind: "terminal", isTrashed: true },
      "t-2": { kind: "terminal" },
    });
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const all = await executeViewlessAction(request("terminal.list", {}), deps);
    const trash = await executeViewlessAction(
      request("terminal.list", { location: "trash" }),
      deps
    );

    expect((all as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual(["t-2"]);
    expect((trash as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual(["t-1"]);
    expect((all as { result: ListResult }).result.panelLimit.count).toBe(1);
  });

  it("filters by worktree and id", async () => {
    const pty = makePty({
      "t-1": { kind: "terminal", worktreeId: "/repo-wt/a" },
      "t-2": { kind: "terminal", worktreeId: "/repo-wt/b" },
    });
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const byWorktree = await executeViewlessAction(
      request("terminal.list", { worktreeId: "/repo-wt/b" }),
      deps
    );
    const byId = await executeViewlessAction(request("terminal.list", { terminalId: "t-1" }), deps);

    expect((byWorktree as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual([
      "t-2",
    ]);
    expect((byId as { result: ListResult }).result.terminals.map((t) => t.id)).toEqual(["t-1"]);
  });

  it("reads client metadata only off a panel the writer could have written", async () => {
    const pty = makePty({ "t-1": { kind: "terminal" }, "p-1": { kind: "terminal" } });
    const { deps } = makeDeps(
      { getPtyReader: () => pty },
      {
        state: savedState([
          {
            id: "t-1",
            kind: "terminal",
            title: "Shell",
            location: "grid",
            extensionState: { mcp: { ticket: "T-1" }, presetEnv: { SECRET: "x" } },
          },
          {
            id: "p-1",
            kind: "terminal",
            title: "Plugin's",
            location: "grid",
            pluginId: "acme",
            extensionState: { mcp: { ticket: "P-1" } },
          },
        ]),
      }
    );

    const asked = await executeViewlessAction(
      request("terminal.list", { includeClientMetadata: true }),
      deps
    );
    const plain = await executeViewlessAction(request("terminal.list", {}), deps);

    const rows = (asked as { result: ListResult }).result.terminals;
    expect(rows.find((row) => row.id === "t-1")?.clientMetadata).toEqual({ ticket: "T-1" });
    // A plugin owns its whole bag, so a key it chose to call `mcp` is not read.
    expect(rows.find((row) => row.id === "p-1")?.clientMetadata).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    for (const row of (plain as { result: ListResult }).result.terminals) {
      expect(row).not.toHaveProperty("clientMetadata");
    }
  });

  it("refuses an ownership filter, which only main can answer", async () => {
    const { deps } = makeDeps({ getPtyReader: () => makePty() });

    const result = await executeViewlessAction(request("terminal.list", { owned: true }), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });
});

describe("terminal.getOutput with no frontend", () => {
  it("reads a terminal's tail with ANSI stripped", async () => {
    const pty = makePty(
      { "t-1": { kind: "terminal" } },
      { "t-1": "\x1b[32mok\x1b[0m\nline two\n" }
    );
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(
      request("terminal.getOutput", { terminalId: "t-1", maxLines: 10 }),
      deps
    );

    expect(result).toMatchObject({ ok: true, result: { terminalId: "t-1", truncated: false } });
    const content = (result as { result: { content: string } }).result.content;
    expect(content).toContain("ok");
    expect(content).toContain("line two");
    expect(content).not.toContain("\x1b");
  });

  it("answers another project's terminal as one that is not there", async () => {
    const pty = makePty({}, { "t-other": "secret output" });
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(
      request("terminal.getOutput", { terminalId: "t-other" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { content: null, error: expect.any(String) },
    });
    expect(pty.getSerializedStateAsync).not.toHaveBeenCalled();
  });
});

describe("terminal.getStatus with no frontend", () => {
  it("answers from the pty-host read main already serves", async () => {
    const { deps } = makeDeps({
      readTerminalStatus: async (_args, projectId) =>
        ({
          terminals: [{ terminalId: `from-${projectId}` }],
          source: "pty",
          unavailableFields: [],
        }) as never,
    });

    const result = await executeViewlessAction(
      request("terminal.getStatus", { terminalIds: ["t-1"] }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { terminals: [{ terminalId: "from-proj-1" }] },
    });
  });

  it("reports a call it cannot answer as invalid, not as a failure to retry", async () => {
    const { deps } = makeDeps({
      readTerminalStatus: async () => {
        throw new McpError(ErrorCode.InvalidParams, "name the terminals");
      },
    });

    const result = await executeViewlessAction(
      request("terminal.getStatus", { terminalIds: [] }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  describe("naming no terminals: the fleet a view would pick (#13501)", () => {
    function fleet() {
      const pty = makePty({
        "t-grid": { kind: "terminal", worktreeId: "/repo-wt/a" },
        "t-dock": { kind: "terminal", worktreeId: "/repo-wt/b" },
        "t-trash": { kind: "terminal", isTrashed: true },
        "t-unsaved": { kind: "terminal" },
      });
      const readTerminalStatus = vi.fn(async (args: unknown) => ({
        terminals: ((args as { terminalIds: string[] }).terminalIds ?? []).map((terminalId) => ({
          terminalId,
          agentId: null,
          agentState: null,
        })),
        source: "pty" as const,
        unavailableFields: [],
      }));
      const { deps } = makeDeps(
        { getPtyReader: () => pty, readTerminalStatus: readTerminalStatus as never },
        {
          state: savedState([
            { id: "t-dock", kind: "terminal", title: "Dock", location: "dock" },
            { id: "t-grid", kind: "terminal", title: "Grid", location: "grid" },
            { id: "t-bg", kind: "terminal", title: "Background", location: "background" },
          ]),
        }
      );
      return { deps, readTerminalStatus };
    }

    it("reads the project's panels in layout order, leaving out the trash and the background", async () => {
      const { deps, readTerminalStatus } = fleet();

      const result = await executeViewlessAction(
        request("terminal.getStatus", { includeOutput: true }),
        deps
      );

      expect(readTerminalStatus).toHaveBeenCalledWith(
        { includeOutput: true, terminalIds: ["t-dock", "t-grid", "t-unsaved"] },
        PROJECT.id
      );
      expect(result).toMatchObject({ ok: true });
    });

    it("filters by worktree and by location as a view does", async () => {
      const { deps, readTerminalStatus } = fleet();

      await executeViewlessAction(
        request("terminal.getStatus", { worktreeId: "/repo-wt/a" }),
        deps
      );
      await executeViewlessAction(request("terminal.getStatus", { location: "trash" }), deps);

      expect(
        readTerminalStatus.mock.calls.map(
          ([args]) => (args as { terminalIds: string[] }).terminalIds
        )
      ).toEqual([["t-grid"], ["t-trash"]]);
    });

    it("answers an empty fleet with no terminals rather than an error", async () => {
      const { deps, readTerminalStatus } = fleet();

      const result = await executeViewlessAction(
        request("terminal.getStatus", { worktreeId: "/repo-wt/none" }),
        deps
      );

      expect(result).toMatchObject({ ok: true, result: { terminals: [], source: "pty" } });
      expect(readTerminalStatus).not.toHaveBeenCalled();
    });

    it("refuses a fleet the pty-host couldn't list whole, rather than reporting it short", async () => {
      const { deps, readTerminalStatus } = fleet();
      const pty = deps.getPtyReader()!;
      deps.getPtyReader = () => ({
        ...pty,
        getAllTerminalsWithCompletenessAsync: async () => ({
          terminals: await pty.getAllTerminalsAsync(),
          degraded: true,
        }),
      });

      const result = await executeViewlessAction(request("terminal.getStatus", {}), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
      expect(readTerminalStatus).not.toHaveBeenCalled();
    });

    it("refuses a fleet whose project inventory went unanswered", async () => {
      const { deps, readTerminalStatus } = fleet();
      const pty = deps.getPtyReader()!;
      deps.getPtyReader = () => ({
        ...pty,
        getTerminalsForProjectAsync: async (_projectId, options) => {
          if (options?.strict) throw new Error("shard didn't answer");
          return [];
        },
      });

      const result = await executeViewlessAction(request("terminal.getStatus", {}), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
      expect(readTerminalStatus).not.toHaveBeenCalled();
    });

    it("reads a fleet larger than one status read takes in batches, in layout order", async () => {
      const records = Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `t-${String(i).padStart(3, "0")}`,
          { kind: "terminal" },
        ])
      );
      const readTerminalStatus = vi.fn(async (args: unknown) => ({
        terminals: (args as { terminalIds: string[] }).terminalIds.map((terminalId) => ({
          terminalId,
          agentId: null,
          agentState: null,
        })),
        source: "pty" as const,
        unavailableFields: [],
      }));
      const { deps } = makeDeps({
        getPtyReader: () => makePty(records),
        readTerminalStatus: readTerminalStatus as never,
      });

      const result = await executeViewlessAction(request("terminal.getStatus", {}), deps);

      expect(
        readTerminalStatus.mock.calls.map(
          ([args]) => (args as { terminalIds: string[] }).terminalIds.length
        )
      ).toEqual([256, 44]);
      const ids = (
        result as { result: { terminals: Array<{ terminalId: string }> } }
      ).result.terminals.map((entry) => entry.terminalId);
      expect(ids).toEqual(Object.keys(records));
    });

    it("refuses arguments a view would refuse, whatever the fleet holds", async () => {
      const { deps, readTerminalStatus } = fleet();

      const result = await executeViewlessAction(
        request("terminal.getStatus", { worktreeId: "/repo-wt/none", includeOutput: "yes" }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(readTerminalStatus).not.toHaveBeenCalled();
    });

    it("refuses a delivery check that names no terminals, as a view does", async () => {
      const { deps, readTerminalStatus } = fleet();

      const result = await executeViewlessAction(
        request("terminal.getStatus", { submissionToken: "tok" }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
      expect(readTerminalStatus).not.toHaveBeenCalled();
    });
  });
});

describe("terminal.close with no frontend", () => {
  it("trashes the process and takes the panel out of the saved layout", async () => {
    const pty = makePty({ "t-1": { kind: "terminal" }, "t-2": { kind: "terminal" } });
    const { deps, store, invoke } = makeDeps(
      { getPtyReader: () => pty },
      {
        state: savedState(
          [
            { id: "t-1", kind: "terminal", title: "One", location: "grid" },
            { id: "t-2", kind: "terminal", title: "Two", location: "dock" },
          ],
          {
            tabGroups: [{ id: "g", location: "grid", activeTabId: "t-1", panelIds: ["t-1"] }],
            mruList: ["terminal:t-1", "terminal:t-2"],
            terminalSizes: { "t-1": { cols: 80, rows: 24 } },
            terminalLayout: { focusedTerminalId: "t-1", maximizedTerminalId: "t-2" },
          }
        ),
      }
    );

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "t-1" }),
      deps
    );

    expect(result).toEqual({ ok: true, result: { closedIds: ["t-1"] } });
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.TERMINAL_TRASH, ["t-1"]);
    const state = store.read();
    expect(state?.terminals.map((t) => t.id)).toEqual(["t-2"]);
    expect(state?.tabGroups).toEqual([]);
    expect(state?.mruList).toEqual(["terminal:t-2"]);
    expect(state?.terminalSizes).toEqual({});
    expect(state?.terminalLayout).toEqual({ maximizedTerminalId: "t-2" });
  });

  it("never reports a terminal closed when the pty-host could not be read", async () => {
    const pty = makePty({ "t-1": { kind: "terminal" } });
    pty.getTerminalAsync.mockRejectedValue(new Error("pty-host timed out"));
    const { deps, store, invoke } = makeDeps(
      { getPtyReader: () => pty },
      { state: savedState([{ id: "t-1", kind: "terminal", title: "One", location: "grid" }]) }
    );

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "t-1" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
    expect(pty.getTerminalAsync).toHaveBeenCalledWith("t-1", undefined, { strict: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.read()?.terminals.map((t) => t.id)).toEqual(["t-1"]);
  });

  it("drops a trashed terminal the layout still names, without trashing it again", async () => {
    const pty = makePty({ "t-1": { kind: "terminal", isTrashed: true } });
    const { deps, store, invoke } = makeDeps(
      { getPtyReader: () => pty },
      { state: savedState([{ id: "t-1", kind: "terminal", title: "One", location: "grid" }]) }
    );

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "t-1" }),
      deps
    );

    expect(result).toEqual({ ok: true, result: { closedIds: [] } });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.read()?.terminals).toEqual([]);
  });

  it("reports nothing closed for a terminal already in the trash", async () => {
    const pty = makePty({ "t-1": { kind: "terminal", isTrashed: true } });
    const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "t-1" }),
      deps
    );

    expect(result).toEqual({ ok: true, result: { closedIds: [] } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes a saved panel with no process by forgetting it", async () => {
    const { deps, store, invoke } = makeDeps(
      { getPtyReader: () => makePty() },
      { state: savedState([{ id: "b-1", kind: "browser", title: "Docs", location: "grid" }]) }
    );

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "b-1" }),
      deps
    );

    expect(result).toEqual({ ok: true, result: { closedIds: ["b-1"] } });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.read()?.terminals).toEqual([]);
  });

  it("rejects an id this project has no panel for", async () => {
    const { deps } = makeDeps({ getPtyReader: () => makePty() });

    const result = await executeViewlessAction(
      request("terminal.close", { terminalId: "nope" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });

  it("needs an explicit id, with no focused panel to fall back on", async () => {
    const { deps } = makeDeps({ getPtyReader: () => makePty() });

    const result = await executeViewlessAction(request("terminal.close", {}), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("terminal.interrupt with no frontend", () => {
  it("sends the cancel keystrokes to an agent mid-turn", async () => {
    const pty = makePty({
      "t-1": { kind: "terminal", detectedAgentId: "claude", agentState: "working" },
    });
    const { deps, send } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(
      request("terminal.interrupt", { terminalId: "t-1" }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { terminalId: "t-1", agentId: "claude", agentStateAtDispatch: "working" },
    });
    expect(send).toHaveBeenCalledWith(PROJECT.id, CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, [["t-1"]]);
  });

  it.each([
    ["an idle agent", { kind: "terminal", detectedAgentId: "claude", agentState: "idle" }],
    [
      "a trashed agent",
      { kind: "terminal", detectedAgentId: "claude", agentState: "working", isTrashed: true },
    ],
    ["a plain shell", { kind: "terminal" }],
    [
      "an exited agent",
      { kind: "terminal", launchAgentId: "claude", isExited: true, agentState: "working" },
    ],
  ])("refuses %s and writes nothing", async (_label, record) => {
    const { deps, send } = makeDeps({ getPtyReader: () => makePty({ "t-1": record }) });

    const result = await executeViewlessAction(
      request("terminal.interrupt", { terminalId: "t-1" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("terminal.sendKeys with no frontend", () => {
  it("writes each named key in order and reads the screen back", async () => {
    const pty = makePty({ "t-1": { kind: "terminal" } }, { "t-1": "Trust this folder?\n" });
    const { deps, send } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(
      request("terminal.sendKeys", { terminalId: "t-1", keys: ["Down", "Enter"] }),
      deps
    );

    expect(send.mock.calls).toEqual([
      [PROJECT.id, CHANNELS.TERMINAL_INPUT, ["t-1", "\x1b[B"]],
      [PROJECT.id, CHANNELS.TERMINAL_INPUT, ["t-1", "\r"]],
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        terminalId: "t-1",
        keys: ["Down", "Enter"],
        screen: expect.stringContaining("Trust"),
      },
    });
  });

  it("refuses a terminal this project does not have", async () => {
    const { deps, send } = makeDeps({ getPtyReader: () => makePty() });

    const result = await executeViewlessAction(
      request("terminal.sendKeys", { terminalId: "t-x", keys: ["Enter"] }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a call with neither keys nor an option to choose", async () => {
    const { deps, send } = makeDeps({
      getPtyReader: () => makePty({ "t-1": { kind: "terminal" } }),
    });

    const result = await executeViewlessAction(
      request("terminal.sendKeys", { terminalId: "t-1" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(send).not.toHaveBeenCalled();
  });
});
