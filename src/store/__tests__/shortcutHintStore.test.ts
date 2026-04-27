import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortcutHintStore, HINT_MILESTONES } from "../shortcutHintStore";

describe("shortcutHintStore", () => {
  beforeEach(() => {
    shortcutHintStore.setState({
      counts: {},
      hydrated: false,
      pointer: null,
      activeHint: null,
      hintedHover: new Set(),
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

  it("isHoverEligible returns false before hydration", () => {
    const s = shortcutHintStore.getState();
    // Store starts with hydrated: false (set in beforeEach)
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(false);
  });

  // --- Hover path tests ---

  it("show with position bypasses stale pointer", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    // No pointer recorded — dispatch path would fail
    const result = s.show("nav.quickSwitcher", "⌘K", { x: 300, y: 400 });

    expect(result).toBe(true);
    const state = shortcutHintStore.getState();
    expect(state.activeHint).toEqual({
      actionId: "nav.quickSwitcher",
      displayCombo: "⌘K",
      x: 300,
      y: 400,
    });
  });

  it("isHoverEligible returns true for count 0", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 0 });
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true);
  });

  it("isHoverEligible returns true for unknown action (treated as count 0)", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({});
    expect(s.isHoverEligible("terminal.new")).toBe(true);
  });

  it("isHoverEligible returns true for milestone count", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true);
  });

  it("isHoverEligible returns false for non-milestone non-zero count", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 4 });
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(false);
  });

  it("isHoverEligible returns false after count was already hinted via hover (one-shot)", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true);
    s.markHoverShown("nav.quickSwitcher");
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(false);
  });

  it("markHoverShown gates count 0 as one-shot", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 0 });
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true);
    s.markHoverShown("nav.quickSwitcher");
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(false);
  });

  it("incrementCount clears hover tracking for that action", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1 });
    s.markHoverShown("nav.quickSwitcher");
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(false);

    s.incrementCount("nav.quickSwitcher");
    // After increment, count is 2 (milestone) and tracking is cleared
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true);
  });

  it("incrementCount leaves hover tracking for other actions intact", () => {
    const s = shortcutHintStore.getState();
    s.hydrateCounts({ "nav.quickSwitcher": 1, "terminal.new": 2 });
    s.markHoverShown("nav.quickSwitcher");
    s.markHoverShown("terminal.new");

    s.incrementCount("nav.quickSwitcher");
    // terminal.new hover tracking should still be present
    expect(s.isHoverEligible("nav.quickSwitcher")).toBe(true); // cleared + now at milestone 2
    expect(s.isHoverEligible("terminal.new")).toBe(false); // still tracked at count 2
  });
});
