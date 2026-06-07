import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

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
      needsWake: undefined,
      terminal: {
        refresh: vi.fn(),
        rows: 24,
        scrollToBottom: vi.fn(),
      } as unknown as ManagedTerminal["terminal"],
    };

    mockDeps = {
      getInstance: vi.fn(() => mockManagedTerminal as ManagedTerminal),
      wakeAndRestore: vi.fn(() => Promise.resolve(true)),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    policy = new TerminalRendererPolicy(mockDeps);
  });

  describe("initializeBackendTier", () => {
    it("should set lastBackendTier to the provided value", () => {
      policy.initializeBackendTier("test-id", "background");

      expect(policy.getLastBackendTier("test-id")).toBe("background");
    });

    it("should set needsWake=true when initializing to background tier", () => {
      policy.initializeBackendTier("test-id", "background");

      expect(mockManagedTerminal.needsWake).toBe(true);
    });

    it("should not set needsWake when initializing to active tier", () => {
      mockManagedTerminal.needsWake = undefined;

      policy.initializeBackendTier("test-id", "active");

      expect(policy.getLastBackendTier("test-id")).toBe("active");
      expect(mockManagedTerminal.needsWake).toBeUndefined();
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

  describe("initializeBackendTier integration with applyRendererPolicy", () => {
    it("should trigger wake when transitioning from initialized background to active", async () => {
      // Set up terminal as if it was backgrounded (lastAppliedTier = BACKGROUND)
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      // Initialize to background (simulating reconnection after project switch)
      policy.initializeBackendTier("test-id", "background");

      expect(policy.getLastBackendTier("test-id")).toBe("background");
      expect(mockManagedTerminal.needsWake).toBe(true);

      // Now apply active policy (simulating terminal becoming visible)
      // This is an "upgrade" since FOCUSED (100) < BACKGROUND (1000)
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      // Should have triggered wake because:
      // 1. Backend tier was "background" (from initializeBackendTier)
      // 2. Transitioning to "active" backend tier (FOCUSED maps to active)
      // 3. needsWake was true
      expect(mockDeps.wakeAndRestore).toHaveBeenCalledWith("test-id");

      // Backend tier should now be "active"
      expect(policy.getLastBackendTier("test-id")).toBe("active");
    });

    it("should not trigger wake when initializing to active tier", () => {
      // Initialize to active
      policy.initializeBackendTier("test-id", "active");

      // Set up terminal as if it was at BACKGROUND tier (to trigger a tier change)
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      // Apply active policy
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      // Should not have triggered wake since:
      // - Backend tier was already "active" (from initializeBackendTier)
      // - Condition "prevBackendTier !== 'active'" is false
      expect(mockDeps.wakeAndRestore).not.toHaveBeenCalled();
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

  describe("onPostWake callback", () => {
    it("calls onPostWake for alt-screen terminals after successful wake", async () => {
      const onPostWake = vi.fn();
      mockDeps.onPostWake = onPostWake;
      mockManagedTerminal.isAltBuffer = true;
      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.isVisible = true;
      mockManagedTerminal.latestWasAtBottom = true;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(onPostWake).toHaveBeenCalledWith("test-id");
      });
    });

    it("calls onPostWake for non-alt-screen terminals after successful wake", async () => {
      const onPostWake = vi.fn();
      mockDeps.onPostWake = onPostWake;
      mockManagedTerminal.isAltBuffer = false;
      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.isVisible = true;
      mockManagedTerminal.latestWasAtBottom = true;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(onPostWake).toHaveBeenCalledWith("test-id");
      });
    });

    it("does not call onPostWake when wake fails", async () => {
      const onPostWake = vi.fn();
      mockDeps.onPostWake = onPostWake;
      mockDeps.wakeAndRestore = vi.fn(() => Promise.resolve(false));
      mockManagedTerminal.isAltBuffer = true;
      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(mockDeps.wakeAndRestore).toHaveBeenCalled();
      });

      expect(onPostWake).not.toHaveBeenCalled();
    });

    it("does not auto-scroll to bottom for non-alt terminals after wake", async () => {
      mockManagedTerminal.isAltBuffer = false;
      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      mockManagedTerminal.isVisible = true;
      mockManagedTerminal.latestWasAtBottom = true;

      const terminal = mockManagedTerminal.terminal as unknown as {
        scrollToBottom: ReturnType<typeof vi.fn>;
        refresh: ReturnType<typeof vi.fn>;
      };

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(mockDeps.wakeAndRestore).toHaveBeenCalled();
      });

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });
  });

  describe("applyDeferredResize callback", () => {
    it("calls applyDeferredResize before terminal.refresh on the synchronous wake path", async () => {
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

      // needsWake=false → synchronous refresh path inside applyRendererPolicyImmediate.
      mockManagedTerminal.needsWake = false;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      // Initialize sets needsWake=true; reset before the upgrade so we hit the sync branch.
      mockManagedTerminal.needsWake = false;
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      expect(applyDeferredResize).toHaveBeenCalledWith("test-id");
      expect(callOrder).toEqual(["applyDeferredResize", "refresh"]);
    });

    it("calls applyDeferredResize before terminal.refresh after a successful async wake", async () => {
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

      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(applyDeferredResize).toHaveBeenCalledWith("test-id");
      });

      expect(callOrder).toEqual(["applyDeferredResize", "refresh"]);
    });

    it("calls applyDeferredResize before terminal.refresh on the wake-failure recovery path", async () => {
      const callOrder: string[] = [];
      const applyDeferredResize = vi.fn(() => {
        callOrder.push("applyDeferredResize");
      });
      mockDeps.applyDeferredResize = applyDeferredResize;
      mockDeps.wakeAndRestore = vi.fn(() => Promise.reject(new Error("boom")));

      const terminal = mockManagedTerminal.terminal as unknown as {
        refresh: ReturnType<typeof vi.fn>;
      };
      terminal.refresh = vi.fn(() => {
        callOrder.push("refresh");
      });

      mockManagedTerminal.needsWake = true;
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;

      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      policy.initializeBackendTier("test-id", "background");
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);

      await vi.waitFor(() => {
        expect(applyDeferredResize).toHaveBeenCalledWith("test-id");
      });

      expect(callOrder).toEqual(["applyDeferredResize", "refresh"]);
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
      // No wake: the applied tier never went to background.
      expect(mockDeps.wakeAndRestore).not.toHaveBeenCalled();
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

    it("re-sends the active backend tier and runs the wake path", async () => {
      const { terminalClient } = await import("@/clients");
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      mockManagedTerminal.needsWake = true;
      policy.initializeBackendTier("test-id", "background");

      policy.reassertActiveTier("test-id");

      expect(policy.getLastBackendTier("test-id")).toBe("active");
      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "active", 200);
      expect(mockDeps.wakeAndRestore).toHaveBeenCalledWith("test-id");
    });

    it("no-ops when the backend tier is already active or the applied tier is BACKGROUND", () => {
      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;
      policy.initializeBackendTier("test-id", "active");
      policy.reassertActiveTier("test-id");
      expect(mockDeps.wakeAndRestore).not.toHaveBeenCalled();

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      policy.initializeBackendTier("test-id", "background");
      policy.reassertActiveTier("test-id");
      expect(mockDeps.wakeAndRestore).not.toHaveBeenCalled();
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

  describe("onBackgrounded callback (#9906)", () => {
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

    it("fires when the backend tier transitions active → background", async () => {
      const onBackgrounded = vi.fn();
      mockDeps.onBackgrounded = onBackgrounded;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;

      // Downgrade to BACKGROUND arms the hysteresis timer; the callback fires
      // only when it actually applies.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);
      expect(onBackgrounded).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(onBackgrounded).toHaveBeenCalledExactlyOnceWith("test-id");
    });

    it("does not fire on an active → active tier change", async () => {
      const onBackgrounded = vi.fn();
      mockDeps.onBackgrounded = onBackgrounded;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.VISIBLE;

      // Upgrade VISIBLE → FOCUSED stays "active" on the backend — no background.
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.FOCUSED);
      vi.advanceTimersByTime(1000);
      expect(onBackgrounded).not.toHaveBeenCalled();
    });

    it("does not fire again when already background (background → background)", async () => {
      const onBackgrounded = vi.fn();
      mockDeps.onBackgrounded = onBackgrounded;
      const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
      policy = new TerminalRendererPolicy(mockDeps);

      mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
      mockManagedTerminal.getRefreshTier = () => TerminalRefreshTier.FOCUSED;

      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(1000);
      expect(onBackgrounded).toHaveBeenCalledTimes(1);

      // Re-applying BACKGROUND is a no-op (prevBackendTier already background).
      onBackgrounded.mockClear();
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(1000);
      expect(onBackgrounded).not.toHaveBeenCalled();
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
