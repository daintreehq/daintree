import { afterEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn((_name: string) => "/Users/g/Library/Application Support/Daintree"),
  getAppPath: vi.fn(() => "/Users/g/src/daintree"),
}));

vi.mock("electron", () => ({ app }));

const pid1 = vi.hoisted(() => ({ comm: "systemd\n" as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((file: string, ...rest: unknown[]) => {
      if (file !== "/proc/1/comm") return (actual.readFileSync as Function)(file, ...rest);
      if (pid1.comm === null) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return pid1.comm;
    }) as typeof actual.readFileSync,
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => "/home/node" },
    homedir: () => "/home/node",
  };
});

import {
  hostLaunchCommand,
  hostLocation,
  hostStartsOnConnect,
  resetHostStartsOnConnectForTests,
} from "../hostLocation.js";

const realPlatform = process.platform;

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  onPlatform(realPlatform);
  app.isPackaged = true;
  pid1.comm = "systemd\n";
  resetHostStartsOnConnectForTests();
});

describe("hostLocation on Linux", () => {
  const uid = process.getuid?.() ?? 1000;

  it("listens in the uid's runtime directory where systemd is PID 1, or PID 1 can't be read", () => {
    onPlatform("linux");
    expect(hostStartsOnConnect()).toBe(false);
    expect(hostLocation().dir).toBe(`/run/user/${uid}/daintree`);
    resetHostStartsOnConnectForTests();
    pid1.comm = null;
    expect(hostLocation().dir).toBe(`/run/user/${uid}/daintree`);
  });

  it("listens under the home's cache where no init system runs, dev and packaged apart", () => {
    onPlatform("linux");
    pid1.comm = "docker-init\n";
    expect(hostStartsOnConnect()).toBe(true);
    expect(hostLocation()).toEqual({
      dir: "/home/node/.cache/daintree/run",
      socketPath: "/home/node/.cache/daintree/run/host.sock",
      discoveryPath: "/home/node/.cache/daintree/run/host.json",
    });
    app.isPackaged = false;
    expect(hostLocation().dir).toBe("/home/node/.cache/daintree-dev/run");
  });

  it("never starts on connect off Linux", () => {
    onPlatform("darwin");
    pid1.comm = "docker-init\n";
    expect(hostStartsOnConnect()).toBe(false);
  });
});

describe("hostLaunchCommand", () => {
  it("tells the bridge which profile a macOS Host listens in", () => {
    onPlatform("darwin");
    expect(hostLaunchCommand()).toEqual([
      process.execPath,
      "--user-data-dir=/Users/g/Library/Application Support/Daintree",
    ]);
    app.isPackaged = false;
    expect(hostLaunchCommand()).toEqual([
      process.execPath,
      "/Users/g/src/daintree",
      "--user-data-dir=/Users/g/Library/Application Support/Daintree",
    ]);
  });

  it("adds nothing on Linux, where the socket isn't in the profile", () => {
    onPlatform("linux");
    expect(hostLaunchCommand()).toEqual([process.execPath]);
  });
});
