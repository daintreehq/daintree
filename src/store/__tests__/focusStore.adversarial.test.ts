// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFocusStore, type PanelState } from "../focusStore";

beforeEach(() => {
  useFocusStore.setState({ isFocusMode: false, savedPanelState: null });
});

afterEach(() => {
  useFocusStore.setState({ isFocusMode: false, savedPanelState: null });
});

describe("focusStore adversarial", () => {
  it("savedPanelState is cloned on write — mutating the original does not leak into the store", () => {
    const state: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };
    useFocusStore.getState().setFocusMode(true, state);

    state.sidebarWidth = 9999;
    state.diagnosticsOpen = true;

    const saved = useFocusStore.getState().savedPanelState;
    expect(saved?.sidebarWidth).toBe(320);
    expect(saved?.diagnosticsOpen).toBe(false);
  });

  it("setFocusMode(true, newState) while already in focus mode replaces savedPanelState (hydration case)", () => {
    const stateA: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };
    const stateB: PanelState = { sidebarWidth: 640, diagnosticsOpen: true };

    useFocusStore.getState().setFocusMode(true, stateA);
    useFocusStore.getState().setFocusMode(true, stateB);

    expect(useFocusStore.getState().savedPanelState).toEqual(stateB);
  });

  it("re-enable without payload does not null out an existing snapshot", () => {
    const stateA: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };
    useFocusStore.getState().setFocusMode(true, stateA);

    useFocusStore.getState().setFocusMode(true);

    expect(useFocusStore.getState().savedPanelState).toEqual(stateA);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });

  it("disable always clears savedPanelState regardless of passed-in state", () => {
    const stateA: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };
    const stateB: PanelState = { sidebarWidth: 9999, diagnosticsOpen: true };
    useFocusStore.getState().setFocusMode(true, stateA);

    useFocusStore.getState().setFocusMode(false, stateB);

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });

  it("toggleFocusMode round-trip is symmetric and clears snapshot on exit", () => {
    const state: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };

    useFocusStore.getState().toggleFocusMode(state);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
    expect(useFocusStore.getState().savedPanelState).toEqual(state);

    useFocusStore.getState().toggleFocusMode(state);
    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });

  it("getSavedPanelState reflects current store state (not a cached value)", () => {
    const state: PanelState = { sidebarWidth: 100, diagnosticsOpen: false };
    expect(useFocusStore.getState().getSavedPanelState()).toBeNull();

    useFocusStore.getState().setFocusMode(true, state);
    expect(useFocusStore.getState().getSavedPanelState()).toEqual(state);
  });

  it("reset clears both fields even when focus is active with a snapshot", () => {
    const state: PanelState = { sidebarWidth: 200, diagnosticsOpen: true };
    useFocusStore.getState().setFocusMode(true, state);

    useFocusStore.getState().reset();

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });

  it("setFocusMode(true) with no payload on a cold store stores null snapshot (not undefined)", () => {
    useFocusStore.getState().setFocusMode(true);

    expect(useFocusStore.getState().isFocusMode).toBe(true);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });
});
