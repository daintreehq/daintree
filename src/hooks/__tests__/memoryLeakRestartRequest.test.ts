import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "@shared/types/pty-host";

const panelsById: Record<string, Record<string, unknown>> = {};
const restartTerminal = vi.fn(async (_id: string): Promise<void> => {});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById, restartTerminal }) },
}));

type SpawnListener = (id: string, result: SpawnResult) => void;
const spawnListeners = new Set<SpawnListener>();
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: {
    onSpawnResult: (listener: SpawnListener) => {
      spawnListeners.add(listener);
      return () => spawnListeners.delete(listener);
    },
  },
}));

function answerSpawn(id: string, result: Omit<SpawnResult, "id">): void {
  for (const listener of [...spawnListeners]) listener(id, { id, ...result });
}

interface Notice {
  type: string;
  title: string;
  message: string;
  context: unknown;
  replaceKey?: string;
  action?: { label: string; actionId?: string; actionArgs?: unknown };
}
const notify = vi.fn((_notice: Notice) => {});
vi.mock("@/lib/notify", () => ({ notify: (notice: Notice) => notify(notice) }));

const { handleMemoryLeakRestartRequest, SPAWN_ANSWER_WAIT_MS } =
  await import("../useMemoryLeakDetection");

function pane(overrides: Record<string, unknown> = {}) {
  return { id: "t1", kind: "terminal", title: "Claude", worktreeId: "wt-1", ...overrides };
}

/** What `restartTerminal` leaves behind once it has killed the old process and dispatched a spawn. */
function dispatchesSpawn(patch: Record<string, unknown> = {}) {
  return async (id: string) => {
    const current = panelsById[id]!;
    panelsById[id] = {
      ...current,
      restartKey: ((current.restartKey as number | undefined) ?? 0) + 1,
      ...patch,
    };
  };
}

const request = { terminalId: "t1", thresholdMb: 8192 };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("handleMemoryLeakRestartRequest", () => {
  beforeEach(() => {
    restartTerminal.mockReset();
    restartTerminal.mockImplementation(dispatchesSpawn());
    notify.mockClear();
    spawnListeners.clear();
    for (const key of Object.keys(panelsById)) delete panelsById[key];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces the restart only once the host confirms the replacement", async () => {
    panelsById.t1 = pane({ agentState: "working", restartKey: 2 });

    const handled = handleMemoryLeakRestartRequest(request);
    await settle();

    expect(restartTerminal).toHaveBeenCalledWith("t1");
    expect(notify).not.toHaveBeenCalled();

    answerSpawn("t1", { success: true });
    await handled;

    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("info");
    expect(notice.title).toContain("Auto-restarted");
    expect(notice.title).toContain("Claude");
    expect(notice.message).toContain((8192).toLocaleString());
    expect(notice.context).toEqual({ panelId: "t1", worktreeId: "wt-1" });
    expect(spawnListeners.size).toBe(0);
  });

  it("takes a host answer that lands before the restart call returns", async () => {
    panelsById.t1 = pane({ restartKey: 0 });
    restartTerminal.mockImplementationOnce(async (id) => {
      await dispatchesSpawn()(id);
      answerSpawn(id, { success: true });
    });

    await handleMemoryLeakRestartRequest(request);

    expect(notify.mock.calls[0]![0].title).toContain("Auto-restarted");
  });

  it("ignores a spawn answer that belongs to the process being replaced", async () => {
    panelsById.t1 = pane({ restartKey: 0 });
    restartTerminal.mockImplementationOnce(async (id) => {
      answerSpawn(id, { success: false, error: { code: "OLD", message: "stale answer" } });
      await dispatchesSpawn()(id);
    });

    const handled = handleMemoryLeakRestartRequest(request);
    await settle();
    expect(notify).not.toHaveBeenCalled();

    answerSpawn("t1", { success: true });
    await handled;

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].title).toContain("Auto-restarted");
  });

  it("reports a restart that failed validation and points at the pane", async () => {
    panelsById.t1 = pane({ agentState: "working", restartKey: 2 });
    restartTerminal.mockImplementationOnce(async (id) => {
      panelsById[id] = {
        ...panelsById[id],
        restartError: {
          message: "Working directory does not exist: /gone",
          timestamp: 1,
          recoverable: true,
        },
      };
    });

    await handleMemoryLeakRestartRequest(request);

    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(notice.title).toContain("Claude");
    expect(notice.message).toContain("Working directory does not exist: /gone");
    expect(notice.action).toMatchObject({
      actionId: "panel.focus",
      actionArgs: { panelId: "t1" },
    });
    expect(spawnListeners.size).toBe(0);
  });

  it("reports the host refusing the replacement spawn", async () => {
    panelsById.t1 = pane({ restartKey: 1 });

    const handled = handleMemoryLeakRestartRequest(request);
    await settle();
    answerSpawn("t1", {
      success: false,
      error: { code: "ENOENT", message: "Shell not found: /bin/nope" },
    });
    await handled;

    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("Shell not found: /bin/nope");
    expect(notice.action?.actionId).toBe("panel.focus");
  });

  it("reports a spawn the restart itself refused, without waiting on the host", async () => {
    panelsById.t1 = pane({ restartKey: 1 });
    restartTerminal.mockImplementationOnce(
      dispatchesSpawn({
        spawnStatus: "failed",
        spawnError: { code: "PLUGIN_TOOLS_MISSING", message: "Required plugin tools are off" },
      })
    );

    await handleMemoryLeakRestartRequest(request);

    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("Required plugin tools are off");
  });

  it("reports a host that never answers", async () => {
    vi.useFakeTimers();
    panelsById.t1 = pane({ restartKey: 1 });

    const handled = handleMemoryLeakRestartRequest(request);
    await vi.advanceTimersByTimeAsync(SPAWN_ANSWER_WAIT_MS);
    await handled;

    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(spawnListeners.size).toBe(0);
  });

  it("reports a restart that threw", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockRejectedValueOnce(new Error("IPC channel closed"));

    await handleMemoryLeakRestartRequest(request);

    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("IPC channel closed");
  });

  it("reports a restart refused before anything changed", async () => {
    panelsById.t1 = pane({ restartKey: 3 });
    restartTerminal.mockImplementationOnce(async () => {});

    await handleMemoryLeakRestartRequest(request);

    const notice = notify.mock.calls[0]![0];
    expect(notice.type).toBe("warning");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(notice.action?.actionId).toBe("panel.focus");
    expect(spawnListeners.size).toBe(0);
  });

  it("doesn't count an error left by an earlier attempt as this one's", async () => {
    const stale = { message: "Working directory does not exist: /gone", timestamp: 1 };
    panelsById.t1 = pane({ restartKey: 3, restartError: stale });
    restartTerminal.mockImplementationOnce(async () => {});

    await handleMemoryLeakRestartRequest(request);

    expect(notify.mock.calls[0]![0].type).toBe("warning");
  });

  it("doesn't repeat a failure the pane already shows from the last attempt", async () => {
    const message = "Working directory does not exist: /gone";
    panelsById.t1 = pane({ restartError: { message, timestamp: 1, recoverable: true } });
    restartTerminal.mockImplementationOnce(async (id) => {
      panelsById[id] = {
        ...panelsById[id],
        restartError: { message, timestamp: 2, recoverable: true },
      };
    });

    await handleMemoryLeakRestartRequest(request);

    expect(notify).not.toHaveBeenCalled();
  });

  it("files every outcome under one key, so a success retires an earlier failure", async () => {
    panelsById.t1 = pane({ restartKey: 0 });
    restartTerminal.mockImplementationOnce(async (id) => {
      panelsById[id] = {
        ...panelsById[id],
        restartError: { message: "CLI not found in PATH", timestamp: 1, recoverable: true },
      };
    });
    await handleMemoryLeakRestartRequest(request);

    panelsById.t1 = { ...panelsById.t1, restartError: undefined };
    const handled = handleMemoryLeakRestartRequest(request);
    await settle();
    answerSpawn("t1", { success: true });
    await handled;

    const [failure, success] = notify.mock.calls.map(([notice]) => notice);
    expect(failure!.type).toBe("error");
    expect(success!.type).toBe("info");
    expect(failure!.replaceKey).toBeDefined();
    expect(success!.replaceKey).toBe(failure!.replaceKey);
  });

  it("says nothing about a pane closed during the restart", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockImplementationOnce(async (id) => {
      delete panelsById[id];
    });

    await handleMemoryLeakRestartRequest(request);

    expect(notify).not.toHaveBeenCalled();
    expect(spawnListeners.size).toBe(0);
  });

  it("says nothing about a pane trashed while the host answered", async () => {
    panelsById.t1 = pane({ restartKey: 0 });

    const handled = handleMemoryLeakRestartRequest(request);
    await settle();
    panelsById.t1 = { ...panelsById.t1, location: "trash" };
    answerSpawn("t1", { success: true });
    await handled;

    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a restart already under way to report itself", async () => {
    panelsById.t1 = pane({ isRestarting: true });
    await handleMemoryLeakRestartRequest(request);
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a pane waiting for input alone", async () => {
    panelsById.t1 = pane({ agentState: "waiting" });
    await handleMemoryLeakRestartRequest(request);
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a pane locked against input alone", async () => {
    panelsById.t1 = pane({ isInputLocked: true });
    await handleMemoryLeakRestartRequest(request);
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a terminal this view doesn't hold", async () => {
    await handleMemoryLeakRestartRequest({ terminalId: "missing", thresholdMb: 8192 });
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a panel with no PTY", async () => {
    panelsById.t1 = pane({ kind: "browser" });
    await handleMemoryLeakRestartRequest(request);
    expect(restartTerminal).not.toHaveBeenCalled();
  });
});
