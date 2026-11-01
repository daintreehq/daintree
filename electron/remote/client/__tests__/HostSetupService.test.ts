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
    expect(scripts[1]!.input).toMatchObject({ text: expect.stringContaining("[Service]") });
    expect(scripts.map((s) => s.script)).toEqual([
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
        expect.stringContaining("systemctl --user start daintree-host.service"),
      ]);

      const noUnit = recording([linux(false).replace("@@dt:unit yes", "@@dt:unit no")]);
      await expect(service("", { run: noUnit.run }).setup.ensureHostRunning(studio)).resolves.toBe(
        "not-startable"
      );
      expect(started(noUnit.scripts)).toBe(false);
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
      let clock = 1_000_000;
      const { run, scripts } = recording([MAC_QUIT()]);
      const { setup } = service("", { run, now: () => clock });
      await setup.ensureHostRunning(studio);
      clock += 9 * 60_000;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(1);
      clock += 2 * 60_000;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(2);
      clock -= 60 * 60_000;
      await setup.ensureHostRunning(studio);
      expect(probes(scripts)).toBe(3);
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
