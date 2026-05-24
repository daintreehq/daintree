/**
 * Anti-flap regression test for #7234. setReconnectError is gated behind a
 * 400ms debounce so rapid hydration churn can't mount/dismount the banner
 * faster than the eye can track. Cancellation paths (clearReconnectError,
 * restartTerminal) must drop pending writes so a stale debounce can't
 * resurrect an error after the user moved on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { __resetReconnectErrorDebouncersForTesting, __getReconnectErrorDebouncerCountForTesting } =
  await import("../browser");

const ERROR_A = {
  type: "timeout" as const,
  message: "Reconnection timed out",
  timestamp: 1000,
};
const ERROR_B = {
  type: "error" as const,
  message: "Different failure",
  timestamp: 2000,
};

function seedPanel(id: string) {
  usePanelStore.setState({
    panelsById: {
      [id]: {
        id,
        kind: "terminal",
        title: "T",
        cwd: "/repo",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    },
    panelIds: [id],
  });
}

describe("reconnect error debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReconnectErrorDebouncersForTesting();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
    });
  });

  afterEach(async () => {
    __resetReconnectErrorDebouncersForTesting();
    vi.useRealTimers();
  });

  it("does not write reconnectError synchronously", () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toBeUndefined();
    expect(usePanelStore.getState().panelsById["t-1"]?.runtimeStatus).toBeUndefined();
  });

  it("writes the error after the 400ms gate elapses", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);

    await vi.advanceTimersByTimeAsync(399);
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toEqual(ERROR_A);
    expect(usePanelStore.getState().panelsById["t-1"]?.runtimeStatus).toBe("error");
  });

  it("collapses rapid repeated calls into a single write of the latest error", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    await vi.advanceTimersByTimeAsync(200);
    usePanelStore.getState().setReconnectError("t-1", ERROR_B);
    await vi.advanceTimersByTimeAsync(399);
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toEqual(ERROR_B);
  });

  it("clearReconnectError cancels a pending debounce so no stale write lands", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    usePanelStore.getState().clearReconnectError("t-1");

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toBeUndefined();
    expect(usePanelStore.getState().panelsById["t-1"]?.runtimeStatus).toBeUndefined();
  });

  it("removePanel cancels a pending debounce so it can't resurrect a removed panel", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    usePanelStore.getState().removePanel("t-1");

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]).toBeUndefined();
  });

  it("trashPanel cancels a pending debounce so undo-trash never reveals a phantom error", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    usePanelStore.getState().trashPanel("t-1");

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toBeUndefined();
    expect(usePanelStore.getState().panelsById["t-1"]?.runtimeStatus).not.toBe("error");
  });

  it("evicts the debouncer entry from the map after firing", async () => {
    seedPanel("t-1");
    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    expect(__getReconnectErrorDebouncerCountForTesting()).toBe(1);

    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toEqual(ERROR_A);
    expect(__getReconnectErrorDebouncerCountForTesting()).toBe(0);
  });

  it("debounces independently per panel id", async () => {
    seedPanel("t-1");
    usePanelStore.setState({
      panelsById: {
        ...usePanelStore.getState().panelsById,
        "t-2": {
          id: "t-2",
          kind: "terminal",
          title: "T",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["t-1", "t-2"],
    });

    usePanelStore.getState().setReconnectError("t-1", ERROR_A);
    await vi.advanceTimersByTimeAsync(300);
    usePanelStore.getState().setReconnectError("t-2", ERROR_B);

    // t-1's gate elapses first
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-1"]?.reconnectError).toEqual(ERROR_A);
    expect(usePanelStore.getState().panelsById["t-2"]?.reconnectError).toBeUndefined();

    // t-2's gate elapses 300ms later
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    expect(usePanelStore.getState().panelsById["t-2"]?.reconnectError).toEqual(ERROR_B);
  });
});
