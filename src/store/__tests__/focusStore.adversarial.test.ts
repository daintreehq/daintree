// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFocusStore, type PanelState } from "../focusStore";

const cleanState = {
  gestureSidebarHidden: false,
  gestureAssistantHidden: false,
  isFocusMode: false,
  gestureSnapshot: null,
  savedPanelState: null,
};

beforeEach(() => {
  useFocusStore.setState(cleanState);
});

afterEach(() => {
  useFocusStore.setState(cleanState);
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

    useFocusStore.getState().toggleFocusMode(state, {
      sidebarVisible: true,
      assistantVisible: false,
    });
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

  it("reset clears all gesture state even when active", () => {
    const state: PanelState = { sidebarWidth: 200, diagnosticsOpen: true };
    useFocusStore.getState().setFocusMode(true, state);

    useFocusStore.getState().reset();

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
    expect(useFocusStore.getState().gestureSnapshot).toBeNull();
  });

  it("setFocusMode(true) with no payload on a cold store stores null snapshot (not undefined)", () => {
    useFocusStore.getState().setFocusMode(true);

    expect(useFocusStore.getState().isFocusMode).toBe(true);
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });
});

describe("focusStore independent gestures (issue #6659)", () => {
  const panelState: PanelState = { sidebarWidth: 320, diagnosticsOpen: false };

  it("gesture with only sidebar visible suppresses only the sidebar", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: false,
    });

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });

  it("gesture with only assistant visible suppresses only the assistant", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: false,
      assistantVisible: true,
    });

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });

  it("gesture with both visible suppresses both", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: true,
    });

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
    expect(useFocusStore.getState().gestureSnapshot).toEqual({
      hidSidebar: true,
      hidAssistant: true,
    });
  });

  it("gesture with neither visible is a no-op (nothing to hide)", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: false,
      assistantVisible: false,
    });

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().gestureSnapshot).toBeNull();
  });

  it("clearSidebarGesture leaves the assistant gesture untouched", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: true,
    });

    useFocusStore.getState().clearSidebarGesture();

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });

  it("clearAssistantGesture leaves the sidebar gesture untouched", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: true,
    });

    useFocusStore.getState().clearAssistantGesture();

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });

  it("clearing the last active gesture clears the snapshot too", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: false,
    });

    useFocusStore.getState().clearSidebarGesture();

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().gestureSnapshot).toBeNull();
    expect(useFocusStore.getState().savedPanelState).toBeNull();
  });

  it("clearSidebarGesture is a no-op when sidebar gesture isn't active", () => {
    useFocusStore.getState().clearSidebarGesture();

    expect(useFocusStore.getState().isFocusMode).toBe(false);
    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
  });

  it("setSidebarGestureHidden(true) hides the sidebar without affecting assistant", () => {
    // Pre-existing assistant gesture state
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: false,
      assistantVisible: true,
    });

    useFocusStore.getState().setSidebarGestureHidden(true, panelState);

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
  });

  it("setSidebarGestureHidden(false) restores only the sidebar", () => {
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: true,
      assistantVisible: true,
    });

    useFocusStore.getState().setSidebarGestureHidden(false);

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
  });

  it("setSidebarGestureHidden is idempotent", () => {
    useFocusStore.getState().setSidebarGestureHidden(false);
    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);

    useFocusStore.getState().setSidebarGestureHidden(true, panelState);
    const snapshotAfterFirst = useFocusStore.getState().gestureSnapshot;
    useFocusStore.getState().setSidebarGestureHidden(true, panelState);
    expect(useFocusStore.getState().gestureSnapshot).toBe(snapshotAfterFirst);
  });

  it("setFocusMode(true) hydration path only suppresses the sidebar — assistant follows its own state", () => {
    useFocusStore.getState().setFocusMode(true);

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(useFocusStore.getState().gestureSnapshot).toEqual({
      hidSidebar: true,
      hidAssistant: false,
    });
  });

  it("toolbar-hidden sidebar followed by gesture enters (not exits) the gesture", () => {
    // Toolbar button hides only the sidebar — no gesture snapshot recorded.
    useFocusStore.getState().setSidebarGestureHidden(true, panelState);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
    expect(useFocusStore.getState().gestureSnapshot).toBeNull();

    // Subsequent double-click gesture should ENTER and hide the assistant.
    // Previously this branch keyed on isFocusMode, which would have falsely
    // exited the gesture and cleared the sidebar instead.
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: false,
      assistantVisible: true,
    });

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(true);
    expect(useFocusStore.getState().gestureSnapshot).not.toBeNull();
  });

  it("inverse gesture restores only what the gesture hid (toolbar-hidden sidebar stays hidden)", () => {
    useFocusStore.getState().setSidebarGestureHidden(true, panelState);
    useFocusStore.getState().toggleFocusMode(panelState, {
      sidebarVisible: false,
      assistantVisible: true,
    });

    // Snapshot recorded "gesture hid the assistant only" since the sidebar
    // was already hidden when the gesture entered. The inverse gesture must
    // therefore restore ONLY the assistant — the sidebar's pre-existing
    // toolbar-hidden state is not part of the gesture's responsibility.
    useFocusStore.getState().toggleFocusMode(panelState);

    expect(useFocusStore.getState().gestureSnapshot).toBeNull();
    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);
    expect(useFocusStore.getState().gestureAssistantHidden).toBe(false);
    expect(useFocusStore.getState().isFocusMode).toBe(true);
  });
});
