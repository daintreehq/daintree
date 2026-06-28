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

  describe("initializeBackendTier", () => {
    it("should set lastBackendTier to the provided value", () => {
      policy.initializeBackendTier("test-id", "background");

      expect(policy.getLastBackendTier("test-id")).toBe("background");
    });

    it("should not call setActivityTier on backend (only initializes frontend state)", async () => {
      const { terminalClient } = await import("@/clients");

      policy.initializeBackendTier("test-id", "background");

      expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    });

    it("should handle missing managed terminal gracefully", () => {
      mockDeps.getInstance = vi.fn(() => undefined);

      // Should not throw
      expect(() => {
        policy.initializeBackendTier("missing-id", "background");
      }).not.toThrow();

      // Should still set the tier in the map
      expect(policy.getLastBackendTier("missing-id")).toBe("background");
    });
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
