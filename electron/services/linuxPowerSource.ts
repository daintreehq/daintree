import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const POWER_SUPPLY_DIR = "/sys/class/power_supply";
const POLL_INTERVAL_MS = 30_000;

async function readAttribute(dir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(path.join(dir, name), "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Electron has no battery source on desktop Linux: `isOnBatteryPower()` is a
 * stub that always answers false and `on-battery`/`on-ac` never fire (#12516),
 * so the kernel's power_supply class is read instead.
 *
 * On battery means a system battery is present and no external supply is
 * online, or a UPS reports it is discharging. A peripheral's battery — a
 * wireless mouse — reports scope "Device" and is ignored, or every desktop with
 * one would read as unplugged. Where a laptop exposes no external supply at
 * all, the battery's own status decides.
 *
 * Null when the answer can't be known: the class is unreadable, a supply's
 * type is, or nothing says which way a battery is going. A caller keeps its
 * last answer then rather than guessing either way.
 */
export async function readLinuxOnBattery(root = POWER_SUPPLY_DIR): Promise<boolean | null> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }

  const batteryStatuses: Array<string | null> = [];
  let externalOffline = 0;
  let externalUnknown = false;
  let externalOnline = false;
  let upsDischarging = false;

  for (const name of names) {
    const dir = path.join(root, name);
    const [type, scope] = await Promise.all([
      readAttribute(dir, "type"),
      readAttribute(dir, "scope"),
    ]);
    if (type === null) return null;
    if (scope === "Device") continue;

    if (type === "Battery") {
      batteryStatuses.push(await readAttribute(dir, "status"));
    } else if (type === "UPS") {
      if ((await readAttribute(dir, "status")) === "Discharging") upsDischarging = true;
    } else {
      // 1 is online, 2 is an online programmable supply (USB PD).
      const online = await readAttribute(dir, "online");
      if (online === null) externalUnknown = true;
      else if (online === "0") externalOffline++;
      else externalOnline = true;
    }
  }

  if (upsDischarging) return true;
  if (batteryStatuses.length === 0 || externalOnline) return false;
  if (externalOffline > 0 && !externalUnknown) return true;
  if (batteryStatuses.includes("Discharging")) return true;
  return batteryStatuses.some((status) => status !== null && status !== "Unknown") ? false : null;
}

export interface LinuxPowerSourceWatch {
  /** Reads the source now rather than at the next poll. */
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * Polls, since sysfs attributes raise no change notification a watcher could
 * rely on. `onChange` runs for the first conclusive read and then only when the
 * answer changes; an inconclusive read leaves the last answer standing, and a
 * read overtaken by a later one is dropped.
 */
export function watchLinuxPowerSource(
  onChange: (onBattery: boolean) => void,
  intervalMs = POLL_INTERVAL_MS,
  read: () => Promise<boolean | null> = () => readLinuxOnBattery()
): LinuxPowerSourceWatch {
  let disposed = false;
  let latest = 0;
  let last: boolean | null = null;

  const refresh = async () => {
    const generation = ++latest;
    const onBattery = await read().catch(() => null);
    if (disposed || generation !== latest || onBattery === null || onBattery === last) return;
    last = onBattery;
    try {
      onChange(onBattery);
    } catch (error) {
      console.warn("[LinuxPowerSource] listener threw:", error);
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
