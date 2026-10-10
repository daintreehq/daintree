// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

describe("canopy actions", () => {
  const registry: ActionRegistry = new Map();

  beforeAll(async () => {
    const { registerCanopyActions } = await import("../canopyActions");
    registerCanopyActions(registry);
  });

  afterEach(() => useCanopyStore.setState({ mode: "unset", isOpen: false }));

  const definition = (id: string) => registry.get(id)!();

  it.each(["canopy.toggle", "canopy.markAllRead"])(
    "%s is listed and runs until the user hides Canopy, and then says where to show it",
    (id) => {
      for (const mode of ["unset", "on"] as const) {
        useCanopyStore.setState({ mode });
        expect(definition(id).isVisible?.({})).toBe(true);
        expect(definition(id).isEnabled?.({})).toBe(true);
        expect(definition(id).disabledReason?.({})).toBeUndefined();
      }
      useCanopyStore.setState({ mode: "hidden" });
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toBe(
        "Canopy is hidden. Show it from Settings > Canopy."
      );
    }
  );

  it("marks read only this project's agents when Canopy is set to This project", async () => {
    const markAllRead = vi.fn(async () => []);
    Object.defineProperty(window, "electron", {
      value: { canopy: { markAllRead, restoreReads: vi.fn() } },
      configurable: true,
      writable: true,
    });
    window.__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    } as typeof window.__DAINTREE_INITIAL_PROJECT__;
    const mark = (runId: string) => ({
      runId,
      spawnedAt: 1,
      turn: 2,
      readTurn: 1,
      markedUnreadAt: null,
      version: 1,
    });
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          { runId: "here", workspaceId: "p1", spawnedAt: 1 },
          { runId: "there", workspaceId: "p2", spawnedAt: 1 },
        ],
        changedAt: 0,
        degraded: false,
        lastSuccessfulAt: 0,
      } as unknown as FleetSnapshot,
    });
    useCanopyStore.setState({
      mode: "on",
      scope: "project",
      snapshot: {
        activated: true,
        dispositions: [],
        reads: [mark("here"), mark("there")],
      } as unknown as CanopySnapshot,
    });
    try {
      await definition("canopy.markAllRead").run(undefined, {});
      expect(markAllRead).toHaveBeenCalledWith([{ runId: "here", spawnedAt: 1, turn: 2 }]);
      // Before the fleet is read, which runs are this project's can't be told:
      // the action stands down and says why, rather than doing nothing.
      useFleetSnapshotStore.setState({ snapshot: null });
      expect(definition("canopy.markAllRead").isEnabled?.({})).toBe(false);
      expect(definition("canopy.markAllRead").disabledReason?.({})).toBe(
        "Canopy hasn't listed this project's agents yet."
      );
    } finally {
      delete window.__DAINTREE_INITIAL_PROJECT__;
      useCanopyStore.setState({ scope: "all", snapshot: null });
      useFleetSnapshotStore.setState({ snapshot: null });
    }
  });

  it("opens nothing from a run let through while hidden", async () => {
    useCanopyStore.setState({ mode: "hidden" });
    await definition("canopy.toggle").run(undefined, {});
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });
});
