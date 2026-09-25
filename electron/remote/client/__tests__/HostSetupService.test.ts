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
    knownTargets: () => [],
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
    const result = await setup.probe({ sshTarget: "greg@bigbox" });
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
    await expect(setup.probe({ sshTarget: "-oProxyCommand=evil" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(calls).toEqual([]);
  });

  it("runs an install as an operation, pushes its outcome as events and keeps it for status", async () => {
    const { setup, events } = service(MAC_RUNNING_OLD);
    const result = await setup.install({ opId: "op-7", sshTarget: "studio" });
    expect(result).toEqual({ status: "agents-working", working: null });
    expect(events.at(-1)).toMatchObject({
      type: "install-settled",
      opId: "op-7",
      sshTarget: "studio",
      outcome: { status: "succeeded", result: { status: "agents-working", working: null } },
    });
    expect(events.some((e) => e.type === "install-progress")).toBe(true);
    expect(setup.installStatus({ opId: "op-7" })).toMatchObject({ status: "succeeded" });
    expect(setup.installStatus({ opId: "never" })).toEqual({ status: "unknown" });
  });

  it("requires an operation id and a known whileWorking", async () => {
    const { setup } = service(MAC_RUNNING_OLD);
    expect(() => setup.install({ opId: "", sshTarget: "studio" })).toThrow(/opId/);
    expect(() =>
      setup.install({
        opId: "op-1",
        sshTarget: "studio",
        whileWorking: "yolo" as never,
      })
    ).toThrow(/whileWorking/);
  });

  it("asks the user to turn Host mode on at a Linux machine with no Daintree unit", async () => {
    const { setup, calls } = service(LINUX_NO_UNIT);
    await expect(setup.startHostMode({ sshTarget: "bigbox" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    // Never launches the backend from the SSH session.
    expect(calls.every(([, args]) => (args.at(-1) ?? "").includes("@@dt:uname"))).toBe(true);
  });

  it("starts a Mac in Host mode through its logged-in session", async () => {
    const outputs = [MAC_RUNNING_OLD.replace("@@dt:listening yes\n", ""), MAC_RUNNING_OLD];
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
    const result = await setup.startHostMode({ sshTarget: "studio" });
    expect(result.hostModeListening).toBe(true);
    expect(calls.some((c) => c.includes("open -g -a") && c.includes("--host-mode"))).toBe(true);
  });

  it("drops the SSH master and cached bundles when a host is forgotten", async () => {
    const { setup, calls } = service(LINUX_NO_UNIT);
    const key = crypto.createHash("sha256").update("studio").digest("hex").slice(0, 16);
    const hostCache = path.join(clientDir, "bundles", key);
    const otherCache = path.join(clientDir, "bundles", "someone-else");
    await fs.mkdir(hostCache, { recursive: true });
    await fs.mkdir(otherCache, { recursive: true });
    await fs.writeFile(path.join(hostCache, "Daintree.zip"), "partial");
    await setup.forgetArtifacts({ sshTarget: "studio" });
    const exit = calls.find(([, args]) => args.includes("-O") && args.includes("exit"));
    expect(exit?.[1].at(-1)).toBe("studio");
    await expect(fs.access(hostCache)).rejects.toThrow();
    await expect(fs.access(otherCache)).resolves.toBeUndefined();
  });
});
