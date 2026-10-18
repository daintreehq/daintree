import { describe, expect, it } from "vitest";
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

  it("never lists the assistant's own terminal", async () => {
    const pty = makePty({ "t-help": { kind: "terminal", isAssistantTerminal: true } });
    const { deps } = makeDeps({ getPtyReader: () => pty });

    const result = await executeViewlessAction(request("terminal.list", {}), deps);

    expect((result as { result: ListResult }).result.terminals).toEqual([]);
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
    const pty = makePty({ "t-1": { kind: "terminal" } });
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
        ]),
      }
    );

    const result = await executeViewlessAction(
      request("terminal.list", { includeClientMetadata: true }),
      deps
    );

    const row = (result as { result: ListResult }).result.terminals[0];
    expect(JSON.stringify(row)).not.toContain("SECRET");
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

    const result = await executeViewlessAction(request("terminal.getStatus", {}), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
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
            mruList: ["t-1", "t-2"],
            terminalSizes: { "t-1": { cols: 80, rows: 24 } },
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
    expect(state?.mruList).toEqual(["t-2"]);
    expect(state?.terminalSizes).toEqual({});
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
