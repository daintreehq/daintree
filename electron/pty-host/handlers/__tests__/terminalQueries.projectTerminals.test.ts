import { describe, it, expect, vi } from "vitest";
import { createTerminalQueryHandlers } from "../terminalQueries.js";
import type { HostContext } from "../types.js";
import type { PtyHostTerminalInfo } from "../../../../shared/types/pty-host.js";

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "proj-1",
    kind: "terminal",
    title: id,
    cwd: "/tmp",
    agentState: "idle",
    spawnedAt: 0,
    wasKilled: false,
    isExited: false,
    ptyProcess: { cols: 80, rows: 24 },
    ...overrides,
  };
}

/** A host whose project lists `ids`; `records` holds what `getTerminal` still finds. */
function host(ids: string[], records: ReturnType<typeof record>[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const sendEvent = vi.fn();
  const ptyManager = {
    getTerminalsForProject: vi.fn((projectId: string) => (projectId === "proj-1" ? ids : [])),
    getTerminal: vi.fn((id: string) => byId.get(id)),
    isInTrash: vi.fn(() => false),
    isClosing: vi.fn(() => false),
    getActivityTier: vi.fn(() => "active" as const),
    getSubmission: vi.fn(() => undefined),
    hasPendingSubmission: vi.fn(() => false),
    analysisObservedSince: vi.fn(() => undefined),
    getTrashExpiresAt: vi.fn(() => undefined),
  };
  const ctx = { sendEvent, ptyManager, getPauseCoordinator: vi.fn() } as unknown as HostContext;
  const handlers = createTerminalQueryHandlers(ctx);

  const projectTerminals = (projectId = "proj-1") => {
    sendEvent.mockClear();
    handlers["get-project-terminals"]?.({
      type: "get-project-terminals",
      projectId,
      requestId: `req-${projectId}`,
    });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    return sendEvent.mock.calls[0]![0] as {
      type: string;
      requestId: string;
      terminals: PtyHostTerminalInfo[];
    };
  };
  const terminal = (id: string) => {
    sendEvent.mockClear();
    handlers["get-terminal"]?.({ type: "get-terminal", id, requestId: "r2" });
    return (sendEvent.mock.calls[0]![0] as { terminal: PtyHostTerminalInfo | null }).terminal;
  };
  return { projectTerminals, terminal, ptyManager };
}

describe("get-project-terminals (#17776)", () => {
  it("answers every record of the project in one reply, in the registry's id order", () => {
    const h = host(["t3", "t1", "t2"], [record("t1"), record("t2"), record("t3")]);
    const event = h.projectTerminals();
    expect(event.type).toBe("project-terminals");
    expect(event.requestId).toBe("req-proj-1");
    expect(event.terminals.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
    expect(h.ptyManager.getTerminalsForProject).toHaveBeenCalledWith("proj-1");
  });

  it("projects each record exactly as a per-id get-terminal would", () => {
    const h = host(
      ["live", "exited"],
      [
        record("live", { ptyProcess: { cols: 203, rows: 51 }, agentSessionId: "s1" }),
        record("exited", { isExited: true, isAssistantTerminal: true }),
      ]
    );
    const { terminals } = h.projectTerminals();
    expect(terminals).toEqual([h.terminal("live"), h.terminal("exited")]);
    expect(terminals[1]?.isAssistantTerminal).toBe(true);
  });

  it("carries the live grid, and keeps an exited terminal with no grid", () => {
    const h = host(
      ["live", "exited", "killed"],
      [
        record("live", { ptyProcess: { cols: 203, rows: 51 } }),
        record("exited", { isExited: true, ptyProcess: { cols: 120, rows: 40 } }),
        record("killed", { wasKilled: true, ptyProcess: { cols: 120, rows: 40 } }),
      ]
    );
    const [live, exited, killed] = h.projectTerminals().terminals;
    expect(live).toMatchObject({ id: "live", hasPty: true, ptyCols: 203, ptyRows: 51 });
    expect(exited).toMatchObject({ id: "exited", hasPty: false, isExited: true });
    expect(exited?.ptyCols).toBeUndefined();
    expect(exited?.ptyRows).toBeUndefined();
    expect(killed).toMatchObject({ id: "killed", hasPty: false });
    expect(killed?.ptyCols).toBeUndefined();
  });

  it("skips an id whose record is gone by the time it is read", () => {
    const h = host(["t1", "gone", "t2"], [record("t1"), record("t2")]);
    expect(h.projectTerminals().terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(h.terminal("gone")).toBeNull();
  });

  it("answers an empty list for a project with no terminals", () => {
    const h = host(["t1"], [record("t1")]);
    expect(h.projectTerminals("other").terminals).toEqual([]);
    expect(h.ptyManager.getTerminalsForProject).toHaveBeenCalledWith("other");
  });
});
