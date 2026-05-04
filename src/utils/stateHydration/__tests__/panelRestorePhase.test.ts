import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { TerminalState, BackendTerminalInfo } from "@shared/types/ipc/terminal";

// --- Module mocks ---
vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

const initializeBackendTierMock = vi.fn();
const setTargetSizeMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    initializeBackendTier: (...args: unknown[]) => initializeBackendTierMock(...args),
    setTargetSize: (...args: unknown[]) => setTargetSizeMock(...args),
  },
}));

const reconnectWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../reconnectManager", () => ({
  reconnectWithTimeout: (...args: unknown[]) => reconnectWithTimeoutMock(...args),
}));

vi.mock("../statePatcher", () => ({
  inferKind: (s: TerminalState) => s.kind ?? "terminal",
  resolveAgentId: (id: string | undefined) => id,
  inferAgentIdFromTitle: (
    _title: string | undefined,
    kind: string | undefined,
    existing: string | undefined
  ) => {
    if (existing) return existing;
    return kind === "agent" ? "claude" : undefined;
  },
  buildArgsForBackendTerminal: (b: BackendTerminalInfo, s: TerminalState) => ({
    cwd: b.cwd,
    kind: b.kind ?? "terminal",
    launchAgentId: b.launchAgentId,
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    existingId: b.id,
    title: b.title,
  }),
  buildArgsForReconnectedFallback: (
    rt: { id?: string; cwd?: string; title?: string },
    s: TerminalState
  ) => ({
    cwd: rt.cwd ?? "/cwd",
    kind: s.kind ?? "terminal",
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    existingId: rt.id,
  }),
  buildArgsForRespawn: (s: TerminalState, kind: string) => ({
    cwd: s.cwd ?? "/cwd",
    kind,
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    requestedId: s.id,
    launchAgentId: s.launchAgentId,
  }),
  buildArgsForNonPtyRecreation: (s: TerminalState, kind: string) => ({
    cwd: s.cwd ?? "/cwd",
    kind,
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    requestedId: s.id,
  }),
  buildArgsForOrphanedTerminal: (t: BackendTerminalInfo) => ({
    cwd: t.cwd,
    kind: t.kind ?? "terminal",
    existingId: t.id,
    location: "grid" as const,
    title: t.title,
  }),
  inferWorktreeIdFromCwd: () => undefined,
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (k: string) => k === "terminal" || k === "agent",
  getPanelKindConfig: (k: string) =>
    k === "terminal" || k === "agent" || k === "browser" || k === "dev-preview"
      ? { kind: k }
      : undefined,
}));

vi.mock("@shared/utils/smokeTestTerminals", () => ({
  isSmokeTestTerminalId: (id: string) => id.startsWith("smoke-"),
}));

// Override stagger constants so tests don't have to wait 100ms × N
vi.mock("../batchScheduler", async () => {
  const actual = await vi.importActual<typeof import("../batchScheduler")>("../batchScheduler");
  return {
    ...actual,
    RESTORE_SPAWN_BATCH_SIZE: 2,
    RESTORE_SPAWN_BATCH_DELAY_MS: 0,
  };
});

// --- Fixtures ---
type RawContext = Parameters<typeof restorePanelsPhase>[1];
type MockedContext = Omit<RawContext, "addPanel" | "checkCurrent" | "withHydrationBatch"> & {
  addPanel: Mock;
  checkCurrent: Mock;
  withHydrationBatch: Mock;
};

let restoredIdCounter = 0;

function makeContext(overrides: Partial<RawContext> = {}): MockedContext {
  const addPanel: Mock = vi.fn(
    async (args: { requestedId?: string; existingId?: string }) =>
      args.requestedId ?? args.existingId ?? `restored-${++restoredIdCounter}`
  );
  const checkCurrent: Mock = vi.fn(() => true);
  const withHydrationBatch: Mock = vi.fn(async (run: () => Promise<void>) => {
    await run();
  });
  const ctx: MockedContext = {
    addPanel,
    checkCurrent,
    withHydrationBatch,
    backendTerminalMap: new Map<string, BackendTerminalInfo>(),
    terminalSizes: {} as Record<string, { cols: number; rows: number }>,
    activeWorktreeId: null,
    projectRoot: "/proj",
    agentSettings: undefined,
    clipboardDirectory: undefined,
    projectPresetsByAgent: {},
    _switchId: undefined,
    worktreesPromise: Promise.resolve([]),
    restoreTerminalOrder: undefined,
    safeMode: false,
    logHydrationInfo: vi.fn(),
  };
  return Object.assign(ctx, overrides);
}

function panel(id: string, overrides: Partial<TerminalState> = {}): TerminalState {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/proj",
    ...overrides,
  };
}

function backend(id: string, overrides: Partial<BackendTerminalInfo> = {}): BackendTerminalInfo {
  return {
    id,
    cwd: "/proj",
    spawnedAt: 0,
    hasPty: true,
    ...overrides,
  };
}

const { restorePanelsPhase } = await import("../panelRestorePhase");

beforeEach(() => {
  initializeBackendTierMock.mockReset();
  setTargetSizeMock.mockReset();
  reconnectWithTimeoutMock.mockReset();
});

describe("restorePanelsPhase — saved panels", () => {
  it("returns empty restoreTasks and runs no panel work when savedPanels is undefined", async () => {
    const ctx = makeContext();
    const { restoreTasks } = await restorePanelsPhase(undefined, ctx);
    expect(restoreTasks).toEqual([]);
    expect(ctx.addPanel).not.toHaveBeenCalled();
  });

  it("skips smoke test terminal snapshots", async () => {
    const ctx = makeContext();
    await restorePanelsPhase([panel("smoke-1")], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
  });

  it("skips legacy assistant panels", async () => {
    const ctx = makeContext();
    await restorePanelsPhase([panel("a", { kind: "assistant" })], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
  });

  it("reconnects to a matched backend terminal and pushes a restore task", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("t1", backend("t1", { activityTier: "active" }));
    const { restoreTasks } = await restorePanelsPhase([panel("t1", { worktreeId: "w1" })], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(restoreTasks).toEqual([
      expect.objectContaining({ terminalId: "t1", worktreeId: "w1", location: "grid" }),
    ]);
    expect(initializeBackendTierMock).toHaveBeenCalledWith("t1", "active");
    expect(ctx.backendTerminalMap.has("t1")).toBe(false);
  });

  it("skips dead agent backend terminals (hasPty=false + agentId set) and removes from map", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("dead", backend("dead", { hasPty: false, launchAgentId: "claude" }));
    const { restoreTasks } = await restorePanelsPhase([panel("dead")], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
    expect(restoreTasks).toEqual([]);
    expect(ctx.backendTerminalMap.has("dead")).toBe(false);
  });

  it("respawns a PTY panel when reconnect returns not_found on cold restart (_switchId undefined)", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ _switchId: undefined });
    await restorePanelsPhase([panel("p1", { kind: "agent", launchAgentId: "claude" })], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ requestedId: "p1" });
  });

  it("phantom-skips agent panel when reconnect returns not_found during a live switch (_switchId defined)", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ _switchId: "switch-123" });
    await restorePanelsPhase([panel("p1", { kind: "agent", launchAgentId: "claude" })], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
  });

  it("phantom-skips agent panel when _switchId is the empty string (defined-but-falsy)", async () => {
    // Pins `_switchId !== undefined`. A regression to truthiness check (`if (_switchId)`)
    // would silently break this case (#4973 phantom-agent guard).
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ _switchId: "" });
    await restorePanelsPhase([panel("p1", { kind: "agent", launchAgentId: "claude" })], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
  });

  it("does NOT phantom-skip plain terminal panels during a live switch (only agent kind is gated)", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ _switchId: "switch-1" });
    await restorePanelsPhase([panel("plain", { kind: "terminal" })], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
  });

  it("uses reconnected fallback args when reconnect succeeds", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({
      status: "found",
      terminal: { id: "p1", cwd: "/proj", activityTier: "background" },
    });
    const ctx = makeContext();
    const { restoreTasks } = await restorePanelsPhase([panel("p1")], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(restoreTasks).toHaveLength(1);
    expect(initializeBackendTierMock).toHaveBeenCalledWith("p1", "background");
  });

  it("recreates non-PTY panels (browser, dev-preview) without reconnect", async () => {
    const ctx = makeContext();
    await restorePanelsPhase([panel("b1", { kind: "browser" })], ctx);
    expect(reconnectWithTimeoutMock).not.toHaveBeenCalled();
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
  });

  it("aborts before background-PTY phase when checkCurrent returns false after priority phase", async () => {
    // Cancellation pin: priority PTY restored, background PTY skipped, orphan skipped.
    const ctx = makeContext({ activeWorktreeId: "wA" });
    let priorityRan = false;
    ctx.checkCurrent.mockImplementation(() => {
      // Returns true initially (entering priority phase) and false after the
      // priority panel is restored (between priority and background PTY phases).
      if (priorityRan) return false;
      return true;
    });
    ctx.backendTerminalMap.set("t-prio", backend("t-prio"));
    ctx.backendTerminalMap.set("t-bg", backend("t-bg"));
    ctx.backendTerminalMap.set("orphan", backend("orphan"));

    // Track when the priority panel is restored so the next checkCurrent call returns false.
    const originalAddPanel = ctx.addPanel.getMockImplementation();
    ctx.addPanel.mockImplementation(async (args: { existingId?: string; requestedId?: string }) => {
      const id = await (originalAddPanel ?? (() => Promise.resolve("x")))(args);
      if (args.existingId === "t-prio") priorityRan = true;
      return id;
    });

    await restorePanelsPhase(
      [panel("t-prio", { worktreeId: "wA" }), panel("t-bg", { worktreeId: "wB" })],
      ctx
    );

    // Priority panel was restored; background and orphan were aborted.
    const addPanelArgs = ctx.addPanel.mock.calls.map(
      (call) => (call[0] as { existingId?: string }).existingId
    );
    expect(addPanelArgs).toEqual(["t-prio"]);
  });

  it("calls restoreTerminalOrder with addPanel-returned IDs in saved order (not saved IDs)", async () => {
    const restoreTerminalOrder = vi.fn();
    const ctx = makeContext({
      restoreTerminalOrder,
      activeWorktreeId: "wA",
    });
    // Differentiate returned IDs from saved IDs so a regression that passes
    // saved IDs would surface immediately.
    ctx.addPanel.mockImplementation(
      async (args: { existingId?: string; requestedId?: string }) =>
        `new-${args.existingId ?? args.requestedId}`
    );
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));
    ctx.backendTerminalMap.set("t3", backend("t3"));
    await restorePanelsPhase(
      [
        panel("t1", { worktreeId: "wA" }), // priority (active)
        panel("t2", { worktreeId: "wB" }), // background
        panel("t3", { worktreeId: "wA" }), // priority
      ],
      ctx
    );
    expect(restoreTerminalOrder).toHaveBeenCalledTimes(1);
    expect(restoreTerminalOrder.mock.calls[0]![0]).toEqual(["new-t1", "new-t2", "new-t3"]);
  });

  it("does not call restoreTerminalOrder when no panels were restored", async () => {
    const restoreTerminalOrder = vi.fn();
    const ctx = makeContext({ restoreTerminalOrder });
    await restorePanelsPhase([panel("smoke-1")], ctx);
    expect(restoreTerminalOrder).not.toHaveBeenCalled();
  });

  it("applies saved terminal sizes after restore", async () => {
    const ctx = makeContext({
      terminalSizes: { t1: { cols: 120, rows: 40 } },
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(setTargetSizeMock).toHaveBeenCalledWith("t1", 120, 40);
  });

  it("ignores invalid (zero or non-finite) saved sizes", async () => {
    const ctx = makeContext({
      terminalSizes: { t1: { cols: 0, rows: 40 } },
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(setTargetSizeMock).not.toHaveBeenCalled();
  });
});

describe("restorePanelsPhase — orphan reconnection", () => {
  it("appends orphan terminals not in saved state", async () => {
    const ctx = makeContext({ activeWorktreeId: "wActive" });
    ctx.backendTerminalMap.set("orphan1", backend("orphan1", { cwd: "/proj/foo" }));
    const { restoreTasks } = await restorePanelsPhase([], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(restoreTasks).toEqual([
      expect.objectContaining({ terminalId: "orphan1", location: "grid" }),
    ]);
  });

  it("falls back to activeWorktreeId for orphans when cwd inference returns undefined", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("o1", backend("o1"));
    await restorePanelsPhase([], ctx);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
  });

  it("skips startup default- terminals when there are no saved panels", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("default-init", backend("default-init"));
    const { restoreTasks } = await restorePanelsPhase([], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
    expect(restoreTasks).toEqual([]);
  });

  it("includes default- terminals when there ARE saved panels", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("default-x", backend("default-x"));
    ctx.backendTerminalMap.set("t1", backend("t1"));
    // t1 will be matched and removed from map; default-x is left as orphan.
    await restorePanelsPhase([panel("t1")], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
  });

  it("skips orphans entirely in safe mode", async () => {
    const ctx = makeContext({ safeMode: true });
    ctx.backendTerminalMap.set("o1", backend("o1"));
    ctx.backendTerminalMap.set("o2", backend("o2"));
    const { restoreTasks } = await restorePanelsPhase([], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
    expect(restoreTasks).toEqual([]);
  });

  it("skips orphans whose hasPty is false", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("dead", backend("dead", { hasPty: false }));
    const { restoreTasks } = await restorePanelsPhase([], ctx);
    expect(ctx.addPanel).not.toHaveBeenCalled();
    expect(restoreTasks).toEqual([]);
  });
});

describe("restorePanelsPhase — withHydrationBatch wrapper", () => {
  it("wraps the WHOLE batch (one withHydrationBatch per stagger batch, not per task)", async () => {
    // RESTORE_SPAWN_BATCH_SIZE=2 (mocked) — 2 background PTY tasks fit in one batch.
    // If a regression wrapped each task individually, this would fire twice.
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));
    await restorePanelsPhase(
      [panel("t1", { worktreeId: "wB" }), panel("t2", { worktreeId: "wB" })],
      ctx
    );
    // Both panels are background priority (worktreeId !== activeWorktreeId).
    // Expect exactly one withHydrationBatch call covering the whole batch.
    expect(ctx.withHydrationBatch).toHaveBeenCalledTimes(1);
  });
});

describe("restorePanelsPhase — matched backend not re-appended as orphan", () => {
  it("matched backend terminals are removed from the map before orphan scan (no double restore)", async () => {
    // Pins backendTerminalMap.delete() inside the saved-panels execute() — if the
    // delete is moved after orphan collection, "matched" would also appear as an orphan.
    const ctx = makeContext();
    ctx.backendTerminalMap.set("matched", backend("matched"));
    ctx.backendTerminalMap.set("orphan", backend("orphan"));
    await restorePanelsPhase([panel("matched")], ctx);
    // Exactly two addPanel calls: matched (saved) + orphan — never three.
    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
    const ids = ctx.addPanel.mock.calls.map(
      (call) => (call[0] as { existingId?: string }).existingId
    );
    expect(ids.sort()).toEqual(["matched", "orphan"]);
  });
});
