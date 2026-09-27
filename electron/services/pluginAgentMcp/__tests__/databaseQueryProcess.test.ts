import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import {
  MAX_CONCURRENT_DATABASE_PROCESSES,
  runDatabaseToolInProcess,
  type DatabaseChildProcess,
  type DatabaseProcessDeps,
} from "../databaseQueryProcess.js";
import { DATABASE_SCHEMA_TOOL, type DatabaseToolRequest } from "../databaseTools.js";

const request: DatabaseToolRequest = { tool: DATABASE_SCHEMA_TOOL, targets: [] };

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
  // Free every slot a test left held.
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
    await expect(
      runDatabaseToolInProcess(request, new AbortController().signal, d)
    ).rejects.toMatchObject({ code: "DB_BUSY" });
    children[0]!.exit();
    const next = runDatabaseToolInProcess(request, new AbortController().signal, d);
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
});
