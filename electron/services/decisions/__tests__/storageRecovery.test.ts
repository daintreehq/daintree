import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", () => ({ logWarn }));

import {
  DISK_FULL_RESTART_DELAYS_MS,
  DISK_FULL_SAME_OUTAGE_MS,
  StorageRecovery,
} from "../storageRecovery.js";

const [FIRST, SECOND, THIRD] = DISK_FULL_RESTART_DELAYS_MS;

/** A recovery whose disk reads and restarts are recorded, with what each one answers set per test. */
function recovery(room: () => Promise<boolean | null> = async () => true) {
  const calls: string[] = [];
  let restarts = true;
  const subject = new StorageRecovery({
    checkDiskSpace: async () => {
      calls.push("check");
      return room();
    },
    restart: async () => {
      calls.push("restart");
      return restarts;
    },
    now: () => Date.now(),
  });
  return {
    subject,
    calls,
    refuseRestarts: () => {
      restarts = false;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  logWarn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StorageRecovery", () => {
  it("reads free space after a wait, and restarts the store when there is room", async () => {
    const { subject, calls } = recovery();

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual(["check", "restart"]);
  });

  it("leaves a store to the monitor's exit while space reads critical", async () => {
    const { subject, calls } = recovery(async () => false);

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check"]);
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    expect(calls).toEqual(["check"]);
  });

  it("restarts anyway when free space can't be read, or the read fails", async () => {
    const unread = recovery(async () => null);
    unread.subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(unread.calls).toEqual(["check", "restart"]);

    const failed = recovery(async () => {
      throw new Error("statfs failed");
    });
    failed.subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(failed.calls).toEqual(["check", "restart"]);
  });

  it("waits longer each time the store runs out of room again, then leaves it stopped", async () => {
    const { subject, calls } = recovery();

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.diskFull();
    await vi.advanceTimersByTimeAsync(SECOND - 1);
    expect(calls).toEqual(["check", "restart"]);
    await vi.advanceTimersByTimeAsync(1);
    subject.diskFull();
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(calls).toEqual(["check", "restart", "check", "restart", "check", "restart"]);

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    expect(calls).toHaveLength(6);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("starts a new outage at the shortest wait once a restart has held long enough", async () => {
    const { subject, calls } = recovery();

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check", "restart", "check", "restart"]);
  });

  it("counts no restart the service refused", async () => {
    const { subject, calls, refuseRestarts } = recovery();
    refuseRestarts();

    for (let i = 0; i < DISK_FULL_RESTART_DELAYS_MS.length + 1; i += 1) {
      subject.diskFull();
      await vi.advanceTimersByTimeAsync(FIRST);
    }

    expect(calls.filter((call) => call === "restart")).toHaveLength(
      DISK_FULL_RESTART_DELAYS_MS.length + 1
    );
  });

  it("waits once for faults that land while a wait is already set", async () => {
    const { subject, calls } = recovery();

    subject.diskFull();
    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check", "restart"]);
  });

  it("looks again at a fault that lands while it is restarting", async () => {
    let release!: (room: boolean) => void;
    const { subject, calls } = recovery(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );

    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);
    // The replacement store ran out of room before this attempt finished.
    subject.diskFull();
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["check", "restart"]);

    await vi.advanceTimersByTimeAsync(SECOND);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["check", "restart", "check", "restart"]);
  });

  it("does nothing once disposed, not even a wait already set", async () => {
    const { subject, calls } = recovery();

    subject.diskFull();
    subject.dispose();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.diskFull();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
