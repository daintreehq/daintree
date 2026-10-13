// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMacroFocusStore, isAssistantFocused } from "../macroFocusStore";

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
  });

  describe("clearFocus", () => {
    it("clears the focused region", () => {
      useMacroFocusStore.getState().cycleNext();
      expect(useMacroFocusStore.getState().focusedRegion).not.toBeNull();
      useMacroFocusStore.getState().clearFocus();
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
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

  describe("isAssistantFocused (#6959)", () => {
    beforeEach(() => {
      const store = useMacroFocusStore.getState();
      store.clearFocus();
      store.refs.clear();
      // Reset assistant visibility default
      store.setVisibility("assistant", false);
      // Drop any focus left over from prior tests
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
      ) {
        document.activeElement.blur();
      }
    });

    it("returns false when nothing is focused and no assistant ref is registered", () => {
      expect(isAssistantFocused()).toBe(false);
    });

    it("returns true when focusedRegion is 'assistant' (cycle path)", () => {
      const store = useMacroFocusStore.getState();
      store.setVisibility("assistant", true);
      // Stub the assistant region ref so cycleNext can call .focus()
      const panelEl = document.createElement("section");
      panelEl.tabIndex = -1;
      document.body.appendChild(panelEl);
      store.setRegionRef("assistant", panelEl);

      // Force focusedRegion via direct setState rather than cycling — keeps
      // the test independent of cycle order.
      useMacroFocusStore.setState({ focusedRegion: "assistant" });
      expect(isAssistantFocused()).toBe(true);

      document.body.removeChild(panelEl);
    });

    it("returns true when document.activeElement lives inside the assistant ref", () => {
      const store = useMacroFocusStore.getState();
      const panelEl = document.createElement("section");
      const inputEl = document.createElement("textarea");
      panelEl.appendChild(inputEl);
      document.body.appendChild(panelEl);
      store.setRegionRef("assistant", panelEl);

      inputEl.focus();
      expect(document.activeElement).toBe(inputEl);
      // focusedRegion is null — the helper must still detect DOM focus.
      expect(useMacroFocusStore.getState().focusedRegion).toBeNull();
      expect(isAssistantFocused()).toBe(true);

      document.body.removeChild(panelEl);
    });

    it("returns false when activeElement is outside the assistant ref", () => {
      const store = useMacroFocusStore.getState();
      const assistantPanel = document.createElement("section");
      const otherPanel = document.createElement("section");
      const otherInput = document.createElement("input");
      otherPanel.appendChild(otherInput);
      document.body.appendChild(assistantPanel);
      document.body.appendChild(otherPanel);
      store.setRegionRef("assistant", assistantPanel);

      otherInput.focus();
      expect(isAssistantFocused()).toBe(false);

      document.body.removeChild(assistantPanel);
      document.body.removeChild(otherPanel);
    });
  });
});
