import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

const { wakeMock, setScrollbackRestoreErrorMock, clearScrollbackRestoreErrorMock } = vi.hoisted(
  () => ({
    wakeMock: vi.fn(),
    setScrollbackRestoreErrorMock: vi.fn(),
    clearScrollbackRestoreErrorMock: vi.fn(),
  })
);

vi.mock("@/clients", () => ({
  terminalClient: {
    wake: wakeMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      setScrollbackRestoreError: setScrollbackRestoreErrorMock,
      clearScrollbackRestoreError: clearScrollbackRestoreErrorMock,
    }),
  },
}));

import { TerminalRefreshTier } from "@/types";
import { TerminalWakeManager, type WakeManagerDeps } from "../TerminalWakeManager";
import type { ManagedTerminal } from "../types";

type MockManagedTerminal = Pick<
  ManagedTerminal,
  "terminal" | "isAltBuffer" | "lastAppliedTier" | "everWoken" | "wakeSynced"
> & {
  isOpened?: boolean;
  isAttaching?: boolean;
  isHibernated?: boolean;
  lastScrollbackRestoreError?: TerminalScrollbackRestoreError;
};

describe("TerminalWakeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setScrollbackRestoreErrorMock.mockReset();
    clearScrollbackRestoreErrorMock.mockReset();
  });

  it("returns false when wake request fails instead of rejecting", async () => {
    wakeMock.mockRejectedValueOnce(new Error("wake failed"));
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    await expect(manager.wakeAndRestore("term-1")).resolves.toEqual({
      ok: false,
      replayedMainBuffer: false,
    });
  });

  it("allows retry after a failed wakeAndRestore call", async () => {
    wakeMock.mockRejectedValue(new Error("wake failed"));
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    await manager.wakeAndRestore("term-2");
    await manager.wakeAndRestore("term-2");

    expect(wakeMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent wakeAndRestore calls per terminal", async () => {
    let resolveWake!: (value: { state: string }) => void;
    const wakePromise = new Promise<{ state: string }>((resolve) => {
      resolveWake = resolve;
    });
    wakeMock.mockReturnValue(wakePromise);

    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const first = manager.wakeAndRestore("term-3");
    const second = manager.wakeAndRestore("term-3");
    expect(wakeMock).toHaveBeenCalledTimes(1);

    resolveWake({ state: "serialized-state" });

    await expect(first).resolves.toEqual({ ok: true, replayedMainBuffer: true });
    await expect(second).resolves.toEqual({ ok: true, replayedMainBuffer: true });
    expect(deps.restoreFromSerialized).toHaveBeenCalledTimes(1);
  });

  it("does not replay a serialized snapshot into a live alt-screen TUI; resyncs via redraw (#10807)", async () => {
    // Regression: bdf7d6f01 (#9894) deleted the alt-buffer early-return so
    // alt-screen wakes replayed the host snapshot via reset()+write, which
    // mangles the live TUI's absolutely-positioned frame. The snapshot must
    // never be replayed into a live alt buffer; the pane resyncs through a
    // forced SIGWINCH redraw (resyncAltBufferOnWake) instead.
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const resyncAltBufferOnWake = vi.fn();
    const refresh = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh, hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      resyncAltBufferOnWake,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt");

    // No reset()+replay; resolve replayedMainBuffer:false so the policy FLUSHES
    // the held bytes (the forced repaint supersedes them) rather than treating
    // the snapshot as authoritative and discarding them.
    expect(result).toEqual({ ok: true, replayedMainBuffer: false });
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(resyncAltBufferOnWake).toHaveBeenCalledTimes(1);
    expect(resyncAltBufferOnWake).toHaveBeenCalledWith("term-alt");
    expect(managed.wakeSynced).toBe(true);
    expect(managed.everWoken).toBe(true);
  });

  it("resyncs an alt-screen wake with no serialized state via redraw, not a stale decline (#10807/#9894)", async () => {
    // With the alt-buffer branch ahead of the !state check, a null snapshot no
    // longer declines and strands the pane (the old #9894 hazard) — an alt pane
    // is resynced by a forced redraw whether or not the host had a snapshot.
    wakeMock.mockResolvedValueOnce({ state: null });
    const onDeclined = vi.fn();
    const resyncAltBufferOnWake = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: true,
      everWoken: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      onDeclined,
      resyncAltBufferOnWake,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt-null-state");

    expect(result).toEqual({ ok: true, replayedMainBuffer: false });
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
    expect(resyncAltBufferOnWake).toHaveBeenCalledTimes(1);
    // No data-loss marker and no decline retry: the redraw resynced the pane.
    expect(onDeclined).not.toHaveBeenCalled();
    expect(manager.hasPendingWake("term-alt-null-state")).toBe(false);

    manager.dispose();
  });

  it("declines a main-buffer wake with no serialized state so it retries (#9894/#10309)", async () => {
    // Main-buffer panes keep the original anti-stale contract: a previously
    // woken pane whose snapshot vanished declines (ok:false) and schedules a
    // retry so it resyncs once the host has a snapshot. Alt panes take the
    // redraw branch above instead — this locks that divergence.
    wakeMock.mockResolvedValue({ state: null });
    const onDeclined = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
      everWoken: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      onDeclined,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-main-null-state");

    expect(result).toEqual({ ok: false, replayedMainBuffer: false });
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    // A previously-woken main-buffer pane schedules a decline retry (no marker
    // — genuine host drops surface via the OSC 57301 path, not wake-decline).
    expect(manager.hasPendingWake("term-main-null-state")).toBe(true);
    expect(onDeclined).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("declines an alt-screen wake when a selection starts during the wake await (#10807)", async () => {
    // hasSelection() is false at entry (clears the pre-await guard) but true
    // once the host wake resolves. The resize-driven repaint would disrupt the
    // drag-select, so the alt branch declines + schedules a retry rather than
    // nudging — mirroring the main-buffer mid-wake selection guard.
    let selectionActive = false;
    wakeMock.mockImplementationOnce(async () => {
      selectionActive = true;
      return { state: "serialized-state" };
    });
    const resyncAltBufferOnWake = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => selectionActive) } as any,
      isAltBuffer: true,
      everWoken: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      resyncAltBufferOnWake,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt-sel");

    expect(result).toEqual({ ok: false, replayedMainBuffer: false });
    expect(resyncAltBufferOnWake).not.toHaveBeenCalled();
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(managed.wakeSynced).toBe(false);
    expect(manager.hasPendingWake("term-alt-sel")).toBe(true);

    manager.dispose();
  });

  it("redraws an alt-screen pane even when the host reports no change (alt branch precedes the noChange skip) (#10807)", async () => {
    // A wakeSynced alt pane can get { noChange: true } from the host. The alt
    // branch sits BEFORE the noChange skip so the repaint nudge still fires —
    // otherwise a stale/corrupted alt frame could be silently skipped.
    wakeMock.mockResolvedValueOnce({ state: null, noChange: true });
    const resyncAltBufferOnWake = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: true,
      wakeSynced: true,
      everWoken: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      resyncAltBufferOnWake,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt-nochange");

    expect(result).toEqual({ ok: true, replayedMainBuffer: false });
    expect(resyncAltBufferOnWake).toHaveBeenCalledTimes(1);
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
  });

  it("restores serialized state for non-alt-screen terminals", async () => {
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-normal");

    expect(result).toEqual({ ok: true, replayedMainBuffer: true });
    expect(deps.restoreFromSerialized).toHaveBeenCalledWith("term-normal", "serialized-state");
  });

  it("treats a noChange wake as a successful no-op: no replay, held bytes still flush", async () => {
    wakeMock.mockResolvedValueOnce({ state: null, noChange: true });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      wakeSynced: true,
    };
    const onDeclined = vi.fn();
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      onDeclined,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-nochange");

    // replayedMainBuffer false: the pane was not reset+replayed, so bytes held
    // while backgrounded must still be flushed by the caller (#9910 contract).
    expect(result).toEqual({ ok: true, replayedMainBuffer: false });
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
    // Not a decline: no marker, no retry sequence, sync claim retained.
    expect(onDeclined).not.toHaveBeenCalled();
    expect(manager.hasPendingWake("term-nochange")).toBe(false);
    expect(managed.wakeSynced).toBe(true);
  });

  it("asserts canSkipUnchanged only while the pane holds its last applied sync", async () => {
    wakeMock.mockResolvedValue({ state: "serialized-state" });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    // Fresh instance: no sync claim yet.
    await manager.wakeAndRestore("term-skip");
    expect(wakeMock).toHaveBeenLastCalledWith("term-skip", { canSkipUnchanged: false });
    // The successful replay establishes the claim for the next wake.
    expect(managed.wakeSynced).toBe(true);

    await manager.wakeAndRestore("term-skip");
    expect(wakeMock).toHaveBeenLastCalledWith("term-skip", { canSkipUnchanged: true });
  });

  it("drops the sync claim when the replay fails so the next wake forces a serialize", async () => {
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      wakeSynced: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => false),
      restoreFromSerializedIncremental: vi.fn(async () => false),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-fail");

    expect(result).toEqual({ ok: false, replayedMainBuffer: false });
    expect(managed.wakeSynced).toBe(false);
  });

  it("fails wake for non-alt-screen terminals when serialized state is missing", async () => {
    wakeMock.mockResolvedValueOnce({ state: null });
    const onDeclined = vi.fn();
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
      onDeclined,
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-normal-null-state");

    expect(result).toEqual({ ok: false, replayedMainBuffer: false });
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
    // #10309: a never-restored terminal (everWoken absent) draws no marker and
    // schedules no retry — the null snapshot is a clean no-op, not a data gap.
    expect(onDeclined).not.toHaveBeenCalled();
    expect(manager.hasPendingWake("term-normal-null-state")).toBe(false);

    manager.dispose();
  });

  it("does not claim a main-buffer replay when the instance was replaced mid-wake", async () => {
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const original: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    const replacement: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    let current = original;
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => current as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => {
        // LRU eviction + respawn under the same id while the replay runs.
        current = replacement;
        return true;
      }),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-swapped");

    // The replay landed in a stale terminal — claiming replayedMainBuffer
    // would make callers discard the replacement's held bytes.
    expect(result).toEqual({ ok: true, replayedMainBuffer: false });
    expect(original.terminal.refresh).not.toHaveBeenCalled();
    expect(replacement.terminal.refresh).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping wake() triggers while restore is in flight", async () => {
    let resolveWake!: (value: { state: string }) => void;
    const wakePromise = new Promise<{ state: string }>((resolve) => {
      resolveWake = resolve;
    });
    wakeMock.mockReturnValue(wakePromise);

    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    manager.wake("term-4");
    manager.wake("term-4");

    expect(wakeMock).toHaveBeenCalledTimes(1);

    resolveWake({ state: "serialized-state" });
    await wakePromise;
  });

  describe("rate-limit coalescing (#8562)", () => {
    function makeDeps(managed: MockManagedTerminal): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("schedules a trailing-edge wake when called inside the rate-limit window", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        // First wake fires immediately
        manager.wake("term-rl-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Allow first wake to resolve and record lastWakeTime
        await vi.advanceTimersByTimeAsync(0);

        // Second wake within rate-limit window MUST NOT be dropped silently —
        // it schedules a trailing-edge timer for the end of the window.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-rl-1");
        // Trailing-edge timer hasn't fired yet
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Advance past the window and the trailing wake fires
        await vi.advanceTimersByTimeAsync(1000);
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("collapses repeated calls inside the window to a single trailing wake", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-2");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Three more calls during the window — should collapse to one trailing
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");

        expect(wakeMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1500);
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels pending rate-limited wake when clearWakeState is called", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-3");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-rl-3");

        // Clear state cancels the pending trailing wake
        manager.clearWakeState("term-rl-3");

        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispose cancels all pending rate-limited wakes", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-4");
        await vi.advanceTimersByTimeAsync(0);
        manager.wake("term-rl-5");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-4");
        manager.wake("term-rl-5");

        manager.dispose();

        await vi.advanceTimersByTimeAsync(2000);
        // No additional wakes fired after dispose
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancelPendingWake (#9906)", () => {
    function makeDeps(managed: MockManagedTerminal, hasInstance = true): WakeManagerDeps {
      return {
        getInstance: vi.fn(() =>
          hasInstance ? (managed as unknown as ManagedTerminal) : undefined
        ),
        hasInstance: vi.fn(() => hasInstance),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("stops a trailing-edge rate-limited wake from firing its IPC", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        // First wake fires immediately and records lastWakeTime.
        manager.wake("term-cancel-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Second wake inside the window schedules a trailing-edge timer.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-cancel-1");
        expect(manager.hasPendingWake("term-cancel-1")).toBe(true);

        // The terminal is backgrounded: cancel the pending wake before it fires.
        manager.cancelPendingWake("term-cancel-1");
        expect(manager.hasPendingWake("term-cancel-1")).toBe(false);

        // Advancing past the window must NOT fire the cancelled trailing wake —
        // this is the stale `wake-terminal` IPC the fix prevents.
        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels an instance-retry pending wake", () => {
      vi.useFakeTimers();
      try {
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        // No instance yet → wake() schedules a retry.
        const manager = new TerminalWakeManager(makeDeps(managed, false));

        manager.wake("term-cancel-2");
        expect(manager.hasPendingWake("term-cancel-2")).toBe(true);

        manager.cancelPendingWake("term-cancel-2");
        expect(manager.hasPendingWake("term-cancel-2")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the rate-limit window (lastWakeTime) so a follow-up wake still coalesces", async () => {
      // Unlike clearWakeState, cancelPendingWake must NOT reset lastWakeTime —
      // a quick background→foreground within the 1s window should still be
      // rate-limited (scheduled as trailing), not fire a fresh wake immediately.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-cancel-3");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Schedule a trailing wake, then cancel it (background transition).
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-cancel-3");
        manager.cancelPendingWake("term-cancel-3");
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Foreground again still inside the original 1s window: because
        // lastWakeTime survived, this must coalesce into a trailing wake rather
        // than fire immediately.
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-cancel-3");
        expect(wakeMock).toHaveBeenCalledTimes(1);
        expect(manager.hasPendingWake("term-cancel-3")).toBe(true);

        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("background guard on scheduled wake (#9906)", () => {
    it("does not fire a trailing-edge wake if the terminal is backgrounded when the timer fires", async () => {
      // Covers the hysteresis window: the wake was scheduled before the user
      // backgrounded the pane, and the debounced BACKGROUND tier apply (which
      // calls cancelPendingWake) hasn't run yet — but backgroundedTerminals is
      // already true. The timer must check it and skip the stale IPC.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        let backgrounded = false;
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const deps: WakeManagerDeps = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
          hasInstance: vi.fn(() => true),
          restoreFromSerialized: vi.fn(() => true),
          restoreFromSerializedIncremental: vi.fn(async () => true),
          isBackgrounded: () => backgrounded,
        };
        const manager = new TerminalWakeManager(deps);

        manager.wake("term-bg-guard");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Schedule a trailing wake, then background the pane before it fires.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-bg-guard");
        backgrounded = true;

        await vi.advanceTimersByTimeAsync(2000);
        // The trailing wake's IPC was suppressed by the background guard.
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips an instance-retry wake that resolves while backgrounded", () => {
      vi.useFakeTimers();
      try {
        let hasInstance = false;
        let backgrounded = false;
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const deps: WakeManagerDeps = {
          getInstance: vi.fn(() =>
            hasInstance ? (managed as unknown as ManagedTerminal) : undefined
          ),
          hasInstance: vi.fn(() => hasInstance),
          restoreFromSerialized: vi.fn(() => true),
          restoreFromSerializedIncremental: vi.fn(async () => true),
          isBackgrounded: () => backgrounded,
        };
        const manager = new TerminalWakeManager(deps);

        // No instance yet → schedules a retry.
        manager.wake("term-retry-bg");
        // The instance appears but the pane is backgrounded before the retry.
        hasInstance = true;
        backgrounded = true;

        vi.advanceTimersByTime(500);
        expect(wakeMock).not.toHaveBeenCalled();

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("hasInFlightWake", () => {
    it("is true only while a wakeAndRestore is in flight", async () => {
      let resolveWake!: (value: { state: string }) => void;
      wakeMock.mockReturnValue(
        new Promise<{ state: string }>((resolve) => {
          resolveWake = resolve;
        })
      );
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      };
      const deps: WakeManagerDeps = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
      const manager = new TerminalWakeManager(deps);

      expect(manager.hasInFlightWake("term-if")).toBe(false);

      const wake = manager.wakeAndRestore("term-if");
      expect(manager.hasInFlightWake("term-if")).toBe(true);

      resolveWake({ state: "serialized-state" });
      await wake;
      // The in-flight entry is removed in a finally on the wake promise —
      // give that continuation one microtask turn.
      await Promise.resolve();
      expect(manager.hasInFlightWake("term-if")).toBe(false);
    });
  });

  describe("hasPendingWake", () => {
    function makePendingDeps(hasInstance: boolean): WakeManagerDeps {
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      };
      return {
        getInstance: vi.fn(() =>
          hasInstance ? (managed as unknown as ManagedTerminal) : undefined
        ),
        hasInstance: vi.fn(() => hasInstance),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("reflects a rate-limit-coalesced wake until it fires", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const manager = new TerminalWakeManager(makePendingDeps(true));

        manager.wake("term-pw");
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.hasPendingWake("term-pw")).toBe(false);

        // Second wake inside the 1s rate-limit window is coalesced.
        manager.wake("term-pw");
        expect(manager.hasPendingWake("term-pw")).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);
        expect(manager.hasPendingWake("term-pw")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reflects an instance-retry wake", () => {
      vi.useFakeTimers();
      try {
        const manager = new TerminalWakeManager(makePendingDeps(false));

        manager.wake("term-pr");
        expect(manager.hasPendingWake("term-pr")).toBe(true);

        manager.clearWakeState("term-pr");
        expect(manager.hasPendingWake("term-pr")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("replay failure surfaces classified error (#9896)", () => {
    const longState = "x".repeat(2_000_000); // > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes

    function makeFailureDeps(
      managed: MockManagedTerminal,
      options: {
        smallOk: boolean;
        incrementalOk: boolean;
      }
    ): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => options.smallOk),
        restoreFromSerializedIncremental: vi.fn(async () => options.incrementalOk),
      };
    }

    it("returns false and publishes the classified error to the panel store on small-path replay failure", async () => {
      wakeMock.mockResolvedValueOnce({ state: "small-state" });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "parse",
        message: "Parser error at offset 0",
        timestamp: 123,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-small");

      expect(result).toEqual({ ok: false, replayedMainBuffer: false });
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-fail-small", restoreError);
      // The buffer refresh that success would perform is skipped on failure.
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
    });

    it("returns false and publishes the classified error on incremental-path replay failure", async () => {
      wakeMock.mockResolvedValueOnce({ state: longState });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "timeout",
        message: "Write timeout",
        timestamp: 456,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: false })
      );

      const result = await manager.wakeAndRestore("term-fail-incr");

      expect(result).toEqual({ ok: false, replayedMainBuffer: false });
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-fail-incr", restoreError);
    });

    it("does not call setScrollbackRestoreError when the restore succeeds", async () => {
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-success");

      expect(result).toEqual({ ok: true, replayedMainBuffer: true });
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
      expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    });

    it("returns false without touching the panel store if no classified error was stashed", async () => {
      // Defensive: a restore method returning false with no lastScrollbackRestoreError
      // shouldn't crash or publish a banner — just fail the wake.
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-no-error");

      expect(result).toEqual({ ok: false, replayedMainBuffer: false });
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    });

    it("does not record lastWakeTime when the wake fails (rate limit window stays open)", async () => {
      // A failed wake must return false so the upstream triggerWake callback
      // deletes any stale lastWakeTime entry, letting a follow-up wake fire
      // immediately (no rate-limit coalescing for a known-failed replay).
      // We verify the boolean return is what triggerWake observes, not the
      // private lastWakeTime map (which is implementation detail).
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const restoreError: TerminalScrollbackRestoreError = {
          type: "error",
          message: "boom",
          timestamp: 1,
        };
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          lastScrollbackRestoreError: restoreError,
        };
        const restoreFn = vi.fn(() => false);
        const deps: WakeManagerDeps = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
          hasInstance: vi.fn(() => true),
          restoreFromSerialized: restoreFn,
          restoreFromSerializedIncremental: vi.fn(async () => true),
        };
        const manager = new TerminalWakeManager(deps);

        const first = manager.wakeAndRestore("term-rate-fail");
        await vi.advanceTimersByTimeAsync(0);
        const firstResult = await first;
        expect(firstResult.ok).toBe(false); // signals failure to triggerWake

        // Second wake fires immediately (no rate-limit coalescing) because
        // triggerWake observed `false` and did not record lastWakeTime.
        const second = manager.wakeAndRestore("term-rate-fail");
        await vi.advanceTimersByTimeAsync(0);
        await second;
        expect(restoreFn).toHaveBeenCalledTimes(2);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears any prior banner on successful restore (recovery without manual dismiss)", async () => {
      // Mirror of hydration's retry path (#8535): a previous failed wake may
      // have left a banner in the panel store. Once the wake succeeds, the
      // banner must be cleared so the user doesn't see a stale error after
      // the replay has recovered.
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-recover");

      expect(result).toEqual({ ok: true, replayedMainBuffer: true });
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
      expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-recover");
    });

    it("does not clear a banner when the wake fails (failure is preserved)", async () => {
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "parse",
        message: "Parser error",
        timestamp: 1,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-no-clear");

      expect(result).toEqual({ ok: false, replayedMainBuffer: false });
      expect(clearScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("declined-wake retry (#9894)", () => {
    type SelectionMock = ReturnType<typeof vi.fn>;

    function makeDeclineDeps(
      managed: MockManagedTerminal,
      onDeclined?: (id: string) => void
    ): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
        onDeclined,
      };
    }

    function makeManaged(hasSelection: SelectionMock): MockManagedTerminal {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection } as any,
        isAltBuffer: false,
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        // #10309: these tests exercise the genuine "previously restored, now
        // woke with no snapshot" path (retry without marker). everWoken marks
        // the terminal as having successfully restored before. A fresh terminal
        // (everWoken absent) would instead short-circuit to a silent no-op.
        everWoken: true,
      };
    }

    it("retries a selection-guarded decline and resyncs once the selection clears", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        // Selection held on the initial wake, released by the time the retry runs.
        const hasSelection = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
        const onDeclined = vi.fn();
        const managed = makeManaged(hasSelection);
        const deps = makeDeclineDeps(managed, onDeclined);
        const manager = new TerminalWakeManager(deps);

        const first = await manager.wakeAndRestore("term-decline-sel");
        expect(first).toEqual({ ok: false, replayedMainBuffer: false });
        // The selection guard fires before the wake IPC — no snapshot fetched.
        expect(wakeMock).not.toHaveBeenCalled();
        // No marker for a selection decline — it would write into the terminal
        // the guard is protecting.
        expect(onDeclined).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);
        // Retry ran with the selection cleared: snapshot fetched and replayed.
        expect(wakeMock).toHaveBeenCalledTimes(1);
        expect(deps.restoreFromSerialized).toHaveBeenCalledWith(
          "term-decline-sel",
          "serialized-state"
        );

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries a previously-restored terminal's null-state decline up to the cap without a marker (#10309)", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const onDeclined = vi.fn();
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed, onDeclined));

        const first = await manager.wakeAndRestore("term-decline-null");
        expect(first).toEqual({ ok: false, replayedMainBuffer: false });
        // #10309: the wake-decline path never draws the data-loss marker — a
        // genuine host-side drop surfaces through the OSC 57301 path instead.
        expect(onDeclined).not.toHaveBeenCalled();
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Three bounded retries, each 300ms apart, then the sequence stops.
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(300);
        expect(wakeMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries

        // No further retries after the cap.
        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(4);
        expect(onDeclined).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying once a retry resyncs the pane", async () => {
      vi.useFakeTimers();
      try {
        // Null on the initial wake, snapshot available on the retry.
        wakeMock.mockResolvedValueOnce({ state: null }).mockResolvedValue({
          state: "serialized-state",
        });
        const onDeclined = vi.fn();
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed, onDeclined));

        await manager.wakeAndRestore("term-decline-recover");
        // #10309: no marker drawn from the wake-decline path.
        expect(onDeclined).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);
        expect(wakeMock).toHaveBeenCalledTimes(2); // initial + 1 retry that succeeded

        // The successful retry ends the sequence — no further attempts.
        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(2);
        expect(onDeclined).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry into a re-backgrounded terminal", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed));

        await manager.wakeAndRestore("term-decline-bg");
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Pane re-backgrounded before the retry fires — the tier-transition
        // wake will handle it when it returns to active.
        managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clearWakeState cancels a pending decline retry", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed));

        await manager.wakeAndRestore("term-decline-clear");
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.clearWakeState("term-decline-clear");

        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispose cancels a pending decline retry", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed));

        await manager.wakeAndRestore("term-decline-dispose");
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();

        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a pending decline retry via hasPendingWake (watchdog flush guard)", async () => {
      // The reconciliation watchdog gates its stalled-bytes flush on
      // !hasPendingWake. A pending decline retry will reset the terminal on
      // replay, so the flush must wait — hasPendingWake must report it.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed));

        expect(manager.hasPendingWake("term-decline-pending")).toBe(false);

        await manager.wakeAndRestore("term-decline-pending");
        expect(manager.hasPendingWake("term-decline-pending")).toBe(true);

        manager.clearWakeState("term-decline-pending");
        expect(manager.hasPendingWake("term-decline-pending")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending decline retry when a direct wakeAndRestore later succeeds", async () => {
      // RendererPolicy / visibility-restore wakes call wakeAndRestore directly,
      // bypassing triggerWake. A success there must cancel the leftover decline
      // timer so it doesn't fire a redundant reset on the active pane.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValueOnce({ state: null }).mockResolvedValue({
          state: "serialized-state",
        });
        const managed = makeManaged(vi.fn(() => false));
        const manager = new TerminalWakeManager(makeDeclineDeps(managed));

        await manager.wakeAndRestore("term-decline-direct");
        expect(manager.hasPendingWake("term-decline-direct")).toBe(true);

        // A direct wake (e.g. from RendererPolicy) succeeds before the retry.
        const result = await manager.wakeAndRestore("term-decline-direct");
        expect(result).toEqual({ ok: true, replayedMainBuffer: true });
        expect(manager.hasPendingWake("term-decline-direct")).toBe(false);

        // The leftover decline timer must not fire another wake.
        await vi.advanceTimersByTimeAsync(900);
        expect(wakeMock).toHaveBeenCalledTimes(2); // initial null + direct success
      } finally {
        vi.useRealTimers();
      }
    });

    it("exhausts selection retries silently when the selection is held throughout", async () => {
      // Documented tradeoff: while a selection is held the guard never fetches
      // or replays a snapshot (it would destroy the selection), and no marker is
      // drawn (it would write into the guarded terminal). The pane re-wakes on
      // the next tier transition; the bounded retries just give up quietly.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const onDeclined = vi.fn();
        const managed = makeManaged(vi.fn(() => true)); // selection held forever
        const manager = new TerminalWakeManager(makeDeclineDeps(managed, onDeclined));

        await manager.wakeAndRestore("term-decline-stuck");
        // Run out the full retry budget.
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(900);

        // Selection guard returns before the wake IPC, so no snapshot is ever
        // fetched and no marker is drawn.
        expect(wakeMock).not.toHaveBeenCalled();
        expect(onDeclined).not.toHaveBeenCalled();
        expect(manager.hasPendingWake("term-decline-stuck")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("fresh vs. restored null-state wake (#10309)", () => {
    function makeDeps(
      managed: MockManagedTerminal,
      onDeclined: (id: string) => void,
      restoreOk = true
    ): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => restoreOk),
        restoreFromSerializedIncremental: vi.fn(async () => restoreOk),
        onDeclined,
      };
    }

    it("treats a fresh terminal's null-state wake as a clean no-op (no marker, no retry)", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: null });
        const onDeclined = vi.fn();
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          // everWoken absent — this terminal has never successfully restored.
        };
        const manager = new TerminalWakeManager(makeDeps(managed, onDeclined));

        const result = await manager.wakeAndRestore("term-fresh");

        expect(result).toEqual({ ok: false, replayedMainBuffer: false });
        expect(onDeclined).not.toHaveBeenCalled();
        expect(manager.hasPendingWake("term-fresh")).toBe(false);

        // No retry ever fires for the fresh no-op path.
        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries (no marker) once a terminal that previously restored later wakes with no snapshot", async () => {
      vi.useFakeTimers();
      try {
        // First wake returns a snapshot and restores successfully → everWoken set.
        // Second wake returns null → genuine lost snapshot for a restored pane.
        wakeMock
          .mockResolvedValueOnce({ state: "serialized-state" })
          .mockResolvedValue({ state: null });
        const onDeclined = vi.fn();
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          lastAppliedTier: TerminalRefreshTier.FOCUSED,
        };
        const manager = new TerminalWakeManager(makeDeps(managed, onDeclined));

        const firstResult = await manager.wakeAndRestore("term-restored");
        expect(firstResult).toEqual({ ok: true, replayedMainBuffer: true });
        expect(managed.everWoken).toBe(true);

        const secondResult = await manager.wakeAndRestore("term-restored");
        expect(secondResult).toEqual({ ok: false, replayedMainBuffer: false });
        // A restored pane that loses its snapshot retries, but draws no marker.
        expect(onDeclined).not.toHaveBeenCalled();
        expect(manager.hasPendingWake("term-restored")).toBe(true);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("sets everWoken only on a successful restore, not merely on a non-null wake return", async () => {
      // A wake that returns a snapshot but fails to replay it must NOT mark the
      // terminal as restored — the gate keys on a landed restore, not the IPC
      // return. A later null-state wake then stays a silent no-op.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
        const onDeclined = vi.fn();
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          lastScrollbackRestoreError: { type: "parse", message: "boom", timestamp: 1 },
        };
        const manager = new TerminalWakeManager(makeDeps(managed, onDeclined, false));

        const result = await manager.wakeAndRestore("term-restore-failed");
        expect(result).toEqual({ ok: false, replayedMainBuffer: false });
        expect(managed.everWoken).toBeFalsy();

        // A subsequent null-state wake is treated as fresh: no marker, no retry.
        wakeMock.mockResolvedValue({ state: null });
        const second = await manager.wakeAndRestore("term-restore-failed");
        expect(second).toEqual({ ok: false, replayedMainBuffer: false });
        expect(onDeclined).not.toHaveBeenCalled();
        expect(manager.hasPendingWake("term-restore-failed")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats an empty-string snapshot as a no-op for a fresh terminal (falsy, not just null)", async () => {
      // serialize() returns "" for a fresh terminal; "" is falsy and must hit
      // the same fresh no-op path as null — no marker, no retry.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "" });
        const onDeclined = vi.fn();
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
        };
        const manager = new TerminalWakeManager(makeDeps(managed, onDeclined));

        const result = await manager.wakeAndRestore("term-empty-state");

        expect(result).toEqual({ ok: false, replayedMainBuffer: false });
        expect(onDeclined).not.toHaveBeenCalled();
        expect(manager.hasPendingWake("term-empty-state")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("sets everWoken on the incremental restore path, not just the small-state path", async () => {
      // A snapshot larger than the incremental threshold restores via
      // restoreFromSerializedIncremental; everWoken must be set there too.
      const longState = "x".repeat(2_000_000); // > indicatorThresholdBytes
      wakeMock.mockResolvedValueOnce({ state: longState });
      const onDeclined = vi.fn();
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const deps = makeDeps(managed, onDeclined);
      const manager = new TerminalWakeManager(deps);

      const result = await manager.wakeAndRestore("term-incremental");

      expect(result).toEqual({ ok: true, replayedMainBuffer: true });
      expect(deps.restoreFromSerializedIncremental).toHaveBeenCalledWith(
        "term-incremental",
        longState
      );
      expect(managed.everWoken).toBe(true);

      manager.dispose();
    });

    it("preserves everWoken across clearWakeState (lifetime flag, not per-wake)", async () => {
      // clearWakeState runs on tier transitions; it must not re-arm the
      // spurious-marker path. A restored terminal that is cleared and then
      // wakes with no snapshot still retries (no marker), not silent no-op.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
        const onDeclined = vi.fn();
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          lastAppliedTier: TerminalRefreshTier.FOCUSED,
        };
        const manager = new TerminalWakeManager(makeDeps(managed, onDeclined));

        const first = await manager.wakeAndRestore("term-clear-everwoken");
        expect(first).toEqual({ ok: true, replayedMainBuffer: true });
        expect(managed.everWoken).toBe(true);

        manager.clearWakeState("term-clear-everwoken");
        expect(managed.everWoken).toBe(true);

        wakeMock.mockResolvedValue({ state: null });
        const second = await manager.wakeAndRestore("term-clear-everwoken");
        expect(second).toEqual({ ok: false, replayedMainBuffer: false });
        expect(onDeclined).not.toHaveBeenCalled();
        // Still treated as previously-restored: retry scheduled, no marker.
        expect(manager.hasPendingWake("term-clear-everwoken")).toBe(true);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
