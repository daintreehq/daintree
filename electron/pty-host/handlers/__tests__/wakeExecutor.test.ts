import { describe, it, expect, vi } from "vitest";
import { createWakeExecutor, type WakeOutcome } from "../wakeExecutor.js";
import type { HostContext } from "../types.js";
import type { TerminalInfo } from "../../../services/pty/types.js";

function makeTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    contentEpoch: 0,
    ...overrides,
  } as unknown as TerminalInfo;
}

function makeCtx(terminal: TerminalInfo | undefined): HostContext {
  return {
    ptyManager: {
      getTerminal: vi.fn(() => terminal),
      setActivityMonitorTier: vi.fn(),
      getSerializedStateAsync: vi.fn(async () => "snapshot"),
      getSerializedState: vi.fn(() => "fallback"),
    } as unknown as HostContext["ptyManager"],
    backpressureManager: {
      getActivityTier: vi.fn(() => "active"),
      setActivityTier: vi.fn(),
      clearSuspended: vi.fn(),
      clearPendingVisual: vi.fn(),
      getPausedInterval: vi.fn(() => undefined),
      deletePausedInterval: vi.fn(),
      deletePauseStartTime: vi.fn(),
      emitTerminalStatus: vi.fn(),
      emitReliabilityMetric: vi.fn(),
    } as unknown as HostContext["backpressureManager"],
    getPauseCoordinator: vi.fn(() => undefined),
    rendererConnections: new Map(),
    windowProjectMap: new Map(),
  } as unknown as HostContext;
}

async function runWake(
  ctx: HostContext,
  opts?: Parameters<ReturnType<typeof createWakeExecutor>>[2]
): Promise<WakeOutcome> {
  const executeWake = createWakeExecutor(ctx);
  let outcome: WakeOutcome | undefined;
  await executeWake(
    "term-1",
    (o) => {
      outcome = o;
    },
    opts
  );
  expect(outcome).toBeDefined();
  return outcome!;
}

describe("wake executor no-change short-circuit", () => {
  it("skips serialization when the window's synced epoch matches the content epoch", async () => {
    const terminal = makeTerminal({
      contentEpoch: 5,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx, { windowId: 1, canSkipUnchanged: true });

    expect(outcome).toEqual({ state: null, warnings: undefined, noChange: true });
    expect(ctx.ptyManager.getSerializedStateAsync).not.toHaveBeenCalled();
    expect(ctx.ptyManager.getSerializedState).not.toHaveBeenCalled();
  });

  it("serializes when the renderer does not assert canSkipUnchanged, even with matching epochs", async () => {
    const terminal = makeTerminal({
      contentEpoch: 5,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx, { windowId: 1, canSkipUnchanged: false });

    expect(outcome.noChange).toBeUndefined();
    expect(outcome.state).toBe("snapshot");
    expect(ctx.ptyManager.getSerializedStateAsync).toHaveBeenCalledOnce();
  });

  it("serializes when bytes arrived since the window's last sync, then serve-marks the window", async () => {
    const terminal = makeTerminal({
      contentEpoch: 7,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
      pendingHeadlessWrites: 0,
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx, { windowId: 1, canSkipUnchanged: true });

    expect(outcome.state).toBe("snapshot");
    expect(outcome.noChange).toBeUndefined();
    // Served snapshot covers epoch 7 — the next unchanged wake can skip.
    expect(terminal.wakeSyncedEpochByWindow!.get(1)).toBe(7);
  });

  it("serializes for a different window than the one that synced", async () => {
    const terminal = makeTerminal({
      contentEpoch: 5,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx, { windowId: 2, canSkipUnchanged: true });

    expect(outcome.noChange).toBeUndefined();
    expect(outcome.state).toBe("snapshot");
  });

  it("does not serve-mark while headless writes are still pending parse", async () => {
    // The epoch counts an arrived-but-unparsed tail the snapshot may omit —
    // marking the window synced at this epoch would strand the tail behind a
    // future no-change skip.
    const terminal = makeTerminal({
      contentEpoch: 7,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
      pendingHeadlessWrites: 2,
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx, { windowId: 1, canSkipUnchanged: true });

    expect(outcome.state).toBe("snapshot");
    expect(terminal.wakeSyncedEpochByWindow!.get(1)).toBe(5);
  });

  it("captures the serve-mark epoch before serialization, not after", async () => {
    const terminal = makeTerminal({
      contentEpoch: 7,
      wakeSyncedEpochByWindow: new Map(),
      pendingHeadlessWrites: 0,
    });
    const ctx = makeCtx(terminal);
    vi.mocked(ctx.ptyManager.getSerializedStateAsync).mockImplementation(async () => {
      // Bytes arriving mid-serialize must keep the next wake conservative.
      terminal.contentEpoch = 9;
      return "snapshot";
    });

    await runWake(ctx, { windowId: 1, canSkipUnchanged: true });

    expect(terminal.wakeSyncedEpochByWindow!.get(1)).toBe(7);
    expect(terminal.wakeSyncedEpochByWindow!.get(1)).not.toBe(terminal.contentEpoch);
  });

  it("resumes a paused coordinator on the skip path", async () => {
    const terminal = makeTerminal({
      contentEpoch: 5,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
    });
    const ctx = makeCtx(terminal);
    const coordinator = { resume: vi.fn(), isPaused: false };
    vi.mocked(ctx.backpressureManager.getPausedInterval).mockReturnValue(
      setTimeout(() => {}, 60_000) as never
    );
    (ctx.getPauseCoordinator as ReturnType<typeof vi.fn>).mockReturnValue(coordinator);

    const outcome = await runWake(ctx, { windowId: 1, canSkipUnchanged: true });

    expect(outcome.noChange).toBe(true);
    expect(coordinator.resume).toHaveBeenCalledExactlyOnceWith("backpressure");
  });

  it("never reports noChange on the optionless (IPC) path", async () => {
    const terminal = makeTerminal({
      contentEpoch: 5,
      wakeSyncedEpochByWindow: new Map([[1, 5]]),
    });
    const ctx = makeCtx(terminal);

    const outcome = await runWake(ctx);

    expect(outcome.noChange).toBeUndefined();
    expect(outcome.state).toBe("snapshot");
  });
});
