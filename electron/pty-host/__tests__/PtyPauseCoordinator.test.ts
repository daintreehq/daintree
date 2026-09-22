import { describe, it, expect, vi } from "vitest";
import { PtyPauseCoordinator, pauseTokenFamily, type PauseToken } from "../PtyPauseCoordinator.js";

function createMockRaw() {
  return { pause: vi.fn(), resume: vi.fn() };
}

describe("PtyPauseCoordinator", () => {
  it("calls underlying pause on first hold", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");

    expect(raw.pause).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(true);
  });

  it("does not call underlying pause on second hold", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("ipc-queue");

    expect(raw.pause).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(true);
  });

  it("does not call underlying resume when releasing non-final hold", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("resource-governor");
    const resumed = coord.resume("backpressure");

    expect(resumed).toBe(false);
    expect(raw.resume).not.toHaveBeenCalled();
    expect(coord.isPaused).toBe(true);
  });

  it("calls underlying resume when releasing final hold", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("resource-governor");
    coord.resume("backpressure");
    const resumed = coord.resume("resource-governor");

    expect(resumed).toBe(true);
    expect(raw.resume).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(false);
  });

  it("no-ops when resuming a token that was not held", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    const resumed = coord.resume("ipc-queue");

    expect(resumed).toBe(false);
    expect(raw.resume).not.toHaveBeenCalled();
    expect(coord.isPaused).toBe(true);
  });

  it("no-ops when resuming the same token twice", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.resume("backpressure");
    coord.resume("backpressure");

    expect(raw.resume).toHaveBeenCalledTimes(1);
  });

  it("forceReleaseAll clears all holds and resumes", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("resource-governor");
    coord.pause("system-sleep");
    coord.forceReleaseAll();

    expect(raw.resume).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(false);
    expect(coord.heldTokens.size).toBe(0);
  });

  it("forceReleaseAll no-ops when no holds", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.forceReleaseAll();

    expect(raw.resume).not.toHaveBeenCalled();
  });

  it("handles three-way interleaved pause/resume correctly", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    // ResourceGovernor pauses all
    coord.pause("resource-governor");
    expect(raw.pause).toHaveBeenCalledTimes(1);

    // Backpressure manager also pauses
    coord.pause("backpressure");
    expect(raw.pause).toHaveBeenCalledTimes(1); // no additional call

    // ResourceGovernor releases — PTY should stay paused (backpressure still holds)
    coord.resume("resource-governor");
    expect(raw.resume).not.toHaveBeenCalled();
    expect(coord.isPaused).toBe(true);

    // IPC queue also pauses
    coord.pause("ipc-queue");

    // Backpressure releases
    coord.resume("backpressure");
    expect(raw.resume).not.toHaveBeenCalled();

    // IPC queue releases — now all holds gone, underlying resumes
    coord.resume("ipc-queue");
    expect(raw.resume).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(false);
  });

  it("catches errors from underlying pause", () => {
    const raw = createMockRaw();
    raw.pause.mockImplementation(() => {
      throw new Error("PTY dead");
    });
    const coord = new PtyPauseCoordinator(raw);

    expect(() => coord.pause("backpressure")).not.toThrow();
    expect(coord.isPaused).toBe(true);
  });

  it("catches errors from underlying resume", () => {
    const raw = createMockRaw();
    raw.resume.mockImplementation(() => {
      throw new Error("PTY dead");
    });
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    expect(() => coord.resume("backpressure")).not.toThrow();
    expect(coord.isPaused).toBe(false);
  });

  it("reports held tokens accurately", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("system-sleep");

    expect(coord.hasToken("backpressure")).toBe(true);
    expect(coord.hasToken("system-sleep")).toBe(true);
    expect(coord.hasToken("resource-governor")).toBe(false);
    expect(coord.hasToken("ipc-queue")).toBe(false);
  });

  describe("hasAnyBackpressureToken", () => {
    it.each(["ipc-queue", "port-queue", "port-queue-5", "backpressure"] as const)(
      "returns true when %s is held",
      (token) => {
        const coord = new PtyPauseCoordinator(createMockRaw());
        coord.pause(token);
        expect(coord.hasAnyBackpressureToken()).toBe(true);
      }
    );

    it("returns false when no tokens are held", () => {
      const coord = new PtyPauseCoordinator(createMockRaw());
      expect(coord.hasAnyBackpressureToken()).toBe(false);
    });

    it("returns false when only non-backpressure tokens are held", () => {
      const coord = new PtyPauseCoordinator(createMockRaw());
      coord.pause("resource-governor");
      coord.pause("system-sleep");
      expect(coord.hasAnyBackpressureToken()).toBe(false);
    });

    it("returns true when a backpressure token is held among others", () => {
      const coord = new PtyPauseCoordinator(createMockRaw());
      coord.pause("resource-governor");
      coord.pause("port-queue-3");
      coord.pause("system-sleep");
      expect(coord.hasAnyBackpressureToken()).toBe(true);
    });

    it("returns false after the backpressure token is released", () => {
      const coord = new PtyPauseCoordinator(createMockRaw());
      coord.pause("ipc-queue");
      coord.pause("resource-governor");
      coord.resume("ipc-queue");
      expect(coord.hasAnyBackpressureToken()).toBe(false);
    });
  });

  it("duplicate pause with same token does not double-count", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("backpressure");
    coord.resume("backpressure");

    // Single resume should release since Set prevents duplicates
    expect(raw.resume).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(false);
  });

  describe("capture mode (#12432)", () => {
    const NON_SLEEP_TOKENS: PauseToken[] = [
      "resource-governor",
      "backpressure",
      "ipc-queue",
      "port-queue",
      "port-queue-3",
      "port-queue-worker-3-t1",
    ];

    it("resumes reads held by any non-sleep token when entered", () => {
      for (const token of NON_SLEEP_TOKENS) {
        const raw = createMockRaw();
        const coord = new PtyPauseCoordinator(raw);
        coord.pause(token);
        expect(coord.isReadPaused).toBe(true);

        coord.enterCaptureMode();

        expect(coord.isReadPaused).toBe(false);
        expect(raw.resume).toHaveBeenCalledTimes(1);
        // The owner's hold is still on record for it to release normally.
        expect(coord.hasToken(token)).toBe(true);
        expect(coord.isPaused).toBe(true);
      }
    });

    it("keeps reads flowing when owners pause during capture", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.enterCaptureMode();

      for (const token of NON_SLEEP_TOKENS) coord.pause(token);

      expect(raw.pause).not.toHaveBeenCalled();
      expect(coord.isReadPaused).toBe(false);
      expect(coord.isPaused).toBe(true);
    });

    it("never overrides a system-sleep hold", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.pause("system-sleep");
      coord.pause("resource-governor");

      coord.enterCaptureMode();
      expect(coord.isReadPaused).toBe(true);
      expect(raw.resume).not.toHaveBeenCalled();

      // Wake releases sleep: the governor hold alone no longer stops reads.
      coord.resume("system-sleep");
      expect(coord.isReadPaused).toBe(false);

      // Sleep arriving mid-capture still stops them.
      coord.pause("system-sleep");
      expect(coord.isReadPaused).toBe(true);
    });

    it("re-applies holds that are still held when capture ends", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.pause("resource-governor");
      coord.enterCaptureMode();
      coord.pause("port-queue-2");

      coord.exitCaptureMode();

      expect(coord.isReadPaused).toBe(true);
      expect(raw.pause).toHaveBeenCalledTimes(2);

      coord.resume("resource-governor");
      expect(coord.isReadPaused).toBe(true);
      expect(coord.resume("port-queue-2")).toBe(true);
      expect(coord.isReadPaused).toBe(false);
    });

    it("does not resurrect holds released during capture", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.pause("resource-governor");
      coord.enterCaptureMode();
      coord.pause("ipc-queue");

      // resume() still reports the last hold going away, so owners emit their
      // "running" status exactly as they would outside capture.
      expect(coord.resume("resource-governor")).toBe(false);
      expect(coord.resume("ipc-queue")).toBe(true);
      coord.exitCaptureMode();

      expect(coord.isReadPaused).toBe(false);
      expect(raw.pause).toHaveBeenCalledTimes(1);
    });

    it("reports each suppressed family once, without sleep or window suffixes", () => {
      const coord = new PtyPauseCoordinator(createMockRaw());
      coord.pause("resource-governor");
      coord.pause("system-sleep");
      coord.enterCaptureMode();
      coord.pause("port-queue-1");
      coord.pause("port-queue-2");
      coord.pause("port-queue-worker-1-t1");
      coord.pause("resource-governor");

      expect(coord.exitCaptureMode()).toEqual([
        "port-queue",
        "port-queue-worker",
        "resource-governor",
      ]);
    });

    it("is idempotent in both directions", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.pause("backpressure");

      coord.enterCaptureMode();
      coord.enterCaptureMode();
      expect(raw.resume).toHaveBeenCalledTimes(1);
      expect(coord.isCapturing).toBe(true);

      expect(coord.exitCaptureMode()).toEqual(["backpressure"]);
      expect(coord.exitCaptureMode()).toEqual([]);
      expect(raw.pause).toHaveBeenCalledTimes(2);
      expect(coord.isCapturing).toBe(false);
    });

    it("restores ordinary pause semantics once capture ends", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.enterCaptureMode();
      coord.exitCaptureMode();

      coord.pause("resource-governor");

      expect(raw.pause).toHaveBeenCalledTimes(1);
      expect(coord.isReadPaused).toBe(true);
    });

    it("leaves nothing to re-apply after forceReleaseAll during capture", () => {
      const raw = createMockRaw();
      const coord = new PtyPauseCoordinator(raw);
      coord.pause("resource-governor");
      coord.enterCaptureMode();

      coord.forceReleaseAll();
      coord.exitCaptureMode();

      expect(coord.isReadPaused).toBe(false);
      expect(raw.pause).toHaveBeenCalledTimes(1);
      expect(raw.resume).toHaveBeenCalledTimes(1);
    });

    it("tolerates a dead PTY on entry and exit", () => {
      const coord = new PtyPauseCoordinator({
        pause: () => {
          throw new Error("dead");
        },
        resume: () => {
          throw new Error("dead");
        },
      });
      coord.pause("resource-governor");

      expect(() => coord.enterCaptureMode()).not.toThrow();
      expect(() => coord.exitCaptureMode()).not.toThrow();
    });
  });

  it("pauseTokenFamily folds per-window and per-worker suffixes", () => {
    expect(pauseTokenFamily("port-queue")).toBe("port-queue");
    expect(pauseTokenFamily("port-queue-12")).toBe("port-queue");
    expect(pauseTokenFamily("port-queue-worker-12-term-a")).toBe("port-queue-worker");
    expect(pauseTokenFamily("ipc-queue")).toBe("ipc-queue");
    expect(pauseTokenFamily("system-sleep")).toBe("system-sleep");
  });
});
