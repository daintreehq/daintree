import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IPty } from "node-pty";

type EmitData = (id: string, data: string | Uint8Array) => void;

// What the mocked constructor emits synchronously, standing in for
// TerminalProcess.replayPrelude and the data handoff's buffered-chunk flush.
let constructorOutput: Array<string | Uint8Array> = [];
let shouldThrow = false;
let lastEmitData: EmitData | null = null;
let duringConstruction: (() => void) | null = null;

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
      constructor(id: string, _options: unknown, callbacks: { emitData: EmitData }) {
        lastEmitData = callbacks.emitData;
        for (const chunk of constructorOutput) {
          callbacks.emitData(id, chunk);
        }
        duringConstruction?.();
        if (shouldThrow) throw new Error("constructor failed");
      }
      getInfo() {
        return { wasKilled: false, isExited: false };
      }
      isAgentCurrentlyLive() {
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

const spawnOptions = { cwd: "/tmp", cols: 80, rows: 24, kind: "terminal" as const };

describe("PtyManager.spawn — output emitted during TerminalProcess construction", () => {
  let manager: InstanceType<typeof PtyManager>;
  let dataEvents: Array<[string, string | Uint8Array]>;

  beforeEach(() => {
    constructorOutput = [];
    shouldThrow = false;
    lastEmitData = null;
    duringConstruction = null;
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: createMockPty(),
      prelude: "[oh-my-zsh] Would you like to update? [Y/n] ",
    });
    manager = new PtyManager();
    dataEvents = [];
    manager.on("data", (id: string, data: string | Uint8Array) => {
      dataEvents.push([id, data]);
    });
  });

  it("delivers the pooled-shell prelude replayed from the constructor (#12753)", () => {
    constructorOutput = ["[oh-my-zsh] Would you like to update? [Y/n] "];

    manager.spawn("t1", spawnOptions);

    expect(dataEvents).toEqual([["t1", "[oh-my-zsh] Would you like to update? [Y/n] "]]);
  });

  it("keeps prelude and handoff-buffered chunks in order ahead of live output", () => {
    const buffered = new Uint8Array([0x24, 0x20]);
    constructorOutput = ["prelude ", buffered];

    manager.spawn("t1", spawnOptions);
    lastEmitData!("t1", "live");

    expect(dataEvents).toEqual([
      ["t1", "prelude "],
      ["t1", buffered],
      ["t1", "live"],
    ]);
  });

  it("drops construction output when the constructor throws and does not leak it into the next spawn", () => {
    constructorOutput = ["from failed incarnation"];
    shouldThrow = true;

    expect(() => manager.spawn("t1", spawnOptions)).toThrow("constructor failed");
    expect(dataEvents).toEqual([]);

    constructorOutput = [];
    shouldThrow = false;
    manager.spawn("t1", spawnOptions);
    lastEmitData!("t1", "fresh");

    expect(dataEvents).toEqual([["t1", "fresh"]]);
  });

  it("routes another terminal's output live while one is being constructed", () => {
    manager.spawn("t1", spawnOptions);
    const emitForT1 = lastEmitData!;

    constructorOutput = ["t2 prelude"];
    duringConstruction = () => emitForT1("t1", "t1 live");
    manager.spawn("t2", spawnOptions);

    expect(dataEvents).toEqual([
      ["t1", "t1 live"],
      ["t2", "t2 prelude"],
    ]);
  });
});
