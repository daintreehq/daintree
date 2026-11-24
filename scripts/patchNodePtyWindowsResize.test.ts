import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { patchNodePtyWindowsResize } from "./patchNodePtyWindowsResize.cjs";

const require = createRequire(import.meta.url);
const terminalPath = require.resolve("node-pty/lib/windowsTerminal.js");
const source = readFileSync(terminalPath, "utf8");
const terminalRequire = createRequire(terminalPath);

function makeTerminal(isReady = false) {
  const module = { exports: {} as { WindowsTerminal?: { prototype: object } } };
  new Function("require", "exports", patchNodePtyWindowsResize(source))(
    terminalRequire,
    module.exports
  );
  const { WindowsPtyAgent } = terminalRequire("./windowsPtyAgent");
  const resize = vi.fn();
  const agent = Object.assign(Object.create(WindowsPtyAgent.prototype), {
    _exitCode: undefined,
    _ptyNative: { resize },
    _pty: 17,
    _useConptyDll: true,
  }) as { _exitCode: number | undefined };
  const terminal = Object.assign(Object.create(module.exports.WindowsTerminal!.prototype), {
    _agent: agent,
    _isReady: isReady,
    _deferreds: [],
    _cols: 80,
    _rows: 24,
  }) as {
    resize(cols: number, rows: number): void;
    _isReady: boolean;
    _deferreds: Array<{ run(): void }>;
    _cols: number;
    _rows: number;
  };
  const flushDeferred = () => {
    terminal._isReady = true;
    for (const job of terminal._deferreds.splice(0)) job.run();
  };
  return { terminal, agent, resize, flushDeferred };
}

describe("node-pty Windows resize queued before first socket data", () => {
  it("ignores the queued resize if the shell exited before the data arrived", () => {
    const { terminal, agent, resize, flushDeferred } = makeTerminal();
    terminal.resize(100, 30);
    agent._exitCode = 0;

    expect(flushDeferred).not.toThrow();
    expect(resize).not.toHaveBeenCalled();
    expect([terminal._cols, terminal._rows]).toEqual([80, 24]);
  });

  it("applies the resize and records the new grid if the shell is still live", () => {
    const { terminal, resize, flushDeferred } = makeTerminal();
    terminal.resize(100, 30);
    expect(resize).not.toHaveBeenCalled();

    flushDeferred();

    expect(resize).toHaveBeenCalledWith(17, 100, 30, true);
    expect([terminal._cols, terminal._rows]).toEqual([100, 30]);
  });

  it("preserves the caller's ability to catch a synchronous resize failure", () => {
    const { terminal, agent } = makeTerminal(true);
    agent._exitCode = 0;
    expect(() => terminal.resize(100, 30)).toThrow(/already exited/);
  });

  it("is idempotent and detects a changed dependency", () => {
    const patched = patchNodePtyWindowsResize(source);
    expect(patchNodePtyWindowsResize(patched)).toBe(patched);
    expect(() => patchNodePtyWindowsResize("unknown dependency")).toThrow(/resize changed/);
  });
});
