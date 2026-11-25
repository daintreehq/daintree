import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHostsEvent } from "../../../../shared/types/ipc/remoteHosts.js";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import { HostSetupService, type HostSetupDeps } from "../HostSetupService.js";
import type { ClientBuild } from "../installPlan.js";

const CLIENT: ClientBuild = {
  platform: "darwin",
  arch: "arm64",
  version: "1.4.0",
  commit: "abcdef0123",
  channel: "stable",
  bundle: { kind: "none" },
};

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});

const LINUX_NO_UNIT = [
  "@@dt:uname Linux x86_64",
  "@@dt:install deb /opt/Daintree",
  "@@dt:version 1.3.0",
  "@@dt:unit no",
  "@@dt:end",
].join("\n");

const MAC_RUNNING_OLD = [
  "@@dt:uname Darwin arm64",
  "@@dt:install app-bundle /Applications/Daintree.app",
  "@@dt:version 1.3.0",
  "@@dt:running yes",
  "@@dt:listening yes",
  "@@dt:download yes",
  "@@dt:end",
].join("\n");

let clientDir: string;

beforeEach(async () => {
  clientDir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-setup-"));
});

afterEach(async () => {
  await fs.rm(clientDir, { recursive: true, force: true });
});

function service(
  probeOutput: string,
  overrides: Partial<HostSetupDeps> = {}
): {
  setup: HostSetupService;
  calls: Array<[string, readonly string[]]>;
  events: RemoteHostsEvent[];
} {
  const calls: Array<[string, readonly string[]]> = [];
  const events: RemoteHostsEvent[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, args]);
    const script = args[args.length - 1] ?? "";
    if (command === "ssh" && script.includes("@@dt:uname")) return ok(probeOutput);
    return ok();
  };
  const setup = new HostSetupService({
    run,
    clientDir,
    platform: "darwin",
    knownConnections: () => [],
    clientBuild: () => CLIENT,
    restartImpact: async (hostId) => ({
      detail: null,
      agents: hostId ? { working: 1, waiting: 0 } : null,
    }),
    download: async () => {},
    emit: (event) => events.push(event),
    sleep: async () => {},
    ...overrides,
  });
  return { setup, calls, events };
}

describe("HostSetupService", () => {
  it("reads the ssh config's aliases only when a scan asks, with that scan's signal", async () => {
    const sshConfigAliases = vi.fn(async () => ["build-box"]);
    const { setup } = service(LINUX_NO_UNIT, { platform: "linux", sshConfigAliases });
    expect(sshConfigAliases).not.toHaveBeenCalled();
    const abort = new AbortController();
    const found = await setup.discover(abort.signal);
    expect(sshConfigAliases).toHaveBeenCalledWith(abort.signal);
    expect(found.map((host) => [host.name, host.source])).toEqual([["build-box", "ssh-config"]]);
  });

  it("probes over the shared ControlMaster in BatchMode", async () => {
    const { setup, calls } = service(LINUX_NO_UNIT);
    const result = await setup.probe({ connection: { kind: "ssh", target: "greg@bigbox" } });
    expect(result).toMatchObject({ reachable: true, platform: "linux", matchesClient: false });
    const [command, args] = calls[0]!;
    expect(command).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args.at(-2)).toBe("greg@bigbox");
    expect(args.at(-1)).toMatch(/^sh -c '/);
  });

  it("refuses an SSH target that could be read as an option", async () => {
    const { setup, calls } = service(LINUX_NO_UNIT);
    await expect(
      setup.probe({ connection: { kind: "ssh", target: "-oProxyCommand=evil" } })
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(calls).toEqual([]);
  });

  it("runs an install as an operation, pushes its outcome as events and keeps it for status", async () => {
    const { setup, events } = service(MAC_RUNNING_OLD);
    const result = await setup.install({
      opId: "op-7",
      connection: { kind: "ssh", target: "studio" },
    });
    const unknown = { detail: null, agents: null };
    expect(result).toEqual({ status: "needs-confirmation", impact: unknown });
    expect(events.at(-1)).toMatchObject({
      type: "install-settled",
      opId: "op-7",
      connection: { kind: "ssh", target: "studio" },
      outcome: {
        status: "succeeded",
        result: { status: "needs-confirmation", impact: unknown },
      },
    });
    expect(events.some((e) => e.type === "install-progress")).toBe(true);
    expect(setup.installStatus({ opId: "op-7" })).toMatchObject({ status: "succeeded" });
    expect(setup.installStatus({ opId: "never" })).toEqual({ status: "unknown" });
  });

  it("requires an operation id and a known whileWorking", async () => {
    const { setup } = service(MAC_RUNNING_OLD);
    expect(() =>
      setup.install({ opId: "", connection: { kind: "ssh", target: "studio" } })
    ).toThrow(/opId/);
    expect(() =>
      setup.install({
        opId: "op-1",
        connection: { kind: "ssh", target: "studio" },
        whileWorking: "yolo" as never,
      })
    ).toThrow(/whileWorking/);
    expect(() =>
      setup.install({
        opId: "op-2",
        connection: { kind: "ssh", target: "studio" },
        whileWorking: "proceed",
        confirmed: { detail: "everything" } as never,
      })
    ).toThrow(/confirmed/);
    expect(() =>
      setup.install({
        opId: "op-3",
        connection: { kind: "ssh", target: "studio" },
        allowDowngrade: "yes" as never,
      })
    ).toThrow(/allowDowngrade/);
    for (const applyStaged of [{}, { version: "1.4.0; rm -rf ~" }, "1.4.0"]) {
      expect(() =>
        setup.install({
          opId: "op-4",
          connection: { kind: "ssh", target: "studio" },
          applyStaged: applyStaged as never,
        })
      ).toThrow(/applyStaged/);
    }
  });

  it("bootstraps a fresh Linux host over ssh: the unit on stdin, then a handoff that never starts a backend", async () => {
    const build = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';
    const fresh = [
      "@@dt:uname Linux x86_64",
      "@@dt:install deb /opt/Daintree",
      `@@dt:buildinfo ${build}`,
      "@@dt:unit no",
      "@@dt:linger Linger=yes",
      "@@dt:end",
    ].join("\n");
    const state = JSON.stringify({
      daintreeHostMode: 1,
      pid: 9,
      enabled: true,
      startAtLogin: true,
      startAtLoginInstalled: true,
      startAtLoginError: null,
      keychain: { state: "unavailable", detail: "no keyring (headless)", checked: true },
    });
    const on = fresh
      .replace("@@dt:unit no", "@@dt:unit yes\n@@dt:unitenabled enabled")
      .replace(
        "@@dt:end",
        `@@dt:listening yes\n@@dt:hostpid 9\n@@dt:hostmodestate ${state}\n@@dt:end`
      );
    const outputs = [fresh, on];
    const scripts: Array<{ script: string; input: unknown }> = [];
    const { setup } = service("", {
      run: async (_command, args, options) => {
        const script = args.at(-1) ?? "";
        if (script.includes("@@dt:uname"))
          return ok(outputs.length > 1 ? outputs.shift()! : outputs[0]!);
        scripts.push({ script, input: options?.input });
        if (script.includes("unitsaved")) return ok("@@dt:unitsaved no\n");
        return ok(script.includes("--host-mode-handoff") ? "@@dt:handoff 0\n" : "");
      },
    });
    const result = await setup.startHostMode({ connection: { kind: "ssh", target: "bigbox" } });
    expect(result.probe.hostModeState).toMatchObject({ enabled: true, startAtLogin: true });
    expect(scripts[2]!.input).toMatchObject({ text: expect.stringContaining("[Service]") });
    expect(scripts.map((s) => s.script)).toEqual([
      // The binary's libraries, before anything there is changed.
      expect.stringContaining("@@dt:libs"),
      expect.stringContaining("daintree-setup-backup"),
      expect.stringMatching(/^sh -c '.*systemctl --user enable daintree-host\.service'$/),
      "sh -c 'systemctl --user start daintree-host.service'",
      // The service's restart count when it started, to tell a crash loop from a slow start.
      expect.stringContaining("NRestarts"),
      expect.stringContaining("--host-mode --enable-host-mode --host-mode-handoff"),
    ]);
  });

  it("says why Host mode wasn't turned on when the host's answer can't be read", async () => {
    const calls: string[] = [];
    const { setup } = service("", {
      run: async (_command, args) => {
        calls.push(args.at(-1) ?? "");
        return ok("not a probe");
      },
    });
    await expect(
      setup.startHostMode({ connection: { kind: "ssh", target: "studio" } })
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("Host mode wasn't turned on"),
    });
    // Only the check ran: nothing was changed there.
    expect(calls).toHaveLength(1);
  });

  it("starts no install or Host mode setup on a host being removed or re-pointed", async () => {
    const { setup, calls } = service(MAC_RUNNING_OLD, {
      isRetiring: (connection) => connection.kind === "ssh" && connection.target === "studio",
    });
    const connection = { kind: "ssh", target: "studio" } as const;
    expect(() => setup.install({ opId: "op-retiring", connection })).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
    await expect(setup.startHostMode({ connection })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setup.ensureHostRunning(connection)).resolves.toBe("not-startable");
    expect(calls).toEqual([]);
  });

  it("switches a Mac on through its logged-in session and reads the setting back", async () => {
    const state = JSON.stringify({
      daintreeHostMode: 1,
      pid: 4242,
      enabled: true,
      startAtLogin: true,
      startAtLoginInstalled: true,
      startAtLoginError: null,
      keychain: { state: "ok", detail: "Keychain answered", checked: true },
    });
    const current = MAC_RUNNING_OLD.replace("@@dt:version 1.3.0", "@@dt:version 1.4.0").replace(
      "@@dt:end",
      '@@dt:buildinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}\n@@dt:end'
    );
    const outputs = [
      current.replace("@@dt:listening yes\n", ""),
      current.replace(
        "@@dt:end",
        `@@dt:hostpid 4242\n@@dt:launchagent yes\n@@dt:hostmodestate ${state}\n@@dt:end`
      ),
    ];
    const calls: string[] = [];
    const { setup } = service("", {
      run: async (_command, args) => {
        const script = args.at(-1) ?? "";
        calls.push(script);
        if (script.includes("@@dt:uname"))
          return ok(outputs.length > 1 ? outputs.shift()! : outputs[0]!);
        return ok();
      },
    });
    const result = await setup.startHostMode({ connection: { kind: "ssh", target: "studio" } });
    expect(result.probe.hostModeListening).toBe(true);
    expect(result.probe.hostModeState?.enabled).toBe(true);
    expect(
      calls.some((c) => c.includes("open -n -g -a") && c.includes("--host-mode --enable-host-mode"))
    ).toBe(true);
  });

  describe("startHostMode: the host's link afterwards (#18182)", () => {
    const state = JSON.stringify({
      daintreeHostMode: 1,
      pid: 4242,
      enabled: true,
      startAtLogin: true,
      startAtLoginInstalled: true,
      startAtLoginError: null,
      keychain: { state: "ok", detail: "Keychain answered", checked: true },
    });
    const current = MAC_RUNNING_OLD.replace("@@dt:version 1.3.0", "@@dt:version 1.4.0").replace(
      "@@dt:end",
      '@@dt:buildinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}\n@@dt:end'
    );
    const stopped = current.replace("@@dt:listening yes\n", "");
    const on = current.replace(
      "@@dt:end",
      `@@dt:hostpid 4242\n@@dt:launchagent yes\n@@dt:hostmodestate ${state}\n@@dt:end`
    );
    const connection = { kind: "ssh", target: "studio" } as const;
    const starting = (outputs: string[], open: () => { code: number }) => {
      const onHostModeStarted = vi.fn();
      const launches: string[] = [];
      /** How many times the host's link had been told, at each probe and launch. */
      const toldBy: number[] = [];
      const deps: Partial<HostSetupDeps> = {
        onHostModeStarted,
        run: async (_command, args) => {
          const script = args.at(-1) ?? "";
          toldBy.push(onHostModeStarted.mock.calls.length);
          if (script.includes("@@dt:uname"))
            return ok(outputs.length > 1 ? outputs.shift()! : outputs[0]!);
          if (script.includes("open -n -g -a")) {
            launches.push(script);
            return { ...ok(), ...open() };
          }
          return ok();
        },
      };
      return { deps, onHostModeStarted, launches, toldBy };
    };

    it("says Host mode is on once a start there reads back, and not before", async () => {
      const { deps, onHostModeStarted, launches, toldBy } = starting([stopped, on], () => ({
        code: 0,
      }));
      const { setup } = service("", deps);
      await setup.startHostMode({ connection });
      expect(launches).toEqual([expect.stringContaining("--enable-host-mode")]);
      // Not while launching, nor before the read-back that confirmed it.
      expect(toldBy.length).toBeGreaterThan(2);
      expect(toldBy.every((told) => told === 0)).toBe(true);
      expect(onHostModeStarted).toHaveBeenCalledExactlyOnceWith(connection);
    });

    it("says so for a host found already on, as a second Retry finds it", async () => {
      const { deps, onHostModeStarted, launches } = starting([on], () => ({ code: 0 }));
      const { setup } = service("", deps);
      await setup.startHostMode({ connection });
      expect(launches).toEqual([]);
      expect(onHostModeStarted).toHaveBeenCalledExactlyOnceWith(connection);
    });

    it("says nothing when the start fails, so a parked link stays parked", async () => {
      const { deps, onHostModeStarted, launches } = starting([stopped], () => ({ code: 1 }));
      const { setup } = service("", deps);
      await expect(setup.startHostMode({ connection })).rejects.toMatchObject({
        userMessage: expect.stringContaining("Couldn't start Daintree on"),
      });
      expect(launches).toHaveLength(1);
      expect(onHostModeStarted).not.toHaveBeenCalled();
    });

    it("says nothing about a host that began being removed while it started", async () => {
      let retiring = false;
      const { deps, onHostModeStarted, launches } = starting([stopped, on], () => {
        retiring = true;
        return { code: 0 };
      });
      const { setup } = service("", { ...deps, isRetiring: () => retiring });
      await setup.startHostMode({ connection });
      expect(launches).toHaveLength(1);
      expect(onHostModeStarted).not.toHaveBeenCalled();
    });
  });

  describe("ensureHostRunning: a host whose Daintree stopped", () => {
    const hostState = (enabled: boolean) =>
      JSON.stringify({
        daintreeHostMode: 1,
        pid: 4242,
        enabled,
        startAtLogin: true,
        startAtLoginInstalled: true,
        startAtLoginError: null,
        keychain: { state: "ok", detail: "Keychain answered", checked: true },
      });
    const MAC_STOPPED = (enabled: boolean) =>
      [
        "@@dt:uname Darwin arm64",
        "@@dt:install app-bundle /Applications/Daintree.app",
        "@@dt:version 1.4.0",
        '@@dt:buildinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}',
        "@@dt:download yes",
        `@@dt:hostmodestate ${hostState(enabled)}`,
        "@@dt:end",
      ].join("\n");
    const recording = (outputs: string[]) => {
      const scripts: string[] = [];
      const run: CommandRunner = async (_command, args) => {
        const script = args.at(-1) ?? "";
        scripts.push(script);
        if (script.includes("@@dt:uname"))
          return ok(outputs.length > 1 ? outputs.shift()! : outputs[0]!);
        return ok();
      };
      return { run, scripts };
    };
    const started = (scripts: string[]) =>
      scripts.some((c) => c.includes("open -n -g -a") || c.includes("systemctl --user start"));
    const probes = (scripts: string[]) => scripts.filter((c) => c.includes("@@dt:uname")).length;
    const studio = { kind: "ssh", target: "studio" } as const;
    const MAC_QUIT = () =>
      MAC_STOPPED(true).replace(
        `@@dt:hostmodestate ${hostState(true)}`,
        `@@dt:hostmodestate ${JSON.stringify({ ...JSON.parse(hostState(true)), pid: 0, stopped: true })}`
      );
    const MAC_STARTED = () =>
      MAC_STOPPED(true).replace(
        "@@dt:end",
        "@@dt:running yes\n@@dt:listening yes\n@@dt:hostpid 4242\n@@dt:launchagent yes\n@@dt:end"
      );
    /** A probe that never finished: ssh's output was cut short. */
    const CUT_SHORT = "@@dt:uname Darwin arm64\n";
    const LINUX_OFF = [
      "@@dt:uname Linux x86_64",
      "@@dt:install deb /opt/Daintree",
      "@@dt:version 1.4.0",
      "@@dt:unit yes",
      `@@dt:hostmodestate ${hostState(false)}`,
      "@@dt:end",
    ].join("\n");
    /** Daintree removed, its last Host mode record left behind. */
    const MAC_UNINSTALLED = `@@dt:uname Darwin arm64\n@@dt:download yes\n@@dt:hostmodestate ${hostState(true)}\n@@dt:end`;
    /** Holds the first probe until released; every probe answers `output`. */
    const heldProbe = (output: string) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const state = { probed: 0, release: () => release() };
      const run: CommandRunner = async (_command, args) => {
        if (!(args.at(-1) ?? "").includes("@@dt:uname")) return ok();
        state.probed++;
        if (state.probed === 1) await held;
        return ok(output);
      };
      return { run, state };
    };

    it("starts a Mac that was a host before, after a power cut left it stopped", async () => {
      const running = MAC_STOPPED(true).replace(
        "@@dt:end",
        "@@dt:running yes\n@@dt:listening yes\n@@dt:hostpid 4242\n@@dt:launchagent yes\n@@dt:end"
      );
      const { run, scripts } = recording([MAC_STOPPED(true), MAC_STOPPED(true), running]);
      const { setup } = service("", { run });
      await expect(setup.ensureHostRunning(studio)).resolves.toBe("started");
      expect(started(scripts)).toBe(true);
      // Started as it was set up: Host mode for this run, no saved setting or login item touched.
      expect(scripts.some((c) => c.includes("--enable-host-mode"))).toBe(false);
    });

    it("starts a Linux host's existing service and writes nothing, even after /run was cleared", async () => {
      const linux = (listening: boolean) =>
        [
          "@@dt:uname Linux x86_64",
          "@@dt:install deb /opt/Daintree",
          "@@dt:version 1.4.0",
          "@@dt:unit yes",
          ...(listening ? ["@@dt:running yes", "@@dt:listening yes"] : []),
          "@@dt:end",
        ].join("\n");
      const { run, scripts } = recording([linux(false), linux(false), linux(true)]);
      await expect(service("", { run }).setup.ensureHostRunning(studio)).resolves.toBe("started");
      const actions = scripts.filter((c) => !c.includes("@@dt:uname"));
      expect(actions).toEqual([
        expect.stringContaining("@@dt:libs"),
        expect.stringContaining("systemctl --user start daintree-host.service"),
      ]);

      const noUnit = recording([linux(false).replace("@@dt:unit yes", "@@dt:unit no")]);
      await expect(service("", { run: noUnit.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(started(noUnit.scripts)).toBe(false);
    });

    it("checks the AppImage a Linux host's service runs, even with a deb installed beside it", async () => {
      const linux = (listening: boolean) =>
        [
          "@@dt:uname Linux x86_64",
          "@@dt:install deb /opt/Daintree",
          "@@dt:version 1.4.0",
          "@@dt:unit yes",
          "@@dt:unitexec /home/greg/Applications/Daintree.AppImage",
          ...(listening ? ["@@dt:running yes", "@@dt:listening yes"] : []),
          "@@dt:end",
        ].join("\n");
      const { run, scripts } = recording([linux(false), linux(false), linux(true)]);
      await expect(service("", { run }).setup.ensureHostRunning(studio)).resolves.toBe("started");
      const check = scripts.find((c) => c.includes("@@dt:libs"))!;
      expect(check).toContain("/home/greg/Applications/Daintree.AppImage");
      expect(check).toContain("--appimage-extract");
    });

    describe("on a Linux machine with no init system", () => {
      const onConnectState = (overrides: Record<string, unknown> = {}) =>
        JSON.stringify({
          ...JSON.parse(hostState(true)),
          startMethod: "on-connect",
          startAtLogin: false,
          startAtLoginInstalled: null,
          ...overrides,
        });
      const box = (opts: { listening?: boolean; state?: string | null; image?: boolean } = {}) =>
        [
          "@@dt:uname Linux x86_64",
          ...(opts.image
            ? [
                "@@dt:appimage /home/node/Applications/Daintree.AppImage",
                '@@dt:appimageinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}',
              ]
            : ["@@dt:install deb /opt/Daintree", "@@dt:version 1.4.0"]),
          "@@dt:unit no",
          "@@dt:fuse no",
          "@@dt:init docker-init",
          ...(opts.listening
            ? ["@@dt:running yes", "@@dt:listening yes", "@@dt:hostpid 4242", "@@dt:hoststart 987"]
            : []),
          ...(opts.state === null ? [] : [`@@dt:hostmodestate ${opts.state ?? onConnectState()}`]),
          "@@dt:end",
        ].join("\n");
      const launches = (scripts: string[]) => scripts.filter((c) => c.includes("nohup"));

      it("starts Daintree again in a session of its own when its record says it's on", async () => {
        const { run, scripts } = recording([
          box({ image: true }),
          box({ image: true }),
          box({ image: true, listening: true }),
        ]);
        await expect(service("", { run }).setup.ensureHostRunning(studio)).resolves.toBe("started");
        expect(launches(scripts)).toHaveLength(1);
        const [launch] = launches(scripts);
        // Quoted again for the login shell, so only its words are checked here.
        expect(launch).toContain("/home/node/Applications/Daintree.AppImage");
        expect(launch).toContain("--ozone-platform=headless");
        expect(launch).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
        // Started as it was set up: nothing is switched on, and no service is asked for.
        expect(launch).not.toContain("--enable-host-mode");
        expect(
          scripts.filter((c) => !c.includes("@@dt:uname")).some((c) => c.includes("systemctl"))
        ).toBe(false);
      });

      it("names every library it can't load and starts nothing, installing nothing on an ssh host", async () => {
        const scripts: string[] = [];
        const run: CommandRunner = async (_command, args) => {
          const script = args.at(-1) ?? "";
          scripts.push(script);
          if (script.includes("@@dt:uname")) return ok(box({ image: true }));
          if (script.includes("@@dt:libs")) return ok("@@dt:libs missing libnspr4.so libnss3.so\n");
          return ok();
        };
        const cloudPackageInstaller = vi.fn(() => async () => ok());
        const onStart = vi.fn();
        const error = await service("", { run, cloudPackageInstaller })
          .setup.ensureHostRunning(studio, undefined, onStart)
          .catch((e: unknown) => e as { userMessage?: string });
        expect(error.userMessage).toContain("studio");
        expect(error.userMessage).toContain("libnspr4.so, libnss3.so");
        expect(error.userMessage).toContain("apt-get update && apt-get satisfy");
        expect(launches(scripts)).toEqual([]);
        expect(onStart).not.toHaveBeenCalled();
        expect(cloudPackageInstaller).not.toHaveBeenCalled();
      });

      it("installs the packages as root on a cloud machine that allows it, checks again, then starts", async () => {
        const order: string[] = [];
        const probes = [
          box({ image: true }),
          box({ image: true }),
          box({ image: true, listening: true }),
        ];
        const checks = ["@@dt:libs missing libnspr4.so\n", "@@dt:libs ok\n"];
        const channel = {
          exec: async (script: string) => {
            if (script.includes("@@dt:uname"))
              return ok(probes.length > 1 ? probes.shift()! : probes[0]!);
            if (script.includes("@@dt:libs")) {
              order.push("check");
              return ok(checks.shift()!);
            }
            if (script.includes("nohup")) {
              order.push("start");
              return ok("@@dt:launched 777 123456 new\n");
            }
            if (script.includes("alive yes")) return ok("@@dt:alive yes\n");
            return ok();
          },
          execWithInput: async () => ok(),
          sendFile: async () => ok(),
        };
        const install = vi.fn(async () => {
          order.push("install");
          return ok();
        });
        const cloudPackageInstaller = vi.fn(() => install);
        const machine = { kind: "cloud", bindingId: "b-1" } as const;
        await expect(
          service("", { channelFor: () => channel, cloudPackageInstaller }).setup.ensureHostRunning(
            machine
          )
        ).resolves.toBe("started");
        expect(cloudPackageInstaller).toHaveBeenCalledWith("b-1");
        expect(order).toEqual(["check", "install", "check", "start"]);
      });

      it("starts nothing where Daintree there never recorded starting on connect", async () => {
        for (const state of [null, hostState(true), onConnectState({ enabled: false })]) {
          const { run, scripts } = recording([box({ state })]);
          await expect(
            service("", { run }).setup.ensureHostRunning(studio),
            String(state)
          ).resolves.toBe("not-startable");
          expect(launches(scripts)).toEqual([]);
        }
      });

      it("leaves one quit on purpose until someone asks for it back", async () => {
        const quit = onConnectState({ pid: 0, stopped: true });
        const left = recording([box({ state: quit })]);
        await expect(service("", { run: left.run }).setup.ensureHostRunning(studio)).resolves.toBe(
          "not-startable"
        );
        expect(launches(left.scripts)).toEqual([]);
        const asked = recording([
          box({ state: quit }),
          box({ state: quit }),
          box({ listening: true }),
        ]);
        await expect(
          service("", { run: asked.run }).setup.ensureHostRunning(studio, undefined, undefined, {
            explicit: true,
          })
        ).resolves.toBe("started");
        expect(launches(asked.scripts)).toHaveLength(1);
      });

      it("stops it on removal, by its own record, and leaves any other host alone", async () => {
        const running = recording([box({ listening: true })]);
        const stopping = service("", {
          run: async (command, args) => {
            const script = args.at(-1) ?? "";
            if (script.includes("@@dt:stopped")) {
              running.scripts.push(script);
              return ok("@@dt:stopped yes\n");
            }
            return running.run(command, args);
          },
        });
        await expect(stopping.setup.stopStartedOnConnect(studio)).resolves.toBe(true);
        const stop = running.scripts.find((c) => c.includes("@@dt:stopped"))!;
        expect(stop).toContain("hp=4242");
        // An AppImage still unpacking is waited for too, never killed outright.
        expect(stop).toContain("host-launch.pid");
        expect(stop).not.toContain("systemctl");

        const others = [
          // A service keeps it: removing the host leaves it running, as before.
          box({ listening: true, state: hostState(true) }).replace(
            "@@dt:init docker-init",
            "@@dt:init systemd"
          ),
          // Running for this run only: not a start Daintree made.
          box({ listening: true, state: onConnectState({ enabled: false }) }),
          // Running, but not by its own account started on connect.
          box({ listening: true, state: hostState(true) }),
        ];
        for (const output of others) {
          const left = recording([output]);
          await expect(
            service("", { run: left.run }).setup.stopStartedOnConnect(studio)
          ).resolves.toBe(false);
          expect(left.scripts.filter((c) => !c.includes("@@dt:uname"))).toEqual([]);
        }
        const wsl = recording([box({ listening: true })]);
        await expect(
          service("", { run: wsl.run }).setup.stopStartedOnConnect({
            kind: "wsl",
            distro: "Ubuntu",
          })
        ).resolves.toBe(false);
        expect(wsl.scripts).toEqual([]);
      });

      it("ends a start still unpacking when it's removed before listening", async () => {
        const left = recording([box({})]);
        const stopping = service("", {
          run: async (command, args) => {
            const script = args.at(-1) ?? "";
            if (script.includes("@@dt:stopped")) {
              left.scripts.push(script);
              return ok("@@dt:stopped yes\n");
            }
            return left.run(command, args);
          },
        });
        await expect(stopping.setup.stopStartedOnConnect(studio)).resolves.toBe(true);
        const stop = left.scripts.find((c) => c.includes("@@dt:stopped"))!;
        // Only the last start, as its receipt names it, is asked to quit.
        expect(stop).toContain("host-launch.pid");
        expect(stop).toContain("/proc/$lp/comm");
        // Nothing else on the account: no Daintree found by name.
        expect(stop).not.toContain("pkill");
        expect(stop).not.toContain("pgrep");

        // Brought back after a quit: its old record still says stopped, and the start is still ended.
        const quit = recording([box({ state: onConnectState({ pid: 0, stopped: true }) })]);
        const afterQuit = service("", {
          run: async (command, args) => {
            const script = args.at(-1) ?? "";
            if (script.includes("@@dt:stopped")) {
              quit.scripts.push(script);
              return ok("@@dt:stopped yes\n");
            }
            return quit.run(command, args);
          },
        });
        await expect(afterQuit.setup.stopStartedOnConnect(studio)).resolves.toBe(true);
        expect(quit.scripts.some((c) => c.includes("host-launch.pid"))).toBe(true);
      });

      it("says at once when the start it made exits, in the log's words", async () => {
        const scripts: string[] = [];
        let probed = 0;
        const run: CommandRunner = async (_command, args) => {
          const script = args.at(-1) ?? "";
          scripts.push(script);
          if (script.includes("@@dt:uname")) {
            probed++;
            return ok(box({ image: true }));
          }
          if (script.includes("nohup")) return ok("@@dt:launched 777 123456 new\n");
          if (script.includes("alive yes")) return ok("");
          if (script.includes("host.log")) {
            return ok(
              "Started Daintree host\n[1:1:FATAL:zygote_host_impl_linux.cc(1)] No usable sandbox!\n"
            );
          }
          return ok();
        };
        await expect(service("", { run }).setup.ensureHostRunning(studio)).rejects.toMatchObject({
          userMessage:
            "Daintree exited on studio as it started: No usable sandbox! (more in ~/.cache/daintree/host.log there)",
        });
        // One check before the start and one after it: not a minute, or five, of waiting.
        expect(probed).toBe(2);
      });

      it("tells its record what every check that reached the host saw", async () => {
        const seen: Array<boolean | undefined> = [];
        const { run } = recording([box({ listening: true })]);
        const { setup } = service("", {
          run,
          onProbed: (_connection, result) => seen.push(result.startsOnConnect),
        });
        await setup.probe({ connection: studio });
        expect(seen).toEqual([true]);
        const unreached = service("", {
          run: async () => ({
            code: 255,
            stdout: "",
            stderr: "no route",
            spawnError: null,
            timedOut: false,
          }),
          onProbed: () => seen.push(undefined),
        });
        await unreached.setup.probe({ connection: studio });
        expect(seen).toEqual([true]);
      });
    });

    it("starts nothing for a connection already cancelled", async () => {
      const { run, scripts } = recording([MAC_STOPPED(true)]);
      const abort = new AbortController();
      abort.abort();
      await expect(
        service("", { run }).setup.ensureHostRunning(studio, abort.signal)
      ).resolves.toBe("not-startable");
      expect(started(scripts)).toBe(false);
    });

    it("leaves alone a host whose user switched Host mode off, or that never ran it", async () => {
      const off = recording([MAC_STOPPED(false)]);
      await expect(service("", { run: off.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(started(off.scripts)).toBe(false);

      const never = recording([MAC_STOPPED(true).replace(/@@dt:hostmodestate .*\n/, "")]);
      await expect(service("", { run: never.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(started(never.scripts)).toBe(false);
    });

    it("leaves alone a host its user quit on purpose", async () => {
      const quit = recording([
        MAC_STOPPED(true).replace(
          `@@dt:hostmodestate ${hostState(true)}`,
          `@@dt:hostmodestate ${JSON.stringify({ ...JSON.parse(hostState(true)), pid: 0, stopped: true })}`
        ),
      ]);
      await expect(service("", { run: quit.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(started(quit.scripts)).toBe(false);
    });

    it("starts a Daintree quit there on purpose when someone asks for the host back (#16170)", async () => {
      const { run, scripts } = recording([MAC_QUIT(), MAC_QUIT(), MAC_STARTED()]);
      const refusals: string[] = [];
      await expect(
        service("", { run }).setup.ensureHostRunning(studio, undefined, undefined, {
          explicit: true,
          onRefused: (refusal) => refusals.push(refusal),
        })
      ).resolves.toBe("started");
      expect(started(scripts)).toBe(true);
      expect(scripts.filter((c) => c.includes("open -n -g -a"))).toEqual([
        expect.stringContaining(" --args --host-mode"),
      ]);
      expect(refusals).toEqual([]);
      // Started as it was set up: nothing switched on or saved there.
      expect(scripts.some((c) => c.includes("--enable-host-mode"))).toBe(false);
    });

    it("says why it started nothing, and never starts where Host mode is off even when asked", async () => {
      const cases: Array<[string, string, boolean, string]> = [
        ["quit, unasked", MAC_QUIT(), false, "quit"],
        ["Host mode off, asked", MAC_STOPPED(false), true, "host-mode-off"],
        [
          "never a host, asked",
          MAC_STOPPED(true).replace(/@@dt:hostmodestate .*\n/, ""),
          true,
          "host-mode-off",
        ],
        ["Linux service with Host mode off, asked", LINUX_OFF, true, "host-mode-off"],
        ["not installed, asked", MAC_UNINSTALLED, true, "not-installed"],
        ["probe cut short, asked", CUT_SHORT, true, "unreached"],
      ];
      for (const [why, output, explicit, refusal] of cases) {
        const { run, scripts } = recording([output]);
        const refusals: string[] = [];
        await expect(
          service("", { run }).setup.ensureHostRunning(studio, undefined, undefined, {
            explicit,
            onRefused: (r) => refusals.push(r),
          }),
          why
        ).resolves.toBe("not-startable");
        expect(refusals, why).toEqual([refusal]);
        expect(started(scripts), why).toBe(false);
      }
    });

    it("looks again past a held refusal when someone asks for the host back", async () => {
      const { run, scripts } = recording([MAC_STOPPED(false)]);
      const { setup } = service("", { run });
      await setup.ensureHostRunning(studio);
      const refusals: string[] = [];
      await setup.ensureHostRunning(studio, undefined, undefined, {
        onRefused: (r) => refusals.push(r),
      });
      expect(probes(scripts)).toBe(1);
      expect(refusals).toEqual(["held"]);
      await setup.ensureHostRunning(studio, undefined, undefined, { explicit: true });
      expect(probes(scripts)).toBe(2);
    });

    it("never installs: a host without Daintree is left as it is", async () => {
      const bare = recording(["@@dt:uname Darwin arm64\n@@dt:download yes\n@@dt:end"]);
      await expect(service("", { run: bare.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(bare.scripts.filter((c) => !c.includes("@@dt:uname"))).toEqual([]);
    });

    it("does nothing to a host that is already listening", async () => {
      const up = recording([MAC_RUNNING_OLD]);
      await expect(service("", { run: up.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "listening"
      );
      expect(started(up.scripts)).toBe(false);
    });

    it("reads each fixture below as the refusal it is named for", async () => {
      const read = (output: string) => service(output).setup.probe({ connection: studio });
      expect(await read(MAC_QUIT())).toMatchObject({
        install: expect.anything(),
        hostModeListening: false,
        hostModeState: { enabled: true, stopped: true },
      });
      expect(await read(LINUX_OFF)).toMatchObject({
        install: expect.anything(),
        advice: { hostModeUnit: true },
        hostModeState: { enabled: false },
      });
      expect(await read(MAC_UNINSTALLED)).toMatchObject({
        reachable: true,
        install: null,
        hostModeState: { enabled: true },
      });
    });

    it("probes a host it can't start once, and goes by that until something changes there", async () => {
      const outputs = {
        quit: MAC_QUIT(),
        "Host mode off on a Mac": MAC_STOPPED(false),
        "Host mode off with a service to start": LINUX_OFF,
        "never a host": MAC_STOPPED(true).replace(/@@dt:hostmodestate .*\n/, ""),
        "not installed": "@@dt:uname Darwin arm64\n@@dt:download yes\n@@dt:end",
        "uninstalled, its record left behind": MAC_UNINSTALLED,
      };
      for (const [why, output] of Object.entries(outputs)) {
        const { run, scripts } = recording([output]);
        const { setup } = service("", { run });
        for (let dial = 0; dial < 3; dial++) {
          await expect(setup.ensureHostRunning(studio), why).resolves.toBe("not-startable");
        }
        expect(probes(scripts), why).toBe(1);
        expect(started(scripts), why).toBe(false);
      }

      const { run, scripts } = recording([MAC_QUIT()]);
      const { setup } = service("", { run });
      await setup.ensureHostRunning(studio);
      // Another machine has its own answer, and a recheck of one leaves the other's.
      const mini = { kind: "ssh", target: "mini" } as const;
      await setup.ensureHostRunning(mini);
      expect(probes(scripts)).toBe(2);
      setup.recheckStart(studio);
      await setup.ensureHostRunning(studio);
      await setup.ensureHostRunning(studio);
      await setup.ensureHostRunning(mini);
      expect(probes(scripts)).toBe(3);
      await setup.forgetArtifacts({ connection: studio });
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(4);
      expect(started(scripts)).toBe(false);
    });

    it("probes again once the answer is ten minutes old, or the clock moved back past it", async () => {
      const HOLD = 10 * 60_000;
      let clock = 1_000_000;
      const { run, scripts } = recording([MAC_QUIT()]);
      const { setup } = service("", { run, now: () => clock });
      await setup.ensureHostRunning(studio);
      clock += HOLD - 1;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(1);
      clock += 1;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(2);
      // That probe's answer holds for ten minutes of its own.
      clock += HOLD - 1;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(2);
      clock += 1;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(3);
      clock -= 60 * 60_000;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(4);
      expect(started(scripts)).toBe(false);
    });

    it("probes again when the last probe learned nothing", async () => {
      const { run, scripts } = recording([CUT_SHORT]);
      const { setup } = service("", { run });
      await expect(setup.ensureHostRunning(studio)).resolves.toBe("not-startable");
      await expect(setup.ensureHostRunning(studio)).resolves.toBe("not-startable");
      expect(probes(scripts)).toBe(2);
    });

    it("keeps nothing a probe saw before a recheck it was under way through", async () => {
      const { run, state } = heldProbe(MAC_QUIT());
      const { setup } = service("", { run });
      const first = setup.ensureHostRunning(studio);
      await vi.waitFor(() => expect(state.probed).toBe(1));
      // Another machine's recheck says nothing about this one.
      setup.recheckStart({ kind: "ssh", target: "mini" });
      state.release();
      await expect(first).resolves.toBe("not-startable");
      await setup.ensureHostRunning(studio);
      expect(state.probed).toBe(1);

      const again = heldProbe(MAC_QUIT());
      const next = service("", { run: again.run }).setup;
      const pending = next.ensureHostRunning(studio);
      await vi.waitFor(() => expect(again.state.probed).toBe(1));
      next.recheckStart(studio);
      again.state.release();
      await expect(pending).resolves.toBe("not-startable");
      await next.ensureHostRunning(studio);
      await next.ensureHostRunning(studio);
      expect(again.state.probed).toBe(2);
    });

    it("keeps nothing a probe saw once its dial was cancelled", async () => {
      const { run, state } = heldProbe(MAC_QUIT());
      const { setup } = service("", { run });
      const abort = new AbortController();
      const first = setup.ensureHostRunning(studio, abort.signal);
      await vi.waitFor(() => expect(state.probed).toBe(1));
      abort.abort();
      state.release();
      await expect(first).resolves.toBe("not-startable");
      await setup.ensureHostRunning(studio);
      expect(state.probed).toBe(2);
    });

    it("probes again after switching Host mode on from here was tried, even when it failed", async () => {
      const scripts: string[] = [];
      const { setup } = service("", {
        run: async (_command, args) => {
          const script = args.at(-1) ?? "";
          scripts.push(script);
          if (script.includes("@@dt:uname")) return ok(MAC_QUIT());
          if (script.includes("--enable-host-mode"))
            return { ...ok(), code: 1, stderr: "no session" };
          return ok();
        },
      });
      await setup.ensureHostRunning(studio);
      await expect(setup.startHostMode({ connection: studio })).rejects.toMatchObject({
        code: "INTERNAL",
      });
      expect(scripts.some((c) => c.includes("--enable-host-mode"))).toBe(true);
      const before = probes(scripts);
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(before + 1);
    });

    it("probes again after a start that failed", async () => {
      const scripts: string[] = [];
      const { setup } = service("", {
        run: async (_command, args) => {
          const script = args.at(-1) ?? "";
          scripts.push(script);
          if (script.includes("@@dt:uname")) return ok(MAC_STOPPED(true));
          if (script.includes("open -n -g -a")) return { ...ok(), code: 1, stderr: "no session" };
          return ok();
        },
      });
      const onStart = vi.fn();
      await expect(setup.ensureHostRunning(studio, undefined, onStart)).rejects.toMatchObject({
        userMessage: expect.stringContaining("Log in there"),
      });
      expect(onStart).toHaveBeenCalledTimes(1);
      await expect(setup.ensureHostRunning(studio)).rejects.toBeDefined();
      expect(probes(scripts)).toBe(2);
    });

    it("says a start is under way only just before the start goes to the host", async () => {
      const { run, scripts } = recording([MAC_STOPPED(true), MAC_STOPPED(true), MAC_STARTED()]);
      const startedYet: boolean[] = [];
      const onStart = vi.fn(() => startedYet.push(started(scripts)));
      await expect(
        service("", { run }).setup.ensureHostRunning(studio, undefined, onStart)
      ).resolves.toBe("started");
      expect(startedYet).toEqual([false]);
      expect(started(scripts)).toBe(true);

      // Checked on and left alone, found listening, or not answering: never starting.
      const neverAHost = MAC_STOPPED(true).replace(/@@dt:hostmodestate .*\n/, "");
      for (const output of [MAC_QUIT(), neverAHost, MAC_RUNNING_OLD, CUT_SHORT]) {
        const quiet = vi.fn();
        await service("", { run: recording([output]).run }).setup.ensureHostRunning(
          studio,
          undefined,
          quiet
        );
        expect(quiet).not.toHaveBeenCalled();
      }

      // Cancelled while it was being checked on: the start never goes.
      const { run: heldRun, state } = heldProbe(MAC_STOPPED(true));
      const abort = new AbortController();
      const cancelled = vi.fn();
      const pending = service("", { run: heldRun }).setup.ensureHostRunning(
        studio,
        abort.signal,
        cancelled
      );
      await vi.waitFor(() => expect(state.probed).toBe(1));
      abort.abort();
      state.release();
      await expect(pending).resolves.toBe("not-startable");
      expect(cancelled).not.toHaveBeenCalled();
    });
  });

  it("drops the SSH master and cached bundles when a host is forgotten", async () => {
    const { setup, calls } = service(LINUX_NO_UNIT);
    const key = crypto.createHash("sha256").update("studio").digest("hex").slice(0, 16);
    const hostCache = path.join(clientDir, "bundles", key);
    const otherCache = path.join(clientDir, "bundles", "someone-else");
    await fs.mkdir(hostCache, { recursive: true });
    await fs.mkdir(otherCache, { recursive: true });
    await fs.writeFile(path.join(hostCache, "Daintree.zip"), "partial");
    await setup.forgetArtifacts({ connection: { kind: "ssh", target: "studio" } });
    const exit = calls.find(([, args]) => args.includes("-O") && args.includes("exit"));
    expect(exit?.[1].at(-1)).toBe("studio");
    await expect(fs.access(hostCache)).rejects.toThrow();
    await expect(fs.access(otherCache)).resolves.toBeUndefined();
  });
});

describe("HostSetupService on Windows (WSL distros)", () => {
  const LINUX_DISTRO = [
    "@@dt:uname Linux x86_64",
    "@@dt:init systemd",
    "@@dt:unit no",
    "@@dt:end",
  ].join("\n");

  function windowsService(overrides: Partial<HostSetupDeps> = {}) {
    const keepalive = { touched: [] as string[], released: [] as string[] };
    const calls: Array<[string, readonly string[]]> = [];
    const result = service(LINUX_DISTRO, {
      platform: "win32",
      run: async (command, args) => {
        calls.push([command, args]);
        return ok(command.endsWith("wsl.exe") ? LINUX_DISTRO : "");
      },
      wslKeepalive: {
        touch: (distro) => keepalive.touched.push(distro),
        release: (distro) => keepalive.released.push(distro),
      },
      ...overrides,
    });
    return { ...result, calls, keepalive };
  }

  it("checks a distro through wsl.exe --exec, holding it up around the command", async () => {
    const { setup, calls, keepalive } = windowsService();
    const result = await setup.probe({ connection: { kind: "wsl", distro: "Ubuntu-24.04" } });
    expect(result).toMatchObject({ reachable: true, platform: "linux" });
    expect(result.advice).toMatchObject({ systemd: true, sleepObserved: null });
    const [command, args] = calls[0]!;
    expect(command).toMatch(/\\System32\\wsl\.exe$/i);
    expect(args.slice(0, 7)).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      "~",
      "--exec",
      "/bin/sh",
      "-c",
    ]);
    expect(args.at(-1)).toContain("@@dt:uname");
    expect(keepalive.touched).toEqual(["Ubuntu-24.04", "Ubuntu-24.04"]);
  });

  it("refuses an ssh host on Windows, and a WSL distro anywhere else", async () => {
    const { setup, calls } = windowsService();
    await expect(
      setup.probe({ connection: { kind: "ssh", target: "greg@studio" } })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(calls).toEqual([]);
    const mac = service(LINUX_DISTRO);
    await expect(
      mac.setup.probe({ connection: { kind: "wsl", distro: "Ubuntu" } })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(mac.calls).toEqual([]);
  });

  it("goes by one answer for a distro however its name is cased", async () => {
    const { setup, calls } = windowsService();
    const probes = () => calls.filter(([, args]) => (args.at(-1) ?? "").includes("@@dt:uname"));
    await expect(setup.ensureHostRunning({ kind: "wsl", distro: "Ubuntu-24.04" })).resolves.toBe(
      "not-startable"
    );
    await setup.ensureHostRunning({ kind: "wsl", distro: "ubuntu-24.04" });
    expect(probes()).toHaveLength(1);
    setup.recheckStart({ kind: "wsl", distro: "UBUNTU-24.04" });
    await setup.ensureHostRunning({ kind: "wsl", distro: "Ubuntu-24.04" });
    expect(probes()).toHaveLength(2);
  });

  it("lets a forgotten host's distro go", async () => {
    const { setup, keepalive } = windowsService();
    await setup.forgetArtifacts({ connection: { kind: "wsl", distro: "Debian" } });
    expect(keepalive.released).toEqual(["Debian"]);
  });

  it("doesn't hold up a distro whose host is being removed or re-pointed", async () => {
    const { setup, keepalive, calls } = windowsService({ isRetiring: () => true });
    // A check already under way when removal began still runs, but takes no hold.
    await (
      setup as unknown as {
        probeOutcome(connection: unknown): Promise<unknown>;
      }
    ).probeOutcome({ kind: "wsl", distro: "Ubuntu" });
    expect(calls).toHaveLength(1);
    expect(keepalive.touched).toEqual([]);
  });
});
