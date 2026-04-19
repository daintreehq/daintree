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

  describe("hydrate", () => {
    it("applies persisted 'scoped' value and marks hydrated", () => {
      useFleetScopeFlagStore.getState().hydrate("scoped");
      const state = useFleetScopeFlagStore.getState();
      expect(state.mode).toBe("scoped");
      expect(state.isHydrated).toBe(true);
    });

    it("falls back to 'legacy' when persisted value is undefined", () => {
      useFleetScopeFlagStore.getState().hydrate(undefined);
      const state = useFleetScopeFlagStore.getState();
      expect(state.mode).toBe("legacy");
      expect(state.isHydrated).toBe(true);
    });

    it("normalizes malformed values to 'legacy'", () => {
      // Defensive path — legacy persisted values or mid-migration garbage
      // should not enable scoped mode.
      useFleetScopeFlagStore.getState().hydrate("SCOPED" as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("legacy");
      resetStore();
      useFleetScopeFlagStore.getState().hydrate(null as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("legacy");
      resetStore();
      useFleetScopeFlagStore.getState().hydrate(42 as never);
      expect(useFleetScopeFlagStore.getState().mode).toBe("legacy");
    });

    it("is idempotent — later hydrate calls cannot clobber user interaction", () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      setStateMock.mockClear();
      useFleetScopeFlagStore.getState().hydrate("legacy");
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
    });
  });

  describe("setMode", () => {
    it("updates mode and persists", () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      expect(useFleetScopeFlagStore.getState().mode).toBe("scoped");
      expect(setStateMock).toHaveBeenCalledWith({ fleetScopeMode: "scoped" });
    });

    it("is a no-op when mode is unchanged", () => {
      useFleetScopeFlagStore.getState().setMode("legacy");
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("marks hydrated so later async hydrate does not clobber", () => {
      useFleetScopeFlagStore.getState().setMode("scoped");
      expect(useFleetScopeFlagStore.getState().isHydrated).toBe(true);
    });
  });
});
