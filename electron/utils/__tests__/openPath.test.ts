import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellMock = vi.hoisted(() => ({ openPath: vi.fn<(target: string) => Promise<string>>() }));
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ shell: shellMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { XDG_OPEN_EXIT_WAIT_MS, openWithDefaultApp } from "../openPath.js";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

describe("openWithDefaultApp", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  let child: FakeChild;

  beforeEach(() => {
    vi.useFakeTimers();
    shellMock.openPath.mockReset();
    child = new FakeChild();
    spawnMock.mockReset().mockReturnValue(child);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("hands the file to xdg-open, detached and with no stdio, instead of shell.openPath", async () => {
    const opening = openWithDefaultApp("/home/u/notes.txt");
    child.emit("exit", 0, null);

    await expect(opening).resolves.toBe("");
    expect(shellMock.openPath).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "xdg-open",
      ["/home/u/notes.txt"],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
  });

  it("leaves Daintree's own launcher variables out of the opened app's environment", async () => {
    process.env.CHROME_DESKTOP = "daintree.desktop";
    process.env.APPIMAGE = "/home/u/Daintree.AppImage";
    process.env.APPDIR = "/tmp/.mount_DaintrXYZ";
    process.env.LD_LIBRARY_PATH = "/tmp/.mount_DaintrXYZ/usr/lib:/opt/lib";
    const opening = openWithDefaultApp("/home/u/notes.txt");
    child.emit("exit", 0, null);
    await opening;

    const env = spawnMock.mock.calls[0][2].env as Record<string, string | undefined>;
    expect(env.CHROME_DESKTOP).toBeUndefined();
    expect(env.APPIMAGE).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBe("/opt/lib");
  });

  it.each([
    [2, "The file doesn't exist"],
    [3, "No tool for opening this file was found"],
    [4, "No application could open this file"],
    [9, "xdg-open exited with status 9"],
  ])("reports xdg-open's exit status %i", async (code, message) => {
    const opening = openWithDefaultApp("/home/u/missing.txt");
    child.emit("exit", code, null);
    await expect(opening).resolves.toBe(message);
  });

  it("says so when xdg-open isn't installed", async () => {
    const opening = openWithDefaultApp("/home/u/notes.txt");
    child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    await expect(opening).resolves.toMatch(/xdg-open isn't installed/);
  });

  it("counts an xdg-open still running after the wait as launched, without holding the app open", async () => {
    let result: string | undefined;
    void openWithDefaultApp("/home/u/notes.txt").then((value) => (result = value));

    await vi.advanceTimersByTimeAsync(XDG_OPEN_EXIT_WAIT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("");
    expect(child.unref).toHaveBeenCalled();

    // A late exit changes nothing.
    child.emit("exit", 4, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("");
  });

  it("never unrefs or re-settles once xdg-open has answered", async () => {
    const opening = openWithDefaultApp("/home/u/notes.txt");
    child.emit("exit", 1, null);
    await expect(opening).resolves.toBe("xdg-open was given an invalid command line");
    await vi.advanceTimersByTimeAsync(XDG_OPEN_EXIT_WAIT_MS * 2);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("reports a signal, a spawn error and a synchronous spawn failure", async () => {
    let opening = openWithDefaultApp("/home/u/a.txt");
    child.emit("exit", null, "SIGKILL");
    await expect(opening).resolves.toBe("xdg-open was stopped by SIGKILL");

    child = new FakeChild();
    spawnMock.mockReturnValue(child);
    opening = openWithDefaultApp("/home/u/b.txt");
    child.emit("error", Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(opening).resolves.toBe("Couldn't run xdg-open: EACCES");

    spawnMock.mockImplementation(() => {
      throw new Error("E2BIG");
    });
    await expect(openWithDefaultApp("/home/u/c.txt")).resolves.toBe("Couldn't run xdg-open: E2BIG");
  });

  it("passes xdg-open an absolute path, so a leading dash can't read as an option", async () => {
    const opening = openWithDefaultApp("-data/logs/daintree.log");
    child.emit("exit", 0, null);
    await opening;
    expect(spawnMock.mock.calls[0][1][0]).toMatch(/^\/.*\/-data\/logs\/daintree\.log$/);
  });

  it("keeps the desktop session's variables and leaves Daintree's own environment alone", async () => {
    process.env.DISPLAY = ":1";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    process.env.CHROME_DESKTOP = "daintree.desktop";
    const opening = openWithDefaultApp("/home/u/notes.txt");
    child.emit("exit", 0, null);
    await opening;

    const env = spawnMock.mock.calls[0][2].env as Record<string, string | undefined>;
    expect(env.DISPLAY).toBe(":1");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    expect(process.env.CHROME_DESKTOP).toBe("daintree.desktop");
  });

  it("keeps Electron's shell.openPath off Linux", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const opening = Promise.resolve("");
    shellMock.openPath.mockReturnValue(opening);
    expect(openWithDefaultApp("/Users/u/notes.txt")).toBe(opening);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
