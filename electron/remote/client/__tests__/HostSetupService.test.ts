import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    workingAgents: async (hostId) => (hostId ? 1 : null),
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
    expect(result).toEqual({ status: "agents-working", working: null });
    expect(events.at(-1)).toMatchObject({
      type: "install-settled",
      opId: "op-7",
      connection: { kind: "ssh", target: "studio" },
      outcome: { status: "succeeded", result: { status: "agents-working", working: null } },
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
      expect.stringContaining("--host-mode --enable-host-mode --host-mode-handoff"),
    ]);
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
