import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { patchNodePtyFork } from "./patchNodePtyFork.cjs";

const require = createRequire(import.meta.url);
const agentPath = require.resolve("node-pty/lib/windowsPtyAgent.js");
const source = readFileSync(agentPath, "utf8");

function loadAgent(fork: ReturnType<typeof vi.fn>) {
  const module = { exports: {} as { WindowsPtyAgent?: { prototype: object } } };
  const localRequire = createRequire(agentPath);
  const kill = vi.fn();
  new Function("require", "module", "exports", "process", "__dirname", patchNodePtyFork(source))(
    (id: string) => (id === "child_process" ? { fork } : localRequire(id)),
    module,
    module.exports,
    { ...process, kill },
    dirname(agentPath)
  );
  const nativeKill = vi.fn();
  const dispose = vi.fn();
  const agent = Object.assign(Object.create(module.exports.WindowsPtyAgent!.prototype), {
    _innerPid: 12345,
    _useConptyDll: false,
    _clearConnectionTimeout: vi.fn(),
    _inSocket: { readable: true },
    _outSocket: { readable: true },
    _ptyNative: { kill: nativeKill },
    _conoutSocketWorker: { dispose },
  }) as { kill(): void; _getConsoleProcessList(): Promise<number[]> };
  return { agent, kill, nativeKill, dispose };
}

describe("packaged node-pty helper compatibility", () => {
  it("reaps the shell and closes native resources when Electron forbids fork", async () => {
    const fork = vi.fn(() => {
      throw new Error(
        "child_process.fork() is not supported when the runAsNode fuse is disabled; use utilityProcess.fork() instead"
      );
    });
    const { agent, kill, nativeKill, dispose } = loadAgent(fork);
    agent.kill();
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith(12345);
    expect(nativeKill).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledOnce();
  });

  it("preserves the normal console-list helper and all returned PIDs", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const { agent } = loadAgent(vi.fn(() => child));
    const result = agent._getConsoleProcessList();
    child.emit("message", { consoleProcessList: [12345, 12346] });
    await expect(result).resolves.toEqual([12345, 12346]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not hide unrelated helper errors", async () => {
    const error = new Error("unexpected spawn failure");
    const { agent } = loadAgent(
      vi.fn(() => {
        throw error;
      })
    );
    await expect(agent._getConsoleProcessList()).rejects.toBe(error);
  });

  it("is idempotent and rejects an unrecognized dependency", () => {
    const patched = patchNodePtyFork(source);
    expect(patchNodePtyFork(patched)).toBe(patched);
    expect(() => patchNodePtyFork("unknown dependency")).toThrow(/helper changed/);
  });
});
