import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import {
  MAX_CONCURRENT_DATABASE_PROCESSES,
  MAX_QUEUED_DATABASE_CALLS,
  SPAWN_DEADLINE_MS,
  runDatabaseToolInProcess,
  type DatabaseChildProcess,
  type DatabaseProcessDeps,
} from "../databaseQueryProcess.js";
import { DATABASE_SCHEMA_TOOL, type DatabaseToolRequest } from "../databaseTools.js";

const request: DatabaseToolRequest = { tool: DATABASE_SCHEMA_TOOL, targets: [] };

/** A request told apart by a marker in `targets`; the fake child never reads it as a target. */
function tagged(label: string): DatabaseToolRequest {
  return { ...request, targets: [label] } as unknown as DatabaseToolRequest;
}

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  posted: DatabaseToolRequest[] = [];
  postMessage(message: DatabaseToolRequest): void {
    this.posted.push(message);
  }
  spawn(pid = 4242): void {
    this.pid = pid;
    this.emit("spawn");
  }
  exit(code = 0): void {
    this.emit("exit", code);
  }
}

const children: FakeChild[] = [];
const waiting: AbortController[] = [];

/** A signal the suite aborts afterwards, so a call left queued never leaks into the next test. */
function queuedSignal(): AbortSignal {
  const controller = new AbortController();
  waiting.push(controller);
  return controller.signal;
}

function deps(): DatabaseProcessDeps & { kill: ReturnType<typeof vi.fn>; child: () => FakeChild } {
  const kill = vi.fn();
  return {
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as DatabaseChildProcess;
    },
    kill,
    child: () => children[children.length - 1]!,
  };
}

afterEach(() => {
  // Drop every call a test left queued, then free every slot it left held.
  for (const controller of waiting.splice(0)) controller.abort();
  for (const child of children.splice(0)) child.exit();
  vi.useRealTimers();
});

describe("runDatabaseToolInProcess", () => {
  it("posts the request and settles with the child's value", async () => {
    const d = deps();
    const result = runDatabaseToolInProcess(request, new AbortController().signal, d);
    const child = d.child();
    expect(child.posted).toEqual([request]);
    child.spawn();
    child.emit("message", { ok: true, value: { databases: [] } });
    await expect(result).resolves.toEqual({ databases: [] });
    child.exit();
  });

  it("rejects with the child's coded error", async () => {
    const d = deps();
    const result = runDatabaseToolInProcess(request, new AbortController().signal, d);
    d.child().emit("message", {
      ok: false,
      error: { code: "DB_NOT_A_QUERY", message: "DB_NOT_A_QUERY: nope" },
    });
    await expect(result).rejects.toMatchObject({
      code: "DB_NOT_A_QUERY",
      message: "DB_NOT_A_QUERY: nope",
    });
  });

  it("kills the child on abort, and before spawn once it has a pid", async () => {
    const d = deps();
    const controller = new AbortController();
    const result = runDatabaseToolInProcess(request, controller.signal, d);
    controller.abort(new Error("Tool call timed out after 60000 ms."));
    await expect(result).rejects.toThrow(/timed out/);
    expect(d.kill).not.toHaveBeenCalled();
    d.child().spawn(99);
    expect(d.kill).toHaveBeenCalledWith(99);
  });

  it("rejects when the child exits without answering", async () => {
    const d = deps();
    const result = runDatabaseToolInProcess(request, new AbortController().signal, d);
    d.child().exit(1);
    await expect(result).rejects.toMatchObject({ code: "DB_PROCESS_EXITED" });
  });

  it("holds a slot until the child exits, not until the call settles", async () => {
    const d = deps();
    const controllers = Array.from({ length: MAX_CONCURRENT_DATABASE_PROCESSES }, () => {
      const controller = new AbortController();
      runDatabaseToolInProcess(request, controller.signal, d).catch(() => {});
      return controller;
    });
    for (const controller of controllers) controller.abort();
    const next = runDatabaseToolInProcess(request, queuedSignal(), d);
    expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES);
    children[0]!.exit();
    expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES + 1);
    d.child().emit("message", { ok: true, value: 1 });
    await expect(next).resolves.toBe(1);
  });

  it("kills a child that answered but does not exit", async () => {
    vi.useFakeTimers();
    const d = deps();
    const result = runDatabaseToolInProcess(request, new AbortController().signal, d);
    const child = d.child();
    child.spawn(7);
    child.emit("message", { ok: true, value: null });
    await result;
    vi.advanceTimersByTime(2_000);
    expect(d.kill).toHaveBeenCalledWith(7);
  });

  it("gives the slot back when a launch never reports spawn or exit", async () => {
    vi.useFakeTimers();
    const d = deps();
    const stuck = Array.from({ length: MAX_CONCURRENT_DATABASE_PROCESSES }, () =>
      runDatabaseToolInProcess(request, new AbortController().signal, d)
    );
    const outcomes = Promise.allSettled(stuck);
    vi.advanceTimersByTime(SPAWN_DEADLINE_MS);
    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "DB_PROCESS_START_FAILED" },
      });
    }

    const next = runDatabaseToolInProcess(request, new AbortController().signal, d);
    d.child().emit("message", { ok: true, value: 2 });
    await expect(next).resolves.toBe(2);

    // A launch that turns up after all is killed, and its exit frees nothing twice.
    children[0]!.spawn(55);
    expect(d.kill).toHaveBeenCalledWith(55);
    children[0]!.exit();
    children[1]!.exit();
    // `next`'s child still holds one slot, so exactly one more starts and the
    // one after it waits — the late exits gave nothing back a second time.
    const before = children.length;
    runDatabaseToolInProcess(request, queuedSignal(), d).catch(() => {});
    runDatabaseToolInProcess(request, queuedSignal(), d).catch(() => {});
    expect(children).toHaveLength(before + 1);
  });

  describe("when every slot is taken", () => {
    function fillSlots(d: ReturnType<typeof deps>): Array<Promise<unknown>> {
      return Array.from({ length: MAX_CONCURRENT_DATABASE_PROCESSES }, () =>
        runDatabaseToolInProcess(request, new AbortController().signal, d).catch(() => {})
      );
    }

    it("waits for a slot instead of failing, and starts when one frees", async () => {
      const d = deps();
      fillSlots(d);
      const waiter = runDatabaseToolInProcess(request, queuedSignal(), d);
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES);
      children[1]!.exit();
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES + 1);
      d.child().emit("message", { ok: true, value: "late" });
      await expect(waiter).resolves.toBe("late");
    });

    it("admits waiters first come first served", async () => {
      const d = deps();
      fillSlots(d);
      const first = runDatabaseToolInProcess(tagged("first"), queuedSignal(), d);
      const second = runDatabaseToolInProcess(tagged("second"), queuedSignal(), d);
      children[0]!.exit();
      expect(d.child().posted[0]).toMatchObject({ targets: ["first"] });
      children[1]!.exit();
      expect(d.child().posted[0]).toMatchObject({ targets: ["second"] });
      first.catch(() => {});
      second.catch(() => {});
    });

    it("drops a waiter whose call is aborted, without taking a slot", async () => {
      const d = deps();
      fillSlots(d);
      const controller = new AbortController();
      const waiter = runDatabaseToolInProcess(request, controller.signal, d);
      controller.abort(new Error("Tool call timed out after 60000 ms."));
      await expect(waiter).rejects.toThrow(/timed out/);
      const next = runDatabaseToolInProcess(request, queuedSignal(), d);
      children[0]!.exit();
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES + 1);
      d.child().emit("message", { ok: true, value: 3 });
      await expect(next).resolves.toBe(3);
    });

    it("answers DB_BUSY only once the queue is full, and admits again after a queued abort", async () => {
      const d = deps();
      fillSlots(d);
      const controllers = Array.from({ length: MAX_QUEUED_DATABASE_CALLS }, () => {
        const controller = new AbortController();
        waiting.push(controller);
        runDatabaseToolInProcess(request, controller.signal, d).catch(() => {});
        return controller;
      });
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES);
      await expect(
        runDatabaseToolInProcess(request, new AbortController().signal, d)
      ).rejects.toMatchObject({ code: "DB_BUSY" });

      controllers[3]!.abort();
      const replacement = runDatabaseToolInProcess(tagged("replacement"), queuedSignal(), d);
      replacement.catch(() => {});
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES);
      // The replacement waits behind every earlier waiter still queued.
      for (let i = 0; i < MAX_QUEUED_DATABASE_CALLS; i++) children[i]!.exit();
      expect(d.child().posted[0]).toMatchObject({ targets: ["replacement"] });
    });

    it("hands a slot freed by the spawn deadline to the oldest waiter", async () => {
      vi.useFakeTimers();
      const d = deps();
      const stuck = Array.from({ length: MAX_CONCURRENT_DATABASE_PROCESSES }, () =>
        runDatabaseToolInProcess(request, new AbortController().signal, d).catch(() => {})
      );
      const waiter = runDatabaseToolInProcess(tagged("waiter"), queuedSignal(), d);
      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES);

      vi.advanceTimersByTime(SPAWN_DEADLINE_MS);
      await Promise.all(stuck);

      expect(children).toHaveLength(MAX_CONCURRENT_DATABASE_PROCESSES + 1);
      expect(d.child().posted[0]).toMatchObject({ targets: ["waiter"] });
      d.child().emit("message", { ok: true, value: 5 });
      await expect(waiter).resolves.toBe(5);
    });

    it("passes the slot on when a waiter's launch throws", async () => {
      const d = deps();
      fillSlots(d);
      const fork = d.fork;
      const failing = runDatabaseToolInProcess(request, queuedSignal(), {
        ...d,
        fork: () => {
          throw new Error("fork failed");
        },
      });
      const next = runDatabaseToolInProcess(request, queuedSignal(), { ...d, fork });
      children[0]!.exit();
      await expect(failing).rejects.toThrow("fork failed");
      d.child().emit("message", { ok: true, value: 4 });
      await expect(next).resolves.toBe(4);
    });
  });
});
