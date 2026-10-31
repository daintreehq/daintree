import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptProcessForKill } from "../../../__tests__/helpers/processKillGuard.js";
import {
  COMMAND_DRAIN_GRACE_MS,
  COMMAND_STOP_GRACE_MS,
  defaultCommandRunner,
  type CommandOptions,
} from "../commandRunner.js";

// Room for process start-up and a loaded CI machine on top of the runner's own graces.
const SLACK_MS = 3_000;
// Late enough that `sh` has set itself up before it is stopped, even on a loaded machine.
const STOP_AT_MS = 1_000;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-runner-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // The scripts record their own pids, so a run that never settled is cleaned
  // up too. A background job is orphaned once `sh` is gone, so the kill guard
  // has to be told it is this test's.
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".pid")) continue;
    const pid = Number((await fs.readFile(path.join(dir, name), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    adoptProcessForKill(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function recordedPid(name: string): Promise<number> {
  return Number((await fs.readFile(path.join(dir, `${name}.pid`), "utf8")).trim());
}

async function run(script: string, options: CommandOptions = {}) {
  const started = performance.now();
  const result = await defaultCommandRunner("sh", ["-c", script], {
    ...options,
    env: { PIDS: dir },
  });
  return { result, elapsed: performance.now() - started };
}

/** Resolves once a script has written its pid file: the sign that it is set up. */
async function whenRecorded(name: string): Promise<void> {
  const file = path.join(dir, `${name}.pid`);
  for (let waited = 0; waited < 10_000; waited += 20) {
    if ((await fs.readFile(file, "utf8").catch(() => "")).trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const stopPaths: Array<{
  name: string;
  options: (ready: string) => CommandOptions;
  timedOut: boolean;
}> = [
  { name: "deadline", options: () => ({ timeoutMs: STOP_AT_MS }), timedOut: true },
  {
    name: "collectForMs",
    options: () => ({ collectForMs: STOP_AT_MS, timeoutMs: 60_000 }),
    timedOut: false,
  },
  {
    name: "abort",
    // Cancelled once the script is set up, however long that took.
    options: (ready) => {
      const controller = new AbortController();
      void whenRecorded(ready).then(() => controller.abort());
      return { signal: controller.signal, timeoutMs: 60_000 };
    },
    timedOut: false,
  },
];

describe.skipIf(process.platform === "win32")("defaultCommandRunner settlement", () => {
  describe.each(stopPaths)("stopped by its $name", ({ options, timedOut }) => {
    it("settles once the program is gone though something else still holds its output", async () => {
      // `sh` dies on SIGTERM, but the background sleep keeps its stdout and
      // stderr pipes open, the way an ssh ControlMaster does for a mux client.
      const { result, elapsed } = await run(
        `sleep 30 & holder=$!; echo out; echo err >&2; echo $holder > "$PIDS/holder.pid"; wait`,
        options("holder")
      );
      expect(isAlive(await recordedPid("holder"))).toBe(true);
      expect(result).toEqual({
        code: null,
        stdout: "out\n",
        stderr: "err\n",
        spawnError: null,
        timedOut,
      });
      expect(elapsed).toBeLessThan(STOP_AT_MS + COMMAND_DRAIN_GRACE_MS + SLACK_MS);
    });

    it("kills a program that ignores SIGTERM once the grace is up", async () => {
      // "ready" is only printed once SIGTERM is ignored.
      const { result, elapsed } = await run(
        `trap "" TERM; echo ready; echo $$ > "$PIDS/child.pid"; exec sleep 30`,
        options("child")
      );
      expect(result).toMatchObject({ code: null, stdout: "ready\n", spawnError: null, timedOut });
      expect(elapsed).toBeLessThan(STOP_AT_MS + COMMAND_STOP_GRACE_MS + SLACK_MS);
      const pid = await recordedPid("child");
      await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    });
  });

  it("reports a stopped run as stopped even when the program exits cleanly on SIGTERM", async () => {
    const { result } = await run(
      `echo $$ > "$PIDS/child.pid"; trap "exit 0" TERM; echo ready; ` +
        `i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
      { timeoutMs: STOP_AT_MS }
    );
    expect(result).toMatchObject({ code: null, stdout: "ready\n", timedOut: true });
  });

  it("keeps reading after the program exits while something it started still writes", async () => {
    // It writes after the drain grace a stopped run would get.
    const { result } = await run(
      `(sleep ${(COMMAND_DRAIN_GRACE_MS + 500) / 1000}; echo late) & exit 3`
    );
    expect(result).toMatchObject({ code: 3, stdout: "late\n", timedOut: false });
  });

  it("still keeps its deadline when the program has exited but its output stays held", async () => {
    const { result, elapsed } = await run(`sleep 30 & echo $! > "$PIDS/holder.pid"; exit 3`, {
      timeoutMs: STOP_AT_MS,
    });
    expect(result).toMatchObject({ code: null, timedOut: true });
    expect(elapsed).toBeLessThan(STOP_AT_MS + COMMAND_DRAIN_GRACE_MS + SLACK_MS);
  });

  it("lets go of its own ends of the pipes when it settles", async () => {
    // The holder keeps writing until a write fails, then records how many it managed.
    const writes = path.join(dir, "writes");
    const holder =
      `( trap '' PIPE; i=0; while [ $i -lt 200 ] && /bin/echo tick 2>/dev/null; ` +
      `do i=$((i+1)); sleep 0.05; done; echo $i > "$PIDS/writes" ) & ` +
      `echo $! > "$PIDS/holder.pid"; wait`;
    const { result } = await run(holder, { timeoutMs: STOP_AT_MS });
    expect(result.timedOut).toBe(true);
    await expect
      .poll(() => fs.readFile(writes, "utf8").catch(() => ""), { timeout: 8_000 })
      .toMatch(/^\d+\n$/);
    expect(Number((await fs.readFile(writes, "utf8")).trim())).toBeLessThan(200);
  });

  it("keeps everything a program printed before it exited", async () => {
    const { result } = await run("head -c 200000 /dev/zero | tr '\\0' a");
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(200_000);
  });

  it("reports a program that couldn't be started", async () => {
    const result = await defaultCommandRunner("dt-no-such-program-15586", []);
    expect(result.code).toBeNull();
    expect(result.spawnError).toMatch(/ENOENT/);
  });

  it("settles on time when the program can't be signalled", async () => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
      this: ChildProcess
    ) {
      this.emit("error", new Error("kill EPERM"));
      return false;
    });
    const { result, elapsed } = await run(`echo $$ > "$PIDS/child.pid"; exec sleep 30`, {
      timeoutMs: STOP_AT_MS,
    });
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ code: null, spawnError: null, timedOut: true });
    expect(elapsed).toBeLessThan(STOP_AT_MS + COMMAND_STOP_GRACE_MS + SLACK_MS);
  });
});
