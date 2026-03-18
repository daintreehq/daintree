import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortcutHintStore } from "../shortcutHintStore";

describe("shortcutHintStore", () => {
  beforeEach(() => {
    shortcutHintStore.setState({
      counts: {},
      hydrated: false,
      pointer: null,
      activeHint: null,
    });
    vi.stubGlobal("window", {
      electron: {
        shortcutHints: {
          incrementCount: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates counts from IPC", () => {
    const { hydrateCounts } = shortcutHintStore.getState();
    hydrateCounts({ "nav.quickSwitcher": 2 });

    const state = shortcutHintStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.counts).toEqual({ "nav.quickSwitcher": 2 });
  });

  it("records pointer position", () => {
    const { recordPointer } = shortcutHintStore.getState();
    recordPointer(100, 200);

    const state = shortcutHintStore.getState();
    expect(state.pointer).toMatchObject({ x: 100, y: 200 });
    expect(state.pointer!.ts).toBeGreaterThan(0);
  });

  it("shows hint and returns true when pointer is fresh and count below threshold", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    s.recordPointer(100, 200);
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(true);
    const state = shortcutHintStore.getState();
    expect(state.activeHint).toEqual({
      actionId: "nav.quickSwitcher",
      displayCombo: "⌘K",
      x: 100,
      y: 200,
    });
  });

  it("returns false and does not show hint when count is at threshold", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 3 });
    s.recordPointer(100, 200);
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("returns false when pointer is stale", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    shortcutHintStore.setState({
      pointer: { x: 100, y: 200, ts: Date.now() - 3000 },
    });
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("returns false when no pointer recorded", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("hides the active hint", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    s.recordPointer(100, 200);
    s.show("nav.quickSwitcher", "⌘K");
    s.hide();

    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("increments count locally and calls IPC", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    s.incrementCount("nav.quickSwitcher");

    expect(shortcutHintStore.getState().counts["nav.quickSwitcher"]).toBe(2);
    expect(window.electron?.shortcutHints?.incrementCount).toHaveBeenCalledWith(
      "nav.quickSwitcher"
    );
  });

  it("increments count from zero", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    s.incrementCount("terminal.new");

    expect(shortcutHintStore.getState().counts["terminal.new"]).toBe(1);
  });
});
