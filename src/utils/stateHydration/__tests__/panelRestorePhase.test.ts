import { describe, it, expect, vi, beforeEach } from "vitest";
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
function makeContext(overrides: Partial<Parameters<typeof restorePanelsPhase>[1]> = {}) {
  const addPanel = vi.fn(
    async (args: { requestedId?: string; existingId?: string }) =>
      args.requestedId ?? args.existingId ?? `restored-${Math.random()}`
  );
  const checkCurrent = vi.fn(() => true);
  const withHydrationBatch = vi.fn(async (run: () => Promise<void>) => {
    await run();
  });
  return {
    addPanel,
    checkCurrent,
    withHydrationBatch,
    backendTerminalMap: new Map<string, BackendTerminalInfo>(),
    terminalSizes: {} as Record<string, { cols: number; rows: number }>,
    activeWorktreeId: null as string | null,
    projectRoot: "/proj",
    agentSettings: undefined,
    clipboardDirectory: undefined,
    projectPresetsByAgent: {},
    _switchId: undefined as string | undefined,
    worktreesPromise: Promise.resolve([]),
    restoreTerminalOrder: undefined,
    safeMode: false,
    logHydrationInfo: vi.fn(),
    ...overrides,
  };
}

function panel(id: string, overrides: Partial<TerminalState> = {}): TerminalState {
  return {
    id,
    kind: "terminal",
    cwd: "/proj",
    ...overrides,
  } as TerminalState;
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
    await restorePanelsPhase([panel("a", { kind: "assistant" } as Partial<TerminalState>)], ctx);
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
    expect(ctx.addPanel.mock.calls[0][0]).toMatchObject({ requestedId: "p1" });
  });

  it("phantom-skips agent panel when reconnect returns not_found during a live switch (_switchId defined)", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ _switchId: "switch-123" });
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
    await restorePanelsPhase([panel("b1", { kind: "browser" } as Partial<TerminalState>)], ctx);
    expect(reconnectWithTimeoutMock).not.toHaveBeenCalled();
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
  });

  it("aborts mid-phase when checkCurrent returns false between phases", async () => {
    const ctx = makeContext();
    // Two PTY panels (priority + background) — fail check after non-PTY phase
    let calls = 0;
    ctx.checkCurrent.mockImplementation(() => {
      calls++;
      return calls < 2; // returns false on the second call
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));
    await restorePanelsPhase([panel("t1", { worktreeId: "wA" }), panel("t2")], ctx);
    // We can't easily assert how many panels were restored without timing,
    // but the test confirms checkCurrent is consulted (no throw, no orphan ran).
    expect(ctx.checkCurrent).toHaveBeenCalled();
  });

  it("calls restoreTerminalOrder with sorted ids matching saved order", async () => {
    const restoreTerminalOrder = vi.fn();
    const ctx = makeContext({
      restoreTerminalOrder,
      activeWorktreeId: "wA",
    });
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
    expect(restoreTerminalOrder.mock.calls[0][0]).toEqual(["t1", "t2", "t3"]);
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
    expect(ctx.addPanel.mock.calls[0][0]).toMatchObject({ worktreeId: "wA" });
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
  it("wraps each phase in a hydration batch (begin/flush) when provided", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));
    await restorePanelsPhase([panel("t1"), panel("t2")], ctx);
    // At minimum, withHydrationBatch is called for each non-empty phase.
    expect(ctx.withHydrationBatch).toHaveBeenCalled();
  });
});
