import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalClientMock = vi.hoisted(() => ({ submit: vi.fn() }));
const getSerializedStatesMock = vi.hoisted(() => vi.fn());
const fleetArmingMock = vi.hoisted(() => ({ armedIds: new Set<string>() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds: fleetArmingMock.armedIds }) },
}));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { registerTerminalQueryActions } from "../terminalQueryActions";

/**
 * Snapshots cross IPC bundled with the grid they were captured at (#11552).
 * This action only reads the payload, so fixtures declare plain strings and
 * this wraps them rather than restating the envelope at every call site.
 */
function snapshotMap(
  entries: Record<string, string | null>
): Record<string, { data: string; cols: number; rows: number } | null> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, data]) => [
      id,
      data === null ? null : { data, cols: 80, rows: 24 },
    ])
  );
}

type StatusEntry = {
  terminalId: string;
  agentId: string | null;
  agentState: string | null;
  waitingReason?: string;
  lastTransitionAt?: number;
  exitCode?: number | null;
  spawnedAt?: number;
  lastCheckResult?: {
    command: string | null;
    passed: boolean;
    ranAt: number;
    failureSummary: string | null;
    truncated: boolean;
  };
  recentOutput?: string | null;
  armed?: boolean;
  error?: string;
};

type StatusResult = { terminals: StatusEntry[] };

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerTerminalQueryActions(actions, {} as ActionCallbacks);
  return actions;
}

async function callGetStatus(actions: ActionRegistry, args?: unknown): Promise<StatusResult> {
  const factory = actions.get("terminal.getStatus");
  if (!factory) throw new Error("missing terminal.getStatus");
  const def = factory() as AnyActionDefinition;
  return (await def.run(args, {} as never)) as StatusResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  fleetArmingMock.armedIds = new Set<string>();
  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        terminal: {
          getSerializedStates: getSerializedStatesMock,
        },
      },
    },
    writable: true,
    configurable: true,
  });
});

describe("terminal.getStatus", () => {
  it("returns a `terminals` object wrapper, never a raw array", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });

    const result = await callGetStatus(setupActions());
    expect(Array.isArray(result)).toBe(false);
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0]?.terminalId).toBe("t1");
  });

  it("resolves explicit terminalIds and returns per-entry error for unknown ids", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "working" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "completed" },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "missing", "t2"],
    });

    expect(terminals).toHaveLength(3);
    expect(terminals[0]).toMatchObject({ terminalId: "t1", agentState: "working" });
    expect(terminals[1]).toMatchObject({
      terminalId: "missing",
      agentState: null,
      error: "Terminal not found",
    });
    expect(terminals[2]).toMatchObject({ terminalId: "t2", agentState: "completed" });
  });

  it("treats ephemeral panels as not found when targeted by id", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "dock",
          agentState: "idle",
          excludeFromPersistence: true,
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
    });

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      terminalId: "t1",
      agentState: null,
      error: "Terminal not found",
    });
  });

  it("default filter excludes trash and background panels", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3", "t4"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "trash", agentState: "exited" },
        t3: { id: "t3", kind: "terminal", location: "background", agentState: "idle" },
        t4: { id: "t4", kind: "terminal", location: "dock", agentState: "working" },
      },
    });

    const { terminals } = await callGetStatus(setupActions());
    const ids = terminals.map((t) => t.terminalId).sort();
    expect(ids).toEqual(["t1", "t4"]);
  });

  it("filters by worktreeId and explicit location", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-a" },
        t2: { id: "t2", kind: "terminal", location: "grid", worktreeId: "wt-b" },
        t3: { id: "t3", kind: "terminal", location: "trash", worktreeId: "wt-a" },
      },
    });

    const byWorktree = await callGetStatus(setupActions(), { worktreeId: "wt-a" });
    expect(byWorktree.terminals.map((t) => t.terminalId)).toEqual(["t1"]);

    const byLocation = await callGetStatus(setupActions(), { location: "trash" });
    expect(byLocation.terminals.map((t) => t.terminalId)).toEqual(["t3"]);
  });

  it("excludes excludeFromPersistence panels from filter results", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "dock", agentState: "idle" },
        t2: {
          id: "t2",
          kind: "terminal",
          location: "dock",
          agentState: "idle",
          excludeFromPersistence: true,
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions());
    expect(terminals.map((t) => t.terminalId)).toEqual(["t1"]);
  });

  it("includes removeOnExit-only panels in filter results (flags are independent)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "dock", agentState: "idle" },
        t2: {
          id: "t2",
          kind: "terminal",
          location: "dock",
          agentState: "idle",
          removeOnExit: true,
          excludeFromPersistence: false,
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions());
    expect(terminals.map((t) => t.terminalId)).toEqual(["t1", "t2"]);
  });

  it("prefers detectedAgentId over launchAgentId", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          launchAgentId: "claude",
          detectedAgentId: "codex",
          agentState: "working",
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: ["t1"] });
    expect(terminals[0]?.agentId).toBe("codex");
  });

  it("falls back to launchAgentId when no live detection", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          launchAgentId: "claude",
          agentState: "idle",
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: ["t1"] });
    expect(terminals[0]?.agentId).toBe("claude");
  });

  it("includes waitingReason only when agentState is `waiting`", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "waiting",
          waitingReason: "question",
        },
        t2: {
          id: "t2",
          kind: "terminal",
          location: "grid",
          agentState: "working",
          waitingReason: "prompt", // present but should be omitted
        },
        t3: { id: "t3", kind: "terminal", location: "grid", agentState: "waiting" },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "t2", "t3"],
    });
    expect(terminals[0]?.waitingReason).toBe("question");
    expect(terminals[1]?.waitingReason).toBeUndefined();
    expect(terminals[2]?.waitingReason).toBeUndefined();
  });

  it("sources lastTransitionAt from TerminalInstance.lastStateChange", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "idle",
          lastStateChange: 1_700_000_000_000,
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: ["t1"] });
    expect(terminals[0]?.lastTransitionAt).toBe(1_700_000_000_000);
  });

  it("surfaces exitCode and spawnedAt from the panel (#10638)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "exited",
          launchAgentId: "claude",
          exitCode: 1,
          startedAt: 1_700_000_000_000,
        },
        // Still running — no exitCode on the panel yet → reported as null.
        t2: {
          id: "t2",
          kind: "terminal",
          location: "grid",
          agentState: "working",
          launchAgentId: "claude",
          startedAt: 1_700_000_001_000,
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: ["t1", "t2"] });
    expect(terminals[0]).toMatchObject({
      terminalId: "t1",
      exitCode: 1,
      spawnedAt: 1_700_000_000_000,
    });
    expect(terminals[1]?.exitCode).toBeNull();
    expect(terminals[1]?.spawnedAt).toBe(1_700_000_001_000);
  });

  it("surfaces lastCheckResult from the panel, undefined when absent (#10682)", async () => {
    const checkResult = {
      command: "npm run check",
      passed: false,
      ranAt: 1_700_000_000_500,
      failureSummary: "Found 2 errors.",
      truncated: false,
    };
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "waiting",
          launchAgentId: "claude",
          lastCheckResult: checkResult,
        },
        // No check observed → field absent in the entry.
        t2: {
          id: "t2",
          kind: "terminal",
          location: "grid",
          agentState: "working",
          launchAgentId: "claude",
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: ["t1", "t2"] });
    expect(terminals[0]?.lastCheckResult).toEqual(checkResult);
    expect(terminals[1]?.lastCheckResult).toBeUndefined();
  });

  it("does not call getSerializedStates when includeOutput is omitted", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "working" },
      },
    });

    const { terminals } = await callGetStatus(setupActions());
    expect(getSerializedStatesMock).not.toHaveBeenCalled();
    expect(terminals.every((t) => t.recentOutput === undefined)).toBe(true);
  });

  it("calls getSerializedStates exactly once for the whole fleet (no N+1)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "working" },
        t3: { id: "t3", kind: "terminal", location: "grid", agentState: "waiting" },
      },
    });
    getSerializedStatesMock.mockResolvedValue(
      snapshotMap({ t1: "alpha\nbeta", t2: "gamma", t3: null })
    );

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10 },
    });

    expect(getSerializedStatesMock).toHaveBeenCalledTimes(1);
    expect(getSerializedStatesMock).toHaveBeenCalledWith(["t1", "t2", "t3"]);
    expect(terminals.find((t) => t.terminalId === "t1")?.recentOutput).toBe("alpha\nbeta");
    expect(terminals.find((t) => t.terminalId === "t3")?.recentOutput).toBeNull();
  });

  it("surfaces real content past a bottom-padding tail (issue #10763)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "waiting" },
      },
    });
    // Codex-shaped buffer: answer + idle composer, then bottom blank padding
    // that would otherwise fill the small recentOutput window entirely.
    getSerializedStatesMock.mockResolvedValue(
      snapshotMap({ t1: "agent answer\nidle composer\r\n" + "\r\n".repeat(40) })
    );

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10 },
    });
    const out = terminals.find((t) => t.terminalId === "t1")?.recentOutput as string;
    // The 40-row blank padding is gone; recentOutput is exactly the real tail.
    expect(out).toBe("agent answer\nidle composer");
  });

  it("caps includeOutput.lines at 50", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: lines }));

    // The Zod schema rejects values >50 at the boundary, but the runtime guard
    // also clamps for callers that bypass schema validation. Test the runtime
    // guard with an in-range value (50) and assert the slice length.
    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 50 },
    });
    const out = terminals[0]?.recentOutput;
    expect(typeof out).toBe("string");
    expect((out as string).split("\n")).toHaveLength(50);
    expect((out as string).split("\n")[0]).toBe("line-150");
  });

  it("strips ANSI by default and preserves it when stripAnsi is false", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    const ansi = "\x1b[31mred\x1b[0m";
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: ansi }));

    const stripped = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10 },
    });
    expect(stripped.terminals[0]?.recentOutput).toBe("red");

    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: ansi }));
    const raw = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10, stripAnsi: false },
    });
    expect(raw.terminals[0]?.recentOutput).toBe(ansi);
  });

  it("preserves status fields when getSerializedStates rejects", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "working",
          launchAgentId: "claude",
          lastStateChange: 1234,
        },
      },
    });
    getSerializedStatesMock.mockRejectedValue(new Error("ipc gone"));

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10 },
    });

    expect(terminals[0]).toMatchObject({
      terminalId: "t1",
      agentState: "working",
      agentId: "claude",
      lastTransitionAt: 1234,
      recentOutput: null,
      error: "ipc gone",
    });
  });

  it("returns empty terminals array when filter matches nothing", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: [],
      panelsById: {},
    });

    const { terminals } = await callGetStatus(setupActions());
    expect(terminals).toEqual([]);
    expect(getSerializedStatesMock).not.toHaveBeenCalled();
  });

  it("does not invoke getSerializedStates when no resolved terminals exist", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: [],
      panelsById: {},
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["missing-1", "missing-2"],
      includeOutput: { lines: 10 },
    });

    expect(terminals).toHaveLength(2);
    expect(terminals.every((t) => t.error === "Terminal not found")).toBe(true);
    expect(getSerializedStatesMock).not.toHaveBeenCalled();
  });

  it("explicit terminalIds: [] returns empty rather than the full fleet", async () => {
    // Schema rejects empty arrays, but the runtime guard must still treat an
    // explicit `terminalIds` array as the targeted path — never silently fall
    // back to the fleet. Bypass schema by calling run() directly with [].
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "working" },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), { terminalIds: [] });
    expect(terminals).toEqual([]);
  });

  it("explicit terminalIds bypasses worktreeId/location filters", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          worktreeId: "wt-a",
          agentState: "idle",
        },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      worktreeId: "wt-other",
      location: "trash",
    });

    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.terminalId).toBe("t1");
    expect(terminals[0]?.error).toBeUndefined();
  });

  it("ANDs worktreeId and location filters in the fleet path", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-a" },
        t2: { id: "t2", kind: "terminal", location: "trash", worktreeId: "wt-a" },
        t3: { id: "t3", kind: "terminal", location: "grid", worktreeId: "wt-b" },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      worktreeId: "wt-a",
      location: "grid",
    });

    expect(terminals.map((t) => t.terminalId)).toEqual(["t1"]);
  });

  it("clamps runtime lines to 50 when callers bypass the schema with an out-of-range value", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: lines }));

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 999 },
    });
    const out = terminals[0]?.recentOutput as string;
    expect(out.split("\n")).toHaveLength(50);
    expect(out.split("\n")[0]).toBe("line-150");
  });

  it("returns recentOutput: null without error when getSerializedStates omits a key", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "working" },
      },
    });
    // t2 is omitted from the response (not even null) — distinct from the
    // "explicit null" failure mode of the IPC handler.
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha" }));

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 10 },
    });

    const t1 = terminals.find((t) => t.terminalId === "t1");
    const t2 = terminals.find((t) => t.terminalId === "t2");
    expect(t1?.recentOutput).toBe("alpha");
    expect(t1?.error).toBeUndefined();
    expect(t2?.recentOutput).toBeNull();
    expect(t2?.error).toBeUndefined();
  });

  it("reflects the fleet arming set: armed true only for armed terminals", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "working" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    fleetArmingMock.armedIds = new Set<string>(["t1"]);

    const { terminals } = await callGetStatus(setupActions());

    expect(terminals.find((t) => t.terminalId === "t1")?.armed).toBe(true);
    expect(terminals.find((t) => t.terminalId === "t2")?.armed).toBe(false);
  });

  it("omits armed on not-found entries (they carry error instead)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    fleetArmingMock.armedIds = new Set<string>(["t1"]);

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "missing"],
    });

    expect(terminals.find((t) => t.terminalId === "t1")?.armed).toBe(true);
    const missing = terminals.find((t) => t.terminalId === "missing");
    expect(missing?.error).toBe("Terminal not found");
    expect(missing?.armed).toBeUndefined();
  });
});
