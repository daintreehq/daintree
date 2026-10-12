import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => childProcessMock);

import {
  SOUND_SETTINGS_START_GRACE_MS,
  linuxSoundSettingsLaunchers,
  openLinuxSoundSettings,
} from "../linuxSoundSettings.js";

const commands = (desktop: string | undefined) =>
  linuxSoundSettingsLaunchers(desktop).map((l) => [l.command, ...l.args].join(" "));

/** Each spawn gets the next scripted child; the script decides what it does. */
function scriptChildren(...behaviours: Array<(child: FakeChild) => void>) {
  const children: FakeChild[] = [];
  for (const behave of behaviours) {
    childProcessMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => behave(child));
      return child;
    });
  }
  return children;
}

const missing = (child: FakeChild) =>
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
const refuses = (child: FakeChild) => child.emit("exit", 1, null);
const handsOff = (child: FakeChild) => child.emit("exit", 0, null);
const keepsRunning = () => {};

describe("linuxSoundSettingsLaunchers", () => {
  it("tries the session desktop's own sound panel before any standalone mixer", () => {
    expect(commands("ubuntu:GNOME")[0]).toBe("gnome-control-center sound");
    expect(commands("KDE").slice(0, 2)).toEqual([
      "systemsettings kcm_pulseaudio",
      "systemsettings5 kcm_pulseaudio",
    ]);
    expect(commands("X-Cinnamon")[0]).toBe("cinnamon-settings sound");
    expect(commands("MATE")[0]).toBe("mate-volume-control");
    expect(commands("Budgie:GNOME").slice(0, 2)).toEqual([
      "budgie-control-center sound",
      "gnome-control-center sound",
    ]);
  });

  it("never offers GNOME's panel where it refuses to run, and always ends on a mixer", () => {
    for (const desktop of ["XFCE", "KDE", "sway", undefined]) {
      const list = commands(desktop);
      expect(list).not.toContain("gnome-control-center sound");
      expect(list).toContain("pavucontrol");
    }
  });

  it("lists each launcher once", () => {
    const list = commands("LXQt");
    expect(new Set(list).size).toBe(list.length);
    expect(list[0]).toBe("pavucontrol-qt");
  });
});

describe("openLinuxSoundSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    childProcessMock.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves past a missing app and one that exits with an error to the first that stays up", async () => {
    const failures: string[] = [];
    const children = scriptChildren(missing, refuses, keepsRunning);

    const result = openLinuxSoundSettings("XFCE", (launcher) => failures.push(launcher.command));
    await vi.advanceTimersByTimeAsync(SOUND_SETTINGS_START_GRACE_MS);

    await expect(result).resolves.toBe(true);
    expect(failures).toEqual(["pavucontrol", "pwvucontrol"]);
    expect(childProcessMock.spawn).toHaveBeenLastCalledWith(
      "pavucontrol-qt",
      [],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(children.every((child) => child.unref.mock.calls.length === 1)).toBe(true);
  });

  it("starts the settings app without Daintree's desktop entry or an AppImage's libraries", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.CHROME_DESKTOP = "daintree.desktop";
    process.env.APPIMAGE = "/home/u/Daintree.AppImage";
    process.env.APPDIR = "/tmp/.mount_DaintrABC";
    process.env.LD_LIBRARY_PATH = "/tmp/.mount_DaintrABC/usr/lib";
    try {
      scriptChildren(keepsRunning);
      const result = openLinuxSoundSettings("GNOME");
      await vi.advanceTimersByTimeAsync(SOUND_SETTINGS_START_GRACE_MS);
      await expect(result).resolves.toBe(true);

      const env = childProcessMock.spawn.mock.calls[0][2].env as Record<string, string | undefined>;
      expect(env.CHROME_DESKTOP).toBeUndefined();
      expect(env.APPIMAGE).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      for (const name of ["CHROME_DESKTOP", "APPIMAGE", "APPDIR", "LD_LIBRARY_PATH"]) {
        delete process.env[name];
      }
    }
  });

  it("counts a clean exit as open: a single-instance app handed off to its window", async () => {
    scriptChildren(handsOff);
    const result = openLinuxSoundSettings("XFCE");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(true);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
  });

  it("reports false when nothing starts, including a spawn that throws outright", async () => {
    childProcessMock.spawn.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    scriptChildren(missing, missing);

    const result = openLinuxSoundSettings(undefined);
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toBe(false);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(3);
  });

  it("keeps a late child error from becoming an uncaught exception", async () => {
    const children = scriptChildren(keepsRunning);
    const result = openLinuxSoundSettings("XFCE");
    await vi.advanceTimersByTimeAsync(SOUND_SETTINGS_START_GRACE_MS);
    await expect(result).resolves.toBe(true);

    const [child] = children;
    expect(child.listenerCount("error")).toBeGreaterThan(0);
    expect(() => child.emit("error", new Error("late"))).not.toThrow();
  });
});
