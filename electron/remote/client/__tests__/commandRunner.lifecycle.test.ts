import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  COMMAND_DRAIN_GRACE_MS,
  COMMAND_STOP_GRACE_MS,
  defaultCommandRunner,
  type CommandOptions,
  type CommandResult,
} from "../commandRunner.js";

/** A program whose exit and pipe closing the test decides, one event at a time. */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  print(stream: "stdout" | "stderr", text: string): void {
    this[stream].emit("data", Buffer.from(text));
  }
}

function start(options: CommandOptions) {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
  let result: CommandResult | undefined;
  void defaultCommandRunner("ssh", ["host", "true"], options).then((r) => {
    result = r;
  });
  return { child, settled: () => result };
}

const DEADLINE_MS = 1_000;

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("defaultCommandRunner lifecycle", () => {
  it("settles a stopped run a drain grace after it exits, with what it printed meanwhile", async () => {
    const run = start({ timeoutMs: DEADLINE_MS });
    run.child.print("stdout", "before ");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(run.child.signals).toEqual(["SIGTERM"]);

    run.child.emit("exit", null, "SIGTERM");
    run.child.print("stdout", "after");
    run.child.print("stderr", "bye");
    await vi.advanceTimersByTimeAsync(COMMAND_DRAIN_GRACE_MS - 1);
    expect(run.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(run.settled()).toEqual({
      code: null,
      stdout: "before after",
      stderr: "bye",
      spawnError: null,
      timedOut: true,
    });
    expect(run.child.signals).toEqual(["SIGTERM"]);
    expect(run.child.stdout.destroyed).toBe(true);
    expect(run.child.stderr.destroyed).toBe(true);
  });

  it("kills a program that ignores SIGTERM when the stop grace is up, and not before", async () => {
    const run = start({ timeoutMs: DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + COMMAND_STOP_GRACE_MS - 1);
    expect(run.child.signals).toEqual(["SIGTERM"]);
    expect(run.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(run.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(run.settled()).toMatchObject({ code: null, timedOut: true });
    expect(run.child.stdout.destroyed).toBe(true);
    expect(run.child.stderr.destroyed).toBe(true);
  });

  it("doesn't let an exit late in the stop grace extend it", async () => {
    const run = start({ timeoutMs: DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + COMMAND_STOP_GRACE_MS - 10);
    run.child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(10);
    expect(run.settled()).toMatchObject({ code: null, timedOut: true });
    expect(run.child.signals).toEqual(["SIGTERM"]);
  });

  it("keeps reading after a natural exit until the pipes close", async () => {
    const run = start({ timeoutMs: 60_000 });
    run.child.emit("exit", 3, null);
    await vi.advanceTimersByTimeAsync(COMMAND_STOP_GRACE_MS + COMMAND_DRAIN_GRACE_MS);
    expect(run.settled()).toBeUndefined();

    run.child.print("stdout", "late");
    run.child.emit("close", 3, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settled()).toEqual({
      code: 3,
      stdout: "late",
      stderr: "",
      spawnError: null,
      timedOut: false,
    });
  });

  it("drains without signalling when the deadline passes after a natural exit", async () => {
    const run = start({ timeoutMs: DEADLINE_MS });
    run.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + COMMAND_DRAIN_GRACE_MS - 1);
    expect(run.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(run.settled()).toMatchObject({ code: null, timedOut: true });
    expect(run.child.signals).toEqual([]);
  });

  it("stops once, for whichever reason comes first", async () => {
    const controller = new AbortController();
    const run = start({ collectForMs: 500, timeoutMs: DEADLINE_MS, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(run.child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(COMMAND_STOP_GRACE_MS);
    expect(run.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(run.settled()).toMatchObject({ code: null, timedOut: false });
  });

  it("doesn't start a program for a run that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      defaultCommandRunner("ssh", ["host", "true"], { signal: controller.signal })
    ).resolves.toEqual({ code: null, stdout: "", stderr: "", spawnError: null, timedOut: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
