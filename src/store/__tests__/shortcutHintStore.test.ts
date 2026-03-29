import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortcutHintStore, HINT_MILESTONES } from "../shortcutHintStore";

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

  it("shows hint when count is a milestone", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
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

  it("returns false when count is not a milestone", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 4 });
    s.recordPointer(100, 200);
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("shows hint at each milestone value", () => {
    for (const milestone of HINT_MILESTONES) {
      shortcutHintStore.setState({
        counts: { "nav.quickSwitcher": milestone },
        hydrated: true,
        pointer: null,
        activeHint: null,
      });
      const s = shortcutHintStore.getState();
      s.recordPointer(100, 200);
      const result = s.show("nav.quickSwitcher", "⌘K");
      expect(result).toBe(true);
    }
  });

  it("does not show hint at non-milestone values", () => {
    const nonMilestones = [0, 4, 5, 9, 11, 25, 31, 49, 51, 151, 999];
    for (const count of nonMilestones) {
      shortcutHintStore.setState({
        counts: { "nav.quickSwitcher": count },
        hydrated: true,
        pointer: null,
        activeHint: null,
      });
      const s = shortcutHintStore.getState();
      s.recordPointer(100, 200);
      const result = s.show("nav.quickSwitcher", "⌘K");
      expect(result).toBe(false);
    }
  });

  it("stops showing hints after the last milestone", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 151 });
    s.recordPointer(100, 200);
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
  });

  it("returns false when pointer is stale", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    shortcutHintStore.setState({
      pointer: { x: 100, y: 200, ts: Date.now() - 3000 },
    });
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("returns false when no pointer recorded", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("hides the active hint", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
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

  it("shows hint after increment-then-show sequence (ActionService flow)", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    s.recordPointer(100, 200);
    s.incrementCount("nav.quickSwitcher");
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(true);
    expect(shortcutHintStore.getState().counts["nav.quickSwitcher"]).toBe(1);
  });

  it("does not show hint after last milestone is reached via increment", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 150 });
    s.recordPointer(100, 200);
    s.incrementCount("nav.quickSwitcher");
    const result = s.show("nav.quickSwitcher", "⌘K");

    expect(result).toBe(false);
    expect(shortcutHintStore.getState().counts["nav.quickSwitcher"]).toBe(151);
  });

  it("tracks actions independently", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 4 });
    s.recordPointer(100, 200);

    s.incrementCount("terminal.new");
    const resultA = s.show("terminal.new", "⌘T");
    const resultB = s.show("nav.quickSwitcher", "⌘K");

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
  });
});
