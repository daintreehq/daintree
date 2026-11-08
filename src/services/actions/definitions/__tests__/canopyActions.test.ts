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

  describe("with a Canopy window", () => {
    const focus = vi.fn<() => Promise<boolean>>();
    const open = vi.fn<() => Promise<void>>(async () => {});
    const popOut = vi.fn<(popOut: CanopyPopOut) => Promise<void>>(async () => {});

    function installWindowApi(): void {
      Object.defineProperty(window, "electron", {
        value: { canopyWindow: { focus, open, popOut } },
        configurable: true,
        writable: true,
      });
    }

    afterEach(() => {
      focus.mockReset();
      open.mockClear();
      popOut.mockReset();
      popOut.mockResolvedValue(undefined);
      vi.mocked(notify).mockClear();
      useCanopyStore.setState({ hostId: null, unreadOnly: false });
    });

    it("brings the window forward instead of opening the panel here", async () => {
      installWindowApi();
      focus.mockResolvedValue(true);
      useCanopyStore.setState({ mode: "on", isOpen: false });

      await definition("canopy.toggle").run(undefined, {});

      expect(focus).toHaveBeenCalledTimes(1);
      expect(useCanopyStore.getState().isOpen).toBe(false);
    });

    it("opens the panel again once the window is gone", async () => {
      installWindowApi();
      focus.mockResolvedValue(false);
      useCanopyStore.setState({ mode: "on", isOpen: false });

      await definition("canopy.toggle").run(undefined, {});

      expect(useCanopyStore.getState().isOpen).toBe(true);
    });

    it("closes a panel open here rather than leaving it behind the window", async () => {
      installWindowApi();
      useCanopyStore.setState({ mode: "on", isOpen: true });

      await definition("canopy.toggle").run(undefined, {});

      expect(focus).not.toHaveBeenCalled();
      expect(useCanopyStore.getState().isOpen).toBe(false);
    });

    it("asks nothing of main before Canopy is on, when no window can exist", async () => {
      installWindowApi();
      useCanopyStore.setState({ mode: "unset", isOpen: false });

      await definition("canopy.toggle").run(undefined, {});

      expect(focus).not.toHaveBeenCalled();
      expect(useCanopyStore.getState().isOpen).toBe(true);
    });

    it.each(["unset", "hidden"] as const)("isn't offered with Canopy %s", (mode) => {
      useCanopyStore.setState({ mode });
      const openWindow = definition("canopy.openWindow");

      expect(openWindow.isVisible?.({})).toBe(false);
      expect(openWindow.isEnabled?.({})).toBe(false);
      expect(openWindow.disabledReason?.({})).toMatch(/isn't on/);
    });

    it("is offered once Canopy is on, and opens the window when no panel is open here", async () => {
      installWindowApi();
      useCanopyStore.setState({ mode: "on", isOpen: false });
      const openWindow = definition("canopy.openWindow");

      expect(openWindow.isVisible?.({})).toBe(true);
      expect(openWindow.isEnabled?.({})).toBe(true);

      await openWindow.run(undefined, {});

      expect(open).toHaveBeenCalledTimes(1);
      expect(popOut).not.toHaveBeenCalled();
    });

    it("pops a panel open here out into the window, closing it only once the window has it (#16338)", async () => {
      installWindowApi();
      let taken!: () => void;
      popOut.mockImplementationOnce(() => new Promise<void>((resolve) => (taken = resolve)));
      useCanopyStore.setState({ mode: "on", isOpen: true, unreadOnly: true });

      const running = definition("canopy.openWindow").run(undefined, {});
      await Promise.resolve();

      expect(open).not.toHaveBeenCalled();
      expect(popOut).toHaveBeenCalledTimes(1);
      expect(popOut.mock.calls[0]![0].unreadOnly).toBe(true);
      expect(useCanopyStore.getState().isOpen).toBe(true);

      taken();
      await running;
      expect(useCanopyStore.getState().isOpen).toBe(false);
    });

    it("leaves the panel exactly as it was when the window didn't take it, and says so", async () => {
      installWindowApi();
      popOut.mockRejectedValueOnce(new Error("no"));
      useCanopyStore.setState({ mode: "on", isOpen: true, hostId: "*", unreadOnly: true });
      const before = useCanopyStore.getState();

      await expect(definition("canopy.openWindow").run(undefined, {})).rejects.toThrow("no");

      const after = useCanopyStore.getState();
      expect(after.isOpen).toBe(true);
      expect(after.hostId).toBe(before.hostId);
      expect(after.unreadOnly).toBe(before.unreadOnly);
      expect(notify).toHaveBeenCalledTimes(1);
      const toast = vi.mocked(notify).mock.calls[0]![0];
      expect(toast.type).toBe("error");
      expect(toast.actions?.map((action) => action.label)).toEqual(["Try again"]);
    });

    it("says a double click's one failure once, owning the toast", async () => {
      installWindowApi();
      let refuse!: (error: Error) => void;
      popOut.mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = reject)));
      useCanopyStore.setState({ mode: "on", isOpen: true });
      const openWindow = definition("canopy.openWindow");

      const first = openWindow.run(undefined, {});
      const second = openWindow.run(undefined, {});
      refuse(new Error("no"));

      await expect(first).rejects.toThrow("no");
      await expect(second).rejects.toThrow("no");
      expect(popOut).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(openWindow.selfNotifiesOnExecutionError).toBe(true);
    });

    it("never pops the Canopy window out into itself", async () => {
      installWindowApi();
      window.__DAINTREE_CANOPY_WINDOW__ = true;
      useCanopyStore.setState({ mode: "on", isOpen: true });

      await definition("canopy.openWindow").run(undefined, {});

      expect(popOut).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
      delete window.__DAINTREE_CANOPY_WINDOW__;
    });

    it("says why when the window couldn't open with no panel here", async () => {
      installWindowApi();
      open.mockRejectedValueOnce(new Error("no"));
      useCanopyStore.setState({ mode: "on", isOpen: false });

      await expect(definition("canopy.openWindow").run(undefined, {})).rejects.toThrow("no");

      expect(notify).toHaveBeenCalledTimes(1);
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
