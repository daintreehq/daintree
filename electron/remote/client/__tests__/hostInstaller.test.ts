import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import { probeHost } from "../hostProbe.js";
import { runHostInstall, type InstallProgress, type InstallerDeps } from "../hostInstaller.js";
import type { ClientBuild } from "../installPlan.js";
import type { RemoteShell } from "../remoteShell.js";

const CLIENT: ClientBuild = {
  platform: "darwin",
  arch: "arm64",
  version: "1.4.0",
  commit: "abcdef0123",
  channel: "stable",
  bundle: { kind: "app-bundle", path: "/Applications/Daintree.app" },
};
const NEW_BUILD = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';
const OLD_BUILD = '{"daintreeBuildInfo":1,"version":"1.3.0","commit":"0123456789"}';

function macProbe(opts: { build: string | null; hostMode: boolean; running?: boolean }): string {
  return [
    "@@dt:uname Darwin arm64",
    ...(opts.build
      ? [
          "@@dt:install app-bundle /Applications/Daintree.app",
          `@@dt:version ${JSON.parse(opts.build).version}`,
          `@@dt:buildinfo ${opts.build}`,
        ]
      : []),
    ...(opts.running || opts.hostMode ? ["@@dt:running yes"] : []),
    ...(opts.hostMode ? ["@@dt:listening yes", "@@dt:hostpid 4242"] : []),
    "@@dt:download yes",
    "@@dt:end",
  ].join("\n");
}

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});

interface FakeShell extends RemoteShell {
  scripts: string[];
  uploads: Array<[string, string]>;
}

function fakeShell(answer: (script: string) => CommandResult = () => ok()): FakeShell {
  const shell: FakeShell = {
    scripts: [],
    uploads: [],
    exec: async (script) => {
      shell.scripts.push(script);
      if (script.includes("mktemp -d")) return ok("@@dt:stage /tmp/daintree-stage.abc123\n");
      if (script.includes("ditto -x -k")) return ok("@@dt:version 1.4.0\n");
      if (script.includes('echo "@@dt:home')) return ok("@@dt:home /home/greg\n");
      if (script.includes("@@dt:stopped")) return ok("@@dt:stopped yes\n");
      return answer(script);
    },
    upload: async (local, remote) => {
      shell.uploads.push([local, remote]);
      return ok();
    },
  };
  return shell;
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-install-"));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

function makeDeps(params: {
  shell: FakeShell;
  probes: string[];
  working?: Array<number | null>;
  client?: ClientBuild;
  run?: CommandRunner;
}): InstallerDeps & { progress: InstallProgress[]; reconnect: ReturnType<typeof vi.fn> } {
  const probes = [...params.probes];
  const working = [...(params.working ?? [0])];
  const run: CommandRunner =
    params.run ??
    (async (command, args) => {
      if (command === "ditto") await fs.writeFile(args[args.length - 1]!, "zip");
      return ok();
    });
  return {
    shell: params.shell,
    run,
    client: params.client ?? CLIENT,
    probe: async () => {
      const stdout = probes.length > 1 ? probes.shift()! : probes[0]!;
      const probeShell: RemoteShell = { exec: async () => ok(stdout), upload: async () => ok() };
      return probeHost({ sshTarget: "studio", shell: probeShell, client: CLIENT });
    },
    workingAgents: async () => (working.length > 1 ? working.shift()! : working[0]!),
    download: async (_url, destination) => fs.writeFile(destination, "artifact"),
    cacheDir,
    reconnect: vi.fn(async () => true),
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 1_000);
    })(),
    progress: [],
  };
}

async function install(
  deps: ReturnType<typeof makeDeps>,
  payload: Partial<Parameters<typeof runHostInstall>[0]> = {},
  signal = new AbortController().signal
) {
  return runHostInstall({ opId: "op-1", sshTarget: "studio", ...payload }, deps, signal, (p) =>
    deps.progress.push(p)
  );
}

describe("runHostInstall", () => {
  it("copies this Mac's own bundle to a fresh Mac, staging and checking it before placing it", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: null, hostMode: false }),
        macProbe({ build: NEW_BUILD, hostMode: false }),
      ],
    });
    const result = await install(deps);
    expect(result.status).toBe("installed");
    expect(shell.uploads).toEqual([
      [path.join(cacheDir, "Daintree-1.4.0-arm64.zip"), "/tmp/daintree-stage.abc123/bundle.zip"],
    ]);
    const order = shell.scripts.map((s) =>
      s.includes("mktemp")
        ? "stage"
        : s === "rm -rf '/Applications/Daintree.app.old'"
          ? "drop-backup"
          : s.includes("ditto -x")
            ? "verify"
            : s.includes("Daintree.app.old")
              ? "swap"
              : s.includes("@@dt:stopped")
                ? "stop"
                : s.startsWith("open ")
                  ? "start"
                  : "other"
    );
    // Nothing was running, so nothing is stopped or started.
    expect(order).toEqual(["stage", "verify", "swap", "drop-backup"]);
    // The packed copy doesn't outlive the upload.
    await expect(fs.access(path.join(cacheDir, "Daintree-1.4.0-arm64.zip"))).rejects.toThrow();
  });

  it("refuses while the host reports working agents, changing nothing", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [macProbe({ build: OLD_BUILD, hostMode: true })],
      working: [2],
    });
    await expect(install(deps, { hostId: "studio" })).resolves.toEqual({
      status: "agents-working",
      working: 2,
    });
    expect(shell.scripts).toEqual([]);
    expect(shell.uploads).toEqual([]);
  });

  it("refuses when agent activity can't be seen, so the user decides", async () => {
    const deps = makeDeps({
      shell: fakeShell(),
      probes: [macProbe({ build: OLD_BUILD, hostMode: true })],
      working: [null],
    });
    await expect(install(deps)).resolves.toEqual({ status: "agents-working", working: null });
  });

  it("updates anyway once confirmed: stops the host, swaps, restarts in Host mode and reconnects", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: NEW_BUILD, hostMode: false }),
        macProbe({ build: NEW_BUILD, hostMode: true }),
      ],
      working: [3],
    });
    const result = await install(deps, { hostId: "studio", whileWorking: "proceed" });
    expect(result).toMatchObject({ status: "installed", reconnected: true });
    expect(deps.reconnect).toHaveBeenCalledWith("studio");
    const stop = shell.scripts.find((s) => s.includes("@@dt:stopped"))!;
    expect(stop).toContain("kill -TERM 4242");
    expect(shell.scripts).toContain("open -g -a '/Applications/Daintree.app' --args --host-mode");
    expect(deps.progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining([
        "checking",
        "copying",
        "stopping",
        "installing",
        "restarting",
        "reconnecting",
      ])
    );
  });

  it("updates when idle: stages first, then waits until no agents are working", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: NEW_BUILD, hostMode: true }),
      ],
      working: [2, 1, 0],
    });
    const result = await install(deps, { hostId: "studio", whileWorking: "wait-for-idle" });
    expect(result.status).toBe("installed");
    const waits = deps.progress.filter((p) => p.stage === "waiting-for-idle");
    expect(waits.map((p) => p.message)).toEqual([
      "Waiting for 2 working agents on the host",
      "Waiting for 1 working agent on the host",
    ]);
    const stagedAt = deps.progress.findIndex((p) => p.stage === "copying");
    const waitedAt = deps.progress.findIndex((p) => p.stage === "waiting-for-idle");
    expect(stagedAt).toBeLessThan(waitedAt);
  });

  it("stops waiting for idle when cancelled, before touching the running host", async () => {
    const shell = fakeShell();
    const controller = new AbortController();
    const deps = makeDeps({
      shell,
      probes: [macProbe({ build: OLD_BUILD, hostMode: true })],
      working: [1],
    });
    deps.sleep = async () => {
      controller.abort();
    };
    await expect(
      install(deps, { whileWorking: "wait-for-idle" }, controller.signal)
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(shell.scripts.some((s) => s.includes("@@dt:stopped"))).toBe(false);
  });

  it("leaves the old build in place when the host doesn't quit", async () => {
    const shell = fakeShell();
    shell.exec = async (script) => {
      shell.scripts.push(script);
      if (script.includes("mktemp -d")) return ok("@@dt:stage /tmp/daintree-stage.abc123\n");
      if (script.includes("ditto -x -k")) return ok("@@dt:version 1.4.0\n");
      if (script.includes("@@dt:stopped")) return ok("@@dt:stopped no\n");
      return ok();
    };
    const deps = makeDeps({ shell, probes: [macProbe({ build: OLD_BUILD, hostMode: true })] });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(/didn't quit/);
    expect(shell.scripts.some((s) => s.includes("Daintree.app.old"))).toBe(false);
  });

  it("has a Linux host fetch its deb and hands the user one sudo command", async () => {
    const shell = fakeShell();
    const linux = [
      "@@dt:uname Linux x86_64",
      "@@dt:install deb /opt/Daintree",
      "@@dt:version 1.3.0",
      "@@dt:running yes",
      "@@dt:download yes",
      "@@dt:end",
    ].join("\n");
    const deps = makeDeps({ shell, probes: [linux], working: [5] });
    const result = await install(deps);
    expect(result).toMatchObject({
      status: "needs-user-command",
      command: { command: "sudo apt install /tmp/daintree-stage.abc123/daintree_1.4.0_amd64.deb" },
    });
    const fetch = shell.scripts.find((s) => s.includes("curl"))!;
    expect(fetch).toContain("'https://updates.daintree.org/releases/daintree_1.4.0_amd64.deb'");
    // Daintree never runs sudo and restarts nothing for a deb.
    expect(shell.scripts.some((s) => s.includes("sudo"))).toBe(false);
    expect(shell.scripts.some((s) => s.includes("@@dt:stopped"))).toBe(false);
  });

  it("replaces an AppImage in place and restarts only through the user's own unit", async () => {
    const shell = fakeShell();
    const before = [
      "@@dt:uname Linux x86_64",
      "@@dt:appimage /home/greg/Applications/Daintree-1.3.0-x86_64.AppImage",
      "@@dt:unit yes",
      "@@dt:listening yes",
      "@@dt:hostpid 77",
      "@@dt:end",
    ].join("\n");
    // The install leaves the build marker beside the AppImage, which is how it is read back.
    const after = before.replace("@@dt:unit yes", `@@dt:appimageinfo ${NEW_BUILD}\n@@dt:unit yes`);
    const deps = makeDeps({ shell, probes: [before, after], working: [0] });
    const result = await install(deps, { hostId: "box" });
    expect(result.status).toBe("installed");
    const swap = shell.scripts.find((s) => s.includes("mv -f"))!;
    expect(swap).toContain("'/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage'");
    expect(swap).toContain(
      `printf '%s' '${NEW_BUILD}' > '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json'`
    );
    expect(shell.scripts).toContain("systemctl --user start daintree-host.service");
  });

  it("puts the previous build back and restarts it when the new one won't start", async () => {
    const shell = fakeShell((script) =>
      script.startsWith("open ")
        ? { ...ok(), code: 1, stderr: "LSOpenURLsWithRole() failed" }
        : ok()
    );
    const deps = makeDeps({ shell, probes: [macProbe({ build: OLD_BUILD, hostMode: true })] });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(/start Daintree/);
    const rollback = shell.scripts.findIndex(
      (s) =>
        s.includes("mv '/Applications/Daintree.app.old' '/Applications/Daintree.app'") &&
        s.startsWith("if [ -d")
    );
    expect(rollback).toBeGreaterThan(-1);
    expect(shell.scripts.slice(rollback + 1).some((s) => s.startsWith("open "))).toBe(true);
  });

  it("won't stop a running Linux AppImage it has no way to restart", async () => {
    const shell = fakeShell();
    const running = [
      "@@dt:uname Linux x86_64",
      "@@dt:appimage /home/greg/Applications/Daintree-1.3.0-x86_64.AppImage",
      "@@dt:running yes",
      "@@dt:unit no",
      "@@dt:end",
    ].join("\n");
    const deps = makeDeps({ shell, probes: [running], working: [0] });
    await expect(install(deps)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(shell.scripts.some((s) => s.includes("@@dt:stopped"))).toBe(false);
  });

  it("can't wait for idle on a host whose agent activity can't be seen", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [macProbe({ build: OLD_BUILD, hostMode: true })],
      working: [null],
    });
    await expect(install(deps, { whileWorking: "wait-for-idle" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(shell.scripts.some((s) => s.includes("@@dt:stopped"))).toBe(false);
  });

  it("refuses a staged Mac build from another commit", async () => {
    const shell = fakeShell();
    const base = shell.exec;
    shell.exec = async (script, options) =>
      script.includes("ditto -x -k")
        ? (shell.scripts.push(script),
          ok(
            `@@dt:version 1.4.0\n@@dt:buildinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"9999999"}\n`
          ))
        : base(script, options);
    const deps = makeDeps({ shell, probes: [macProbe({ build: null, hostMode: false })] });
    await expect(install(deps)).rejects.toThrow(/expected commit/);
    expect(shell.scripts.some((s) => s.includes("Daintree.app.old"))).toBe(false);
  });

  it("reports an unreachable host as disconnected with ssh's words", async () => {
    const deps = makeDeps({ shell: fakeShell(), probes: ["garbage"] });
    await expect(install(deps)).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
  });

  it("says up to date without staging anything", async () => {
    const shell = fakeShell();
    const deps = makeDeps({ shell, probes: [macProbe({ build: NEW_BUILD, hostMode: true })] });
    await expect(install(deps)).resolves.toMatchObject({ status: "up-to-date" });
    expect(shell.scripts).toEqual([]);
  });
});
