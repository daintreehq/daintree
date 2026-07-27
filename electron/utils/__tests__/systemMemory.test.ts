import { afterEach, describe, expect, it } from "vitest";
import {
  getSystemMemoryThresholds,
  readAvailableSystemMemoryMb,
  readSystemMemorySnapshot,
} from "../systemMemory.js";

describe("systemMemory thresholds", () => {
  it("preserves proportional thresholds on an 8 GB machine", () => {
    expect(getSystemMemoryThresholds(8 * 1024)).toEqual({
      criticalMb: 8 * 1024 * 0.1,
      warningMb: 8 * 1024 * 0.2,
    });
  });

  it("caps thresholds on high-memory machines", () => {
    expect(getSystemMemoryThresholds(64 * 1024)).toEqual({
      criticalMb: 1024,
      warningMb: 2048,
    });
  });
});

describe("readSystemMemorySnapshot", () => {
  const proc = process as unknown as {
    getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
  };
  const original = proc.getSystemMemoryInfo;

  function stub(value: unknown) {
    Object.defineProperty(process, "getSystemMemoryInfo", { configurable: true, value });
  }

  afterEach(() => {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: original,
    });
  });

  it("treats a zero total as an API artifact rather than critical pressure", () => {
    // A transiently zeroed struct must not read as "no memory available" — that
    // would collapse every cached view and downgrade the profile on a glitch.
    stub(() => ({ free: 0, purgeable: 0, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBeNull();
  });

  it("rejects a malformed reading instead of coercing the missing field to zero", () => {
    // `free: -1` with a plausible purgeable would otherwise sum back into a
    // healthy-looking figure.
    stub(() => ({ free: -1024, purgeable: 4096, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBeNull();

    for (const bad of [{}, { free: "lots" }, { free: Number.NaN }]) {
      stub(() => bad);
      expect(readAvailableSystemMemoryMb()).toBeNull();
    }
    stub(undefined);
    expect(readAvailableSystemMemoryMb()).toBeNull();
    stub(() => {
      throw new Error("boom");
    });
    expect(readAvailableSystemMemoryMb()).toBeNull();
  });

  it("adds purgeable to free and ignores a malformed purgeable figure", () => {
    // macOS holds reclaimable pages as purgeable rather than free, so dropping
    // it would fire false positives on every healthy Mac.
    stub(() => ({ free: 512 * 1024, purgeable: 256 * 1024, total: 8 * 1024 * 1024 }));
    // totalMb comes from os.totalmem(), not the stubbed struct, so only the
    // derived components are assertable here.
    const snapshot = readSystemMemorySnapshot();
    expect(snapshot).toMatchObject({ freeMb: 512, purgeableMb: 256, availableMb: 768 });
    expect(readAvailableSystemMemoryMb()).toBe(768);

    stub(() => ({ free: 512 * 1024, purgeable: Number.NaN, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBe(512);
  });
});
