import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readLinuxOnBattery,
  watchLinuxPowerSource,
  type LinuxPowerSourceWatch,
} from "../linuxPowerSource.js";

let root: string;

async function supply(name: string, attributes: Record<string, string>): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [key, value] of Object.entries(attributes)) {
    await writeFile(path.join(dir, key), `${value}\n`);
  }
}

describe("readLinuxOnBattery", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "power-supply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a laptop with its adapter unplugged as on battery", async () => {
    await supply("BAT0", { type: "Battery", scope: "System", status: "Discharging" });
    await supply("AC", { type: "Mains", online: "0" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(true);
  });

  it("reads a laptop with its adapter online as on AC", async () => {
    await supply("BAT0", { type: "Battery", status: "Charging" });
    await supply("AC", { type: "Mains", online: "1" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(false);
  });

  it("counts a USB supply as online for any non-zero value", async () => {
    await supply("BAT0", { type: "Battery", status: "Charging" });
    await supply("ucsi-source-psy-USBC000:001", { type: "USB", online: "2" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(false);
  });

  it("reads a machine with no battery as on AC", async () => {
    await supply("AC", { type: "Mains", online: "1" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(false);
  });

  it("ignores a peripheral's battery", async () => {
    await supply("hidpp_battery_0", { type: "Battery", scope: "Device", status: "Discharging" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(false);
  });

  it("reads a desktop whose UPS is discharging as on battery", async () => {
    await supply("ups", { type: "UPS", status: "Discharging" });

    await expect(readLinuxOnBattery(root)).resolves.toBe(true);
  });

  it("falls back to the battery's status when there is no adapter to read", async () => {
    await supply("BAT0", { type: "Battery", status: "Charging" });
    await expect(readLinuxOnBattery(root)).resolves.toBe(false);

    await supply("BAT0", { status: "Discharging" });
    await expect(readLinuxOnBattery(root)).resolves.toBe(true);

    await supply("BAT0", { status: "Unknown" });
    await expect(readLinuxOnBattery(root)).resolves.toBeNull();
  });

  it("reports nothing when a supply's type cannot be read", async () => {
    await supply("BAT0", { status: "Discharging" });
    await supply("AC", { type: "Mains", online: "1" });

    await expect(readLinuxOnBattery(root)).resolves.toBeNull();
  });

  it("reports nothing when the class cannot be read", async () => {
    await expect(readLinuxOnBattery(path.join(root, "missing"))).resolves.toBeNull();
  });
});

describe("watchLinuxPowerSource", () => {
  const INTERVAL_MS = 30_000;
  let watch: LinuxPowerSourceWatch | null = null;
  let reads: Array<(value: boolean | null) => void>;
  const read = () =>
    new Promise<boolean | null>((resolve) => {
      reads.push(resolve);
    });

  beforeEach(() => {
    vi.useFakeTimers();
    reads = [];
  });

  afterEach(() => {
    watch?.dispose();
    watch = null;
    vi.useRealTimers();
  });

  async function settle(index: number, value: boolean | null) {
    reads[index]!(value);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("reports the first reading and then only changes", async () => {
    const onChange = vi.fn();
    watch = watchLinuxPowerSource(onChange, INTERVAL_MS, read);

    await settle(0, false);
    expect(onChange).toHaveBeenCalledWith(false);

    void watch.refresh();
    await settle(1, false);
    void watch.refresh();
    await settle(2, true);

    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });

  it("reads again on every poll", async () => {
    watch = watchLinuxPowerSource(vi.fn(), INTERVAL_MS, read);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(reads).toHaveLength(3);
  });

  it("drops a read that a later one overtook", async () => {
    const onChange = vi.fn();
    watch = watchLinuxPowerSource(onChange, INTERVAL_MS, read);
    await settle(0, false);

    void watch.refresh();
    void watch.refresh();
    await settle(2, true);
    await settle(1, false);

    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });

  it("keeps the last reading when a read is inconclusive or fails", async () => {
    const onChange = vi.fn();
    watch = watchLinuxPowerSource(onChange, INTERVAL_MS, () =>
      reads.length === 0 ? read() : Promise.reject(new Error("EIO"))
    );
    await settle(0, true);

    await watch.refresh();
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it("reports nothing once disposed", async () => {
    const onChange = vi.fn();
    watch = watchLinuxPowerSource(onChange, INTERVAL_MS, read);

    watch.dispose();
    await settle(0, true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(onChange).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });
});
