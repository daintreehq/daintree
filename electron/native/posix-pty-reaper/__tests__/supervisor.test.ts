import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Builds the real supervisor and drives it against real process trees, so the
// reparenting and PID-identity behaviour is proven against the kernel rather
// than a mock (#13176).

const SOURCE = path.resolve(__dirname, "../src/supervisor.c");
const TICK_MS = "50";

function compilerAvailable(): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  try {
    execFileSync("cc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun = compilerAvailable();

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  // A killed process may linger as a zombie until its parent reaps it.
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return stat === "" || stat.startsWith("Z");
  } catch {
    // ps exits non-zero once the pid is gone; anything else is unknown.
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

function parentOf(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const ppid = Number.parseInt(out.trim(), 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

describe.skipIf(!canRun)("daintree_pty_supervisor (#8769, #13176)", { timeout: 30_000 }, () => {
  let dir: string;
  let bin: string;
  const children: ChildProcess[] = [];
  const strays: number[] = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-supervisor-"));
    bin = path.join(dir, "daintree_pty_supervisor");
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Werror", SOURCE, "-o", bin]);
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of strays.splice(0)) {
      // Reaped strays are skipped so a recycled pid is never signalled.
      if (isGone(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function startSupervisor(): ChildProcess {
    const sup = spawn(bin, [TICK_MS], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(sup);
    return sup;
  }

  /**
   * A terminal-like root whose short-lived child backgrounds a long sleep and
   * then exits, so the sleep reparents away from the root while the
   * supervisor is watching — the detached case a pipe-close-only snapshot
   * can't see.
   */
  async function startRootWithDetachedGrandchild(): Promise<{
    root: ChildProcess;
    intermediate: number;
    grandchild: number;
  }> {
    const pidFile = path.join(dir, `gc-${Date.now()}-${Math.random()}`);
    const root = spawn(
      "sh",
      ["-c", `sh -c 'sleep 300 & echo "$! $$" > "${pidFile}"; sleep 2'; exec sleep 300`],
      { stdio: "ignore" }
    );
    children.push(root);
    const ready = await waitFor(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").includes(" ")
    );
    expect(ready).toBe(true);
    const [grandchild, intermediate] = fs
      .readFileSync(pidFile, "utf8")
      .trim()
      .split(" ")
      .map((v) => Number.parseInt(v, 10));
    strays.push(grandchild);
    return { root, intermediate, grandchild };
  }

  function exitOf(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("exit", () => resolve()));
  }

  it("reaps a registered root and a descendant that reparented away before the crash", async () => {
    const sup = startSupervisor();
    const { root, intermediate, grandchild } = await startRootWithDetachedGrandchild();
    sup.stdin!.write(`ADD ${root.pid}\n`);

    // The intermediate shell exits after 2s, orphaning the sleep away from
    // the registered root before the "crash".
    expect(await waitFor(() => isGone(intermediate))).toBe(true);
    expect(await waitFor(() => parentOf(grandchild) !== intermediate)).toBe(true);
    expect(isGone(grandchild)).toBe(false);

    // Closing the pipe without DISARM is what a hard crash of main looks like.
    sup.stdin!.end();
    await exitOf(sup);

    expect(await waitFor(() => isGone(grandchild))).toBe(true);
    await exitOf(root);
    expect(root.signalCode).toBe("SIGKILL");
  });

  it("stands down on DISARM", async () => {
    const sup = startSupervisor();
    const { root, grandchild } = await startRootWithDetachedGrandchild();
    sup.stdin!.write(`ADD ${root.pid}\n`);
    await new Promise((r) => setTimeout(r, 200));

    sup.stdin!.write("DISARM\n");
    sup.stdin!.end();
    await exitOf(sup);
    await new Promise((r) => setTimeout(r, 200));

    expect(isGone(grandchild)).toBe(false);
    expect(root.exitCode).toBeNull();
    expect(root.signalCode).toBeNull();
  });

  it("still reaps what a terminal left running after its root is retired by REMOVE", async () => {
    const sup = startSupervisor();
    const { root, intermediate, grandchild } = await startRootWithDetachedGrandchild();
    sup.stdin!.write(`ADD ${root.pid}\n`);
    expect(await waitFor(() => isGone(intermediate))).toBe(true);

    // The terminal exits and Main retires it; the orphaned job it left behind
    // must stay covered.
    root.kill("SIGKILL");
    await exitOf(root);
    sup.stdin!.write(`REMOVE ${root.pid}\n`);
    await new Promise((r) => setTimeout(r, 200));
    expect(isGone(grandchild)).toBe(false);

    sup.stdin!.end();
    await exitOf(sup);

    expect(await waitFor(() => isGone(grandchild))).toBe(true);
  });

  it("leaves unregistered processes alone", async () => {
    const sup = startSupervisor();
    const { root } = await startRootWithDetachedGrandchild();
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    children.push(bystander);
    sup.stdin!.write(`ADD ${root.pid}\n`);
    await new Promise((r) => setTimeout(r, 200));

    sup.stdin!.end();
    await exitOf(sup);
    await exitOf(root);

    expect(root.signalCode).toBe("SIGKILL");
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
  });

  it("never registers a pid it cannot prove identity for", async () => {
    // Spawn and reap a process so its pid is dead (and unlikely reused) by the
    // time the supervisor sees the ADD; a bystander must still survive.
    const dead = spawn("true", [], { stdio: "ignore" });
    await exitOf(dead);
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    children.push(bystander);

    const sup = startSupervisor();
    sup.stdin!.write(`ADD ${dead.pid}\n`);
    await new Promise((r) => setTimeout(r, 200));
    sup.stdin!.end();
    await exitOf(sup);

    expect(sup.exitCode).toBe(0);
    expect(bystander.signalCode).toBeNull();
  });
});
