import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalUnseenOutputTracker, UNSEEN_THRESHOLD } from "../TerminalUnseenOutputTracker";

describe("TerminalUnseenOutputTracker", () => {
  let tracker: TerminalUnseenOutputTracker;
  const terminalId = "test-terminal";

  beforeEach(() => {
    tracker = new TerminalUnseenOutputTracker();
  });

  describe("incrementUnseen", () => {
    it("should increment unseen count when user is scrolled back", () => {
      tracker.incrementUnseen(terminalId, true);
      const snapshot = tracker.getSnapshot(terminalId);
      expect(snapshot.unseen).toBe(1);
    });

    it("should not increment unseen count when user is at bottom", () => {
      tracker.incrementUnseen(terminalId, false);
      const snapshot = tracker.getSnapshot(terminalId);
      expect(snapshot.unseen).toBe(0);
    });

    it("notifies on the 0→1 entry and on the threshold crossing (UNSEEN_THRESHOLD → UNSEEN_THRESHOLD+1)", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      // 0 → 1: first unseen, consumers need to know scroll-back + output started
      tracker.incrementUnseen(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(1);

      // 1 → 2: still below threshold, no additional notification
      tracker.incrementUnseen(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(1);

      // 2 → 3: threshold crossing — this is when the pill becomes visible
      tracker.incrementUnseen(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("shows the pill for a burst a hidden pane merged into fewer writes", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      // A burst one write over the threshold, landing as a plain write plus one merged batch.
      tracker.incrementUnseen(terminalId, true);
      tracker.incrementUnseen(terminalId, true, UNSEEN_THRESHOLD);

      expect(tracker.getSnapshot(terminalId).unseen).toBeGreaterThan(UNSEEN_THRESHOLD);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("publishes the crossing when one merged batch jumps straight over the threshold", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      tracker.incrementUnseen(terminalId, true, UNSEEN_THRESHOLD + 5);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(UNSEEN_THRESHOLD + 5);
      expect(listener).toHaveBeenCalledTimes(1);

      tracker.incrementUnseen(terminalId, true, 4);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("holds weighted increments unpublished and releases back to the held count", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);
      tracker.incrementUnseen(terminalId, true);
      listener.mockClear();

      const held = tracker.holdUnseen(terminalId);
      tracker.incrementUnseen(terminalId, true, 40);
      expect(listener).not.toHaveBeenCalled();
      expect(tracker.getSnapshot(terminalId).unseen).toBe(1);
      // Counted while held, not discarded: the raw count a second hold reads.
      expect(tracker.holdUnseen(terminalId)).toBe(held + 40);

      tracker.releaseUnseen(terminalId, held);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(1);

      // Counting resumes from the released value, weights included.
      tracker.incrementUnseen(terminalId, true, 2);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(3);
    });

    it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
      "counts a malformed batch size (%s) as one write and keeps counting",
      (bad) => {
        tracker.incrementUnseen(terminalId, true, bad);
        tracker.incrementUnseen(terminalId, true, UNSEEN_THRESHOLD);
        expect(tracker.getSnapshot(terminalId).unseen).toBe(1 + UNSEEN_THRESHOLD);

        tracker.clearUnseen(terminalId, true);
        expect(tracker.getSnapshot(terminalId).unseen).toBe(0);
      }
    );

    it("does not wake subscribers for further increments above the threshold", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      for (let i = 0; i < 100; i++) {
        tracker.incrementUnseen(terminalId, true);
      }

      // Two notifications total: entry (0→1) and threshold cross (2→3).
      // All subsequent increments are silent — the pill is already visible
      // and its label is count-agnostic, so re-renders would be wasted.
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("reflects the running unseen count on notified snapshots", () => {
      tracker.incrementUnseen(terminalId, true);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(1);

      tracker.incrementUnseen(terminalId, true);
      tracker.incrementUnseen(terminalId, true);
      // Snapshot updates on the threshold crossing (2→3)
      expect(tracker.getSnapshot(terminalId).unseen).toBe(3);
    });

    it("should maintain separate counters for different terminals", () => {
      const terminal1 = "terminal-1";
      const terminal2 = "terminal-2";

      tracker.incrementUnseen(terminal1, true);
      tracker.incrementUnseen(terminal2, true);
      tracker.incrementUnseen(terminal2, true);

      expect(tracker.getSnapshot(terminal1).unseen).toBe(1);
      // terminal2 has raw count 2 but only the 0→1 crossing refreshed the
      // snapshot — 1→2 is below the threshold crossing.
      expect(tracker.getSnapshot(terminal2).unseen).toBe(1);
    });
  });

  describe("clearUnseen", () => {
    it("should clear unseen count and notify listeners", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      tracker.incrementUnseen(terminalId, true);
      listener.mockClear();

      tracker.clearUnseen(terminalId, false);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(0);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should not notify if unseen count is already 0", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      tracker.clearUnseen(terminalId, false);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("updateScrollState", () => {
    it("should update scroll state and notify listeners", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      tracker.updateScrollState(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(tracker.getSnapshot(terminalId).isUserScrolledBack).toBe(true);
    });

    it("should not notify if scroll state has not changed", () => {
      const listener = vi.fn();
      tracker.subscribe(terminalId, listener);

      tracker.updateScrollState(terminalId, false);
      listener.mockClear();

      tracker.updateScrollState(terminalId, false);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("subscribe", () => {
    it("should add listener and return unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = tracker.subscribe(terminalId, listener);

      tracker.incrementUnseen(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      tracker.clearUnseen(terminalId, false);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should support multiple listeners for the same terminal", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      tracker.subscribe(terminalId, listener1);
      tracker.subscribe(terminalId, listener2);

      tracker.incrementUnseen(terminalId, true);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSnapshot", () => {
    it("should return initial snapshot with default values", () => {
      const snapshot = tracker.getSnapshot(terminalId);
      expect(snapshot).toEqual({
        isUserScrolledBack: false,
        unseen: 0,
      });
    });

    it("should return stable snapshot reference when state unchanged", () => {
      const snapshot1 = tracker.getSnapshot(terminalId);
      const snapshot2 = tracker.getSnapshot(terminalId);
      expect(snapshot1).toBe(snapshot2);
    });

    it("should return new snapshot reference when state changes", () => {
      const snapshot1 = tracker.getSnapshot(terminalId);
      tracker.incrementUnseen(terminalId, true);
      const snapshot2 = tracker.getSnapshot(terminalId);
      expect(snapshot1).not.toBe(snapshot2);
    });
  });

  describe("destroy", () => {
    it("should clean up all state for a terminal", () => {
      const listener = vi.fn();
      const unsubscribe = tracker.subscribe(terminalId, listener);
      tracker.incrementUnseen(terminalId, true);

      unsubscribe();
      tracker.destroy(terminalId);
      listener.mockClear();

      const snapshot = tracker.getSnapshot(terminalId);
      expect(snapshot).toEqual({
        isUserScrolledBack: false,
        unseen: 0,
      });

      tracker.incrementUnseen(terminalId, true);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("holdUnseen / releaseUnseen (#12398)", () => {
    it("hands back the raw count, not the throttled snapshot", () => {
      const beyond = UNSEEN_THRESHOLD + 3;
      for (let i = 0; i < beyond; i++) tracker.incrementUnseen(terminalId, true);
      expect(tracker.getSnapshot(terminalId).unseen).toBeLessThan(beyond);
      expect(tracker.holdUnseen(terminalId)).toBe(beyond);
    });

    it("publishes nothing while held, then lowers back to the held count and counts on from there", () => {
      const listener = vi.fn();
      tracker.incrementUnseen(terminalId, true);
      tracker.subscribe(terminalId, listener);
      const held = tracker.holdUnseen(terminalId);

      for (let i = 0; i <= UNSEEN_THRESHOLD; i++) tracker.incrementUnseen(terminalId, true);
      expect(listener).not.toHaveBeenCalled();
      expect(tracker.getSnapshot(terminalId).unseen).toBe(held);

      tracker.releaseUnseen(terminalId, held);
      expect(tracker.getSnapshot(terminalId)).toEqual({ isUserScrolledBack: true, unseen: held });
      expect(listener).not.toHaveBeenCalled();

      // Counting resumes from the lowered value: the next threshold crossing
      // is exactly where it would have been without the redraw.
      for (let i = held; i < UNSEEN_THRESHOLD; i++) tracker.incrementUnseen(terminalId, true);
      expect(listener).not.toHaveBeenCalled();
      tracker.incrementUnseen(terminalId, true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(UNSEEN_THRESHOLD + 1);
    });

    it("never raises the count — a clear that landed meanwhile stays cleared", () => {
      const listener = vi.fn();
      for (let i = 0; i <= UNSEEN_THRESHOLD; i++) tracker.incrementUnseen(terminalId, true);
      const held = tracker.holdUnseen(terminalId);
      tracker.clearUnseen(terminalId, false);
      tracker.subscribe(terminalId, listener);

      tracker.releaseUnseen(terminalId, held);

      expect(tracker.getSnapshot(terminalId).unseen).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    });

    it("release publishes the settled count when the snapshot had been throttled", () => {
      const listener = vi.fn();
      const beyond = UNSEEN_THRESHOLD + 3;
      for (let i = 0; i < beyond; i++) tracker.incrementUnseen(terminalId, true);
      const throttled = tracker.getSnapshot(terminalId).unseen;
      expect(throttled).toBeLessThan(beyond);
      tracker.subscribe(terminalId, listener);

      const held = tracker.holdUnseen(terminalId);
      tracker.releaseUnseen(terminalId, held);

      expect(tracker.getSnapshot(terminalId).unseen).toBe(beyond);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("destroy forgets the hold", () => {
      tracker.holdUnseen(terminalId);
      tracker.destroy(terminalId);

      tracker.incrementUnseen(terminalId, true);
      expect(tracker.getSnapshot(terminalId).unseen).toBe(1);
    });
  });
});
