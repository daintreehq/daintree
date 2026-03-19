import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IPty } from "node-pty";

let shouldThrow = false;
const constructorError = new Error("HeadlessTerminal init failed");

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../pty/terminalSpawn.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    computeSpawnContext: vi.fn(() => ({
      shell: "/bin/zsh",
      args: ["-l"],
      isAgentTerminal: false,
      agentId: undefined,
      env: {},
    })),
    acquirePtyProcess: vi.fn(),
  };
});

vi.mock("../pty/index.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TerminalProcess: class MockTerminalProcess {
      constructor() {
        if (shouldThrow) throw constructorError;
      }
      getInfo() {
        return {};
      }
      getIsAgentTerminal() {
        return false;
      }
      setSabModeEnabled() {}
      shouldPreserveOnExit() {
        return false;
      }
    },
  };
});

const { acquirePtyProcess } = await import("../pty/terminalSpawn.js");
const { PtyManager } = await import("../PtyManager.js");

function createMockPty(): IPty {
  return {
    pid: 999,
    cols: 80,
    rows: 24,
    process: "zsh",
    handleFlowControl: false,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as IPty;
}

describe("PtyManager.spawn — PTY cleanup on constructor failure", () => {
  let manager: InstanceType<typeof PtyManager>;
  let mockPty: IPty;

  beforeEach(() => {
    shouldThrow = false;
    mockPty = createMockPty();
    vi.mocked(acquirePtyProcess).mockReturnValue(mockPty);
    manager = new PtyManager();
  });

  it("kills orphaned PTY when TerminalProcess constructor throws", () => {
    shouldThrow = true;

    expect(() =>
      manager.spawn("t1", {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        kind: "terminal",
        type: "terminal",
      })
    ).toThrow(constructorError);

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it("does not register terminal when constructor throws", () => {
    shouldThrow = true;

    try {
      manager.spawn("t1", {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        kind: "terminal",
        type: "terminal",
      });
    } catch {
      // expected
    }

    expect(manager.hasTerminal("t1")).toBe(false);
  });

  it("propagates the original error even if ptyProcess.kill() also throws", () => {
    shouldThrow = true;
    vi.mocked(mockPty.kill).mockImplementation(() => {
      throw new Error("ESRCH");
    });

    expect(() =>
      manager.spawn("t1", {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        kind: "terminal",
        type: "terminal",
      })
    ).toThrow(constructorError);

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it("does not attempt kill when acquirePtyProcess itself throws", () => {
    vi.mocked(acquirePtyProcess).mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    expect(() =>
      manager.spawn("t1", {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        kind: "terminal",
        type: "terminal",
      })
    ).toThrow("spawn ENOENT");

    expect(manager.hasTerminal("t1")).toBe(false);
  });

  it("registers terminal normally when constructor succeeds", () => {
    shouldThrow = false;

    manager.spawn("t1", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      kind: "terminal",
      type: "terminal",
    });

    expect(manager.hasTerminal("t1")).toBe(true);
    expect(mockPty.kill).not.toHaveBeenCalled();
  });
});
