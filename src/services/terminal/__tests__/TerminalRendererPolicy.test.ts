import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

// Hibernation removed: a background→active (foreground) transition is a plain,
// SYNCHRONOUS repaint — applyDeferredResize → terminal.refresh → onPostWake →
// onResumeFlush. There is no wake/resync, no needsWake arming, no discard path,
// and no onBackgrounded callback. These tests assert the repaint-only behavior.
describe("TerminalRendererPolicy", () => {
  let policy: import("../TerminalRendererPolicy").TerminalRendererPolicy;
  let mockDeps: RendererPolicyDeps;
  let mockManagedTerminal: Partial<ManagedTerminal>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockManagedTerminal = {
      lastActiveTime: 0,
      lastAppliedTier: undefined,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
      tierChangeTimer: undefined,
      pendingTier: undefined,
      terminal: {
        refresh: vi.fn(),
        rows: 24,
        scrollToBottom: vi.fn(),
      } as unknown as ManagedTerminal["terminal"],
    };

    mockDeps = {
      getInstance: vi.fn(() => mockManagedTerminal as ManagedTerminal),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    policy = new TerminalRendererPolicy(mockDeps);
  });

  describe("background → active foreground transition (plain repaint)", () => {
    it("repaints (refresh + onPostWake + onResumeFlush) instead of waking", async () => {
      const onPostWake = vi.fn();
      const onResumeFlush = vi.fn();
      mockDeps.onPostWake = onPostWake;
      mockDeps.onResumeFlush = onResumeFlush;
      const terminal = mockManagedTerminal.terminal as unknown as {
        refresh: ReturnType<typeof vi.fn>;
      };

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      // Reconnected after a project switch: backend recorded as background.
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      policy.initializeBackendTier("test-id", "background");

      // FOCUSED (100) < BACKGROUND (1000) → an upgrade, applied immediately.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
      expect(onPostWake).toHaveBeenCalledWith("test-id");
      expect(onResumeFlush).toHaveBeenCalledWith("test-id");
      expect(policy.getLastBackendTier("test-id")).toBe("active");
    });

    it("does not repaint when the backend tier was already active", async () => {
      const onPostWake = vi.fn();
      const onResumeFlush = vi.fn();
      mockDeps.onPostWake = onPostWake;
      mockDeps.onResumeFlush = onResumeFlush;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      // Backend already active; a within-active tier change must not repaint.
      policy.initializeBackendTier("test-id", "active");
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onPostWake).not.toHaveBeenCalled();
      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("calls applyDeferredResize before terminal.refresh", async () => {
      const callOrder: string[] = [];
      const applyDeferredResize = vi.fn(() => {
        callOrder.push("applyDeferredResize");
        return true;
      });
      mockDeps.applyDeferredResize = applyDeferredResize;
      const terminal = mockManagedTerminal.terminal as unknown as {
        refresh: ReturnType<typeof vi.fn>;
      };
      terminal.refresh = vi.fn(() => {
        callOrder.push("refresh");
      });

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(applyDeferredResize).toHaveBeenCalledWith("test-id");
      expect(callOrder).toEqual(["applyDeferredResize", "refresh"]);
    });

    it("does not resend backend tier when switching within active renderer tiers", async () => {
      const { terminalClient } = await import("@/clients");

      policy.initializeBackendTier("test-id", "background");
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);
      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "active", 50);

      vi.clearAllMocks();
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BURST);

      // FOCUSED → BURST keeps tier=active and polling=50ms — both unchanged.
      expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    });

    it("seeds backend polling hint on the first apply even when tier matches default", async () => {
      const { terminalClient } = await import("@/clients");

      // First apply after mount: the provider resolves VISIBLE on the very
      // first read and `lastAppliedTier` is still undefined. The PTY host's
      // ActivityMonitor defaults to 50ms, so skipping `setActivityTier` here
      // would defeat the 200ms VISIBLE cadence. The policy must send the hint
      // anyway.
      mockManagedTerminal.lastAppliedTier = undefined;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.VISIBLE;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);

      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "active", 200);
      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    });

    it("does not re-send the polling hint on subsequent matching applies (idempotent)", async () => {
      const { terminalClient } = await import("@/clients");
      mockManagedTerminal.lastAppliedTier = undefined;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.VISIBLE;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);
      vi.clearAllMocks();

      // After the seed, lastAppliedTier === VISIBLE, so a second identical
      // apply hits the early return and skips IPC.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);

      expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    });
  });

  describe("onTierApplied callback", () => {
    it("fires immediately on upgrade to FOCUSED", async () => {
      const onTierApplied = vi.fn();
      mockDeps.onTierApplied = onTierApplied;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onTierApplied).toHaveBeenCalledWith(
        "test-id",
        TerminalRefreshTier.FOCUSED,
        mockManagedTerminal
      );
    });

    it("does not fire for no-op tier changes", async () => {
      const onTierApplied = vi.fn();
      mockDeps.onTierApplied = onTierApplied;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      // Same tier — should be a no-op, callback should not fire
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onTierApplied).not.toHaveBeenCalled();
    });
  });

  describe("flap-resolution flush (#9779)", () => {
    let onResumeFlush: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush as unknown as ((id: string) => void) | undefined;
      // The active-tier-supersede branch re-arms a downgrade timer via
      // window.setTimeout; the node test env has no window, so stub it.
      vi.stubGlobal("window", { setTimeout: vi.fn(() => 999), clearTimeout: vi.fn() });
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // A pending BACKGROUND downgrade is in flight (timer armed) and the computed
    // tier flaps back to the SAME active tier it left. This lands in the
    // equal-tier branch, which clears the timer without applying any tier change
    // — so without the fix the held bytes would never flush.
    it("flushes on the equal-tier flap-back (FOCUSED → BG-pending → FOCUSED)", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.pendingTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onResumeFlush).toHaveBeenCalledExactlyOnceWith("test-id");
    });

    // The computed tier flaps to a MORE active tier than the applied one while a
    // BACKGROUND downgrade is pending. This lands in the upgrade branch; the
    // applied tier was active throughout so applyRendererPolicyImmediate's own
    // flush branch (prevBackendTier !== "active") never fires.
    it("flushes on the upgrade flap (VISIBLE applied, BG-pending → FOCUSED)", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.pendingTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onResumeFlush).toHaveBeenCalledExactlyOnceWith("test-id");
    });

    // The pending BACKGROUND downgrade is superseded by a different active-tier
    // downgrade (FOCUSED → VISIBLE). The old held bytes must drain now rather
    // than waiting for the new tier's debounce timer to fire.
    it("flushes when an active-tier downgrade supersedes the BG-pending one", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.VISIBLE;
      mockManagedTerminal.pendingTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);

      expect(onResumeFlush).toHaveBeenCalledExactlyOnceWith("test-id");
    });

    it("does not flush when no BACKGROUND downgrade is pending", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.pendingTier = undefined;
      mockManagedTerminal.tierChangeTimer = undefined;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("does not flush when the pending downgrade targets a non-BACKGROUND tier", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.pendingTier = TerminalRefreshTier.VISIBLE;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("does not flush when the incoming tier is itself BACKGROUND", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.pendingTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);

      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("does not flush when a timer is armed but no tier is pending", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.pendingTier = undefined;
      mockManagedTerminal.tierChangeTimer = 999 as unknown as number;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(onResumeFlush).not.toHaveBeenCalled();
    });
  });

  // Uses real (faked) timers to prove the flush hook coexists with — and the
  // flap-back actually cancels — the armed downgrade timer. The sentinel-stub
  // block above checks the hook fires; this verifies the timer never fires.
  describe("flap-resolution timer cancellation (#9779)", () => {
    let onResumeFlush: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.useFakeTimers();
      onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush as unknown as ((id: string) => void) | undefined;
      // The implementation arms timers via window.setTimeout; point window at
      // the faked global timers so setTimeout/clearTimeout stay consistent.
      vi.stubGlobal("window", globalThis);
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("flushes once and cancels the armed timer so BACKGROUND never applies", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;

      // Computed tier drops to BACKGROUND: arms the real 500ms downgrade timer.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);
      expect(mockManagedTerminal.pendingTier).toBe(TerminalRefreshTier.BACKGROUND);
      expect(mockManagedTerminal.tierChangeTimer).not.toBeUndefined();
      expect(onResumeFlush).not.toHaveBeenCalled();

      // Flap back to FOCUSED before the timer fires.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);
      expect(onResumeFlush).toHaveBeenCalledExactlyOnceWith("test-id");
      expect(mockManagedTerminal.pendingTier).toBeUndefined();
      expect(mockManagedTerminal.tierChangeTimer).toBeUndefined();

      // Advancing past the hysteresis window must NOT apply BACKGROUND — the
      // timer was cancelled, so the applied tier stays FOCUSED.
      vi.advanceTimersByTime(1000);
      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect(onResumeFlush).toHaveBeenCalledTimes(1);
    });
  });

  describe("reassertActiveTier (watchdog repair)", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.stubGlobal("window", globalThis);
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("re-sends the active backend tier and runs the repaint path", async () => {
      const { terminalClient } = await import("@/clients");
      const onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      policy.initializeBackendTier("test-id", "background");

      policy.reassertActiveTier("test-id");

      expect(policy.getLastBackendTier("test-id")).toBe("active");
      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "active", 200);
      expect(onResumeFlush).toHaveBeenCalledWith("test-id");
    });

    it("no-ops when the backend tier is already active or the applied tier is BACKGROUND", () => {
      const onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush;

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      policy.initializeBackendTier("test-id", "active");
      policy.reassertActiveTier("test-id");
      expect(onResumeFlush).not.toHaveBeenCalled();

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      policy.initializeBackendTier("test-id", "background");
      policy.reassertActiveTier("test-id");
      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("no-ops while the view is suppressed (#12798)", async () => {
      const { terminalClient } = await import("@/clients");
      const onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush;
      mockDeps.isViewSuppressed = () => true;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      policy.initializeBackendTier("test-id", "background");
      policy.reassertActiveTier("test-id");

      expect(policy.getLastBackendTier("test-id")).toBe("background");
      expect(terminalClient.setActivityTier).not.toHaveBeenCalledWith("test-id", "active", 200);
      expect(onResumeFlush).not.toHaveBeenCalled();
    });

    it("cancels a pending hysteresis downgrade so the repair is not undone", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;

      // Arm a real BACKGROUND downgrade timer, then simulate a host-side
      // background rewrite landing while it is pending.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);
      expect(mockManagedTerminal.tierChangeTimer).not.toBeUndefined();
      policy.initializeBackendTier("test-id", "background");

      policy.reassertActiveTier("test-id");
      expect(mockManagedTerminal.pendingTier).toBeUndefined();
      expect(mockManagedTerminal.tierChangeTimer).toBeUndefined();

      // The stale timer must not fire and re-background the terminal.
      vi.advanceTimersByTime(1000);
      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect(policy.getLastBackendTier("test-id")).toBe("active");
    });
  });

  describe("cached project view (#12514)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Hysteresis timers are armed via window.setTimeout; point window at the
      // faked globals so the node env can run them.
      vi.stubGlobal("window", globalThis);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("clamps any requested tier to BACKGROUND and applies it without hysteresis", async () => {
      const { terminalClient } = await import("@/clients");
      const onTierApplied = vi.fn();
      mockDeps.onTierApplied = onTierApplied;
      mockDeps.isViewSuppressed = () => true;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

      // The write-burst path requests BURST on every chunk a cached agent
      // streams; it must land as BACKGROUND, not as a foreground upgrade.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BURST);

      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
      expect(mockManagedTerminal.tierChangeTimer).toBeUndefined();
      expect(onTierApplied).toHaveBeenCalledWith(
        "test-id",
        TerminalRefreshTier.BACKGROUND,
        mockManagedTerminal
      );
      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "background", 500);
    });

    it("cancels a pending foreground downgrade timer when the view is cached", async () => {
      let cached = false;
      mockDeps.isViewSuppressed = () => cached;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);
      expect(mockManagedTerminal.tierChangeTimer).toBeDefined();

      cached = true;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.VISIBLE);

      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
      expect(mockManagedTerminal.tierChangeTimer).toBeUndefined();
      expect(mockManagedTerminal.pendingTier).toBeUndefined();
      // The stale VISIBLE timer must not fire and re-promote the cached view.
      vi.advanceTimersByTime(1000);
      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
    });

    it("upgrades through the ordinary repaint path once the view is back", async () => {
      const { terminalClient } = await import("@/clients");
      let cached = true;
      const onResumeFlush = vi.fn();
      mockDeps.onResumeFlush = onResumeFlush;
      mockDeps.isViewSuppressed = () => cached;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);
      expect(policy.getLastBackendTier("test-id")).toBe("background");

      cached = false;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect(terminalClient.setActivityTier).toHaveBeenLastCalledWith("test-id", "active", 50);
      expect(onResumeFlush).toHaveBeenCalledWith("test-id");
    });

    it("reasserts background to the host even when its record says active", async () => {
      // A cold-created BACKGROUND pane records its backend tier as "active" on
      // purpose; replaying that record on cache would send "active".
      const { terminalClient } = await import("@/clients");
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
      policy.initializeBackendTier("test-id", "active");

      policy.reassertBackgroundTier("test-id");
      policy.reassertBackgroundTier("test-id");

      expect(vi.mocked(terminalClient.setActivityTier).mock.calls).toEqual([
        ["test-id", "background", 500],
        ["test-id", "background", 500],
      ]);
      expect(policy.getLastBackendTier("test-id")).toBe("background");
    });

    it("keeps downgrade hysteresis for a view that is not cached", async () => {
      mockDeps.isViewSuppressed = () => false;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);

      expect(mockManagedTerminal.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect(mockManagedTerminal.pendingTier).toBe(TerminalRefreshTier.BACKGROUND);
    });
  });

  describe("clearTierState", () => {
    it("should remove tier state for terminal", () => {
      policy.initializeBackendTier("test-id", "background");
      expect(policy.getLastBackendTier("test-id")).toBe("background");

      policy.clearTierState("test-id");

      expect(policy.getLastBackendTier("test-id")).toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("should clear all tier state", () => {
      policy.initializeBackendTier("test-1", "background");
      policy.initializeBackendTier("test-2", "active");

      policy.dispose();

      expect(policy.getLastBackendTier("test-1")).toBeUndefined();
      expect(policy.getLastBackendTier("test-2")).toBeUndefined();
    });
  });
});

function createManagedTerminal(
  overrides: Partial<ManagedTerminal> = {}
): ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } } {
  return {
    lastActiveTime: 0,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    pendingTier: undefined,
    tierChangeTimer: undefined,
    terminal: {
      refresh: vi.fn(),
      rows: 24,
    },
    ...overrides,
  } as ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } };
}

// Hibernation removed: the background→active transition is a synchronous plain
// repaint (refresh + onPostWake + onResumeFlush). There is no async wake, no
// wake-generation gating, and no discard path. These adversarial cases cover the
// tier-dedupe / hysteresis-timer machinery that stays, plus the repaint path.
describe("TerminalRendererPolicy adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("DISPOSE_CANCELS_PENDING_DOWNGRADE", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.dispose();
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    expect(deps.onTierApplied).not.toHaveBeenCalled();
    expect(managed.pendingTier).toBeUndefined();
    expect(managed.tierChangeTimer).toBeUndefined();
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("CLEAR_TIER_STATE_PREVENTS_STALE_FLIP", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.clearTierState("terminal-1");
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    expect(deps.onTierApplied).not.toHaveBeenCalled();
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("CHURN_COLLAPSES_TO_LAST_TIER", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalledWith("terminal-1", "background");
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    expect(deps.onTierApplied).toHaveBeenCalledTimes(1);
    expect(deps.onTierApplied).toHaveBeenCalledWith(
      "terminal-1",
      TerminalRefreshTier.VISIBLE,
      managed
    );
  });

  it("PER_TERMINAL_TIMERS_ISOLATED", async () => {
    const managedA = createManagedTerminal();
    const managedB = createManagedTerminal();
    const managedById = new Map<string, ManagedTerminal>([
      ["terminal-a", managedA],
      ["terminal-b", managedB],
    ]);
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn((id: string) => managedById.get(id)),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-a", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-b", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-a", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(1000);

    expect(managedA.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    expect(managedB.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("REBACKGROUND_AFTER_FOREGROUND_DOES_NOT_REPAINT_AGAIN", async () => {
    const managed = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onResumeFlush: vi.fn(),
      onPostWake: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    // BACKGROUND→FOCUSED repaints exactly once (synchronously).
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);
    expect(managed.terminal.refresh).toHaveBeenCalledTimes(1);
    expect(deps.onResumeFlush).toHaveBeenCalledTimes(1);

    vi.mocked(managed.terminal.refresh).mockClear();
    vi.mocked(deps.onResumeFlush!).mockClear();
    vi.mocked(deps.onPostWake!).mockClear();

    // Re-backgrounding (active→background) must NOT run the repaint/flush path —
    // that only fires on background→active.
    managed.getRefreshTier = () => TerminalRefreshTier.BACKGROUND;
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    vi.advanceTimersByTime(1000);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
    expect(deps.onPostWake).not.toHaveBeenCalled();
    expect(deps.onResumeFlush).not.toHaveBeenCalled();
  });

  it("HOST_PUSHED_BACKGROUND_REARMS_DEDUPE_SO_NEXT_ACTIVE_RESENDS", async () => {
    // Issue #9778 / lesson #8998 (same-tier no-op trap): when the PTY host
    // silently demotes a terminal to "background" via recomputeActivityTiers,
    // it pushes a tier-changed message that the renderer applies through
    // initializeBackendTier. That MUST re-arm the outbound dedupe baseline so a
    // subsequent "active" is actually resent to the host instead of being
    // dropped as a redundant same-tier call — which is exactly what left the
    // producer gate suppressing bytes while the pane looked active.
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const { terminalClient } = await import("@/clients");
    const policy = new TerminalRendererPolicy(deps);

    // Renderer's last outbound tier is "active".
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(1);

    // Re-sending "active" without any intervening change dedupes (proves the
    // trap exists — this is the no-op that would strand a host-demoted terminal).
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(1);

    // Host-pushed demotion arrives over the MessagePort and re-arms the baseline.
    policy.initializeBackendTier("terminal-1", "background");

    // Now the renderer reactivating sends a real "active" to the host again.
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(2);
    expect(terminalClient.setActivityTier).toHaveBeenLastCalledWith(
      "terminal-1",
      "active",
      undefined
    );
  });

  it("HOST_PUSHED_TIER_AND_RENDERER_CACHE_AGREE_AFTER_EACH_TRANSITION (#9798)", async () => {
    // Folded in from closed issue #9798. The renderer's cached view of the
    // backend tier (getLastBackendTier) must never diverge from the tier it
    // last agreed with the host on. Two directions of agreement:
    //   1. host→renderer: a host-pushed tier (initializeBackendTier, the
    //      tier-changed message from recomputeActivityTiers) is reflected by
    //      getLastBackendTier with no outbound call.
    //   2. renderer→host: a renderer-driven setBackendTier ships a value to
    //      the host that is byte-for-byte the same value getLastBackendTier
    //      then reports — the cache and the wire never disagree.
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const { terminalClient } = await import("@/clients");
    const policy = new TerminalRendererPolicy(deps);

    // host→renderer: a host demotion seeds the cache without an outbound call.
    policy.initializeBackendTier("terminal-1", "background");
    expect(policy.getLastBackendTier("terminal-1")).toBe("background");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();

    // renderer→host: the value sent to the host equals the value the cache
    // then reports — they agree, no divergence.
    policy.setBackendTier("terminal-1", "active");
    const sentTier = vi.mocked(terminalClient.setActivityTier).mock.calls.at(-1)?.[1];
    expect(sentTier).toBe(policy.getLastBackendTier("terminal-1"));
    expect(policy.getLastBackendTier("terminal-1")).toBe("active");
  });
});
