import { describe, it, expect, beforeEach, vi } from "vitest";

const { setStateMock } = vi.hoisted(() => ({
  setStateMock: vi.fn((_patch: Record<string, unknown>) => Promise.resolve()),
}));

vi.mock("@/clients", () => ({
  appClient: {
    setState: setStateMock,
  },
}));

import { useFleetScopeFlagStore } from "../fleetScopeFlagStore";

function resetStore(): void {
  useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: false });
  setStateMock.mockClear();
}

describe("fleetScopeFlagStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("defaults to scoped mode, unhydrated, before any user interaction", async () => {
      // Load the module fresh so we observe the real initial state instead of
      // whatever resetStore() seeded between tests.
      vi.resetModules();
      const { useFleetScopeFlagStore: freshStore } = await import("../fleetScopeFlagStore");
      const state = freshStore.getState();
      expect(state.mode).toBe("scoped");
      expect(state.isHydrated).toBe(false);
    });
  });

  describe("hydrate", () => {
    it("applies persisted 'scoped' value and marks hydrated", () => {
      useFleetScopeFlagStore.getState().hydrate("scoped");
      const state = useFleetScopeFlagStore.getState();
      expect(state.mode).toBe("scoped");
      expect(state.isHydrated).toBe(true);
    });

    it("falls back to 'scoped' when persisted value is undefined", () => {
      useFleetScopeFlagStore.getState().hydrate(undefined);
      const state = useFleetScopeFlagStore.getState();
      expect(state.mode).toBe("scoped");
      expect(state.isHydrated).toBe(true);
    });

    it("preserves explicit 'legacy' opt-in from persisted state", () => {
      // Soak-period contract: users who previously opted into legacy keep it
      // until the legacy paths are removed in the follow-up PR.
      useFleetScopeFlagStore.getState().hydrate("legacy");
      const state = useFleetScopeFlagStore.getState();
      expect(state.mode).toBe("legacy");
      expect(state.isHydrated).toBe(true);
    });

    it("normalizes malformed values to 'scoped'", () => {
      // Defensive path — only the exact string "legacy" survives; any other
      // garbage (wrong case, null, numbers) lands on the new default.
      useFleetScopeFlagStore.getState().hydrate("SCOPED" as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
      resetStore();
      useFleetScopeFlagStore.getState().hydrate(null as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
      resetStore();
      useFleetScopeFlagStore.getState().hydrate(42 as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
    });

    it("is idempotent — later hydrate calls cannot clobber user interaction", () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      setStateMock.mockClear();
      useFleetScopeFlagStore.getState().hydrate("legacy");
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
    });
  });

  describe("setMode", () => {
    it("updates mode and persists", async () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
      // persistMode dynamically imports @/clients, so the setState call
      // resolves after several microtasks. Wait for the mock instead of
      // guessing how many Promise.resolve() ticks are needed.
      await vi.waitFor(() =>
        expect(setStateMock).toHaveBeenCalledWith({ fleetScopeMode: "scoped" })
      );
    });

    it("is a no-op when mode is unchanged (from scoped default)", async () => {
      useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: false });
      setStateMock.mockClear();
      useFleetScopeFlagStore.getState().setMode("scoped");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("persists when flipping from scoped default to legacy", async () => {
      useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: false });
      setStateMock.mockClear();
      useFleetScopeFlagStore.getState().setMode("legacy");
      expect(useFleetScopeFlagStore.getState().mode).toBe("legacy");
      await vi.waitFor(() =>
        expect(setStateMock).toHaveBeenCalledWith({ fleetScopeMode: "legacy" })
      );
    });

    it("marks hydrated so later async hydrate does not clobber", () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      expect(useFleetScopeFlagStore.getState().isHydrated).toBe(true);
    });
  });
});
