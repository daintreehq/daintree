import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLinuxOnBattery, watchLinuxPowerSource } from "../linuxPowerSource.js";

/** Long enough for a refresh's reads against a temp dir to have settled. */
const READ_SETTLE_MS = 20;

let root: string;

async function supply(name: string, attributes: Record<string, string>): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [key, value] of Object.entries(attributes)) {
    await writeFile(path.join(dir, key), `${value}\n`);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "power-supply-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readLinuxOnBattery", () => {
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

  it("counts a USB-C supply that is online as external power", async () => {
    await supply("BAT0", { type: "Battery" });
    await supply("ucsi-source-psy-USBC000:001", { type: "USB", online: "1" });

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

  it("reports nothing when the class cannot be read", async () => {
    await expect(readLinuxOnBattery(path.join(root, "missing"))).resolves.toBeNull();
  });
});

describe("watchLinuxPowerSource", () => {
  it("reports the first reading and then only changes", async () => {
    await supply("BAT0", { type: "Battery" });
    await supply("AC", { type: "Mains", online: "1" });
    const onChange = vi.fn();
    const watch = watchLinuxPowerSource(onChange, 60_000, root);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(false));

    watch.refresh();
    await supply("AC", { online: "0" });
    watch.refresh();
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true));
    expect(onChange).toHaveBeenCalledTimes(2);

    watch.dispose();
  });

  it("keeps the last reading when a read fails, and reports nothing after dispose", async () => {
    await supply("BAT0", { type: "Battery" });
    await supply("AC", { type: "Mains", online: "0" });
    const onChange = vi.fn();
    const watch = watchLinuxPowerSource(onChange, 60_000, root);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(true));

    await rm(root, { recursive: true, force: true });
    watch.refresh();
    await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS));
    expect(onChange).toHaveBeenCalledTimes(1);

    await supply("AC", { type: "Mains", online: "1" });
    watch.dispose();
    watch.refresh();
    await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
