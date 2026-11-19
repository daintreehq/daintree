import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detachedAliveScript,
  detachedStartScript,
  detachedStopScript,
  parseDetachedAlive,
  parseDetachedLaunch,
  type DetachedLaunch,
} from "../hostModeBootstrap.js";
import { stopScript } from "../hostInstaller.js";
import { adoptProcessForKill } from "../../../__tests__/helpers/processKillGuard.js";

/**
 * The start a Linux host with no init system gets, under a real /bin/sh with
 * the host's own userland: what it leaves running, in what session and
 * environment, and how a second start, a check and a stop find it again. It
 * reads /proc, so it runs on Linux only (the unit shards).
 */

const FAKE_DAINTREE = `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/args"
env > "$HOME/env"
ps -o sid= -p $$ > "$HOME/sid"
exec sleep 600
`;

let home: string;
let executable: string;
const started = new Set<number>();

function sh(script: string) {
  return spawnSync("/bin/sh", ["-c", script], {
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22",
      SOMETHING_ELSE: "left behind",
    },
    encoding: "utf8",
    // A start that left the channel open would hold this until the timeout.
    timeout: 15_000,
  });
}

function launch(flags: string[] = []): DetachedLaunch {
  const run = sh(
    detachedStartScript({ executable, appPath: null, appImageExtractAndRun: false }, flags)
  );
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  const launched = parseDetachedLaunch(run.stdout);
  expect(launched).not.toBeNull();
  if (launched!.fresh) {
    // Orphaned to PID 1 once its shell exits: started here, so this test may end it.
    adoptProcessForKill(launched!.pid);
    started.add(launched!.pid);
  }
  return launched!;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform !== "linux")("the detached Host start under a real shell", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "dt-detached-"));
    fs.mkdirSync(path.join(home, "bin"));
    executable = path.join(home, "bin", "fake-daintree");
    fs.writeFileSync(executable, FAKE_DAINTREE, { mode: 0o755 });
  });

  afterEach(() => {
    for (const pid of started) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    started.clear();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("starts it in a session of its own, with only what a service gets, and logs its start", async () => {
    const first = launch(["--enable-host-mode"]);
    expect(first.fresh).toBe(true);
    await until(() => fs.existsSync(path.join(home, "env")), "the start to run");
    expect(fs.readFileSync(path.join(home, "args"), "utf8").trim().split("\n")).toEqual([
      "--host-mode",
      "--ozone-platform=headless",
      "--enable-host-mode",
    ]);
    const env = fs.readFileSync(path.join(home, "env"), "utf8");
    expect(env).toContain(`HOME=${home}\n`);
    expect(env).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n");
    expect(env).toContain("LANG=C.UTF-8\n");
    expect(env).not.toContain("SSH_CONNECTION");
    expect(env).not.toContain("SOMETHING_ELSE");
    if (spawnSync("/bin/sh", ["-c", "command -v setsid"]).status === 0) {
      // Its own session: the login that started it ending doesn't reach it.
      expect(fs.readFileSync(path.join(home, "sid"), "utf8").trim()).toBe(String(first.pid));
    }
    expect(fs.readFileSync(path.join(home, ".cache/daintree/host.log"), "utf8")).toMatch(
      /^Started Daintree host /m
    );
    // Private to its user, as the socket's own folder is.
    expect(fs.statSync(path.join(home, ".cache/daintree")).mode & 0o077).toBe(0);
  });

  it("reports a start still running rather than making a second, and starts afresh once it's gone", async () => {
    const first = launch();
    const again = launch();
    expect(again).toEqual({ ...first, fresh: false });
    expect(parseDetachedAlive(sh(detachedAliveScript(first)).stdout)).toBe(true);

    expect(sh(detachedStopScript(first)).status).toBe(0);
    await until(() => !alive(first.pid), "the start to quit");
    expect(parseDetachedAlive(sh(detachedAliveScript(first)).stdout)).toBe(false);
    // A later process given its pid is never taken for it.
    expect(sh(detachedStopScript({ ...first, startedAt: "1" })).status).toBe(0);

    const next = launch();
    expect(next.fresh).toBe(true);
    expect(next.pid).not.toBe(first.pid);
  });

  it("takes a start its PID 1 never reaped for gone, and starts afresh", async () => {
    // A parent that never waits, as a PID 1 that isn't an init system may be.
    const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    started.add(parent.pid!);
    const zombie = Number(
      await new Promise<string>((resolve) => parent.stdout.once("data", (d) => resolve(String(d))))
    );
    const stat = () =>
      fs.readFileSync(`/proc/${zombie}/stat`, "utf8").replace(/.*\) /, "").split(" ");
    await until(() => stat()[0] === "Z", "the zombie");
    const startedAt = stat()[19]!;
    fs.mkdirSync(path.join(home, ".cache/daintree"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cache/daintree/host-launch.pid"),
      `${zombie} ${startedAt}\n`
    );
    const left: DetachedLaunch = { pid: zombie, startedAt, fresh: true };

    expect(parseDetachedAlive(sh(detachedAliveScript(left)).stdout)).toBe(false);
    expect(parseDetachedAlive(sh(detachedAliveScript({ ...left, startedAt: null })).stdout)).toBe(
      false
    );
    const next = launch();
    expect(next.fresh).toBe(true);
    expect(next.pid).not.toBe(zombie);
  });

  it("is taken down by a recovery stop before it is named Daintree", async () => {
    const first = launch();
    const stopped = sh(stopScript("linux", null, false, null, "stop"));
    expect(stopped.stdout).toContain("@@dt:stopped yes");
    expect(alive(first.pid)).toBe(false);
  });
});
