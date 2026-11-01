import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { formatAttachPreamble } from "../../host/attachStdio.js";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import type { StreamCommandChild } from "../commandStreamTransport.js";
import { HostModeOffError, TransportError, UnusableConnectionError } from "../transport.js";
import {
  WslTransport,
  buildWslAttachArgv,
  buildWslDiscoveryScript,
  type WslTransportOptions,
} from "../wslTransport.js";

const TOKEN = "ab".repeat(32);
const WSL = "C:\\Windows\\System32\\wsl.exe";
const HOST_COMMAND = ["/tmp/.mount_Daintr1/daintree"];
const DEV_HOST_COMMAND = ["/home/dt/dt-src/node_modules/electron/dist/electron", "/home/dt/dt-src"];

const discovery = (command: string[] | null = HOST_COMMAND) =>
  JSON.stringify({
    version: 1,
    socketPath: "/run/user/1000/daintree/host.sock",
    token: TOKEN,
    pid: 4242,
    ...(command && { command }),
  });

const result = (partial: Partial<CommandResult>): CommandResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  spawnError: null,
  timedOut: false,
  ...partial,
});

class FakeBridge extends EventEmitter implements StreamCommandChild {
  stdin = new Writable({ write: (_c, _e, cb) => cb() });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
}

function setup(
  replies: CommandResult[],
  overrides: Partial<WslTransportOptions> = {}
): {
  transport: WslTransport;
  runs: Array<readonly string[]>;
  spawns: string[][];
} {
  const runs: Array<readonly string[]> = [];
  const spawns: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    runs.push(args);
    return replies.shift() ?? result({ code: 3 });
  };
  const transport = new WslTransport({
    distro: "Ubuntu-24.04",
    run,
    wslPath: WSL,
    spawn: (_wsl, args) => {
      spawns.push(args);
      const bridge = new FakeBridge();
      setImmediate(() => bridge.stdout.write(formatAttachPreamble(TOKEN)));
      return bridge;
    },
    ...overrides,
  });
  return { transport, runs, spawns };
}

const signal = () => new AbortController().signal;

describe("buildWslDiscoveryScript", () => {
  it("looks in each runtime directory for a live Host only", () => {
    const script = buildWslDiscoveryScript(["daintree", "daintree-dev"]);
    expect(script).toContain('for n in daintree daintree-dev; do d="/run/user/$u/$n"');
    expect(script).toContain('[ -S "$d/host.sock" ]');
    expect(script).toContain('kill -0 "$p"');
    expect(script.endsWith("exit 3")).toBe(true);
  });

  it("splices in only plain directory names", () => {
    expect(() => buildWslDiscoveryScript(["daintree; rm -rf ~"])).toThrow();
    expect(() => buildWslDiscoveryScript([])).toThrow();
  });
});

describe("WslTransport", () => {
  it("reads the live Host's discovery file, then starts its bridge headless and display-free", async () => {
    const keepalive = vi.fn();
    const { transport, runs, spawns } = setup([result({ stdout: discovery() })], { keepalive });
    const connection = await transport.open(signal());
    expect(connection.token).toBe(TOKEN);
    expect(keepalive).toHaveBeenCalledWith("Ubuntu-24.04");
    expect(runs[0]!.slice(0, 7)).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      "~",
      "--exec",
      "/bin/sh",
      "-c",
    ]);
    expect(spawns).toEqual([
      [
        "-d",
        "Ubuntu-24.04",
        "--cd",
        "~",
        "--exec",
        "/usr/bin/env",
        "-u",
        "DISPLAY",
        "-u",
        "WAYLAND_DISPLAY",
        "/tmp/.mount_Daintr1/daintree",
        "--attach-stdio",
        "--ozone-platform=headless",
      ],
    ]);
    await connection.dispose();
  });

  it("passes a development Host's app folder along with its executable", () => {
    expect(buildWslAttachArgv(DEV_HOST_COMMAND).slice(5)).toEqual([
      ...DEV_HOST_COMMAND,
      "--attach-stdio",
      "--ozone-platform=headless",
    ]);
  });

  it("starts a Host that isn't listening, once, and connects after", async () => {
    for (const options of [undefined, { mayStart: true }]) {
      const ensureRunning = vi.fn(async () => true);
      const { transport, spawns } = setup([result({ code: 3 }), result({ stdout: discovery() })], {
        ensureRunning,
      });
      const connection = await transport.open(signal(), options);
      expect(ensureRunning).toHaveBeenCalledTimes(1);
      expect(spawns).toHaveLength(1);
      await connection.dispose();
    }
  });

  it("starts nothing while the dial says the Host may not be started (it said it is restarting)", async () => {
    const ensureRunning = vi.fn(async () => true);
    const { transport, runs, spawns } = setup([result({ code: 3 })], { ensureRunning });
    await expect(transport.open(signal(), { mayStart: false })).rejects.toBeInstanceOf(
      HostModeOffError
    );
    expect(ensureRunning).not.toHaveBeenCalled();
    // The one discovery read, and no second look after it.
    expect(runs).toHaveLength(1);
    expect(spawns).toHaveLength(0);
  });

  it("says Host mode is off when nothing can start it", async () => {
    const { transport } = setup([result({ code: 3 })], { ensureRunning: async () => false });
    await expect(transport.open(signal())).rejects.toBeInstanceOf(HostModeOffError);
    const bare = setup([result({ code: 3 })]).transport;
    await expect(bare.open(signal())).rejects.toBeInstanceOf(HostModeOffError);
  });

  it("reports wsl.exe's own words for a distro that isn't there, and never starts anything", async () => {
    const ensureRunning = vi.fn(async () => true);
    const { transport, spawns } = setup(
      [
        result({
          code: 4294967295,
          stdout:
            "There is no distribution with the supplied name.\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n",
        }),
      ],
      { ensureRunning }
    );
    const error = await transport.open(signal()).catch((e: unknown) => e);
    // Nothing a retry does differently changes this: the link waits for a Connect.
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect((error as TransportError).message).toBe("Ubuntu-24.04 isn't installed in WSL");
    expect((error as TransportError).detail).toContain("WSL_E_DISTRO_NOT_FOUND");
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  it("says WSL is missing when wsl.exe can't be started", async () => {
    const { transport } = setup([result({ code: null, spawnError: "spawn wsl.exe ENOENT" })]);
    const error = await transport.open(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect(error).toMatchObject({
      message: "WSL isn't available on this PC",
      detail: "spawn wsl.exe ENOENT",
    });
  });

  it("retries other wsl.exe failures: a distro that failed to start may start next time", async () => {
    const { transport } = setup([
      result({
        code: 4294967295,
        stdout: "The operation timed out.\nError code: Wsl/Service/0x8007045b\n",
      }),
    ]);
    const error = await transport.open(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(UnusableConnectionError);
    expect((error as TransportError).message).toBe("Couldn't reach Ubuntu-24.04 through WSL");
  });

  it("refuses a launch command it won't run, and a discovery file that isn't one", async () => {
    const relative = setup([result({ stdout: discovery(["daintree"]) })]).transport;
    await expect(relative.open(signal())).rejects.toMatchObject({
      message: "The Host in WSL didn't say how to start its attach bridge",
    });
    const none = setup([result({ stdout: discovery(null) })]).transport;
    await expect(none.open(signal())).rejects.toMatchObject({ detail: null });
    const garbage = setup([result({ stdout: "not json" })]).transport;
    await expect(garbage.open(signal())).rejects.toMatchObject({
      message: "Host discovery file is not valid",
    });
  });

  it("refuses a distro name wsl.exe could read as an option", () => {
    expect(
      () =>
        new WslTransport({
          distro: "--system",
          run: async () => result({}),
        })
    ).toThrow(/Not a usable WSL distribution/);
  });
});
