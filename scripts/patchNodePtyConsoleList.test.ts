import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { patchNodePtyConsoleListSource } from "./patchNodePtyConsoleList.cjs";

const INSTALLED = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "node-pty",
  "lib",
  "windowsPtyAgent.js"
);

const installed = fs.readFileSync(INSTALLED, "utf8");

interface Agent {
  _innerPid: number;
  _getConsoleProcessList(): Promise<number[]>;
}

/** Evaluates windowsPtyAgent.js with `fork` stubbed, and returns an agent for shell PID 4242. */
function agentWith(source: string, fork: (...args: unknown[]) => unknown): Agent {
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = (id: string) => {
    if (id === "child_process") return { fork };
    if (id === "path") return path;
    return {};
  };
  new Function("exports", "require", "module", "__dirname", source)(
    module.exports,
    fakeRequire,
    module,
    path.dirname(INSTALLED)
  );
  const proto = (module.exports.WindowsPtyAgent as { prototype: Agent }).prototype;
  const agent = Object.create(proto) as Agent;
  agent._innerPid = 4242;
  return agent;
}

const refusingFork = () => {
  throw new Error(
    "child_process.fork() is not supported when the runAsNode fuse is disabled; use utilityProcess.fork() instead"
  );
};

describe("patchNodePtyConsoleListSource", () => {
  const patched = patchNodePtyConsoleListSource(installed);

  it("the installed node-pty forks the console-list agent unguarded, so a refused fork rejects", async () => {
    await expect(agentWith(installed, refusingFork)._getConsoleProcessList()).rejects.toThrow(
      /runAsNode fuse/
    );
  });

  it("falls back to the shell PID when Electron refuses the fork", async () => {
    await expect(agentWith(patched, refusingFork)._getConsoleProcessList()).resolves.toEqual([
      4242,
    ]);
  });

  it("still takes the agent's list when the fork works", async () => {
    const fork = () => ({
      on: (event: string, cb: (message: unknown) => void) => {
        if (event === "message") queueMicrotask(() => cb({ consoleProcessList: [4242, 77] }));
      },
      kill: () => {},
    });
    await expect(agentWith(patched, fork)._getConsoleProcessList()).resolves.toEqual([4242, 77]);
  });

  it("is idempotent and keeps CRLF line endings", () => {
    expect(patchNodePtyConsoleListSource(patched)).toBe(patched);
    const crlf = installed.replace(/\n/g, "\r\n");
    expect(patchNodePtyConsoleListSource(crlf)).toBe(patched.replace(/\n/g, "\r\n"));
  });

  it("fails loudly when node-pty changes the code it edits", () => {
    const moved = installed.replace(
      "conpty_console_list_agent'), [",
      "conpty_console_list_agent'),  ["
    );
    expect(() => patchNodePtyConsoleListSource(moved)).toThrow(/console-list fork edit/);
  });
});
