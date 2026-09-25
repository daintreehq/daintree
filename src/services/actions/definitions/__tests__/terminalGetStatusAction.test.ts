import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalClientMock = vi.hoisted(() => ({
  submit: vi.fn(),
  getSubmissions: vi.fn(),
  getOutputActivity: vi.fn(),
}));
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

import type { TerminalStatusResult } from "@shared/types/terminalStatus";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "@shared/config/mcpLimits";
import { registerTerminalQueryActions } from "../terminalQueryActions";
import { TerminalStatusResultSchema } from "../schemas";

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

// The shared wire types rather than a third hand-maintained mirror that drifts
// from the contract it copies. It does NOT catch a builder omission: every
// added field is optional and `callGetStatus` casts, so TypeScript has nothing
// to complain about. The behavioural assertions below carry that weight.
type StatusResult = TerminalStatusResult;

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
  // Every terminal reads back with no change observed unless a test says
  // otherwise, so `includeOutput` cases about other fields see no row error.
  terminalClientMock.getOutputActivity.mockImplementation(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { status: "read" }]))
  );
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
  it("names its source and declares only the pty-host fields unobservable (#12316, #12336, #12428)", async () => {
    // The same envelope the main-process fallback answers in. A live view saw
    // the panel-shaped fields, so their absence is evidence — a missing `armed`
    // here means "not armed", not "unknown". `hasPty` and `lastOutputChangeAt`
    // are the exceptions: the pty-host computes them and the panel store holds
    // no live copy, so this surface says it could not look rather than
    // reporting silence.
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });

    const result = await callGetStatus(setupActions());

    expect(result.source).toBe("renderer");
    expect(result.unavailableFields).toEqual(["hasPty", "lastOutputChangeAt", "lastTypedInputAt"]);
    expect(result.terminals[0]?.armed).toBe(false);
  });

  it("emits no hasPty key rather than a value it cannot observe (#12336)", async () => {
    // Nothing in the renderer writes `PtyPanelData.hasPty` — not `addPanel`,
    // not `statePatcher` on restore or reconnect, not the `onExit` listener —
    // and `fleetEligibility.ts` records that it lags. Forwarding the stale
    // property, or deriving one from `runtimeStatus`, would publish an
    // interpretation as a process fact. Read off the serialized payload,
    // because an explicit `hasPty: undefined` would vanish on the wire while
    // still satisfying an in-memory property check.
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["live", "stale", "plain"],
      panelsById: {
        live: { id: "live", kind: "terminal", location: "grid", agentState: "working" },
        // A panel carrying the vestigial property must not be believed either.
        stale: {
          id: "stale",
          kind: "terminal",
          location: "grid",
          agentState: "exited",
          hasPty: true,
          runtimeStatus: "exited",
        },
        plain: { id: "plain", kind: "file", location: "grid" },
      },
    });

    const result = await callGetStatus(setupActions());

    expect(result.terminals).toHaveLength(3);
    for (const entry of result.terminals) {
      expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty("hasPty");
    }
    // Pin that these are resolved rows: three error rows would satisfy the
    // omission check above while proving nothing about a populated answer.
    expect(result.terminals.map((t) => t.terminalId)).toEqual(["live", "stale", "plain"]);
    for (const entry of result.terminals) expect(entry.error).toBeUndefined();
    // The non-PTY panel resolves with null agent identity rather than erroring.
    expect(result.terminals[2]).toMatchObject({ agentId: null, agentState: null });
    expect(result.unavailableFields).toEqual(["hasPty", "lastOutputChangeAt", "lastTypedInputAt"]);
  });

  it("emits no lastOutputChangeAt, even from a panel that carries one (#12428)", async () => {
    // The timestamp is tracked on the pty-host's viewport, and the panel store
    // holds no copy. A stray property on a panel is not an observation.
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "working",
          lastOutputChangeAt: 1234,
        },
      },
    });

    const result = await callGetStatus(setupActions());

    expect(result.terminals[0]?.terminalId).toBe("t1");
    expect(result.terminals[0]?.error).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result.terminals[0]))).not.toHaveProperty(
      "lastOutputChangeAt"
    );
    expect(result.unavailableFields).toContain("lastOutputChangeAt");
  });

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

  it("surfaces the observed session count, zero when none has been recorded (#12535)", async () => {
    // The pty generation cannot move for a relaunch inside an unchanged pty, so
    // this is what tells a bound session from its successor. Reported as zero
    // for a pty panel with none recorded, because the row is born with the pty
    // and this surface subscribes to every event that moves the count — absent
    // would read as unobservable and refuse every delivery it answers for.
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          location: "grid",
          agentState: "waiting",
          launchAgentId: "claude",
          startedAt: 1_700_000_000_000,
        },
        t2: {
          id: "t2",
          kind: "terminal",
          location: "grid",
          agentState: "waiting",
          launchAgentId: "claude",
          startedAt: 1_700_000_000_000,
          agentIncarnation: 3,
        },
        t3: { id: "t3", kind: "browser", location: "grid" },
      },
    });

    const { terminals } = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "t2", "t3"],
    });
    expect(terminals[0]?.agentIncarnation).toBe(0);
    expect(terminals[1]?.agentIncarnation).toBe(3);
    expect(terminals[2]?.agentIncarnation).toBeUndefined();
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

  it("flags recentOutputTruncated only when older output was left out (#12450)", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "idle" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "idle" },
        t3: { id: "t3", kind: "terminal", location: "grid", agentState: "idle" },
      },
    });
    getSerializedStatesMock.mockResolvedValue(
      snapshotMap({ t1: "one\ntwo\nthree", t2: "only", t3: null })
    );

    const { terminals } = await callGetStatus(setupActions(), {
      includeOutput: { lines: 2 },
    });

    expect(terminals[0]).toMatchObject({ recentOutput: "two\nthree", recentOutputTruncated: true });
    expect(terminals[1]?.recentOutput).toBe("only");
    expect(terminals[1]).not.toHaveProperty("recentOutputTruncated");
    expect(terminals[2]?.recentOutput).toBeNull();
    expect(terminals[2]).not.toHaveProperty("recentOutputTruncated");
  });

  it("fits a busy fleet's tails under the response cap, newest lines kept (#12450)", async () => {
    const ids = ["t1", "t2", "t3", "t4"];
    const linesFor = (id: string) =>
      Array.from({ length: 50 }, (_, i) => `${id} row ${i} `.padEnd(600, "│"));
    panelStoreMock.getState.mockReturnValue({
      panelIds: ids,
      panelsById: Object.fromEntries(
        ids.map((id) => [id, { id, kind: "terminal", location: "grid", agentState: "working" }])
      ),
    });
    getSerializedStatesMock.mockResolvedValue(
      snapshotMap(Object.fromEntries(ids.map((id) => [id, linesFor(id).join("\n")])))
    );
    // Activity rides the same call (#12495), so its bytes are part of what the
    // tails have to fit around.
    terminalClientMock.getOutputActivity.mockResolvedValue(
      Object.fromEntries(
        ids.map((id, i) => [id, { status: "read", lastOutputChangeAt: 1_700_000_000_000 + i }])
      )
    );

    const result = await callGetStatus(setupActions(), { includeOutput: { lines: 50 } });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
    expect(result.terminals.map((t) => t.terminalId)).toEqual(ids);
    for (const [i, entry] of result.terminals.entries()) {
      const lines = linesFor(entry.terminalId);
      expect(entry.recentOutput).not.toBe("");
      const kept = (entry.recentOutput ?? "").split("\n");
      expect(kept).toEqual(lines.slice(-kept.length));
      expect(entry.recentOutputTruncated).toBe(true);
      expect(entry.agentState).toBe("working");
      expect(entry.lastOutputChangeAt).toBe(1_700_000_000_000 + i);
    }
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

describe("terminal.getStatus submission correlation (#12337)", () => {
  function onePanel() {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "waiting" },
      },
    });
  }

  it("issues no extra lookup when no token was named", async () => {
    onePanel();

    const result = await callGetStatus(setupActions(), { terminalIds: ["t1"] });

    // The default poll path is the hot one — it must not pay for a feature it
    // did not ask for.
    expect(terminalClientMock.getSubmissions).not.toHaveBeenCalled();
    expect(result.terminals[0]?.submission).toBeUndefined();
  });

  it("refuses a token without explicit terminalIds", async () => {
    onePanel();

    // The lookup is terminal-keyed; a filter-only call has no id list to
    // resolve the token against.
    await expect(callGetStatus(setupActions(), { submissionToken: "tok-1" })).rejects.toThrow(
      /terminalIds/
    );
  });

  it("attaches the record the host returned", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({
      t1: { status: "found", record: { token: "tok-1", phase: "pty_written", at: 4242 } },
    });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    expect(terminalClientMock.getSubmissions).toHaveBeenCalledWith(["t1"], "tok-1");
    expect(result.terminals[0]?.submission).toEqual({
      token: "tok-1",
      phase: "pty_written",
      at: 4242,
    });
  });

  it("keeps the output observation through the dispatcher's result parse (#12478)", async () => {
    onePanel();
    const record = {
      token: "tok-1",
      phase: "pty_written" as const,
      at: 4242,
      outputChangeAfterWriteAt: 9000,
    };
    terminalClientMock.getSubmissions.mockResolvedValue({ t1: { status: "found", record } });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    // Dispatch parses results against this schema (#11539), and a Zod object
    // strips keys it does not declare — an undeclared field would vanish on
    // the way out.
    expect(TerminalStatusResultSchema.parse(result).terminals[0]?.submission).toEqual(record);
  });

  it("reports unknown when the terminal was read and holds no record", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({ t1: { status: "absent" } });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-gone",
    });

    expect(result.terminals[0]?.submission).toEqual({ token: "tok-gone", phase: "unknown" });
    expect(result.terminals[0]?.error).toBeUndefined();
  });

  it("does not claim unknown for a terminal that could not be read at all", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({ t1: { status: "unreadable" } });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    // A host RPC that timed out observed nothing. `unknown` would assert this
    // terminal has no such submission on the strength of a failed query — the
    // false certainty this whole issue exists to remove.
    expect(result.terminals[0]?.submission).toBeUndefined();
    expect(result.terminals[0]?.error).toBeDefined();
  });

  it("does not claim unknown for an id the lookup omitted entirely", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({});

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    expect(result.terminals[0]?.submission).toBeUndefined();
    expect(result.terminals[0]?.error).toBeDefined();
  });

  it("keeps each terminal's own outcome in a mixed batch", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["t1", "t2", "t3"],
      panelsById: {
        t1: { id: "t1", kind: "terminal", location: "grid", agentState: "waiting" },
        t2: { id: "t2", kind: "terminal", location: "grid", agentState: "waiting" },
        t3: { id: "t3", kind: "terminal", location: "grid", agentState: "waiting" },
      },
    });
    terminalClientMock.getSubmissions.mockResolvedValue({
      t1: { status: "found", record: { token: "tok-1", phase: "pty_written", at: 1 } },
      t2: { status: "absent" },
      t3: { status: "unreadable" },
    });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "t2", "t3"],
      submissionToken: "tok-1",
    });

    // One batched call, and each row keyed to its own id rather than to
    // whatever the first result happened to be.
    expect(terminalClientMock.getSubmissions).toHaveBeenCalledTimes(1);
    expect(result.terminals[0]?.submission).toEqual({
      token: "tok-1",
      phase: "pty_written",
      at: 1,
    });
    expect(result.terminals[1]?.submission).toEqual({ token: "tok-1", phase: "unknown" });
    expect(result.terminals[2]?.submission).toBeUndefined();
    expect(result.terminals[2]?.error).toBeDefined();
  });

  it("keeps a successful submission record when only the output fetch failed", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({
      t1: { status: "found", record: { token: "tok-1", phase: "pty_written", at: 1 } },
    });
    getSerializedStatesMock.mockRejectedValue(new Error("output fetch died"));

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
      includeOutput: { lines: 5 },
    });

    // The two fetches fail independently; losing one must not discard the
    // other's answer.
    expect(result.terminals[0]?.submission?.phase).toBe("pty_written");
    expect(result.terminals[0]?.error).toContain("output fetch died");
  });

  it("reports an error rather than unknown when the lookup itself failed", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockRejectedValue(new Error("host is down"));

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    // `unknown` asserts the terminal has no such submission. A failed lookup
    // observed nothing at all and must not make that claim.
    expect(result.terminals[0]?.submission).toBeUndefined();
    expect(result.terminals[0]?.error).toContain("host is down");
  });

  it("reports both batch failures instead of letting the later one hide the earlier", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockRejectedValue(new Error("submission lookup died"));
    getSerializedStatesMock.mockRejectedValue(new Error("output fetch died"));

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
      includeOutput: { lines: 5 },
    });

    // Two independent fetches, two things the caller lost. Assigning rather
    // than appending would report only the output failure, and the missing
    // `submission` would look like it was never asked for.
    expect(result.terminals[0]?.error).toContain("submission lookup died");
    expect(result.terminals[0]?.error).toContain("output fetch died");
  });

  it("leaves a not-found entry alone instead of inventing a record for it", async () => {
    onePanel();
    terminalClientMock.getSubmissions.mockResolvedValue({ t1: { status: "absent" } });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "ghost"],
      submissionToken: "tok-1",
    });

    expect(terminalClientMock.getSubmissions).toHaveBeenCalledWith(["t1"], "tok-1");
    expect(result.terminals[1]?.error).toBe("Terminal not found");
    expect(result.terminals[1]?.submission).toBeUndefined();
  });
});

describe("terminal.getStatus output activity (#12495)", () => {
  function panels(...entries: Array<Record<string, unknown>>) {
    panelStoreMock.getState.mockReturnValue({
      panelIds: entries.map((e) => e.id),
      panelsById: Object.fromEntries(entries.map((e) => [e.id, e])),
    });
  }

  it("issues no activity read unless output was asked for", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    terminalClientMock.getSubmissions.mockResolvedValue({ t1: { status: "absent" } });

    const plain = await callGetStatus(setupActions());
    const tokened = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
    });

    // The default poll is the hot path; it must stay free of pty-host hops.
    expect(terminalClientMock.getOutputActivity).not.toHaveBeenCalled();
    for (const result of [plain, tokened]) {
      expect(result.unavailableFields).toEqual([
        "hasPty",
        "lastOutputChangeAt",
        "lastTypedInputAt",
      ]);
      expect(JSON.parse(JSON.stringify(result.terminals[0]))).not.toHaveProperty(
        "lastOutputChangeAt"
      );
    }
  });

  it("fills the host's timestamp for working and settled terminals alike", async () => {
    panels(
      // A stray panel property is not an observation; the host's value wins.
      {
        id: "t1",
        kind: "terminal",
        location: "grid",
        agentState: "working",
        lastOutputChangeAt: 1,
      },
      { id: "t2", kind: "terminal", location: "grid", agentState: "idle" }
    );
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha", t2: "beta" }));
    terminalClientMock.getOutputActivity.mockResolvedValue({
      t1: { status: "read", lastOutputChangeAt: 5_000 },
      t2: { status: "read", lastOutputChangeAt: 6_000 },
    });

    const result = await callGetStatus(setupActions(), { includeOutput: { lines: 5 } });

    expect(terminalClientMock.getOutputActivity).toHaveBeenCalledWith(["t1", "t2"]);
    for (const entry of result.terminals) expect(entry.error).toBeUndefined();
    expect(result.terminals[0]?.recentOutput).toBe("alpha");
    // Read off the parsed result: dispatch parses against this schema, and a
    // Zod object strips keys it does not declare.
    const parsed = TerminalStatusResultSchema.parse(result);
    expect(parsed.terminals.map((t) => t.lastOutputChangeAt)).toEqual([5_000, 6_000]);
    // Looked for on this call, so no longer a field the surface cannot see.
    expect(parsed.unavailableFields).toEqual(["hasPty"]);
  });

  it("omits the key without an error when no change has been observed yet", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha" }));
    terminalClientMock.getOutputActivity.mockResolvedValue({ t1: { status: "read" } });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    expect(JSON.parse(JSON.stringify(result.terminals[0]))).not.toHaveProperty(
      "lastOutputChangeAt"
    );
    expect(result.terminals[0]?.error).toBeUndefined();
    expect(result.unavailableFields).toEqual(["hasPty"]);
  });

  it("reports an unreadable terminal as an error rather than an unchanged screen", async () => {
    panels(
      { id: "t1", kind: "terminal", location: "grid", agentState: "working" },
      { id: "t2", kind: "terminal", location: "grid", agentState: "working" },
      { id: "t3", kind: "terminal", location: "grid", agentState: "working" }
    );
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "a", t2: "b", t3: "c" }));
    // t3 is missing from the reply entirely, which is no more of a read.
    terminalClientMock.getOutputActivity.mockResolvedValue({
      t1: { status: "unreadable" },
      t2: { status: "read", lastOutputChangeAt: 42 },
    });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    const [t1, t2, t3] = result.terminals;
    expect(t1?.error).toBe("Output activity unavailable for this terminal");
    expect(t3?.error).toBe("Output activity unavailable for this terminal");
    expect(t1).not.toHaveProperty("lastOutputChangeAt");
    expect(t3).not.toHaveProperty("lastOutputChangeAt");
    // One bad read costs only its own row, and says so there rather than
    // taking the field away from the whole answer.
    expect(t2?.lastOutputChangeAt).toBe(42);
    expect(t2?.error).toBeUndefined();
    expect(t1?.recentOutput).toBe("a");
    expect(result.unavailableFields).toEqual(["hasPty"]);
  });

  it("keeps the field available when every row of a completed read is unreadable", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha" }));
    terminalClientMock.getOutputActivity.mockResolvedValue({ t1: { status: "unreadable" } });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    // Per-row failures are row errors. Only a hop that failed outright makes
    // the surface itself unable to look.
    expect(result.terminals[0]?.error).toBe("Output activity unavailable for this terminal");
    expect(result.unavailableFields).toEqual(["hasPty"]);
  });

  it("asks only about resolved PTY panels", async () => {
    panels(
      { id: "t1", kind: "terminal", location: "grid", agentState: "working" },
      { id: "f1", kind: "file", location: "grid" }
    );
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha", f1: null }));
    terminalClientMock.getOutputActivity.mockResolvedValue({
      t1: { status: "read", lastOutputChangeAt: 7 },
    });

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1", "f1", "ghost"],
      includeOutput: {},
    });

    expect(terminalClientMock.getOutputActivity).toHaveBeenCalledWith(["t1"]);
    expect(result.terminals[0]?.lastOutputChangeAt).toBe(7);
    // A panel with no tracker is not an unread one.
    expect(result.terminals[1]?.error).toBeUndefined();
    expect(result.terminals[2]?.error).toBe("Terminal not found");
  });

  it("issues no activity read when no PTY panel resolved", async () => {
    panels({ id: "f1", kind: "file", location: "grid" });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ f1: null }));

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    expect(terminalClientMock.getOutputActivity).not.toHaveBeenCalled();
    expect(result.unavailableFields).toEqual(["hasPty"]);
  });

  it("issues the activity and output reads together rather than one after the other", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    // Both held open: a sequential implementation, in either order, leaves the
    // second read unissued while the first is pending.
    let releaseOutput!: (value: unknown) => void;
    let releaseActivity!: (value: unknown) => void;
    getSerializedStatesMock.mockReturnValue(
      new Promise((resolve) => {
        releaseOutput = resolve;
      })
    );
    terminalClientMock.getOutputActivity.mockReturnValue(
      new Promise((resolve) => {
        releaseActivity = resolve;
      })
    );

    const pending = callGetStatus(setupActions(), { includeOutput: {} });
    await Promise.resolve();

    expect(getSerializedStatesMock).toHaveBeenCalledTimes(1);
    expect(terminalClientMock.getOutputActivity).toHaveBeenCalledTimes(1);
    releaseOutput(snapshotMap({ t1: "alpha" }));
    releaseActivity({ t1: { status: "read", lastOutputChangeAt: 3 } });
    const result = await pending;
    expect(result.terminals[0]).toMatchObject({ recentOutput: "alpha", lastOutputChangeAt: 3 });
  });

  it("fills the host's typed-input time alongside the output time (#12718)", async () => {
    panels(
      { id: "t1", kind: "terminal", location: "grid", agentState: "waiting" },
      { id: "t2", kind: "terminal", location: "grid", agentState: "waiting" }
    );
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha", t2: "beta" }));
    terminalClientMock.getOutputActivity.mockResolvedValue({
      // Typed with no screen change yet must still surface.
      t1: { status: "read", lastTypedInputAt: 8_000 },
      t2: { status: "read", lastOutputChangeAt: 6_000, lastTypedInputAt: 4_000 },
    });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    const parsed = TerminalStatusResultSchema.parse(result);
    expect(parsed.terminals[0]?.lastTypedInputAt).toBe(8_000);
    expect(parsed.terminals[0]).not.toHaveProperty("lastOutputChangeAt");
    expect(parsed.terminals[1]).toMatchObject({
      lastOutputChangeAt: 6_000,
      lastTypedInputAt: 4_000,
    });
    expect(parsed.unavailableFields).toEqual(["hasPty"]);
  });

  it("keeps the tail when the activity read fails, and says the field went unobserved", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    getSerializedStatesMock.mockResolvedValue(snapshotMap({ t1: "alpha" }));
    terminalClientMock.getOutputActivity.mockRejectedValue(new Error("activity died"));

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    expect(result.terminals[0]?.recentOutput).toBe("alpha");
    expect(result.terminals[0]?.error).toContain("activity died");
    expect(result.terminals[0]).not.toHaveProperty("lastOutputChangeAt");
    expect(result.terminals[0]).not.toHaveProperty("lastTypedInputAt");
    expect(result.unavailableFields).toEqual(["hasPty", "lastOutputChangeAt", "lastTypedInputAt"]);
  });

  it("contains a bridge that throws synchronously to its own field", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    getSerializedStatesMock.mockImplementation(() => {
      throw new Error("bridge missing");
    });
    terminalClientMock.getOutputActivity.mockResolvedValue({
      t1: { status: "read", lastOutputChangeAt: 8 },
    });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    expect(result.terminals[0]?.error).toBe("bridge missing");
    expect(result.terminals[0]?.recentOutput).toBeNull();
    expect(result.terminals[0]?.lastOutputChangeAt).toBe(8);
  });

  it("keeps the timestamp when only the output fetch failed", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    getSerializedStatesMock.mockRejectedValue(new Error("output fetch died"));
    terminalClientMock.getOutputActivity.mockResolvedValue({
      t1: { status: "read", lastOutputChangeAt: 77 },
    });

    const result = await callGetStatus(setupActions(), { includeOutput: {} });

    expect(result.terminals[0]?.lastOutputChangeAt).toBe(77);
    expect(result.terminals[0]?.recentOutput).toBeNull();
    expect(result.terminals[0]?.error).toBe("output fetch died");
    expect(result.unavailableFields).toEqual(["hasPty"]);
  });

  it("reports every batch failure instead of letting one hide the others", async () => {
    panels({ id: "t1", kind: "terminal", location: "grid", agentState: "working" });
    terminalClientMock.getSubmissions.mockRejectedValue(new Error("submission lookup died"));
    getSerializedStatesMock.mockRejectedValue(new Error("output fetch died"));
    terminalClientMock.getOutputActivity.mockRejectedValue(new Error("activity died"));

    const result = await callGetStatus(setupActions(), {
      terminalIds: ["t1"],
      submissionToken: "tok-1",
      includeOutput: {},
    });

    expect(result.terminals[0]?.error).toBe(
      "submission lookup died; output fetch died; activity died"
    );
  });
});
