import { describe, it, expect, vi } from "vitest";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";

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
    coord.resume("backpressure");

    expect(raw.resume).not.toHaveBeenCalled();
    expect(coord.isPaused).toBe(true);
  });

  it("calls underlying resume when releasing final hold", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.pause("resource-governor");
    coord.resume("backpressure");
    coord.resume("resource-governor");

    expect(raw.resume).toHaveBeenCalledTimes(1);
    expect(coord.isPaused).toBe(false);
  });

  it("no-ops when resuming a token that was not held", () => {
    const raw = createMockRaw();
    const coord = new PtyPauseCoordinator(raw);

    coord.pause("backpressure");
    coord.resume("ipc-queue");

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
});
