import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", () => ({ logWarn }));

import {
  BUSY_RECOVERY,
  BUSY_RESTART_DELAYS_MS,
  BUSY_SAME_OUTAGE_MS,
  DISK_FULL_RECOVERY,
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
    policy: DISK_FULL_RECOVERY,
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

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual(["check", "restart"]);
  });

  it("leaves a store to the monitor's exit while space reads critical", async () => {
    const { subject, calls } = recovery(async () => false);

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check"]);
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    expect(calls).toEqual(["check"]);
  });

  it("restarts anyway when free space can't be read, or the read fails", async () => {
    const unread = recovery(async () => null);
    unread.subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(unread.calls).toEqual(["check", "restart"]);

    const failed = recovery(async () => {
      throw new Error("statfs failed");
    });
    failed.subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(failed.calls).toEqual(["check", "restart"]);
  });

  it("waits longer each time the store runs out of room again, then leaves it stopped", async () => {
    const { subject, calls } = recovery();

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.faulted();
    await vi.advanceTimersByTimeAsync(SECOND - 1);
    expect(calls).toEqual(["check", "restart"]);
    await vi.advanceTimersByTimeAsync(1);
    subject.faulted();
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(calls).toEqual(["check", "restart", "check", "restart", "check", "restart"]);

    subject.faulted();
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    expect(calls).toHaveLength(6);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("starts a new outage at the shortest wait once a restart has held long enough", async () => {
    const { subject, calls } = recovery();

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    await vi.advanceTimersByTimeAsync(DISK_FULL_SAME_OUTAGE_MS);
    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check", "restart", "check", "restart"]);
  });

  it("counts no restart the service refused", async () => {
    const { subject, calls, refuseRestarts } = recovery();
    refuseRestarts();

    for (let i = 0; i < DISK_FULL_RESTART_DELAYS_MS.length + 1; i += 1) {
      subject.faulted();
      await vi.advanceTimersByTimeAsync(FIRST);
    }

    expect(calls.filter((call) => call === "restart")).toHaveLength(
      DISK_FULL_RESTART_DELAYS_MS.length + 1
    );
  });

  it("waits once for faults that land while a wait is already set", async () => {
    const { subject, calls } = recovery();

    subject.faulted();
    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["check", "restart"]);
  });

  it("looks again, after the next wait, at a fault that lands while it is restarting", async () => {
    const calls: string[] = [];
    let finish!: () => void;
    const subject = new StorageRecovery({
      policy: DISK_FULL_RECOVERY,
      checkDiskSpace: async () => {
        calls.push("check");
        return true;
      },
      restart: () => {
        calls.push("restart");
        return new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        });
      },
    });

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    // The replacement store ran out of room before this restart finished.
    subject.faulted();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(calls).toEqual(["check", "restart"]);

    finish();
    await vi.advanceTimersByTimeAsync(SECOND - 1);
    expect(calls).toEqual(["check", "restart"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["check", "restart", "check", "restart"]);
  });

  it("restarts nothing when disposed while it reads free space", async () => {
    let read!: (room: boolean) => void;
    const { subject, calls } = recovery(
      () =>
        new Promise<boolean>((resolve) => {
          read = resolve;
        })
    );

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.dispose();
    read(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["check"]);
  });

  it("keeps a restart that throws contained, and the next fault still gets its wait", async () => {
    const calls: string[] = [];
    let fail = true;
    const subject = new StorageRecovery({
      policy: DISK_FULL_RECOVERY,
      checkDiskSpace: async () => true,
      restart: async () => {
        calls.push("restart");
        if (fail) {
          fail = false;
          throw new Error("store wouldn't open");
        }
        return true;
      },
    });

    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual(["restart", "restart"]);
  });

  it("does nothing once disposed, not even a wait already set", async () => {
    const { subject, calls } = recovery();

    subject.faulted();
    subject.dispose();
    await vi.advanceTimersByTimeAsync(FIRST);
    subject.faulted();
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("StorageRecovery for a busy database (#16840)", () => {
  /** A busy-database recovery, which reads no free space, its restarts recorded. */
  function busy() {
    const calls: string[] = [];
    let finish: (() => void) | null = null;
    let hold = false;
    const subject = new StorageRecovery({
      policy: BUSY_RECOVERY,
      restart: () => {
        calls.push("restart");
        if (!hold) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        });
      },
      now: () => Date.now(),
    });
    return {
      subject,
      calls,
      holdRestarts: () => {
        hold = true;
      },
      finish: () => finish?.(),
    };
  }

  it("restarts after its own shorter waits without reading free space, then leaves the store stopped", async () => {
    const { subject, calls } = busy();
    const waits = BUSY_RESTART_DELAYS_MS;

    for (const wait of waits) {
      subject.faulted();
      await vi.advanceTimersByTimeAsync(wait - 1);
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.length).toBe(before + 1);
    }
    expect(calls).toEqual(waits.map(() => "restart"));

    subject.faulted();
    await vi.advanceTimersByTimeAsync(BUSY_SAME_OUTAGE_MS);
    expect(calls).toHaveLength(waits.length);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("busy"), {
      restarts: waits.length,
    });
  });

  it("spends nothing from a disk-space budget, nor a disk-space fault from its own", async () => {
    const disk = recovery();
    const { subject, calls } = busy();

    for (let i = 0; i < DISK_FULL_RESTART_DELAYS_MS.length; i += 1) {
      disk.subject.faulted();
      await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[i]!);
    }
    subject.faulted();
    await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);

    expect(disk.calls.filter((call) => call === "restart")).toHaveLength(
      DISK_FULL_RESTART_DELAYS_MS.length
    );
    expect(calls).toEqual(["restart"]);
  });

  it("starts a full budget once reset, cancelling a wait already set", async () => {
    const { subject, calls } = busy();
    for (const wait of BUSY_RESTART_DELAYS_MS) {
      subject.faulted();
      await vi.advanceTimersByTimeAsync(wait);
    }
    subject.faulted();
    expect(calls).toHaveLength(BUSY_RESTART_DELAYS_MS.length);

    subject.reset();
    subject.faulted();
    subject.reset();
    await vi.advanceTimersByTimeAsync(BUSY_SAME_OUTAGE_MS);
    expect(calls).toHaveLength(BUSY_RESTART_DELAYS_MS.length);

    subject.faulted();
    await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
    expect(calls).toHaveLength(BUSY_RESTART_DELAYS_MS.length + 1);
  });

  it("counts no restart that finished after a reset toward the next lifetime's budget", async () => {
    const { subject, calls, holdRestarts, finish } = busy();
    holdRestarts();

    subject.faulted();
    await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
    expect(calls).toEqual(["restart"]);
    subject.reset();
    finish();
    await vi.advanceTimersByTimeAsync(0);

    // Had the old restart counted, this fault would wait the second, longer delay.
    subject.faulted();
    await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
    expect(calls).toEqual(["restart", "restart"]);
  });
});
