import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { TerminalState, BackendTerminalInfo } from "@shared/types/ipc/terminal";
import type { WorktreeState } from "@shared/types";

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
  buildArgsForRespawn: (
    s: TerminalState,
    kind: string,
    _projectRoot?: string,
    _agentSettings?: unknown,
    reconnectTimedOut?: boolean
  ) => ({
    cwd: s.cwd ?? "/cwd",
    kind,
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    // Mirror the real buildArgsForRespawn: a timed-out reconnect drops the
    // requested id so the store generates a fresh one (#10440).
    requestedId: reconnectTimedOut ? undefined : s.id,
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
// Spy on getRestoreBatchParams so tests can both pin fast/deterministic batches
// (batchSize 2, delayMs 0) AND assert the resource profile is threaded through
// from the context (#10528).
const { getRestoreBatchParamsMock } = vi.hoisted(() => ({
  getRestoreBatchParamsMock: vi.fn(() => ({ batchSize: 2, delayMs: 0 })),
}));

vi.mock("../batchScheduler", async () => {
  const actual = await vi.importActual<typeof import("../batchScheduler")>("../batchScheduler");
  return {
    ...actual,
    RESTORE_SPAWN_BATCH_SIZE: 2,
    RESTORE_SPAWN_BATCH_DELAY_MS: 0,
    getRestoreBatchParams: getRestoreBatchParamsMock,
  };
});

// --- Fixtures ---
type RawContext = Parameters<typeof restorePanelsPhase>[1];
type MockedContext = Omit<RawContext, "addPanel" | "withHydrationBatch"> & {
  addPanel: Mock;
  withHydrationBatch: Mock;
};

let restoredIdCounter = 0;

function makeContext(overrides: Partial<RawContext> = {}): MockedContext {
  const addPanel: Mock = vi.fn(
    async (args: { requestedId?: string; existingId?: string }) =>
      args.requestedId ?? args.existingId ?? `restored-${++restoredIdCounter}`
  );
  const withHydrationBatch: Mock = vi.fn(async (run: () => Promise<void>) => {
    await run();
  });
  const ctx: MockedContext = {
    addPanel,
    withHydrationBatch,
    backendTerminalMap: new Map<string, BackendTerminalInfo>(),
    terminalSizes: {} as Record<string, { cols: number; rows: number }>,
    activeWorktreeId: null,
    projectRoot: "/proj",
    agentSettings: undefined,
    clipboardDirectory: undefined,
    projectPresetsByAgent: {},
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

// Minimal worktree list — getKnownWorktreeIds/resolveRestoredWorktreeId read
// only `id`, so the rest of WorktreeState is irrelevant to re-home resolution.
function wtList(...ids: string[]): WorktreeState[] {
  return ids.map((id) => ({ id })) as unknown as WorktreeState[];
}

const { restorePanelsPhase } = await import("../panelRestorePhase");

beforeEach(() => {
  initializeBackendTierMock.mockReset();
  setTargetSizeMock.mockReset();
  reconnectWithTimeoutMock.mockReset();
  getRestoreBatchParamsMock.mockClear();
  getRestoreBatchParamsMock.mockReturnValue({ batchSize: 2, delayMs: 0 });
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

  it("respawns a PTY agent panel when reconnect returns not_found on cold restart", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext();
    await restorePanelsPhase([panel("p1", { kind: "agent", launchAgentId: "claude" })], ctx);
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ requestedId: "p1" });
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

  it("restores every priority PTY panel even when one rejects (#10528 parallel tier)", async () => {
    // All three are priority (active worktree). The middle addPanel rejects;
    // the parallel Promise.allSettled tier must still attempt all three rather
    // than aborting the rest as the old sequential loop's throw would.
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("p1", backend("p1"));
    ctx.backendTerminalMap.set("p2", backend("p2"));
    ctx.backendTerminalMap.set("p3", backend("p3"));
    const attempted: string[] = [];
    ctx.addPanel.mockImplementation(async (args: { existingId?: string; requestedId?: string }) => {
      const id = args.existingId ?? args.requestedId ?? "";
      attempted.push(id);
      if (id === "p2") throw new Error("spawn failed");
      return id;
    });
    await restorePanelsPhase(
      [
        panel("p1", { worktreeId: "wA" }),
        panel("p2", { worktreeId: "wA" }),
        panel("p3", { worktreeId: "wA" }),
      ],
      ctx
    );
    // p1 and p3 must have been attempted even though p2 rejected — proving the
    // parallel tier did not abort on the first failure.
    expect(attempted).toContain("p1");
    expect(attempted).toContain("p3");
  });

  it("runs priority PTY restores concurrently, not sequentially (#10528)", async () => {
    // p1's addPanel only resolves once p3's addPanel has been called. A
    // sequential loop would call p1 first and deadlock (p3 never reached); the
    // Promise.allSettled tier fires both, so p3 unblocks p1. If this resolves,
    // the tier is genuinely concurrent.
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("p1", backend("p1"));
    ctx.backendTerminalMap.set("p3", backend("p3"));
    let resolveP3Seen!: () => void;
    const p3Seen = new Promise<void>((resolve) => {
      resolveP3Seen = resolve;
    });
    ctx.addPanel.mockImplementation(async (args: { existingId?: string; requestedId?: string }) => {
      const id = args.existingId ?? args.requestedId ?? "";
      if (id === "p3") resolveP3Seen();
      if (id === "p1") await p3Seen;
      return id;
    });
    await restorePanelsPhase(
      [panel("p1", { worktreeId: "wA" }), panel("p3", { worktreeId: "wA" })],
      ctx
    );
    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
  });

  it("threads the context resource profile into getRestoreBatchParams (#10528)", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA", resourceProfile: "performance" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    await restorePanelsPhase([panel("b1", { worktreeId: "wOther" })], ctx);
    expect(getRestoreBatchParamsMock).toHaveBeenCalledWith("performance");
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

describe("restorePanelsPhase — worktree re-home validation (#11387)", () => {
  // restoreTasks[].worktreeId reflects the id after resolveRestoredWorktreeId
  // runs, so it is the observable for how a stranded panel was (or wasn't)
  // re-homed.
  const resolvedWorktreeId = (tasks: { worktreeId?: string }[]) => tasks[0]?.worktreeId;

  it("re-homes a stranded panel onto the active worktree when the active worktree is live", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wMain",
      worktreesPromise: Promise.resolve(wtList("wMain")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase([panel("t1", { worktreeId: "wGone" })], ctx);
    // wGone is absent from the complete list; wMain (the active worktree) is
    // live, so the panel re-homes onto it — the existing #11234 behavior.
    expect(resolvedWorktreeId(restoreTasks)).toBe("wMain");
  });

  it("keeps the saved worktreeId rather than re-homing onto a dead active worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wDeadActive",
      worktreesPromise: Promise.resolve(wtList("wMain")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase([panel("t1", { worktreeId: "wGone" })], ctx);
    // Both the saved worktree AND the active worktree are absent from the
    // complete list. Re-homing onto the dead active would strand the panel on a
    // deleted worktree, so the saved id is kept for the boot's active-selection
    // fallback to repair (#11387 / PR #11235 follow-up).
    expect(resolvedWorktreeId(restoreTasks)).toBe("wGone");
  });

  it("keeps a known saved worktreeId untouched", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wMain",
      worktreesPromise: Promise.resolve(wtList("wMain", "wFeature")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "wFeature" })],
      ctx
    );
    // wFeature is in the list — no re-home, even though it isn't the active one.
    expect(resolvedWorktreeId(restoreTasks)).toBe("wFeature");
  });

  it("keeps the saved worktreeId when the list is unknown (empty), preserving #11234", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wDeadActive",
      worktreesPromise: Promise.resolve([]),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase([panel("t1", { worktreeId: "wGone" })], ctx);
    // An empty (partial/not-ready) list is "unknown", so nothing is validated
    // and the saved assignment survives — never collapsed onto the active one.
    expect(resolvedWorktreeId(restoreTasks)).toBe("wGone");
  });

  it("does not home a no-worktree panel onto a dead active worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wDeadActive",
      worktreesPromise: Promise.resolve(wtList("wMain")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase(
      [panel("t1", { worktreeId: undefined })],
      ctx
    );
    // No saved worktree and the active worktree is dead — leave it unset rather
    // than guess onto a deleted worktree.
    expect(resolvedWorktreeId(restoreTasks)).toBeUndefined();
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

describe("restorePanelsPhase — lastActiveAt promotion (issue #8703)", () => {
  // Priority tasks restore sequentially before background tasks (both phases
  // iterate in saved order within their filter). The addPanel call order is
  // the observable that pins which panels landed in which phase.

  it("promotes the highest-lastActiveAt panel per non-active worktree to the priority tier", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB", lastActiveAt: 50 }),
        panel("a1", { worktreeId: "wA", lastActiveAt: 100 }),
        panel("b2", { worktreeId: "wB", lastActiveAt: 200 }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // Priority (saved order): a1 (active), b2 (max lastActiveAt in wB).
    // Background: b1 (lower lastActiveAt in wB).
    expect(ids).toEqual(["a1", "b2", "b1"]);
  });

  it("does not promote any non-active panels when none have lastActiveAt (legacy snapshot)", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB" }),
        panel("a1", { worktreeId: "wA" }),
        panel("b2", { worktreeId: "wB" }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // Only the active worktree's panel is priority; b1/b2 go to background.
    expect(ids).toEqual(["a1", "b1", "b2"]);
  });

  it("treats lastActiveAt <= 0 as 'no stamp' and does not promote", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB", lastActiveAt: 0 }),
        panel("a1", { worktreeId: "wA" }),
        panel("b2", { worktreeId: "wB", lastActiveAt: 0 }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // Same shape as the legacy-snapshot case — zero stamps do not promote.
    expect(ids).toEqual(["a1", "b1", "b2"]);
  });

  it("promotes both panels when two share the same max non-zero lastActiveAt (tie)", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB", lastActiveAt: 100 }),
        panel("a1", { worktreeId: "wA" }),
        panel("b2", { worktreeId: "wB", lastActiveAt: 100 }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // All three promote into the priority tier in saved order — b1 lands
    // before a1 because the priority filter preserves savedIndex.
    expect(ids).toEqual(["b1", "a1", "b2"]);
  });

  it("does not promote panels without a worktreeId even with a real lastActiveAt", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("nw", backend("nw"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    await restorePanelsPhase(
      [
        panel("nw", { worktreeId: undefined, lastActiveAt: 9999 }),
        panel("a1", { worktreeId: "wA" }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // a1 priority, nw background — nw is excluded from the per-worktree max map.
    expect(ids).toEqual(["a1", "nw"]);
  });

  it("rejects NaN and ±Infinity lastActiveAt — corrupted values never seed the max map", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB", lastActiveAt: Number.NaN }),
        panel("a1", { worktreeId: "wA" }),
        panel("b2", { worktreeId: "wB", lastActiveAt: Number.POSITIVE_INFINITY }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // Neither NaN nor Infinity enters the map; both b1 and b2 stay background.
    expect(ids).toEqual(["a1", "b1", "b2"]);
  });

  it("promotes the single panel in each non-active worktree when it has a real timestamp", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" });
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("c1", backend("c1"));
    await restorePanelsPhase(
      [
        panel("b1", { worktreeId: "wB", lastActiveAt: 10 }),
        panel("a1", { worktreeId: "wA" }),
        panel("c1", { worktreeId: "wC", lastActiveAt: 20 }),
      ],
      ctx
    );
    const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
    // All three promote; saved-order placement is preserved in the priority filter.
    expect(ids).toEqual(["b1", "a1", "c1"]);
  });
});

describe("restorePanelsPhase — visible-panel priority tier (issue #10527)", () => {
  // addPanel order is the observable. Visible PTY panels run in a dedicated
  // tier ahead of the active-worktree priority tier; non-PTY visible panels are
  // unaffected (they stay on the concurrent non-PTY path).
  const restoredIds = (addPanel: Mock): (string | undefined)[] =>
    addPanel.mock.calls.map((c) => {
      const args = c[0] as { existingId?: string; requestedId?: string };
      return args.existingId ?? args.requestedId;
    });

  it("restores the visible PTY panel first, ahead of the active-worktree tier", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA", visiblePanelId: "b1" });
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("a1", { worktreeId: "wA" }), // active -> priority 0
        panel("b1", { worktreeId: "wB", lastActiveAt: 10 }), // visible -> -1 (would be background)
        panel("b2", { worktreeId: "wB", lastActiveAt: 200 }), // max in wB -> priority 0
      ],
      ctx
    );
    // Without the visible tier b1 is background and restores last (a1, b2, b1).
    // The visible tier pulls it to the front.
    expect(restoredIds(ctx.addPanel)).toEqual(["b1", "a1", "b2"]);
    // Restored exactly once — the -1 tier replaces, not duplicates, its slot.
    expect(ctx.addPanel).toHaveBeenCalledTimes(3);
  });

  it("does not let a visible non-PTY panel jump the PTY restore queue", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA", visiblePanelId: "br1" });
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b1", backend("b1"));
    await restorePanelsPhase(
      [
        panel("a1", { worktreeId: "wA" }), // active PTY -> priority 0
        panel("br1", { kind: "browser", worktreeId: "wB" }), // non-PTY, visible
        panel("b1", { worktreeId: "wB", lastActiveAt: 5 }), // background PTY
      ],
      ctx
    );
    // br1 restores via the concurrent non-PTY phase (first), but it never enters
    // the -1 PTY tier, so the PTY ordering (a1 priority, b1 background) is
    // unchanged — the visible non-PTY does not promote the background PTY.
    expect(restoredIds(ctx.addPanel)).toEqual(["br1", "a1", "b1"]);
  });

  it("preserves existing ordering when no visiblePanelId is supplied", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA" }); // visiblePanelId undefined
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("a1", { worktreeId: "wA" }),
        panel("b1", { worktreeId: "wB", lastActiveAt: 10 }),
        panel("b2", { worktreeId: "wB", lastActiveAt: 200 }),
      ],
      ctx
    );
    // a1 (active) + b2 (max in wB) are priority; b1 is background and last.
    expect(restoredIds(ctx.addPanel)).toEqual(["a1", "b2", "b1"]);
  });

  it("degrades to existing ordering when visiblePanelId matches no saved panel", async () => {
    const ctx = makeContext({ activeWorktreeId: "wA", visiblePanelId: "ghost" });
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("a1", { worktreeId: "wA" }),
        panel("b1", { worktreeId: "wB", lastActiveAt: 10 }),
        panel("b2", { worktreeId: "wB", lastActiveAt: 200 }),
      ],
      ctx
    );
    // Identical to the no-signal case — a stale MRU head is harmless.
    expect(restoredIds(ctx.addPanel)).toEqual(["a1", "b2", "b1"]);
  });

  it("restores a visible panel first via the respawn path on cold restart (no backend match)", async () => {
    // No backend terminal for the visible panel → it takes the reconnect/respawn
    // path. It must still jump ahead of the active-worktree PTY.
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({ activeWorktreeId: "wA", visiblePanelId: "v1" });
    ctx.backendTerminalMap.set("a1", backend("a1"));
    await restorePanelsPhase(
      [
        panel("a1", { worktreeId: "wA" }), // active PTY (backend match)
        panel("v1", { kind: "agent", launchAgentId: "claude", worktreeId: "wB" }), // visible, respawn
      ],
      ctx
    );
    // v1 (visible, respawned with requestedId v1) restores before a1.
    expect(restoredIds(ctx.addPanel)).toEqual(["v1", "a1"]);
  });

  it("restores the visible panel exactly once when it is also the active-worktree panel", async () => {
    // Overlap: the visible panel is in the active worktree. priority -1 wins over
    // priority 0, so it lands only in the visible tier — never double-restored.
    const ctx = makeContext({ activeWorktreeId: "wA", visiblePanelId: "a1" });
    ctx.backendTerminalMap.set("a1", backend("a1"));
    ctx.backendTerminalMap.set("a2", backend("a2"));
    await restorePanelsPhase(
      [panel("a1", { worktreeId: "wA" }), panel("a2", { worktreeId: "wA" })],
      ctx
    );
    expect(restoredIds(ctx.addPanel)).toEqual(["a1", "a2"]);
    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
  });

  it("wraps the visible tier in its own hydration batch separate from background", async () => {
    // v1 is the max-lastActiveAt in wB but is visible → priority -1, so b1/b2
    // (lower stamps, same worktree) are NOT promoted and both go to background.
    // Tiers: visible[v1], background[b1,b2] (one batch, size 2) → 2 batch calls.
    // A regression that forgot to wrap the visible tier would drop to 1.
    const ctx = makeContext({ visiblePanelId: "v1" });
    ctx.backendTerminalMap.set("v1", backend("v1"));
    ctx.backendTerminalMap.set("b1", backend("b1"));
    ctx.backendTerminalMap.set("b2", backend("b2"));
    await restorePanelsPhase(
      [
        panel("v1", { worktreeId: "wB", lastActiveAt: 100 }), // visible
        panel("b1", { worktreeId: "wB", lastActiveAt: 5 }), // background
        panel("b2", { worktreeId: "wB", lastActiveAt: 5 }), // background
      ],
      ctx
    );
    expect(restoredIds(ctx.addPanel)).toEqual(["v1", "b1", "b2"]);
    expect(ctx.withHydrationBatch).toHaveBeenCalledTimes(2);
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

describe("restorePanelsPhase — savedIdToRestoredId remap (issue #10440)", () => {
  it("maps the saved id to the freshly generated id when a PTY reconnect times out", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "timeout" });
    const ctx = makeContext();
    // A timed-out respawn passes requestedId: undefined, so the store assigns a
    // new id — model that here and assert the map captures saved → new.
    ctx.addPanel.mockImplementation(
      async (args: { requestedId?: string; existingId?: string }) =>
        args.requestedId ?? args.existingId ?? "regenerated-id"
    );
    const { savedIdToRestoredId } = await restorePanelsPhase(
      [panel("p1", { kind: "agent", launchAgentId: "claude" })],
      ctx
    );
    expect(savedIdToRestoredId.get("p1")).toBe("regenerated-id");
    expect(savedIdToRestoredId.size).toBe(1);
  });

  it("leaves the map empty when a respawn keeps the saved id (not_found, no timeout)", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext();
    // not_found respawn keeps requestedId: "p1", so addPanel returns "p1" — the
    // restored id equals the saved id, an identity mapping that is excluded.
    const { savedIdToRestoredId } = await restorePanelsPhase(
      [panel("p1", { kind: "agent", launchAgentId: "claude" })],
      ctx
    );
    expect(savedIdToRestoredId.size).toBe(0);
  });

  it("excludes identity mappings for cleanly reconnected backend terminals", async () => {
    const ctx = makeContext();
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { savedIdToRestoredId } = await restorePanelsPhase([panel("t1")], ctx);
    // Backend reconnect restores under existingId "t1" — same as saved, skipped.
    expect(savedIdToRestoredId.size).toBe(0);
  });

  it("maps only the timed-out panel, leaving cleanly restored siblings out", async () => {
    // p1 times out (new id); p2 reconnects cleanly under its saved id.
    reconnectWithTimeoutMock.mockImplementation(async (id: string) =>
      id === "p1" ? { status: "timeout" } : { status: "not_found" }
    );
    const ctx = makeContext();
    ctx.addPanel.mockImplementation(
      async (args: { requestedId?: string; existingId?: string }) =>
        args.requestedId ?? args.existingId ?? "new-p1"
    );
    const { savedIdToRestoredId } = await restorePanelsPhase(
      [
        panel("p1", { kind: "agent", launchAgentId: "claude" }),
        panel("p2", { kind: "agent", launchAgentId: "claude" }),
      ],
      ctx
    );
    expect(savedIdToRestoredId.size).toBe(1);
    expect(savedIdToRestoredId.get("p1")).toBe("new-p1");
    expect(savedIdToRestoredId.has("p2")).toBe(false);
  });

  it("returns an empty map when there are no saved panels", async () => {
    const ctx = makeContext();
    const { savedIdToRestoredId } = await restorePanelsPhase(undefined, ctx);
    expect(savedIdToRestoredId.size).toBe(0);
  });

  it("maps every timed-out panel independently with no cross-contamination", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "timeout" });
    const ctx = makeContext();
    // Each respawn (requestedId undefined) gets a distinct generated id.
    let next = 0;
    ctx.addPanel.mockImplementation(
      async (args: { requestedId?: string; existingId?: string }) =>
        args.requestedId ?? args.existingId ?? `gen-${++next}`
    );
    const { savedIdToRestoredId } = await restorePanelsPhase(
      [
        panel("p1", { kind: "agent", launchAgentId: "claude" }),
        panel("p2", { kind: "agent", launchAgentId: "claude" }),
      ],
      ctx
    );
    expect(savedIdToRestoredId.size).toBe(2);
    expect(savedIdToRestoredId.get("p1")).toBe("gen-1");
    expect(savedIdToRestoredId.get("p2")).toBe("gen-2");
  });

  it("returns an error-status panel under its saved id with no remap entry", async () => {
    // status "error" (IPC failure, not timeout) keeps requestedId: saved.id, so
    // the panel restores under its saved id — an identity mapping, excluded.
    reconnectWithTimeoutMock.mockResolvedValue({ status: "error", error: new Error("ipc") });
    const ctx = makeContext();
    const { savedIdToRestoredId } = await restorePanelsPhase(
      [panel("p1", { kind: "agent", launchAgentId: "claude" })],
      ctx
    );
    expect(savedIdToRestoredId.size).toBe(0);
  });
});

describe("restorePanelsPhase — panels outliving their worktree (issue #11232)", () => {
  // Only `id` is read when deciding whether a saved worktreeId still resolves,
  // so the rest of WorktreeState is left off rather than stubbed per test.
  const worktreeList = (...ids: string[]) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    Promise.resolve(ids.map((id) => ({ id, path: `/repo/${id}` })) as never);

  it("re-homes a saved panel whose worktree no longer exists", async () => {
    // Deleting a worktree now leaves its terminals running, and the sidebar row
    // holding them is in-memory only — so a saved panel can name a worktree
    // that is gone. Restoring it as-is would strand a live PTY off-screen,
    // since the grid and dock both filter by the active worktree.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase([panel("t1", { worktreeId: "deleted-wt" })], ctx);

    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
  });

  it("leaves a saved panel alone when its worktree still exists", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA", "wB"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase([panel("t1", { worktreeId: "wB" })], ctx);

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wB" });
  });

  it("keeps the saved worktree when the worktree list is unavailable", async () => {
    // Nothing is known about which worktrees exist, so re-homing would be a
    // guess — the previous behaviour (trust the saved id) is the safe default.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: Promise.resolve(null),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase([panel("t1", { worktreeId: "wB" })], ctx);

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wB" });
  });

  it("keeps saved worktrees when the list is empty (#11234)", async () => {
    // Hydration races backend init, so `worktree.getAll()` answers [] while the
    // workspace host is still registering. Reading that as "every worktree is
    // gone" collapsed every panel into the active worktree, and the save loop
    // persisted the result — so the damage compounded on each restart. An
    // active worktree must be set here, otherwise `activeWorktreeId ?? saved`
    // returns the saved id anyway and the regression hides.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: Promise.resolve([]),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));

    await restorePanelsPhase(
      [panel("t1", { worktreeId: "wB" }), panel("t2", { worktreeId: "wC" })],
      ctx
    );

    // Distinct homes surviving is the invariant: the bug funnelled both into "wA".
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wB" });
    expect(ctx.addPanel.mock.calls[1]![0]).toMatchObject({ worktreeId: "wC" });
  });
});

describe("restorePanelsPhase — panels surviving a worktree move (issue #11388)", () => {
  // A worktree id is its path, so `git worktree move` gives it a new id while
  // its `.git/worktrees/<name>` handle (gitDir) is preserved. The pre-pass reads
  // id + gitDir off the current list to correlate a stale worktreeId.
  const worktreeList = (...worktrees: Array<{ id: string; gitDir?: string }>) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    Promise.resolve(worktrees.map((w) => ({ id: w.id, path: w.id, gitDir: w.gitDir })) as never);

  const GITDIR = "/repo/.git/worktrees/feature";

  it("remaps a moved backend PTY to the new id and rebases its live cwd", async () => {
    // The worktree moved from /old/feature to /new/feature; its gitDir handle is
    // unchanged, so the panel must follow to the new id (not collapse into wA),
    // and its surviving-PTY cwd (reported at the old path) must be rebased.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1", { cwd: "/old/feature/pkg" }));

    await restorePanelsPhase(
      [
        panel("t1", {
          worktreeId: "/old/feature",
          worktreeGitDir: GITDIR,
          cwd: "/old/feature/pkg",
        }),
      ],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({
      worktreeId: "/new/feature",
      cwd: "/new/feature/pkg",
    });
  });

  it("remaps a respawned (cold) PTY and rebases its saved cwd", async () => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });

    await restorePanelsPhase(
      [
        panel("t1", {
          worktreeId: "/old/feature",
          worktreeGitDir: GITDIR,
          cwd: "/old/feature/sub",
        }),
      ],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({
      worktreeId: "/new/feature",
      cwd: "/new/feature/sub",
    });
  });

  it("remaps a moved non-PTY panel (browser) and rebases its cwd", async () => {
    // Non-PTY panels never went through the re-home fallback, but the pre-pass
    // rewrites saved.worktreeId/cwd before buildArgsForNonPtyRecreation reads it.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });

    await restorePanelsPhase(
      [
        panel("b1", {
          kind: "browser",
          worktreeId: "/old/feature",
          worktreeGitDir: GITDIR,
          cwd: "/old/feature",
        }),
      ],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({
      worktreeId: "/new/feature",
      cwd: "/new/feature",
    });
  });

  it("follows the handle when the old path was taken over by another worktree", async () => {
    // A moved /old/feature→/new/feature (handle GITDIR); a DIFFERENT worktree now
    // occupies /old/feature. The panel must follow its handle to /new/feature,
    // not bind to the squatter still sitting at the old id.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList(
        { id: "/old/feature", gitDir: "/repo/.git/worktrees/other" },
        { id: "/new/feature", gitDir: GITDIR }
      ),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase(
      [panel("t1", { worktreeId: "/old/feature", worktreeGitDir: GITDIR })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "/new/feature" });
  });

  it("remaps every panel sharing one moved worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));

    await restorePanelsPhase(
      [
        panel("t1", { worktreeId: "/old/feature", worktreeGitDir: GITDIR }),
        panel("t2", { worktreeId: "/old/feature", worktreeGitDir: GITDIR }),
      ],
      ctx
    );

    // Both share one moved worktree; order across the restore tier is not fixed,
    // so assert each landed on the new id rather than a positional sequence.
    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "/new/feature" });
    expect(ctx.addPanel.mock.calls[1]![0]).toMatchObject({ worktreeId: "/new/feature" });
  });

  it("still re-homes a genuinely-deleted worktree (no gitDir match)", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA", gitDir: "/repo/.git" }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase(
      [panel("t1", { worktreeId: "/old/feature", worktreeGitDir: GITDIR })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
  });

  it("re-homes a legacy snapshot with no stored gitDir handle", async () => {
    // Pre-#11388 snapshots carry no gitDir, so a move can't be correlated — the
    // panel falls through to the existing re-home behavior.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    await restorePanelsPhase([panel("t1", { worktreeId: "/old/feature" })], ctx);

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
  });
});
