// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SpawnError, SpawnResult } from "@shared/types/pty-host";

const panelsById: Record<string, Record<string, unknown>> = {};
const restartTerminal = vi.fn(async (_id: string): Promise<void> => {});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById, restartTerminal }) },
}));

const restarting = new Set<string>();
vi.mock("@/store/restartExitSuppression", () => ({
  isTerminalRestarting: (id: string) => restarting.has(id),
}));

const goToPanel = vi.fn(async (_panelId: string) => {});
vi.mock("@/lib/watchNotification", () => ({
  goToPanel: (panelId: string) => goToPanel(panelId),
}));

type SpawnListener = (id: string, result: SpawnResult) => void;
const spawnListeners = new Set<SpawnListener>();
const backendReadyListeners = new Set<() => void>();
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: {
    onSpawnResult: (listener: SpawnListener) => {
      spawnListeners.add(listener);
      return () => spawnListeners.delete(listener);
    },
    onBackendReady: (listener: () => void) => {
      backendReadyListeners.add(listener);
      return () => backendReadyListeners.delete(listener);
    },
  },
}));

function answerSpawn(id: string, result: Omit<SpawnResult, "id">): void {
  for (const listener of [...spawnListeners]) listener(id, { id, ...result });
}

interface NoticeAction {
  label: string;
  actionId?: string;
  actionArgs?: unknown;
  onClick: () => unknown;
}
interface Notice {
  type: string;
  title: string;
  message: string;
  context: unknown;
  replaceKey?: string;
  action?: NoticeAction;
  actions?: NoticeAction[];
}
const notify = vi.fn((_notice: Notice) => {});
vi.mock("@/lib/notify", () => ({ notify: (notice: Notice) => notify(notice) }));

const {
  handleMemoryLeakRestartRequest,
  resetMemoryRestartReportsForTests,
  SPAWN_ANSWER_WAIT_MS,
  useMemoryLeakDetection,
} = await import("../useMemoryLeakDetection");

function pane(overrides: Record<string, unknown> = {}) {
  return { id: "t1", kind: "terminal", title: "Claude", worktreeId: "wt-1", ...overrides };
}

function restartKeyOf(id: string): number {
  const key = panelsById[id]?.restartKey;
  return typeof key === "number" ? key : 0;
}

/** What `restartTerminal` leaves behind once it has killed the old process and dispatched a spawn. */
function dispatchesSpawn(patch: Record<string, unknown> = {}) {
  return async (id: string) => {
    panelsById[id] = { ...panelsById[id], restartKey: restartKeyOf(id) + 1, ...patch };
  };
}

/** A restart refused at validation: the old process runs on, the count stays. */
function failsValidation(message: string) {
  return async (id: string) => {
    panelsById[id] = {
      ...panelsById[id],
      restartError: { message, timestamp: Date.now(), recoverable: true },
    };
  };
}

function requestFor(terminalId = "t1") {
  return { terminalId, thresholdMb: 8192 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function onlyNotice(): Notice {
  expect(notify).toHaveBeenCalledTimes(1);
  return notify.mock.calls[0]![0];
}

describe("handleMemoryLeakRestartRequest", () => {
  beforeEach(() => {
    restartTerminal.mockReset();
    restartTerminal.mockImplementation(dispatchesSpawn());
    notify.mockReset();
    goToPanel.mockClear();
    spawnListeners.clear();
    backendReadyListeners.clear();
    restarting.clear();
    resetMemoryRestartReportsForTests();
    for (const key of Object.keys(panelsById)) delete panelsById[key];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces the restart only once the host confirms the replacement", async () => {
    vi.useFakeTimers();
    panelsById.t1 = pane({ agentState: "working", restartKey: 2 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await vi.advanceTimersByTimeAsync(0);

    expect(restartTerminal).toHaveBeenCalledWith("t1");
    expect(notify).not.toHaveBeenCalled();

    answerSpawn("t1", { success: true });
    await handled;

    const notice = onlyNotice();
    expect(notice.type).toBe("info");
    expect(notice.title).toContain("Auto-restarted");
    expect(notice.title).toContain("Claude");
    expect(notice.message).toContain((8192).toLocaleString());
    expect(notice.context).toEqual({ panelId: "t1", worktreeId: "wt-1" });
    expect(spawnListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the buttons of a leak warning it merges into", async () => {
    panelsById.t1 = pane();
    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    answerSpawn("t1", { success: true });
    await handled;

    const notice = onlyNotice();
    expect("action" in notice && notice.action === undefined).toBe(true);
    expect("actions" in notice && notice.actions === undefined).toBe(true);
  });

  it("takes a host answer that lands before the restart call returns", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockImplementationOnce(async (id) => {
      await dispatchesSpawn()(id);
      answerSpawn(id, { success: true });
    });

    await handleMemoryLeakRestartRequest(requestFor());

    expect(onlyNotice().title).toContain("Auto-restarted");
  });

  it("ignores a spawn answer from before the replacement was dispatched", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockImplementationOnce(async (id) => {
      answerSpawn(id, { success: false, error: { code: "UNKNOWN", message: "stale answer" } });
      await dispatchesSpawn()(id);
    });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    expect(notify).not.toHaveBeenCalled();

    answerSpawn("t1", { success: true });
    await handled;

    expect(onlyNotice().title).toContain("Auto-restarted");
  });

  it("ignores another terminal's answer on the shared stream", async () => {
    panelsById.t1 = pane();
    panelsById.t2 = pane({ id: "t2", title: "Codex" });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    answerSpawn("t2", { success: true });
    answerSpawn("t1", {
      success: false,
      error: { code: "ENOENT", message: "Shell not found: /bin/nope" },
    });
    await handled;

    const notice = onlyNotice();
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("Shell not found: /bin/nope");
  });

  it("reports a restart that failed validation and points at the pane", async () => {
    panelsById.t1 = pane({ agentState: "working", restartKey: 2 });
    restartTerminal.mockImplementationOnce(
      failsValidation("Working directory does not exist: /gone")
    );

    await handleMemoryLeakRestartRequest(requestFor());

    const notice = onlyNotice();
    expect(notice.type).toBe("error");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(notice.title).toContain("Claude");
    expect(notice.message).toContain("Working directory does not exist: /gone");
    expect(notice.actions).toBeUndefined();
    expect(notice.action).toMatchObject({ actionId: "panel.focus", actionArgs: { panelId: "t1" } });
    await notice.action!.onClick();
    expect(goToPanel).toHaveBeenCalledWith("t1");
    expect(spawnListeners.size).toBe(0);
  });

  it("reports the host refusing the replacement spawn", async () => {
    panelsById.t1 = pane({ restartKey: 1 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    answerSpawn("t1", {
      success: false,
      error: { code: "ENOENT", message: "Shell not found: /bin/nope" },
    });
    await handled;

    const notice = onlyNotice();
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("Shell not found: /bin/nope");
    expect(notice.action?.actionId).toBe("panel.focus");
  });

  it("reports a spawn the restart itself refused, without waiting on the host", async () => {
    panelsById.t1 = pane({ restartKey: 1 });
    const spawnError = {
      code: "REQUIRED_PLUGIN_TOOLS",
      message: "Required plugin tools are off",
    } satisfies SpawnError;
    restartTerminal.mockImplementationOnce(dispatchesSpawn({ spawnStatus: "failed", spawnError }));

    await handleMemoryLeakRestartRequest(requestFor());

    const notice = onlyNotice();
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("Required plugin tools are off");
  });

  it("calls a host that hasn't answered by the deadline unconfirmed, not failed", async () => {
    vi.useFakeTimers();
    panelsById.t1 = pane({ restartKey: 1 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await vi.advanceTimersByTimeAsync(SPAWN_ANSWER_WAIT_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await handled;

    const notice = onlyNotice();
    expect(notice.type).toBe("warning");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(notice.title).not.toContain("Couldn't");
    expect(spawnListeners.size).toBe(0);
  });

  it("takes main's report of a silent host as unconfirmed, not failed", async () => {
    panelsById.t1 = pane({ restartKey: 1 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    answerSpawn("t1", {
      success: false,
      error: { code: "SPAWN_TIMEOUT", message: "No answer after 30 seconds." },
    });
    await handled;

    const notice = onlyNotice();
    expect(notice.type).toBe("warning");
    expect(notice.title).not.toContain("Couldn't");
  });

  it("reports a restart that threw", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockRejectedValueOnce(new Error("IPC channel closed"));

    await handleMemoryLeakRestartRequest(requestFor());

    const notice = onlyNotice();
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("IPC channel closed");
    expect(spawnListeners.size).toBe(0);
  });

  it("reports a restart refused before anything changed", async () => {
    panelsById.t1 = pane({ restartKey: 3 });
    restartTerminal.mockImplementationOnce(async () => {});

    await handleMemoryLeakRestartRequest(requestFor());

    const notice = onlyNotice();
    expect(notice.type).toBe("warning");
    expect(notice.title).not.toContain("Auto-restarted");
    expect(notice.action?.actionId).toBe("panel.focus");
    expect(spawnListeners.size).toBe(0);
  });

  it("doesn't count an error left by an earlier attempt as this one's", async () => {
    const stale = { message: "Working directory does not exist: /gone", timestamp: 1 };
    panelsById.t1 = pane({ restartKey: 3, restartError: stale });
    restartTerminal.mockImplementationOnce(async () => {});

    await handleMemoryLeakRestartRequest(requestFor());

    expect(onlyNotice().type).toBe("warning");
  });

  it("reports a failure once while the process it left running stays the same", async () => {
    const message = "Working directory does not exist: /gone";
    panelsById.t1 = pane({ restartKey: 4 });
    restartTerminal.mockImplementation(failsValidation(message));

    await handleMemoryLeakRestartRequest(requestFor());
    await handleMemoryLeakRestartRequest(requestFor());

    expect(onlyNotice().message).toContain(message);
  });

  it("reports a retry that fails for a different reason", async () => {
    panelsById.t1 = pane({ restartKey: 4 });
    restartTerminal.mockImplementationOnce(
      failsValidation("Working directory does not exist: /gone")
    );
    restartTerminal.mockImplementationOnce(failsValidation("claude CLI not found in PATH"));

    await handleMemoryLeakRestartRequest(requestFor());
    await handleMemoryLeakRestartRequest(requestFor());

    expect(notify.mock.calls.map(([notice]) => notice.message)).toEqual([
      "Working directory does not exist: /gone",
      "claude CLI not found in PATH",
    ]);
  });

  it("reports the same failure again once a restart in between replaced the process", async () => {
    const message = "Working directory does not exist: /gone";
    panelsById.t1 = pane({ restartKey: 4 });
    restartTerminal.mockImplementation(failsValidation(message));

    await handleMemoryLeakRestartRequest(requestFor());
    panelsById.t1 = { ...panelsById.t1, restartKey: 5 };
    await handleMemoryLeakRestartRequest(requestFor());

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("reports its first failure even when the pane shows the same one from the user's restart", async () => {
    const message = "Working directory does not exist: /gone";
    panelsById.t1 = pane({ restartError: { message, timestamp: 1, recoverable: true } });
    restartTerminal.mockImplementationOnce(failsValidation(message));

    await handleMemoryLeakRestartRequest(requestFor());

    expect(onlyNotice().type).toBe("error");
  });

  it("files a terminal's outcomes under one key of its own", async () => {
    panelsById.t1 = pane({ restartKey: 0 });
    panelsById.t2 = pane({ id: "t2", title: "Codex", restartKey: 0 });
    restartTerminal.mockImplementationOnce(failsValidation("claude CLI not found in PATH"));
    await handleMemoryLeakRestartRequest(requestFor("t1"));

    restartTerminal.mockImplementationOnce(async () => {});
    await handleMemoryLeakRestartRequest(requestFor("t1"));

    panelsById.t1 = { ...panelsById.t1, restartError: undefined };
    const handled = handleMemoryLeakRestartRequest(requestFor("t1"));
    await settle();
    answerSpawn("t1", { success: true });
    await handled;

    restartTerminal.mockImplementationOnce(failsValidation("codex CLI not found in PATH"));
    await handleMemoryLeakRestartRequest(requestFor("t2"));

    const [failure, skipped, success, other] = notify.mock.calls.map(([notice]) => notice);
    expect([failure!.type, skipped!.type, success!.type, other!.type]).toEqual([
      "error",
      "warning",
      "info",
      "error",
    ]);
    expect(failure!.replaceKey).toBeDefined();
    expect(skipped!.replaceKey).toBe(failure!.replaceKey);
    expect(success!.replaceKey).toBe(failure!.replaceKey);
    expect(other!.replaceKey).toBeDefined();
    expect(other!.replaceKey).not.toBe(failure!.replaceKey);
  });

  it("says nothing about a pane closed during the restart", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockImplementationOnce(async (id) => {
      delete panelsById[id];
    });

    await handleMemoryLeakRestartRequest(requestFor());

    expect(notify).not.toHaveBeenCalled();
    expect(spawnListeners.size).toBe(0);
  });

  it("says nothing about a pane closed while the host answered", async () => {
    vi.useFakeTimers();
    panelsById.t1 = pane();

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await vi.advanceTimersByTimeAsync(0);
    delete panelsById.t1;
    answerSpawn("t1", { success: true });
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(spawnListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says nothing about a pane trashed while the host answered", async () => {
    panelsById.t1 = pane({ restartKey: 0 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    panelsById.t1 = { ...panelsById.t1, location: "trash" };
    answerSpawn("t1", { success: true });
    await handled;

    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves the outcome to a restart that took over before the host answered", async () => {
    panelsById.t1 = pane({ restartKey: 0 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    panelsById.t1 = { ...panelsById.t1, restartKey: 2 };
    answerSpawn("t1", { success: true });
    await handled;

    expect(notify).not.toHaveBeenCalled();
    expect(spawnListeners.size).toBe(0);
  });

  it("says nothing when a restart took over and the host never answered either", async () => {
    vi.useFakeTimers();
    panelsById.t1 = pane({ restartKey: 0 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await vi.advanceTimersByTimeAsync(0);
    panelsById.t1 = { ...panelsById.t1, restartKey: 2 };
    await vi.advanceTimersByTimeAsync(SPAWN_ANSWER_WAIT_MS);
    await handled;

    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a failure again once the host recovered and replayed its processes", async () => {
    (window as unknown as { electron: unknown }).electron = {
      events: { on: () => () => {} },
    };
    const { unmount } = renderHook(() => useMemoryLeakDetection(false));
    try {
      const message = "Working directory does not exist: /gone";
      panelsById.t1 = pane({ restartKey: 4 });
      restartTerminal.mockImplementation(failsValidation(message));

      await handleMemoryLeakRestartRequest(requestFor());
      await handleMemoryLeakRestartRequest(requestFor());
      expect(notify).toHaveBeenCalledTimes(1);

      for (const listener of [...backendReadyListeners]) listener();
      await handleMemoryLeakRestartRequest(requestFor());
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      delete (window as unknown as { electron?: unknown }).electron;
    }
    expect(backendReadyListeners.size).toBe(0);
  });

  it("says nothing when a restart took over right after the host confirmed this one", async () => {
    panelsById.t1 = pane({ restartKey: 0 });

    const handled = handleMemoryLeakRestartRequest(requestFor());
    await settle();
    answerSpawn("t1", { success: true });
    panelsById.t1 = { ...panelsById.t1, restartKey: 2 };
    await handled;

    expect(notify).not.toHaveBeenCalled();
  });

  it("forgets a closed pane's failure even when another pane's report ends early", async () => {
    const message = "Working directory does not exist: /gone";
    panelsById.t1 = pane({ restartKey: 4 });
    restartTerminal.mockImplementationOnce(failsValidation(message));
    await handleMemoryLeakRestartRequest(requestFor("t1"));
    delete panelsById.t1;

    panelsById.t2 = pane({ id: "t2" });
    restartTerminal.mockImplementationOnce(async (id) => {
      delete panelsById[id];
    });
    await handleMemoryLeakRestartRequest(requestFor("t2"));

    panelsById.t1 = pane({ restartKey: 4 });
    restartTerminal.mockImplementationOnce(failsValidation(message));
    await handleMemoryLeakRestartRequest(requestFor("t1"));

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("releases its listener when reporting throws", async () => {
    panelsById.t1 = pane();
    restartTerminal.mockImplementationOnce(
      failsValidation("Working directory does not exist: /gone")
    );
    notify.mockImplementationOnce(() => {
      throw new Error("toaster unavailable");
    });

    await expect(handleMemoryLeakRestartRequest(requestFor())).rejects.toThrow(
      "toaster unavailable"
    );
    expect(spawnListeners.size).toBe(0);
  });

  it("leaves a restart already under way to report itself", async () => {
    panelsById.t1 = pane({ isRestarting: true });
    await handleMemoryLeakRestartRequest(requestFor());
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a restart that has begun but not yet flagged the pane to report itself", async () => {
    panelsById.t1 = pane();
    restarting.add("t1");
    await handleMemoryLeakRestartRequest(requestFor());
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a pane waiting for input alone", async () => {
    panelsById.t1 = pane({ agentState: "waiting" });
    await handleMemoryLeakRestartRequest(requestFor());
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a pane locked against input alone", async () => {
    panelsById.t1 = pane({ isInputLocked: true });
    await handleMemoryLeakRestartRequest(requestFor());
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a terminal this view doesn't hold", async () => {
    await handleMemoryLeakRestartRequest(requestFor("missing"));
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a panel with no PTY", async () => {
    panelsById.t1 = pane({ kind: "browser" });
    await handleMemoryLeakRestartRequest(requestFor());
    expect(restartTerminal).not.toHaveBeenCalled();
  });
});
