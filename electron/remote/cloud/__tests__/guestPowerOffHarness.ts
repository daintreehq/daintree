import { HostIdleTracker } from "../../host/HostIdleTracker.js";
import { GuestPowerOffKeeper } from "../../host/GuestPowerOffKeeper.js";
import {
  createGuestPowerOffSystem,
  type CommandRun,
  type MetadataFetch,
} from "../../host/guestPowerOffSystem.js";

export const IDLE_MINUTES = 30;
export const MINUTE = 60_000;

/**
 * A host on a cloud machine, as Host mode runs one: a real idle clock, the
 * real power-off keeper and the real OS adapter, with the machine's metadata
 * server and its `sudo systemctl poweroff` played by the test.
 */
export function cloudMachineHost(options: {
  metadata: MetadataFetch;
  /** What the OS does when the host powers it off. */
  powerOff: () => void;
}) {
  const clock = { wall: Date.parse("2026-11-18T09:00:00Z"), mono: 1_000 };
  let busy = false;
  const powerOffs: string[][] = [];
  const files = new Map<string, string>([
    ["/proc/sys/kernel/random/boot_id", "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b\n"],
  ]);
  const run: CommandRun = async (file, args) => {
    if (file !== "/usr/bin/sudo") return { code: 127, stderr: "not found" };
    if (args.includes("-l")) return { code: 0, stderr: "" };
    powerOffs.push([file, ...args]);
    options.powerOff();
    return { code: 0, stderr: "" };
  };
  const system = createGuestPowerOffSystem({
    armFile: "/home/ubuntu/.config/Daintree/guest-power-off.json",
    platform: "linux",
    fetch: options.metadata,
    run,
    exists: async (file) => file === "/usr/bin/systemctl",
    readFile: async (file) => {
      const content = files.get(file);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async (file, data) => {
      files.set(file, data);
    },
    removeFile: async (file) => {
      files.delete(file);
    },
  });
  const tracker = new HostIdleTracker({
    read: async () => ({ agents: { active: busy ? 1 : 0, unreadable: 0 }, shellViews: false }),
    idleAfterMinutes: () => IDLE_MINUTES,
    clock: () => ({ ...clock }),
  });
  const makeKeeper = () =>
    new GuestPowerOffKeeper({
      idle: tracker,
      system,
      now: () => clock.wall,
      tickMs: 24 * 60 * MINUTE,
    });
  let keeper = makeKeeper();
  return {
    get keeper() {
      return keeper;
    },
    files,
    /** Host mode starting again in the same boot, with no Shell: only what it saved remains. */
    async restart() {
      keeper.dispose();
      keeper = makeKeeper();
      await keeper.restore();
    },
    tracker,
    powerOffs,
    setBusy(next: boolean) {
      busy = next;
    },
    /** Time passing on the machine, with the idle check and the keeper's pass their timers would run. */
    async pass(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
      await tracker.check();
      await keeper.tick();
    },
    dispose() {
      keeper.dispose();
      tracker.dispose();
    },
  };
}
