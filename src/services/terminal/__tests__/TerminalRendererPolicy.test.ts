import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/domain";
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
      expect(terminalClient.setActivityTier).toHaveBeenCalledWith("test-id", "active");

      vi.clearAllMocks();
      policy.applyRendererPolicy("test-id", TerminalRefreshTier.BURST);

      expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
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
