import { describe, it, expect, beforeEach } from "vitest";
import { createWatchedPanelsSlice, type WatchedPanelsSlice } from "../watchedPanelsSlice";

function buildSlice() {
  let currentState: WatchedPanelsSlice = {
    watchedPanels: new Set(),
    watchPanel: () => {},
    unwatchPanel: () => {},
  };

  const set = (
    updater: ((s: WatchedPanelsSlice) => Partial<WatchedPanelsSlice>) | Partial<WatchedPanelsSlice>
  ) => {
    const patch = typeof updater === "function" ? updater(currentState) : updater;
    currentState = { ...currentState, ...patch };
  };

  const get = () => currentState;

  const sliceMethods = createWatchedPanelsSlice()(set as never, get as never, {} as never);
  currentState = { ...currentState, ...sliceMethods };

  return {
    getState: () => currentState,
    watchPanel: (id: string) => currentState.watchPanel(id),
    unwatchPanel: (id: string) => currentState.unwatchPanel(id),
  };
}

describe("WatchedPanelsSlice", () => {
  let slice: ReturnType<typeof buildSlice>;

  beforeEach(() => {
    slice = buildSlice();
  });

  describe("watchPanel", () => {
    it("adds a panel ID to watchedPanels", () => {
      slice.watchPanel("panel-1");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(true);
    });

    it("is idempotent — watching already-watched panel does not duplicate", () => {
      slice.watchPanel("panel-1");
      slice.watchPanel("panel-1");
      expect(slice.getState().watchedPanels.size).toBe(1);
    });

    it("can watch multiple panels simultaneously", () => {
      slice.watchPanel("panel-1");
      slice.watchPanel("panel-2");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(true);
      expect(slice.getState().watchedPanels.has("panel-2")).toBe(true);
      expect(slice.getState().watchedPanels.size).toBe(2);
    });

    it("creates a new Set instance on each update (Zustand shallow equality)", () => {
      const before = slice.getState().watchedPanels;
      slice.watchPanel("panel-1");
      expect(slice.getState().watchedPanels).not.toBe(before);
    });
  });

  describe("unwatchPanel", () => {
    it("removes a watched panel ID", () => {
      slice.watchPanel("panel-1");
      slice.unwatchPanel("panel-1");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(false);
    });

    it("is safe to call on a panel that is not watched", () => {
      expect(() => slice.unwatchPanel("panel-x")).not.toThrow();
    });

    it("only removes the specified panel, leaving others intact", () => {
      slice.watchPanel("panel-1");
      slice.watchPanel("panel-2");
      slice.unwatchPanel("panel-1");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(false);
      expect(slice.getState().watchedPanels.has("panel-2")).toBe(true);
    });

    it("creates a new Set instance on each update (Zustand shallow equality)", () => {
      slice.watchPanel("panel-1");
      const before = slice.getState().watchedPanels;
      slice.unwatchPanel("panel-1");
      expect(slice.getState().watchedPanels).not.toBe(before);
    });

    it("toggling watch twice (watch then unwatch) results in panel not watched", () => {
      slice.watchPanel("panel-1");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(true);
      slice.unwatchPanel("panel-1");
      expect(slice.getState().watchedPanels.has("panel-1")).toBe(false);
    });

    it("unwatching while empty leaves an empty Set", () => {
      expect(slice.getState().watchedPanels.size).toBe(0);
      slice.unwatchPanel("does-not-exist");
      expect(slice.getState().watchedPanels.size).toBe(0);
    });
  });
});
