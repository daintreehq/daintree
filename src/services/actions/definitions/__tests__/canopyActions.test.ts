// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { CanopyPopOut, CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { notify } from "@/lib/notify";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

describe("canopy actions", () => {
  const registry: ActionRegistry = new Map();

  beforeAll(async () => {
    const { registerCanopyActions } = await import("../canopyActions");
    registerCanopyActions(registry);
  });

  afterEach(() => useCanopyStore.setState({ mode: "unset", isOpen: false }));

  const definition = (id: string) => registry.get(id)!();

  it("offers Mark all read only once Canopy is on, saying how to turn it on before then", () => {
    useCanopyStore.setState({ mode: "unset" });
    const markAllRead = definition("canopy.markAllRead");
    expect(markAllRead.isVisible?.({})).toBe(true);
    expect(markAllRead.isEnabled?.({})).toBe(false);
    expect(markAllRead.disabledReason?.({})).toMatch(/isn't on/);
    useCanopyStore.setState({ mode: "on" });
    expect(markAllRead.isEnabled?.({})).toBe(true);
  });

  it.each([
    ["canopy.toggle", ["unset", "on"] as const],
    ["canopy.markAllRead", ["on"] as const],
  ])(
    "%s is listed and runs until the user hides Canopy, and then says where to show it",
    (id, modes) => {
      for (const mode of modes) {
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

  describe("the Canopy window, Canopy's one home once on (#16578)", () => {
    /** Main's side: one window, made by the first open and brought forward by the rest. */
    const main = { standing: false, made: 0, broughtForward: 0 };
    const open = vi.fn<() => Promise<void>>(async () => {
      if (main.standing) main.broughtForward += 1;
      else {
        main.standing = true;
        main.made += 1;
      }
    });
    const focus = vi.fn<() => Promise<boolean>>();
    const popOut = vi.fn<(popOut: CanopyPopOut) => Promise<void>>(async () => {});

    function installWindowApi(): void {
      Object.defineProperty(window, "electron", {
        value: { canopyWindow: { focus, open, popOut } },
        configurable: true,
        writable: true,
      });
    }

    afterEach(() => {
      Object.assign(main, { standing: false, made: 0, broughtForward: 0 });
      open.mockClear();
      focus.mockClear();
      popOut.mockClear();
      vi.mocked(notify).mockClear();
    });

    describe.each(["canopy.toggle", "canopy.openWindow"])("%s, with Canopy on", (id) => {
      it("opens the window when none stands, and never the panel here", async () => {
        installWindowApi();
        useCanopyStore.setState({ mode: "on", isOpen: false });

        await definition(id).run(undefined, {});

        expect(open).toHaveBeenCalledTimes(1);
        expect(main).toEqual({ standing: true, made: 1, broughtForward: 0 });
        expect(useCanopyStore.getState().isOpen).toBe(false);
      });

      it("brings a standing window forward, and never the panel here", async () => {
        installWindowApi();
        main.standing = true;
        useCanopyStore.setState({ mode: "on", isOpen: false });

        await definition(id).run(undefined, {});
        await definition(id).run(undefined, {});

        expect(main).toEqual({ standing: true, made: 0, broughtForward: 2 });
        expect(useCanopyStore.getState().isOpen).toBe(false);
      });

      it("puts away a panel this view still holds, opening the window instead of moving it", async () => {
        installWindowApi();
        useCanopyStore.setState({ mode: "on", isOpen: true });

        await definition(id).run(undefined, {});

        expect(useCanopyStore.getState().isOpen).toBe(false);
        expect(popOut).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledTimes(1);
      });

      it("says once why the window couldn't open, owning the toast", async () => {
        installWindowApi();
        open.mockRejectedValueOnce(new Error("no"));
        useCanopyStore.setState({ mode: "on", isOpen: false });

        await expect(definition(id).run(undefined, {})).rejects.toThrow("no");

        expect(definition(id).selfNotifiesOnExecutionError).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        const toast = vi.mocked(notify).mock.calls[0]![0];
        expect(toast.type).toBe("error");
        expect(toast.actions?.map((action) => action.label)).toEqual(["Try again"]);
        expect(useCanopyStore.getState().isOpen).toBe(false);
      });
    });

    it("offers turning Canopy on here before it is on, asking nothing of main", async () => {
      installWindowApi();
      useCanopyStore.setState({ mode: "unset", isOpen: false });

      await definition("canopy.toggle").run(undefined, {});
      expect(useCanopyStore.getState().isOpen).toBe(true);

      await definition("canopy.toggle").run(undefined, {});
      expect(useCanopyStore.getState().isOpen).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    });

    it.each(["unset", "hidden"] as const)("doesn't offer the window with Canopy %s", (mode) => {
      useCanopyStore.setState({ mode });
      const openWindow = definition("canopy.openWindow");

      expect(openWindow.isVisible?.({})).toBe(false);
      expect(openWindow.isEnabled?.({})).toBe(false);
      expect(openWindow.disabledReason?.({})).toMatch(/isn't on/);
    });

    it("offers the window once Canopy is on", () => {
      useCanopyStore.setState({ mode: "on" });
      const openWindow = definition("canopy.openWindow");

      expect(openWindow.isVisible?.({})).toBe(true);
      expect(openWindow.isEnabled?.({})).toBe(true);
    });
  });

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
