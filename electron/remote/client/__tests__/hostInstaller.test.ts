import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import { probeHost } from "../hostProbe.js";
import {
  runHostInstall,
  stopScript,
  type InstallProgress,
  type InstallerDeps,
} from "../hostInstaller.js";
import type { ClientBuild } from "../installPlan.js";
import type { HostCommandChannel } from "../remoteShell.js";

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

interface FakeShell extends HostCommandChannel {
  scripts: string[];
  uploads: Array<[string, string]>;
  /** The sha256 of what each upload carried, by remote path, as the host would read it back. */
  received: Map<string, string>;
}

function fakeShell(answer: (script: string) => CommandResult = () => ok()): FakeShell {
  const shell: FakeShell = {
    scripts: [],
    uploads: [],
    received: new Map(),
    exec: async (script) => {
      shell.scripts.push(script);
      const sha = /@@dt:sha256/.test(script) ? /sha256sum '([^']+)'/.exec(script)?.[1] : null;
      if (sha) return ok(`@@dt:sha256 ${shell.received.get(sha) ?? "missing"}\n`);
      if (script.includes("mktemp -d")) return ok("@@dt:stage /tmp/daintree-stage.abc123\n");
      if (script.includes("ditto -x -k"))
        return ok(`@@dt:version 1.4.0\n@@dt:buildinfo ${NEW_BUILD}\n`);
      if (script.includes("--appimage-extract")) return ok(`@@dt:buildinfo ${NEW_BUILD}\n`);
      if (script.includes('echo "@@dt:home')) return ok("@@dt:home /home/greg\n");
      if (script.includes("@@dt:stopped")) return ok("@@dt:stopped yes\n");
      if (script.includes("@@dt:rolledback")) return ok("@@dt:rolledback yes\n");
      return answer(script);
    },
    execWithInput: async (script) => shell.exec(script),
    sendFile: async (local, remote) => {
      shell.uploads.push([local, remote]);
      const bytes = await fs.readFile(local).catch(() => Buffer.from("unreadable"));
      shell.received.set(remote, crypto.createHash("sha256").update(bytes).digest("hex"));
      return ok();
    },
  };
  return shell;
}

const LINUX_APPIMAGE_HOST = [
  "@@dt:uname Linux x86_64",
  "@@dt:appimage /home/greg/Applications/Daintree-1.3.0-x86_64.AppImage",
  `@@dt:appimageinfo ${OLD_BUILD}`,
  "@@dt:unit yes",
  "@@dt:unitexec /home/greg/Applications/Daintree-1.3.0-x86_64.AppImage",
  "@@dt:listening yes",
  "@@dt:hostpid 77",
  "@@dt:end",
].join("\n");

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
      const probeShell: HostCommandChannel = {
        exec: async () => ok(stdout),
        execWithInput: async () => ok(stdout),
        sendFile: async () => ok(),
      };
      return probeHost({
        connection: { kind: "ssh", target: "studio" },
        shell: probeShell,
        client: CLIENT,
      });
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
  return runHostInstall(
    { opId: "op-1", connection: { kind: "ssh", target: "studio" }, ...payload },
    deps,
    signal,
    (p) => deps.progress.push(p)
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
        : s.includes("@@dt:sha256")
          ? "check-copy"
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
    expect(order).toEqual(["stage", "check-copy", "verify", "swap", "drop-backup"]);
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
    const answer = shell.exec;
    shell.exec = async (script) => {
      if (!script.includes("@@dt:stopped")) return answer(script);
      shell.scripts.push(script);
      return ok("@@dt:stopped no\n");
    };
    const deps = makeDeps({ shell, probes: [macProbe({ build: OLD_BUILD, hostMode: true })] });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(/didn't quit/);
    expect(shell.scripts.some((s) => s.includes("Daintree.app.old"))).toBe(false);
    // Recovery still makes sure Daintree is running there.
    expect(shell.scripts.at(-1)).toBe("open -g -a '/Applications/Daintree.app' --args --host-mode");
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

  describe("a host with curl but no way to the release feed", () => {
    const LINUX_DEB = [
      "@@dt:uname Linux x86_64",
      "@@dt:install deb /opt/Daintree",
      "@@dt:version 1.3.0",
      "@@dt:download yes",
      "@@dt:end",
    ].join("\n");
    const DEB = "daintree_1.4.0_amd64.deb";
    const STAGED = `/tmp/daintree-stage.abc123/${DEB}`;
    const offline = (script: string): CommandResult =>
      script.includes("curl -fsSL")
        ? {
            code: 6,
            stdout: "",
            stderr: "curl: (6) Could not resolve host: updates.daintree.org",
            spawnError: null,
            timedOut: false,
          }
        : ok();

    it("keeps the host's own download when it works", async () => {
      const shell = fakeShell();
      const deps = makeDeps({ shell, probes: [LINUX_DEB] });
      const download = vi.fn(deps.download);
      deps.download = download;
      await expect(install(deps)).resolves.toMatchObject({ status: "needs-user-command" });
      expect(download).not.toHaveBeenCalled();
      expect(shell.uploads).toEqual([]);
    });

    it("downloads the artifact here, copies it over and checks its sha256 there", async () => {
      const shell = fakeShell(offline);
      const deps = makeDeps({ shell, probes: [LINUX_DEB] });
      const download = vi.fn(deps.download);
      deps.download = download;
      await expect(install(deps)).resolves.toMatchObject({
        status: "needs-user-command",
        command: { command: `sudo apt install ${STAGED}` },
      });
      expect(download).toHaveBeenCalledWith(
        `https://updates.daintree.org/releases/${DEB}`,
        path.join(cacheDir, DEB),
        expect.anything()
      );
      expect(shell.uploads).toEqual([[path.join(cacheDir, DEB), STAGED]]);
      const order = shell.scripts.map((s) =>
        s.includes("curl -fsSL")
          ? "host-fetch"
          : s === `rm -f '${STAGED}'`
            ? "drop-partial"
            : s.includes("@@dt:sha256")
              ? "check-copy"
              : s.includes("test -s")
                ? "verify"
                : s.includes("mktemp")
                  ? "stage"
                  : "other"
      );
      expect(order).toEqual(["stage", "host-fetch", "drop-partial", "check-copy", "verify"]);
      expect(deps.progress.map((p) => p.message)).toContain(
        "The host couldn't download the build, so this machine is fetching it"
      );
      // The downloaded copy doesn't outlive the upload.
      await expect(fs.access(path.join(cacheDir, DEB))).rejects.toThrow();
    });

    it("discards a copy whose sha256 differs on the host, leaving nothing staged", async () => {
      const shell = fakeShell(offline);
      const upload = shell.sendFile;
      shell.sendFile = async (local, remote, options) => {
        const result = await upload(local, remote, options);
        shell.received.set(remote, "0".repeat(64));
        return result;
      };
      const deps = makeDeps({ shell, probes: [LINUX_DEB] });
      await expect(install(deps)).rejects.toThrow(/doesn't match this machine's \(sha256\)/);
      expect(shell.scripts.at(-1)).toBe("rm -rf '/tmp/daintree-stage.abc123'");
      expect(shell.scripts.some((s) => s.includes("test -s"))).toBe(false);
    });

    it("says both sides failed when this machine can't download it either", async () => {
      const shell = fakeShell(offline);
      const deps = makeDeps({ shell, probes: [LINUX_DEB] });
      deps.download = async () => {
        throw new Error("getaddrinfo ENOTFOUND updates.daintree.org");
      };
      const error = (await install(deps).then(
        () => new Error("installed"),
        (e: unknown) => e
      )) as Error;
      expect(error.message).toContain("Neither the host nor this machine could download the build");
      expect(error.message).toContain("curl: (6) Could not resolve host");
      expect(error.message).toContain("ENOTFOUND");
      expect(shell.uploads).toEqual([]);
      expect(shell.scripts.at(-1)).toBe("rm -rf '/tmp/daintree-stage.abc123'");
    });
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
    // The marker beside the image is what was read out of the image at staging.
    const verify = shell.scripts.find((s) => s.includes("--appimage-extract"))!;
    expect(verify).toContain("resources/app.asar");
    expect(swap).toContain(
      `printf '%s' '${NEW_BUILD}' > '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json'`
    );
    // Its previous marker is kept beside it along with the image.
    expect(swap).toContain(
      "cp -p '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json' '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json.old'"
    );
    expect(shell.scripts).toContain("systemctl --user start daintree-host.service");
  });

  it("puts the previous build back and restarts it when the new one won't start", async () => {
    let opens = 0;
    const shell = fakeShell((script) =>
      script.startsWith("open ") && opens++ === 0
        ? { ...ok(), code: 1, stderr: "LSOpenURLsWithRole() failed" }
        : ok()
    );
    const deps = makeDeps({ shell, probes: [macProbe({ build: OLD_BUILD, hostMode: true })] });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(
      /start Daintree.*put back and is running again/s
    );
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
    // The build that didn't check out isn't left staged on the host.
    expect(shell.scripts.at(-1)).toBe("rm -rf '/tmp/daintree-stage.abc123'");
  });

  it("refuses a staged Mac build that carries no build marker, before stopping anything", async () => {
    const shell = fakeShell();
    const base = shell.exec;
    shell.exec = async (script, options) =>
      script.includes("ditto -x -k")
        ? (shell.scripts.push(script), ok("@@dt:version 1.4.0\n@@dt:buildinfo \n"))
        : base(script, options);
    const deps = makeDeps({ shell, probes: [macProbe({ build: OLD_BUILD, hostMode: true })] });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(/no build marker/);
    expect(shell.scripts.some((s) => s.includes("@@dt:stopped"))).toBe(false);
  });

  it("refuses an AppImage whose own archive has no build marker", async () => {
    const shell = fakeShell();
    const base = shell.exec;
    shell.exec = async (script, options) =>
      script.includes("--appimage-extract")
        ? (shell.scripts.push(script), ok("@@dt:buildinfo \n"))
        : base(script, options);
    const deps = makeDeps({ shell, probes: [LINUX_APPIMAGE_HOST] });
    await expect(install(deps, { hostId: "box" })).rejects.toThrow(/no build marker/);
    expect(shell.scripts.some((s) => s.includes("mv -f"))).toBe(false);
    // The build that didn't check out isn't left staged on the host.
    expect(shell.scripts.at(-1)).toBe("rm -rf '/tmp/daintree-stage.abc123'");
  });

  it("refuses to pick between AppImages when nothing shows which one is in use", async () => {
    const shell = fakeShell();
    const two = [
      "@@dt:uname Linux x86_64",
      "@@dt:appimage /home/greg/Applications/Daintree-1.9.0-x86_64.AppImage",
      "@@dt:appimage /home/greg/Applications/Daintree-1.10.0-x86_64.AppImage",
      "@@dt:download yes",
      "@@dt:end",
    ].join("\n");
    const deps = makeDeps({ shell, probes: [two] });
    await expect(install(deps)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringMatching(/2 Daintree AppImages/),
    });
    expect(shell.scripts).toEqual([]);
  });

  it("treats a build it can't read back after installing as a failure and puts the old one back", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        // Version right, but no marker to read the commit from.
        macProbe({ build: null, hostMode: true }).replace(
          "@@dt:running",
          "@@dt:install app-bundle /Applications/Daintree.app\n@@dt:version 1.4.0\n@@dt:running"
        ),
        macProbe({ build: OLD_BUILD, hostMode: true }),
      ],
    });
    await expect(install(deps, { hostId: "studio", whileWorking: "proceed" })).rejects.toThrow(
      /couldn't be read back.*put back and is running again/s
    );
    expect(shell.scripts.some((s) => s.includes("@@dt:rolledback"))).toBe(true);
    expect(deps.reconnect).not.toHaveBeenCalled();
  });

  it("rolls back when Host mode never comes back after the new build starts", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        ...Array.from({ length: 200 }, () => macProbe({ build: NEW_BUILD, hostMode: false })),
        macProbe({ build: OLD_BUILD, hostMode: true }),
      ],
    });
    deps.comeBackTimeoutMs = 5_000;
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(
      /Host mode didn't come back/
    );
    const rolledAt = shell.scripts.findIndex((s) => s.includes("@@dt:rolledback"));
    expect(rolledAt).toBeGreaterThan(-1);
    // The new build is stopped before the old one goes back.
    expect(shell.scripts[rolledAt - 1]).toContain("@@dt:stopped");
  });

  it("says so, rather than claiming a restore, when the rollback itself fails", async () => {
    const shell = fakeShell();
    const base = shell.exec;
    shell.exec = async (script, options) =>
      script.includes("@@dt:rolledback")
        ? (shell.scripts.push(script), ok("@@dt:rolledback failed\n"))
        : base(script, options);
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: OLD_BUILD, hostMode: true }),
      ],
    });
    await expect(install(deps, { whileWorking: "proceed" })).rejects.toThrow(
      /couldn't be restored on the host/
    );
  });

  it("restarts the old build when cancelled right after the host stopped", async () => {
    const controller = new AbortController();
    const shell = fakeShell();
    const base = shell.exec;
    shell.exec = async (script, options) => {
      const result = await base(script, options);
      if (script.includes("@@dt:stopped")) controller.abort();
      return result;
    };
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: OLD_BUILD, hostMode: true }),
      ],
    });
    await expect(
      install(deps, { whileWorking: "proceed" }, controller.signal)
    ).rejects.toMatchObject({
      code: "CANCELLED",
      message: expect.stringMatching(/started again/),
    });
    // Nothing was swapped, and Daintree is started again.
    expect(shell.scripts.some((s) => s.includes("Daintree.app.old"))).toBe(false);
    expect(shell.scripts.at(-1)).toBe("open -g -a '/Applications/Daintree.app' --args --host-mode");
  });

  it("puts the old build back when the running host's handshake reports another build", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: NEW_BUILD, hostMode: true }),
        macProbe({ build: OLD_BUILD, hostMode: true }),
      ],
    });
    deps.reconnect.mockResolvedValue(false);
    await expect(install(deps, { hostId: "studio", whileWorking: "proceed" })).rejects.toThrow(
      /running host reported a different build/
    );
    expect(shell.scripts.some((s) => s.includes("@@dt:rolledback"))).toBe(true);
    expect(shell.scripts).not.toContain("rm -rf '/Applications/Daintree.app.old'");
  });

  it("keeps the backup when the running host's handshake can't be had", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [
        macProbe({ build: OLD_BUILD, hostMode: true }),
        macProbe({ build: NEW_BUILD, hostMode: true }),
      ],
    });
    deps.reconnect.mockResolvedValue(null);
    await expect(install(deps, { hostId: "studio", whileWorking: "proceed" })).rejects.toThrow(
      /couldn't be confirmed/
    );
    expect(shell.scripts).not.toContain("rm -rf '/Applications/Daintree.app.old'");
    expect(shell.scripts.some((s) => s.includes("@@dt:rolledback"))).toBe(false);
  });

  it("restores an AppImage's previous marker along with the image", async () => {
    const shell = fakeShell();
    const deps = makeDeps({
      shell,
      probes: [LINUX_APPIMAGE_HOST, LINUX_APPIMAGE_HOST],
    });
    deps.reconnect.mockResolvedValue(false);
    await expect(install(deps, { hostId: "box" })).rejects.toThrow();
    const rollback = shell.scripts.find((s) => s.includes("@@dt:rolledback"))!;
    expect(rollback).toContain(
      "mv -f '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json.old' '/home/greg/Applications/Daintree-1.3.0-x86_64.AppImage.build-info.json'"
    );
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

describe("stopScript", () => {
  // On a shared host another user's Daintree must never be waited on or signalled.
  it.each([
    ["darwin", 4242],
    ["linux", null],
  ] as const)("only looks at and signals the ssh user's own %s process", (platform, pid) => {
    const script = stopScript(platform, pid, platform === "linux");
    const calls = script.match(/\b(pgrep|pkill)\b[^;&|]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('-u "$(id -u)"');
  });
});
