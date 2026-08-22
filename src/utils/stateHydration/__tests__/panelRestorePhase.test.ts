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
  // Mirrors the real two-arg resolver (primary, then fallback, both by
  // truthiness) — dropping the fallback here would quietly make every
  // live-record-first identity lookup resolve to nothing.
  resolveAgentId: (id: string | undefined, fallback?: string) => id || fallback || undefined,
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
    reconnectTimedOut?: boolean,
    _clipboardDirectory?: string,
    _projectPresetsByAgent?: unknown,
    options?: { allowResumeLatest?: boolean; allowSessionIdResume?: boolean }
  ) => ({
    cwd: s.cwd ?? "/cwd",
    kind,
    location: s.location === "dock" ? "dock" : "grid",
    worktreeId: s.worktreeId,
    // Mirror the real buildArgsForRespawn: a timed-out reconnect drops the
    // requested id so the store generates a fresh one (#10440).
    requestedId: reconnectTimedOut ? undefined : s.id,
    launchAgentId: s.launchAgentId,
    // Not real AddTerminalArgs fields — surfaced on the mock's output so the
    // resume election (#11461) is assertable through addPanel's args.
    allowResumeLatest: options?.allowResumeLatest ?? true,
    allowSessionIdResume: options?.allowSessionIdResume ?? true,
  }),
  // Mirrors the real resolver's title recovery (same agent order) so the
  // election's identity resolution can't silently diverge from production.
  resolveRespawnAgentId: (s: TerminalState, kind: string | undefined) => {
    if (s.launchAgentId) return s.launchAgentId;
    if (kind !== "agent") return undefined;
    const title = (s.title ?? "").toLowerCase();
    return ["claude", "antigravity", "gemini", "codex", "opencode"].find((id) =>
      title.includes(id)
    );
  },
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

// `buildResumeLatestCommand` is deliberately NOT mocked: the election's capability
// probe should be measured against the real agent configs, so an agent that gains
// or loses `resumeLatestArgs` is caught here rather than passing against a
// hand-maintained list.

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
    // The default is the git-backed workspace every existing case assumes; the
    // worktree-less workspace cases override it.
    workspaceHasWorktreesPromise: Promise.resolve(true),
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

// Worktree list fixture — getKnownWorktreeIds/resolveRestoredWorktreeId read
// only `id`, but constructing fully-typed WorktreeState objects avoids an
// unsafe cast (mirrors the factory in CrossWorktreeDiff.test.ts).
function wtList(...ids: string[]): WorktreeState[] {
  return ids.map((id) => ({
    id,
    worktreeId: id,
    name: id,
    path: `/proj/${id}`,
    branch: id,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  }));
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

  /**
   * Restore geometry seeds the xterm CONSTRUCTOR and stops there. It must never
   * be parked as an attach target: `TerminalInstanceService`'s attach rAF runs
   * `applyResize(targetCols, targetRows)` INSTEAD of `fit(id)` when a target is
   * parked, so parking would replace the first real container measurement with
   * the PTY's grid — a 240-col PTY revealed in a 90-col dock would be dragged
   * back to 240 with no SIGWINCH to follow it (the PTY is already there, so
   * `TerminalProcess.resize` takes its "unchanged" path). Worse than the 80×24
   * default this replaces, and only latent before because the map was empty.
   */
  it("does not park an attach target, so the first fit measures the real box", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 120, rows: 40 } } });
    ctx.backendTerminalMap.set("t1", backend("t1", { ptyCols: 240, ptyRows: 60 }));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 240, rows: 60 });
    expect(setTargetSizeMock).not.toHaveBeenCalled();
  });

  it("parks no target on the respawn path either", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 120, rows: 40 } } });
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    await restorePanelsPhase([panel("t1")], ctx);
    expect(setTargetSizeMock).not.toHaveBeenCalled();
  });

  /**
   * The saved size must reach xterm's CONSTRUCTOR, not just the attach target
   * (#11718). `setTargetSize` is consumed at first attach, and a pane restored
   * into a non-selected worktree never attaches — it sits prewarmed at 80×24
   * parsing everything its surviving PTY streams. The size is keyed by the
   * persisted id, so it is resolvable before `addPanel`, which is the only point
   * early enough to close the window completely.
   */
  const geometryPassedToAddPanel = (
    addPanel: Mock,
    id: string
  ): { cols: number; rows: number } | undefined =>
    (
      addPanel.mock.calls.find(
        (call) => (call[0] as { existingId?: string; requestedId?: string }).existingId === id
      )?.[0] as { initialTerminalGeometry?: { cols: number; rows: number } }
    )?.initialTerminalGeometry;

  it("hands the saved grid to addPanel when reconnecting a matched backend terminal", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 203, rows: 51 } } });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("hands the saved grid to addPanel on the reconnect-fallback path", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 203, rows: 51 } } });
    reconnectWithTimeoutMock.mockResolvedValue({
      status: "found",
      terminal: { id: "t1", cwd: "/cwd" },
    });
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("hands the saved grid to addPanel when respawning a dead PTY", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 203, rows: 51 } } });
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    await restorePanelsPhase([panel("t1")], ctx);
    const respawnArgs = ctx.addPanel.mock.calls[0]?.[0] as {
      initialTerminalGeometry?: { cols: number; rows: number };
    };
    expect(respawnArgs.initialTerminalGeometry).toEqual({ cols: 203, rows: 51 });
  });

  it("omits an invalid saved grid rather than partially defaulting it", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 0, rows: 51 } } });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toBeUndefined();
  });

  /**
   * The live PTY grid outranks the persisted map (#11718 follow-up). The map is
   * written by exactly one renderer path and was empty on disk for four months
   * after `30ed7877f` deleted its writer; the PTY answer is read off the handle
   * at query time and cannot go stale the same way. These assert the precedence,
   * not the plumbing — a regression that reinstates "persisted wins" restores
   * the original bug on every reconnect.
   */
  it("prefers the live PTY grid over a stale persisted size on reconnect", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 80, rows: 24 } } });
    ctx.backendTerminalMap.set("t1", backend("t1", { ptyCols: 203, ptyRows: 51 }));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("falls back to the persisted size when the PTY grid is half-reported", async () => {
    // A partial pair is not a grid — taking `cols` alone would boot the pane on
    // a geometry no PTY is on, which is the failure this whole path exists for.
    const ctx = makeContext({ terminalSizes: { t1: { cols: 203, rows: 51 } } });
    ctx.backendTerminalMap.set("t1", backend("t1", { ptyCols: 120 }));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("prefers the live PTY grid on the reconnect-fallback path", async () => {
    const ctx = makeContext({ terminalSizes: { t1: { cols: 80, rows: 24 } } });
    reconnectWithTimeoutMock.mockResolvedValue({
      status: "found",
      terminal: { id: "t1", cwd: "/cwd", ptyCols: 203, ptyRows: 51 },
    });
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("boots a reconnected pane on the live grid even with no persisted size at all", async () => {
    // The state on disk today: `terminalSizes` empty for every project.
    const ctx = makeContext({ terminalSizes: {} });
    ctx.backendTerminalMap.set("t1", backend("t1", { ptyCols: 203, ptyRows: 51 }));
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryPassedToAddPanel(ctx.addPanel, "t1")).toEqual({ cols: 203, rows: 51 });
  });

  it("resolves the grid before addPanel, not after it returns", async () => {
    // The ordering IS the fix: an xterm prewarmed inside addPanel has already
    // begun parsing live PTY output by the time addPanel resolves. Read
    // synchronously inside the mock — vitest records the args object by
    // reference, so inspecting it afterwards cannot distinguish a value that was
    // present on entry from one assigned after addPanel returned.
    const ctx = makeContext({ terminalSizes: { t1: { cols: 203, rows: 51 } } });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    let geometryOnEntry: unknown = "addPanel was never called";
    ctx.addPanel.mockImplementation(
      async (args: { existingId?: string; initialTerminalGeometry?: unknown }) => {
        geometryOnEntry = args.initialTerminalGeometry;
        return args.existingId ?? "";
      }
    );
    await restorePanelsPhase([panel("t1")], ctx);
    expect(geometryOnEntry).toEqual({ cols: 203, rows: 51 });
  });
});

describe("restorePanelsPhase — worktree re-home validation (#11387)", () => {
  // restoreTasks[].worktreeId reflects the id after resolveRestoredWorktreeId
  // runs, so it is the observable for how a stranded panel was (or wasn't)
  // re-homed.
  const resolvedWorktreeId = (tasks: { worktreeId?: string }[]) => tasks[0]?.worktreeId;

  it("ghosts a surviving PTY's dead worktree instead of re-homing it (#11911)", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wMain",
      worktreesPromise: Promise.resolve(wtList("wMain")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks, ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "wGone" })],
      ctx
    );
    // wGone is absent from the complete list, but this PTY is still running in
    // it. Re-homing onto wMain would hide that and erase the row the cleanup
    // sweep needs to ever retire the run, so the dead id is kept and reported.
    expect(resolvedWorktreeId(restoreTasks)).toBe("wGone");
    expect([...ghostedWorktreeIds]).toEqual(["wGone"]);
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
    // The panel is still restored (not dropped)...
    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(restoreTasks).toHaveLength(1);
    // ...but with no worktree: the active worktree is dead, so leave it unset
    // rather than guess onto a deleted worktree.
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: undefined });
    expect(resolvedWorktreeId(restoreTasks)).toBeUndefined();
  });

  it("homes a no-worktree panel onto the active worktree when it is live", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wMain",
      worktreesPromise: Promise.resolve(wtList("wMain")),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    const { restoreTasks } = await restorePanelsPhase(
      [panel("t1", { worktreeId: undefined })],
      ctx
    );
    expect(restoreTasks).toHaveLength(1);
    // Active worktree is live — a stranded no-worktree panel homes onto it.
    expect(resolvedWorktreeId(restoreTasks)).toBe("wMain");
  });

  // A scratch, or a folder opened without git, can never enumerate a worktree,
  // so the app-global active id belongs to some other workspace and any saved id
  // can only be one an earlier buggy run stamped on. Restoring either leaves a
  // live PTY in a bucket the grid never renders.
  describe("worktree-less workspace", () => {
    it("restores a stranded panel with no worktree instead of re-homing onto the foreign active id", async () => {
      const ctx = makeContext({
        workspaceHasWorktreesPromise: Promise.resolve(false),
        activeWorktreeId: "/other/project/main",
        worktreesPromise: Promise.resolve([]),
      });
      ctx.backendTerminalMap.set("t1", backend("t1"));
      const { restoreTasks } = await restorePanelsPhase(
        [panel("t1", { worktreeId: undefined })],
        ctx
      );
      expect(restoreTasks).toHaveLength(1);
      expect(resolvedWorktreeId(restoreTasks)).toBeUndefined();
    });

    it("strips a foreign worktreeId a previous run persisted onto a panel", async () => {
      const ctx = makeContext({
        workspaceHasWorktreesPromise: Promise.resolve(false),
        activeWorktreeId: null,
        worktreesPromise: Promise.resolve([]),
      });
      ctx.backendTerminalMap.set("t1", backend("t1"));
      const { restoreTasks } = await restorePanelsPhase(
        [panel("t1", { worktreeId: "/other/project/main" })],
        ctx
      );
      expect(resolvedWorktreeId(restoreTasks)).toBeUndefined();
    });

    it("strips a foreign worktreeId from a non-PTY panel too", async () => {
      const ctx = makeContext({
        workspaceHasWorktreesPromise: Promise.resolve(false),
        activeWorktreeId: "/other/project/main",
        worktreesPromise: Promise.resolve([]),
      });
      await restorePanelsPhase(
        [panel("b1", { kind: "browser", worktreeId: "/other/project/main" })],
        ctx
      );
      expect(ctx.addPanel).toHaveBeenCalledTimes(1);
      expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: undefined });
    });

    // Restore ordering keys off "is this panel on the active worktree", which
    // reads the same app-global id. Ungated, the foreign id makes a panel an
    // earlier run wrongly stamped with it restore FIRST, while the correctly
    // unattributed panel drops to the background tier — another project's
    // selection steering this one's restore order. Saved order here is the
    // reverse of the expectation, so echoing the input cannot pass this.
    it("does not let the foreign active id steer restore priority", async () => {
      const ctx = makeContext({
        workspaceHasWorktreesPromise: Promise.resolve(false),
        activeWorktreeId: "/other/project/main",
        worktreesPromise: Promise.resolve([]),
      });
      ctx.backendTerminalMap.set("fw", backend("fw"));
      ctx.backendTerminalMap.set("nw", backend("nw"));
      await restorePanelsPhase(
        [
          panel("fw", { worktreeId: "/other/project/main" }),
          panel("nw", { worktreeId: undefined }),
        ],
        ctx
      );
      const ids = ctx.addPanel.mock.calls.map((c) => (c[0] as { existingId?: string }).existingId);
      expect(ids).toEqual(["nw", "fw"]);
    });

    it("leaves an orphan PTY worktree-less even when a foreign worktree matches its cwd", async () => {
      const ctx = makeContext({
        workspaceHasWorktreesPromise: Promise.resolve(false),
        activeWorktreeId: "/other/project/main",
        // A worktree-less view should never see a list, but if a stale one leaks
        // through, cwd inference must not attribute the orphan to it either.
        worktreesPromise: Promise.resolve(wtList("wForeign")),
      });
      ctx.backendTerminalMap.set("o1", backend("o1", { cwd: "/proj/wForeign" }));
      await restorePanelsPhase([], ctx);
      // Read the field rather than `toMatchObject`: the orphan builder omits the
      // key entirely when unattributed, which that matcher would not accept.
      const orphanArgs = ctx.addPanel.mock.calls[0]![0] as { worktreeId?: string };
      expect(orphanArgs.worktreeId).toBeUndefined();
    });
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

  it("hands an orphan's saved grid to addPanel, keyed by its backend id (#11718)", async () => {
    // Orphans go through the same prewarm-then-target ordering as saved panels
    // and can be attributed to a worktree that is not the selected one, so they
    // are squarely in this bug's blast radius.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      terminalSizes: { o1: { cols: 203, rows: 51 } },
    });
    ctx.backendTerminalMap.set("o1", backend("o1"));
    await restorePanelsPhase([], ctx);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({
      initialTerminalGeometry: { cols: 203, rows: 51 },
    });
  });

  it("prefers an orphan's live PTY grid over a stale persisted size", async () => {
    // An orphan is by definition a LIVE backend terminal, so its own grid is
    // available and beats whatever the renderer last believed.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      terminalSizes: { o1: { cols: 80, rows: 24 } },
    });
    ctx.backendTerminalMap.set("o1", backend("o1", { ptyCols: 203, ptyRows: 51 }));
    await restorePanelsPhase([], ctx);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({
      initialTerminalGeometry: { cols: 203, rows: 51 },
    });
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

  it("keeps a saved panel on its deleted worktree and reports it for a row (#11911)", async () => {
    // Deleting a worktree leaves its terminals running, and the sidebar row
    // holding them is in-memory only — so a saved panel can name a worktree
    // that is gone. Re-homing it onto the active worktree used to be the
    // answer, but that laundered a run from a deleted worktree into a live
    // one's identity and left nothing for the cleanup sweep to retire. The
    // panel keeps the dead id; hydration rebuilds the row that holds it.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ctx.addPanel).toHaveBeenCalledTimes(1);
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "deleted-wt" });
    expect([...ghostedWorktreeIds]).toEqual(["deleted-wt"]);
  });

  it("reports one ghost id for several panels sharing a deleted worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));
    ctx.backendTerminalMap.set("t2", backend("t2"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" }), panel("t2", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ctx.addPanel).toHaveBeenCalledTimes(2);
    expect([...ghostedWorktreeIds]).toEqual(["deleted-wt"]);
  });

  it("ghosts nothing when the worktree list is unknown", async () => {
    // `null` is "not ready", never proof of absence (#11235) — ghosting off it
    // would bury every live worktree in the project behind a deleted row.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: Promise.resolve(null),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ghostedWorktreeIds.size).toBe(0);
  });

  it("ghosts nothing when the worktree list is empty", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: Promise.resolve([]),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ghostedWorktreeIds.size).toBe(0);
  });

  it("ghosts nothing for a live worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA", "wB"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "wB" })],
      ctx
    );

    expect(ghostedWorktreeIds.size).toBe(0);
  });

  it("re-homes a cold respawn onto the active worktree and ghosts nothing", async () => {
    // not_found means the PTY died on quit, so the respawn boots a NEW process
    // that can pick any live worktree — and its cwd has to point somewhere that
    // still exists. Recording a row for it would resurrect a dead worktree in
    // the sidebar for a session that never ran there.
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
    expect(ghostedWorktreeIds.size).toBe(0);
  });

  it("ghosts a reconnect-fallback survivor whose worktree is gone", async () => {
    // No entry in backendTerminalMap, but the reconnect probe finds the PTY
    // alive — same fact as the matched-backend path, so the same answer.
    reconnectWithTimeoutMock.mockResolvedValue({
      status: "found",
      terminal: backend("t1"),
    });
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "deleted-wt" })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "deleted-wt" });
    expect([...ghostedWorktreeIds]).toEqual(["deleted-wt"]);
  });

  it("ghosts nothing for a panel that never named a worktree", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList("wA"),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: undefined })],
      ctx
    );

    // Still homes onto the live active worktree, as before.
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wA" });
    expect(ghostedWorktreeIds.size).toBe(0);
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

  it("ghosts a genuinely-deleted worktree rather than remapping it (no gitDir match)", async () => {
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA", gitDir: "/repo/.git" }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "/old/feature", worktreeGitDir: GITDIR })],
      ctx
    );

    // No live worktree claims this gitDir, so the worktree really is gone —
    // the panel keeps its id and earns a deleted-worktree row (#11911).
    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "/old/feature" });
    expect([...ghostedWorktreeIds]).toEqual(["/old/feature"]);
  });

  it("ghosts a legacy snapshot with no stored gitDir handle", async () => {
    // Pre-#11388 snapshots carry no gitDir, so a move can't be correlated. The
    // invariant under test is that the panel is NOT adopted by the moved
    // worktree on a guess — it falls through to the deleted-worktree path.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "/old/feature" })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "/old/feature" });
    expect([...ghostedWorktreeIds]).toEqual(["/old/feature"]);
  });

  it("ghosts nothing when the worktree merely moved", async () => {
    // The remap runs before the missing-id check, so a moved worktree is
    // followed to its new id — never mistaken for a deleted one.
    const ctx = makeContext({
      activeWorktreeId: "wA",
      worktreesPromise: worktreeList({ id: "wA" }, { id: "/new/feature", gitDir: GITDIR }),
    });
    ctx.backendTerminalMap.set("t1", backend("t1"));

    const { ghostedWorktreeIds } = await restorePanelsPhase(
      [panel("t1", { worktreeId: "/old/feature", worktreeGitDir: GITDIR })],
      ctx
    );

    expect(ctx.addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "/new/feature" });
    expect(ghostedWorktreeIds.size).toBe(0);
  });
});

describe("restorePanelsPhase — one resume-latest per agent+cwd (issue #11461)", () => {
  /** id → the allowResumeLatest the respawn builder was handed. */
  function allowanceById(ctx: MockedContext): Map<string, boolean> {
    const byId = new Map<string, boolean>();
    for (const [args] of ctx.addPanel.mock.calls as [
      { requestedId?: string; allowResumeLatest?: boolean },
    ][]) {
      if (args.requestedId !== undefined && args.allowResumeLatest !== undefined) {
        byId.set(args.requestedId, args.allowResumeLatest);
      }
    }
    return byId;
  }

  /** id → the allowSessionIdResume the respawn builder was handed. */
  function sessionAllowanceById(ctx: MockedContext): Map<string, boolean> {
    const byId = new Map<string, boolean>();
    for (const [args] of ctx.addPanel.mock.calls as [
      { requestedId?: string; allowSessionIdResume?: boolean },
    ][]) {
      if (args.requestedId !== undefined && args.allowSessionIdResume !== undefined) {
        byId.set(args.requestedId, args.allowSessionIdResume);
      }
    }
    return byId;
  }

  const codexPanel = (id: string, overrides: Partial<TerminalState> = {}): TerminalState =>
    panel(id, { kind: "agent", launchAgentId: "codex", ...overrides });

  beforeEach(() => {
    reconnectWithTimeoutMock.mockResolvedValue({ status: "not_found" });
  });

  it("allows exactly one of several id-less panes sharing a directory", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("a", { lastActiveAt: 100 }),
        codexPanel("b", { lastActiveAt: 300 }),
        codexPanel("c", { lastActiveAt: 200 }),
      ],
      ctx
    );

    // Asserted as a complete map, not just the allowed subset: a regression that
    // dropped the losing panes entirely would still leave one `true`.
    expect(Object.fromEntries(allowanceById(ctx))).toEqual({ a: false, b: true, c: false });
  });

  it("gives the slot to the most recently active pane", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [codexPanel("older", { lastActiveAt: 5 }), codexPanel("newer", { lastActiveAt: 9 })],
      ctx
    );

    expect(allowanceById(ctx).get("newer")).toBe(true);
    expect(allowanceById(ctx).get("older")).toBe(false);
  });

  it("breaks a tie in favour of the earlier saved entry", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [codexPanel("first", { lastActiveAt: 7 }), codexPanel("second", { lastActiveAt: 7 })],
      ctx
    );

    expect(allowanceById(ctx).get("first")).toBe(true);
    expect(allowanceById(ctx).get("second")).toBe(false);
  });

  it("treats a corrupt lastActiveAt as least-recent rather than winning", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("corrupt", { lastActiveAt: Number.NaN }),
        codexPanel("valid", { lastActiveAt: 1 }),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("valid")).toBe(true);
    expect(allowanceById(ctx).get("corrupt")).toBe(false);
  });

  it("leaves a lone id-less pane untouched", async () => {
    const ctx = makeContext();

    await restorePanelsPhase([codexPanel("solo")], ctx);

    expect(allowanceById(ctx).get("solo")).toBe(true);
  });

  it("scopes the slot per agent — different agents don't contend", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [codexPanel("cx"), panel("cl", { kind: "agent", launchAgentId: "claude" })],
      ctx
    );

    expect(allowanceById(ctx).get("cx")).toBe(true);
    expect(allowanceById(ctx).get("cl")).toBe(true);
  });

  it("scopes the slot per directory — different cwds don't contend", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [codexPanel("here", { cwd: "/proj/one" }), codexPanel("there", { cwd: "/proj/two" })],
      ctx
    );

    expect(allowanceById(ctx).get("here")).toBe(true);
    expect(allowanceById(ctx).get("there")).toBe(true);
  });

  it("groups equivalent spellings of one directory into the same scope", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("plain", { cwd: "/proj/work", lastActiveAt: 2 }),
        codexPanel("dotted", { cwd: "/proj/work/./", lastActiveAt: 1 }),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("plain")).toBe(true);
    expect(allowanceById(ctx).get("dotted")).toBe(false);
  });

  it("suppresses the fallback where a sibling resumes an exact session id", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("exact", { agentSessionId: "abc", lastActiveAt: 1 }),
        codexPanel("idless", { lastActiveAt: 900 }),
      ],
      ctx
    );

    // "Resume the latest session here" cannot be steered away from the session
    // `exact` is replaying into, and being the more recently focused pane does
    // not change which of the two reaches the directory first.
    expect(allowanceById(ctx).get("idless")).toBe(false);
  });

  it("keeps an exact-id pane's claim inside its own directory", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("exact", { cwd: "/proj/one", agentSessionId: "abc" }),
        codexPanel("idless", { cwd: "/proj/two" }),
      ],
      ctx
    );

    // Different scope, different pool of sessions — nothing to collide with.
    expect(allowanceById(ctx).get("idless")).toBe(true);
  });

  it("suppresses the fallback where a sibling's PTY survived", async () => {
    // The survivor reconnects to a session that is open and being written right
    // now, which is exactly what resume-latest would resolve to.
    const ctx = makeContext({
      backendTerminalMap: new Map([["survivor", backend("survivor", { kind: "agent" })]]),
    });

    await restorePanelsPhase(
      [codexPanel("survivor", { lastActiveAt: 900 }), codexPanel("respawner", { lastActiveAt: 1 })],
      ctx
    );

    expect(allowanceById(ctx).get("respawner")).toBe(false);
  });

  it("suppresses every candidate in a claimed scope, not just the losers", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("exact", { agentSessionId: "abc" }),
        codexPanel("a", { lastActiveAt: 100 }),
        codexPanel("b", { lastActiveAt: 300 }),
      ],
      ctx
    );

    // Asserted as a complete map: a claim must not degrade into "one winner
    // survives", which is the collision this suppression exists to prevent. The
    // claimant's own allowance is moot — it resumes by id and never reaches the
    // fallback — so it stays untouched.
    expect(Object.fromEntries(allowanceById(ctx))).toEqual({ exact: true, a: false, b: false });
  });

  it("does not let one agent's claim suppress another agent's fallback", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("cx-exact", { agentSessionId: "abc" }),
        panel("cl", { kind: "agent", launchAgentId: "claude" }),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("cl")).toBe(true);
  });

  it("elects for a non-Codex capable agent too", async () => {
    // Guards against the blast radius narrowing to whatever the tests name: this
    // resolves capability from the real gemini config, not a mock list.
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        panel("g-old", { kind: "agent", launchAgentId: "gemini", lastActiveAt: 1 }),
        panel("g-new", { kind: "agent", launchAgentId: "gemini", lastActiveAt: 2 }),
      ],
      ctx
    );

    expect(Object.fromEntries(allowanceById(ctx))).toEqual({ "g-old": false, "g-new": true });
  });

  it("suppresses the fallback where a prefetched probe says a sibling is alive", async () => {
    // The probe reports a live PTY, so that pane keeps its open session in the
    // directory. (Only the election is asserted here — the describe-level
    // reconnect mock answers "not_found" for every pane regardless.)
    const ctx = makeContext({
      prefetchedReconnectResults: {
        alive: { id: "alive", exists: true, hasPty: true },
      },
    });

    await restorePanelsPhase(
      [codexPanel("alive", { lastActiveAt: 900 }), codexPanel("cold", { lastActiveAt: 1 })],
      ctx
    );

    expect(allowanceById(ctx).get("cold")).toBe(false);
  });

  it("does not let a backend record with no live PTY claim the scope", async () => {
    // A dead agent backend is dropped outright by the restore branch (it would be
    // a phantom idle panel), so it holds no session — suppressing its cold sibling
    // would cost a resume to protect a conversation that isn't there.
    const ctx = makeContext({
      backendTerminalMap: new Map([
        ["dead", backend("dead", { kind: "agent", launchAgentId: "codex", hasPty: false })],
      ]),
    });

    await restorePanelsPhase(
      [codexPanel("dead", { lastActiveAt: 900 }), codexPanel("cold", { lastActiveAt: 1 })],
      ctx
    );

    expect(allowanceById(ctx).get("cold")).toBe(true);
  });

  it("does not treat a probe reporting no live PTY as a claim", async () => {
    // `exists` without `hasPty` is a known-but-dead terminal: it respawns like any
    // other cold pane, so it neither claims the scope nor escapes the vote.
    const ctx = makeContext({
      prefetchedReconnectResults: {
        dead: { id: "dead", exists: true, hasPty: false },
      },
    });

    await restorePanelsPhase(
      [codexPanel("dead", { lastActiveAt: 900 }), codexPanel("cold", { lastActiveAt: 1 })],
      ctx
    );

    expect(Object.fromEntries(allowanceById(ctx))).toEqual({ dead: true, cold: false });
  });

  it("scopes a live sibling by its own cwd when the snapshot never recorded one", async () => {
    // A legacy snapshot with no cwd would key on projectRoot, missing the
    // directory its live PTY is actually running in.
    const ctx = makeContext({
      backendTerminalMap: new Map([
        ["alive", backend("alive", { kind: "agent", launchAgentId: "codex", cwd: "/proj/sub" })],
      ]),
    });

    await restorePanelsPhase(
      [
        codexPanel("alive", { cwd: undefined }),
        codexPanel("cold", { cwd: "/proj/sub" }),
        codexPanel("elsewhere", { cwd: "/proj/other" }),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("cold")).toBe(false);
    expect(allowanceById(ctx).get("elsewhere")).toBe(true);
  });

  it("identifies a live sibling's agent from its backend record", async () => {
    // Same gap on the other axis: a snapshot written before `launchAgentId`
    // existed can only be recognized as an agent through the live record.
    const ctx = makeContext({
      backendTerminalMap: new Map([
        ["alive", backend("alive", { kind: "agent", launchAgentId: "codex" })],
      ]),
    });

    await restorePanelsPhase(
      [
        panel("alive", { kind: "terminal", title: "Terminal", launchAgentId: undefined }),
        codexPanel("cold"),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("cold")).toBe(false);
  });

  it("elects one owner when two panes carry the same session id", async () => {
    // The state the original collision leaves behind: both panes reopened one
    // conversation, so the next quit captured that one id into both snapshots.
    // Replaying both would put two writers on one transcript.
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("older", { agentSessionId: "dupe", lastActiveAt: 1 }),
        codexPanel("newer", { agentSessionId: "dupe", lastActiveAt: 9 }),
      ],
      ctx
    );

    expect(Object.fromEntries(sessionAllowanceById(ctx))).toEqual({ older: false, newer: true });
    // The loser must not fall through to resume-latest either — in this directory
    // that resolves to the very session the owner is replaying.
    expect(allowanceById(ctx).get("older")).toBe(false);
  });

  it("elects one owner for an agent that has no resume-latest fallback", async () => {
    // Goose resumes by session id but ships no resume-latest args, so it never
    // reaches the capability probe's side of the pre-pass. Duplicate ids still
    // have to be deduped — moving that probe ahead of the exact-id branch would
    // silently exempt every such agent.
    const goosePanel = (id: string, lastActiveAt: number): TerminalState =>
      panel(id, { kind: "agent", launchAgentId: "goose", agentSessionId: "dupe", lastActiveAt });
    const ctx = makeContext();

    await restorePanelsPhase([goosePanel("older", 1), goosePanel("newer", 9)], ctx);

    expect(Object.fromEntries(sessionAllowanceById(ctx))).toEqual({ older: false, newer: true });
  });

  it("gives a live PTY outright ownership of the session id it is attached to", async () => {
    // Ranking is meaningless against a pane that is writing to the transcript
    // right now, and the cold holder loses even though it is the only snapshot
    // contending for that id.
    const ctx = makeContext({
      backendTerminalMap: new Map([
        [
          "alive",
          backend("alive", { kind: "agent", launchAgentId: "codex", agentSessionId: "dupe" }),
        ],
      ]),
    });

    await restorePanelsPhase(
      [
        codexPanel("alive", { agentSessionId: "dupe", lastActiveAt: 1 }),
        codexPanel("cold", { agentSessionId: "dupe", lastActiveAt: 900 }),
      ],
      ctx
    );

    expect(sessionAllowanceById(ctx).get("cold")).toBe(false);
    expect(allowanceById(ctx).get("cold")).toBe(false);
  });

  it("claims a reconnecting pane's scope under the agent its live record names", async () => {
    // Reconnect resolves identity live-first, so a stale snapshot agent id would
    // claim a scope this pane is not in and leave the one it IS in open.
    const ctx = makeContext({
      backendTerminalMap: new Map([
        ["alive", backend("alive", { kind: "agent", launchAgentId: "claude" })],
      ]),
    });

    await restorePanelsPhase(
      [
        codexPanel("alive"),
        panel("cold-claude", { kind: "agent", launchAgentId: "claude" }),
        codexPanel("cold-codex"),
      ],
      ctx
    );

    expect(allowanceById(ctx).get("cold-claude")).toBe(false);
    expect(allowanceById(ctx).get("cold-codex")).toBe(true);
  });

  it("leaves distinct session ids alone", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("a", { agentSessionId: "sess-a" }),
        codexPanel("b", { agentSessionId: "sess-b" }),
      ],
      ctx
    );

    expect(Object.fromEntries(sessionAllowanceById(ctx))).toEqual({ a: true, b: true });
  });

  it("does not let a smoke-test pane consume a real pane's slot", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [codexPanel("smoke-1", { lastActiveAt: 900 }), codexPanel("real", { lastActiveAt: 1 })],
      ctx
    );

    expect(allowanceById(ctx).get("real")).toBe(true);
  });

  it("contends on projectRoot when panes carry no cwd", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        codexPanel("no-cwd-a", { cwd: undefined, lastActiveAt: 1 }),
        codexPanel("no-cwd-b", { cwd: undefined, lastActiveAt: 2 }),
      ],
      ctx
    );

    expect(Object.fromEntries(allowanceById(ctx))).toEqual({
      "no-cwd-a": false,
      "no-cwd-b": true,
    });
  });

  it("does not suppress panes of an agent that has no resume-latest fallback", async () => {
    const ctx = makeContext();

    await restorePanelsPhase(
      [
        panel("g1", { kind: "agent", launchAgentId: "goose" }),
        panel("g2", { kind: "agent", launchAgentId: "goose" }),
      ],
      ctx
    );

    // They fall through to a fresh launch individually; no slot to contend for.
    expect(allowanceById(ctx).get("g1")).toBe(true);
    expect(allowanceById(ctx).get("g2")).toBe(true);
  });

  it("does not make plain terminals contend for a slot", async () => {
    const ctx = makeContext();

    await restorePanelsPhase([panel("t1"), panel("t2")], ctx);

    expect(allowanceById(ctx).get("t1")).toBe(true);
    expect(allowanceById(ctx).get("t2")).toBe(true);
  });
});
