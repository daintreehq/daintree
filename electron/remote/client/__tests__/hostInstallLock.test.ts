import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCommandRunner } from "../commandRunner.js";
import { processStartTime } from "../../host/hostSocketLock.js";
import {
  acquireInstallLock,
  installLockBreakScript,
  installLockHoldScript,
  installLockReleaseScript,
  installLockStatusScript,
} from "../hostInstallLock.js";
import type { HostCommandChannel } from "../remoteShell.js";

// The lock's scripts run under the real sh here (dash on Linux CI, bash 3.2 on
// macOS), with HOME pointed at a scratch folder standing in for the host.
const supported = process.platform === "darwin" || process.platform === "linux";

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dt-install-lock-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
});

const lockFolder = () =>
  path.join(
    home,
    process.platform === "darwin" ? "Library/Application Support/Daintree" : ".cache/daintree"
  );
const lockLink = () => path.join(lockFolder(), "host-install.lock");
const record = (token: string) => path.join(lockFolder(), `owner.${token}`);
/** What the lock names, or null when there is none. */
const lockTarget = () => {
  try {
    return fs.readlinkSync(lockLink());
  } catch {
    return null;
  }
};

const env = () => ({ ...process.env, HOME: home });

function holder(token: string): ChildProcess {
  const child = spawn("sh", ["-c", installLockHoldScript(token)], {
    env: env(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout?.resume();
  children.push(child);
  return child;
}

function status(token: string): string {
  return spawnSync("sh", ["-c", installLockStatusScript(token)], {
    env: env(),
    encoding: "utf8",
  }).stdout.trim();
}

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

/** This machine's sh standing in for the host's, the way setup reaches one over ssh. */
function localChannel(): HostCommandChannel {
  return {
    exec: (script, options) =>
      defaultCommandRunner("sh", ["-c", script], { ...options, env: { HOME: home } }),
    execWithInput: () => {
      throw new Error("not used");
    },
    sendFile: () => {
      throw new Error("not used");
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

describe.runIf(supported)("the host's install lock", () => {
  it("lets one holder at a time have it, the next once the first lets go", async () => {
    holder("aaaa");
    await until(() => status("aaaa") === "@@dt:lock held");
    const second = holder("bbbb");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(status("bbbb")).toBe("@@dt:lock other");
    expect(second.exitCode).toBeNull();

    spawnSync("sh", ["-c", installLockReleaseScript("aaaa")], { env: env() });
    await until(() => status("bbbb") === "@@dt:lock held");
  }, 20_000);

  it("takes over from a holder that was killed outright", async () => {
    const first = holder("aaaa");
    await until(() => status("aaaa") === "@@dt:lock held");
    // No exit trap runs: the lock stays behind, naming a pid that no longer exists.
    first.kill("SIGKILL");
    await exited(first);
    expect(lockTarget()).toBe("owner.aaaa");

    holder("bbbb");
    await until(() => status("bbbb") === "@@dt:lock held");
    // The dead holder's record went with its lock.
    expect(fs.existsSync(record("aaaa"))).toBe(false);
  }, 20_000);

  it("takes over when the recorded pid now belongs to a process that started at another time", async () => {
    const first = holder("aaaa");
    await until(() => status("aaaa") === "@@dt:lock held");
    // The record names the holder by when it really started, not a fixed stand-in.
    const [pid, identity] = fs.readFileSync(record("aaaa"), "utf8").split("\n");
    expect(Number(pid)).toBe(first.pid);
    const started = processStartTime(first.pid!)?.replace(/\s+/g, " ");
    expect(started).toBeTruthy();
    expect(identity!.startsWith(started!)).toBe(true);
    first.kill("SIGKILL");
    await exited(first);
    // A live process (this one) under the recorded pid, but not the one that wrote the lock.
    fs.writeFileSync(record("aaaa"), `${process.pid}\nnot when it started\n`);

    holder("bbbb");
    await until(() => status("bbbb") === "@@dt:lock held");
  }, 20_000);

  it("lets go soon after its channel goes", async () => {
    const first = holder("aaaa");
    await until(() => status("aaaa") === "@@dt:lock held");
    first.stdout?.destroy();
    await exited(first);
    expect(lockTarget()).toBeNull();
    expect(fs.existsSync(record("aaaa"))).toBe(false);
  }, 20_000);

  it("never removes a newer holder's lock when breaking one it judged stale earlier", async () => {
    holder("live");
    await until(() => status("live") === "@@dt:lock held");
    // A waiter that judged an earlier holder gone, then paused while the lock changed hands.
    spawnSync("sh", ["-c", installLockBreakScript("late", "owner.dead")], { env: env() });
    expect(lockTarget()).toBe("owner.live");
    expect(status("live")).toBe("@@dt:lock held");
    // The same break, for the lock it names, removes it.
    spawnSync("sh", ["-c", installLockBreakScript("late", "owner.live")], { env: env() });
    expect(lockTarget()).toBeNull();
  }, 20_000);

  it("waits for another device, says so once, and holds the lock until released", async () => {
    holder("other1");
    await until(() => status("other1") === "@@dt:lock held");
    const deps = { shell: localChannel(), sleep, pollMs: 200 };
    let waiting = 0;
    const acquiring = acquireInstallLock(deps, "mine", new AbortController().signal, () => {
      waiting += 1;
    });
    await until(() => waiting > 0);
    expect(status("mine")).toBe("@@dt:lock other");

    spawnSync("sh", ["-c", installLockReleaseScript("other1")], { env: env() });
    const lock = await acquiring;
    expect(waiting).toBe(1);
    expect(lock.held()).toBe(true);
    expect(status("mine")).toBe("@@dt:lock held");

    await lock.release();
    expect(lock.held()).toBe(false);
    expect(lockTarget()).toBeNull();
    expect(fs.existsSync(record("mine"))).toBe(false);
  }, 20_000);

  it("stops waiting when cancelled, leaving the other device's lock alone", async () => {
    holder("other1");
    await until(() => status("other1") === "@@dt:lock held");
    const controller = new AbortController();
    const acquiring = acquireInstallLock(
      { shell: localChannel(), sleep, pollMs: 200 },
      "mine",
      controller.signal,
      () => controller.abort()
    );
    await expect(acquiring).rejects.toMatchObject({ code: "CANCELLED" });
    expect(status("other1")).toBe("@@dt:lock held");
  }, 20_000);
});
