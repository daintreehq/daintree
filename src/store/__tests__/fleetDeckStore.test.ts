import { describe, it, expect, beforeEach, vi } from "vitest";

const { setStateMock } = vi.hoisted(() => ({
  setStateMock: vi.fn((_patch: Record<string, unknown>) => Promise.resolve()),
}));

vi.mock("@/controllers/FleetDeckController", () => ({
  fleetDeckController: {
    persistOpen: (isOpen: boolean) => setStateMock({ fleetDeckOpen: isOpen }),
    persistAlwaysPreview: (value: boolean) => setStateMock({ fleetDeckAlwaysPreview: value }),
    persistQuorumThreshold: (value: number) => setStateMock({ fleetDeckQuorumThreshold: value }),
  },
}));

import { useFleetDeckStore } from "../fleetDeckStore";

function resetStore(): void {
  useFleetDeckStore.setState({
    isOpen: false,
    stateFilter: "all",
    isHydrated: false,
    alwaysPreview: false,
    quorumThreshold: 5,
  });
  setStateMock.mockClear();
}

describe("fleetDeckStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("open/close/toggle", () => {
    it("opens from closed state and persists", () => {
      useFleetDeckStore.getState().open();
      expect(useFleetDeckStore.getState().isOpen).toBe(true);
      expect(setStateMock).toHaveBeenCalledWith({ fleetDeckOpen: true });
    });

    it("open is idempotent when already open", () => {
      useFleetDeckStore.getState().open();
      setStateMock.mockClear();
      useFleetDeckStore.getState().open();
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("close is idempotent when already closed", () => {
      useFleetDeckStore.getState().close();
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("toggle flips and persists", () => {
      useFleetDeckStore.getState().toggle();
      expect(useFleetDeckStore.getState().isOpen).toBe(true);
      useFleetDeckStore.getState().toggle();
      expect(useFleetDeckStore.getState().isOpen).toBe(false);
      expect(setStateMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("hydrate", () => {
    it("populates isOpen and sets isHydrated", () => {
      useFleetDeckStore.getState().hydrate({ isOpen: true });
      const s = useFleetDeckStore.getState();
      expect(s.isHydrated).toBe(true);
      expect(s.isOpen).toBe(true);
    });

    it("ignores undefined partial fields", () => {
      useFleetDeckStore.getState().hydrate({});
      const s = useFleetDeckStore.getState();
      expect(s.isHydrated).toBe(true);
      expect(s.isOpen).toBe(false);
    });

    it("does not persist during hydrate", () => {
      useFleetDeckStore.getState().hydrate({ isOpen: true });
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("a user mutator before hydrate() wins over stale persisted values", () => {
      // Simulate: user hits Cmd+Alt+Shift+B before AppState IPC resolves
      useFleetDeckStore.getState().open();
      // Stale hydrate arrives with persisted closed state
      useFleetDeckStore.getState().hydrate({ isOpen: false });
      expect(useFleetDeckStore.getState().isOpen).toBe(true);
    });

    it("hydrate() becomes a no-op after first hydrate", () => {
      useFleetDeckStore.getState().hydrate({ isOpen: true });
      useFleetDeckStore.getState().hydrate({ isOpen: false });
      expect(useFleetDeckStore.getState().isOpen).toBe(true);
    });
  });

  describe("state filter", () => {
    it("setStateFilter updates filter without persistence", () => {
      useFleetDeckStore.getState().setStateFilter("waiting");
      expect(useFleetDeckStore.getState().stateFilter).toBe("waiting");
      expect(setStateMock).not.toHaveBeenCalled();
    });

    it("setStateFilter is idempotent", () => {
      useFleetDeckStore.getState().setStateFilter("all");
      // "all" is default — no change expected
      expect(useFleetDeckStore.getState().stateFilter).toBe("all");
    });
  });

  describe("always preview", () => {
    it("setAlwaysPreview persists and updates", () => {
      useFleetDeckStore.getState().setAlwaysPreview(true);
      expect(useFleetDeckStore.getState().alwaysPreview).toBe(true);
      expect(setStateMock).toHaveBeenCalledWith({ fleetDeckAlwaysPreview: true });
    });

    it("setAlwaysPreview is idempotent", () => {
      useFleetDeckStore.getState().setAlwaysPreview(false);
      expect(setStateMock).not.toHaveBeenCalled();
    });
  });

  describe("quorum threshold", () => {
    it("setQuorumThreshold clamps below 2", () => {
      useFleetDeckStore.getState().setQuorumThreshold(1);
      expect(useFleetDeckStore.getState().quorumThreshold).toBe(2);
    });

    it("setQuorumThreshold clamps above 50", () => {
      useFleetDeckStore.getState().setQuorumThreshold(100);
      expect(useFleetDeckStore.getState().quorumThreshold).toBe(50);
    });

    it("setQuorumThreshold persists", () => {
      useFleetDeckStore.getState().setQuorumThreshold(10);
      expect(setStateMock).toHaveBeenCalledWith({ fleetDeckQuorumThreshold: 10 });
    });
  });
});
