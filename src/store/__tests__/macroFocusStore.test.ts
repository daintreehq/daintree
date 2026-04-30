// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMacroFocusStore } from "../macroFocusStore";

describe("macroFocusStore", () => {
  beforeEach(() => {
    const store = useMacroFocusStore.getState();
    store.clearFocus();
    store.setVisibility("grid", true);
    store.setVisibility("dock", false);
    store.setVisibility("sidebar", true);
    store.setVisibility("portal", false);
    store.refs.clear();
  });

  describe("cycleNext", () => {
    it("focuses the first visible region from null", () => {
      useMacroFocusStore.getState().cycleNext();
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("cycles through visible regions in order", () => {
      const store = useMacroFocusStore.getState();
      store.cycleNext(); // grid
      store.cycleNext(); // sidebar (dock is hidden)
      expect(useMacroFocusStore.getState().focusedRegion).toBe("sidebar");
    });

    it("wraps around to the first region", () => {
      const store = useMacroFocusStore.getState();
      store.cycleNext(); // grid
      store.cycleNext(); // sidebar
      store.cycleNext(); // wraps to grid
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("includes dock when visible", () => {
      useMacroFocusStore.getState().setVisibility("dock", true);
      const store = useMacroFocusStore.getState();
      store.cycleNext(); // grid
      store.cycleNext(); // dock
      expect(useMacroFocusStore.getState().focusedRegion).toBe("dock");
    });

    it("includes all four regions when all visible", () => {
      const store = useMacroFocusStore.getState();
      store.setVisibility("dock", true);
      store.setVisibility("portal", true);
      store.cycleNext(); // grid
      store.cycleNext(); // dock
      store.cycleNext(); // sidebar
      store.cycleNext(); // portal
      expect(useMacroFocusStore.getState().focusedRegion).toBe("portal");
      store.cycleNext(); // wraps to grid
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("does nothing when no regions are visible", () => {
      const store = useMacroFocusStore.getState();
      store.setVisibility("grid", false);
      store.setVisibility("sidebar", false);
      store.cycleNext();
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
    });
  });

  describe("cyclePrev", () => {
    it("focuses the last visible region from null", () => {
      useMacroFocusStore.getState().cyclePrev();
      expect(useMacroFocusStore.getState().focusedRegion).toBe("sidebar");
    });

    it("cycles backwards through visible regions", () => {
      const store = useMacroFocusStore.getState();
      store.cyclePrev(); // sidebar
      store.cyclePrev(); // grid (dock hidden)
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("wraps around to the last region", () => {
      const store = useMacroFocusStore.getState();
      store.cyclePrev(); // sidebar
      store.cyclePrev(); // grid
      store.cyclePrev(); // wraps to sidebar
      expect(useMacroFocusStore.getState().focusedRegion).toBe("sidebar");
    });
  });

  describe("setVisibility", () => {
    it("clears focus when the focused region becomes hidden", () => {
      const store = useMacroFocusStore.getState();
      store.cycleNext(); // grid
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
      store.setVisibility("grid", false);
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
    });

    it("does not clear focus when a different region is hidden", () => {
      const store = useMacroFocusStore.getState();
      store.cycleNext(); // grid
      store.setVisibility("sidebar", false);
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("skips state update when visibility is unchanged", () => {
      const initialState = useMacroFocusStore.getState();
      initialState.setVisibility("grid", true); // already true
      // No error or crash — state unchanged
      expect(useMacroFocusStore.getState().visibility.grid).toBe(true);
    });
  });

  describe("clearFocus", () => {
    it("clears the focused region", () => {
      useMacroFocusStore.getState().cycleNext();
      expect(useMacroFocusStore.getState().focusedRegion).not.toBeNull();
      useMacroFocusStore.getState().clearFocus();
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
    });

    it("is a no-op when already null", () => {
      useMacroFocusStore.getState().clearFocus();
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
    });
  });

  describe("setRegionRef", () => {
    it("stores and removes element refs", () => {
      const el = document.createElement("div");
      const store = useMacroFocusStore.getState();
      store.setRegionRef("grid", el);
      expect(store.refs.get("grid")).toBe(el);
      store.setRegionRef("grid", null);
      expect(store.refs.has("grid")).toBe(false);
    });
  });

  describe("focus side effects", () => {
    it("calls focus({ preventScroll: true }) on the registered ref when cycling next", () => {
      const el = document.createElement("div");
      el.focus = vi.fn();
      const store = useMacroFocusStore.getState();
      store.setRegionRef("grid", el);
      store.cycleNext(); // grid
      expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    it("calls focus({ preventScroll: true }) on the registered ref when cycling prev", () => {
      const el = document.createElement("div");
      el.focus = vi.fn();
      const store = useMacroFocusStore.getState();
      store.setRegionRef("sidebar", el);
      store.cyclePrev(); // sidebar
      expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    it("recovers when focusedRegion is stale (no longer visible)", () => {
      const store = useMacroFocusStore.getState();
      store.setVisibility("dock", true);
      store.cycleNext(); // grid
      store.cycleNext(); // dock
      expect(useMacroFocusStore.getState().focusedRegion).toBe("dock");
      // Hide dock while it's focused
      store.setVisibility("dock", false);
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
      // Cycling from null after visibility change
      store.cycleNext();
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });

    it("handles single visible region cycling", () => {
      const store = useMacroFocusStore.getState();
      store.setVisibility("sidebar", false);
      // Only grid is visible
      store.cycleNext(); // grid
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
      store.cycleNext(); // still grid (only one visible)
      expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
    });
  });
});
