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
 * online. A peripheral's battery — a wireless mouse — reports scope "Device"
 * and is ignored, or every desktop with one would read as unplugged. Null when
 * the class can't be read at all.
 */
export async function readLinuxOnBattery(root = POWER_SUPPLY_DIR): Promise<boolean | null> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }

  let hasBattery = false;
  let externalOnline = false;
  for (const name of names) {
    const dir = path.join(root, name);
    const [type, scope] = await Promise.all([
      readAttribute(dir, "type"),
      readAttribute(dir, "scope"),
    ]);
    if (type === null || scope === "Device") continue;
    if (type === "Battery") {
      hasBattery = true;
    } else if ((await readAttribute(dir, "online")) === "1") {
      externalOnline = true;
    }
  }
  return hasBattery && !externalOnline;
}

export interface LinuxPowerSourceWatch {
  /** Reads the source now rather than at the next poll. */
  refresh(): void;
  dispose(): void;
}

/**
 * Polls, since sysfs attributes raise no change notification a watcher could
 * rely on. `onChange` runs for the first successful read and then only when the
 * answer changes; a read that fails leaves the last answer standing.
 */
export function watchLinuxPowerSource(
  onChange: (onBattery: boolean) => void,
  intervalMs = POLL_INTERVAL_MS,
  root = POWER_SUPPLY_DIR
): LinuxPowerSourceWatch {
  let disposed = false;
  let last: boolean | null = null;

  const refresh = () => {
    void readLinuxOnBattery(root)
      .then((onBattery) => {
        if (disposed || onBattery === null || onBattery === last) return;
        last = onBattery;
        onChange(onBattery);
      })
      .catch((error: unknown) => {
        console.warn("[PowerSaveBlocker] Linux power source listener threw:", error);
      });
  };

  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
