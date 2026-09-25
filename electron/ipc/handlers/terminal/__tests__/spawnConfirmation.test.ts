import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPAWN_CONFIRMATION_TIMEOUT_MS,
  armSpawnConfirmation,
  setSpawnConfirmationTimeoutHandler,
  settleSpawnConfirmation,
} from "../spawnConfirmation.js";
import type { SpawnError } from "../../../../../shared/types/pty-host.js";

describe("spawnConfirmation (#12754)", () => {
  let onTimeout: ReturnType<typeof vi.fn<(id: string, error: SpawnError) => void>>;
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    onTimeout = vi.fn<(id: string, error: SpawnError) => void>();
    dispose = setSpawnConfirmationTimeoutHandler(onTimeout);
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("reports SPAWN_TIMEOUT when the host never answers", () => {
    armSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ code: "SPAWN_TIMEOUT" })
    );
  });

  it("stays quiet once the host answers", () => {
    armSpawnConfirmation("t1");
    settleSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("tracks each terminal independently", () => {
    armSpawnConfirmation("t1");
    armSpawnConfirmation("t2");
    settleSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("t2", expect.anything());
  });

  it("re-arming an id restarts its window rather than stacking timers", () => {
    armSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS - 10);
    armSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an installed handler, and disposal drops armed timers", () => {
    armSpawnConfirmation("t1");
    dispose();
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);
    expect(onTimeout).not.toHaveBeenCalled();

    armSpawnConfirmation("t2");
    expect(vi.getTimerCount()).toBe(0);
  });
});
