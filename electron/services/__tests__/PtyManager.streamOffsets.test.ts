import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";

type Callbacks = {
  emitData: (id: string, data: string, streamEnd: number) => void;
  onExit: (id: string, exitCode: number) => void;
  streamOffsetBase?: number;
};

const constructed: Callbacks[] = [];
let preserveOnExit = false;
let infoState = { wasKilled: false, isExited: true };

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

vi.mock("../pty/terminalSpawn.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    computeSpawnContext: vi.fn(() => ({ shell: "/bin/zsh", args: ["-l"], env: {} })),
    acquirePtyProcess: vi.fn(),
  };
});

vi.mock("../pty/index.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TerminalProcess: class MockTerminalProcess {
      constructor(_id: string, _options: unknown, callbacks: Callbacks) {
        constructed.push(callbacks);
      }
      getInfo() {
        return infoState;
      }
      kill() {}
      dispose() {}
      isAgentCurrentlyLive() {
        return false;
      }
      setSabModeEnabled() {}
      shouldPreserveOnExit() {
        return preserveOnExit;
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

function offsetsOf(manager: InstanceType<typeof PtyManager>): Map<string, number> {
  return (manager as unknown as { streamOffsets: Map<string, number> }).streamOffsets;
}

describe("PtyManager stream offsets", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    constructed.length = 0;
    preserveOnExit = false;
    infoState = { wasKilled: false, isExited: true };
    vi.mocked(acquirePtyProcess).mockReturnValue({ ptyProcess: createMockPty(), prelude: "" });
    manager = new PtyManager();
  });

  it("forgets a terminal's offset once it exits for good", () => {
    manager.spawn("t1", spawnOptions);
    const cb = constructed[0];
    cb.emitData("t1", "hello", cb.streamOffsetBase! + 5);
    expect(offsetsOf(manager).has("t1")).toBe(true);

    cb.onExit("t1", 0);

    expect(offsetsOf(manager).size).toBe(0);
  });

  it("forgets a terminal's offset when an exited terminal is killed", () => {
    preserveOnExit = true;
    manager.spawn("t1", spawnOptions);
    const cb = constructed[0];
    cb.emitData("t1", "hello", cb.streamOffsetBase! + 5);
    cb.onExit("t1", 1);
    expect(offsetsOf(manager).has("t1")).toBe(true);

    manager.kill("t1");

    expect(offsetsOf(manager).size).toBe(0);
  });

  it("does not re-record an offset from output arriving after the terminal is gone", () => {
    manager.spawn("t1", spawnOptions);
    const cb = constructed[0];
    cb.onExit("t1", 0);

    cb.emitData("t1", "late", cb.streamOffsetBase! + 4);

    expect(offsetsOf(manager).size).toBe(0);
  });

  it("starts a respawn at a forgotten id past every offset already emitted", () => {
    manager.spawn("t1", spawnOptions);
    const first = constructed[0];
    const firstEnd = first.streamOffsetBase! + 1e12;
    first.emitData("t1", "x", firstEnd);
    first.onExit("t1", 0);
    first.emitData("t1", "late", firstEnd + 4);

    manager.spawn("t1", spawnOptions);

    expect(constructed[1].streamOffsetBase).toBeGreaterThanOrEqual(firstEnd + 4);
  });

  it("keeps a preserved terminal's offset while it stays registered", () => {
    preserveOnExit = true;
    manager.spawn("t1", spawnOptions);
    const cb = constructed[0];
    const end = cb.streamOffsetBase! + 42;
    cb.emitData("t1", "x", end);
    cb.onExit("t1", 1);

    expect(offsetsOf(manager).get("t1")).toBe(end);
  });

  it("starts a fresh id at the host origin however much live terminals have emitted", () => {
    manager.spawn("t1", spawnOptions);
    const origin = constructed[0].streamOffsetBase!;
    constructed[0].emitData("t1", "x", origin + 1e9);

    manager.spawn("t2", spawnOptions);

    expect(constructed[1].streamOffsetBase).toBe(origin);
  });

  it("starts a respawn of a silent terminal no lower than its first base", () => {
    manager.spawn("t0", spawnOptions);
    const t0 = constructed[0];
    t0.emitData("t0", "x", t0.streamOffsetBase! + 500);
    t0.onExit("t0", 0);
    manager.spawn("t1", spawnOptions);
    const silentBase = constructed[1].streamOffsetBase!;
    constructed[1].onExit("t1", 0);

    manager.spawn("t1", spawnOptions);

    expect(constructed[2].streamOffsetBase).toBeGreaterThanOrEqual(silentBase);
  });

  it("continues from the last offset when a killed-but-not-exited terminal is respawned", () => {
    infoState = { wasKilled: false, isExited: false };
    manager.spawn("t1", spawnOptions);
    const first = constructed[0];
    const end = first.streamOffsetBase! + 42;
    first.emitData("t1", "x", end);
    manager.kill("t1");
    infoState = { wasKilled: true, isExited: false };

    manager.spawn("t1", spawnOptions);

    expect(constructed[1].streamOffsetBase).toBe(end);
    first.onExit("t1", 0);
    expect(offsetsOf(manager).get("t1")).toBe(end);
  });

  it("ignores a replaced incarnation's late chunk that is behind its successor", () => {
    infoState = { wasKilled: false, isExited: false };
    manager.spawn("t1", spawnOptions);
    const first = constructed[0];
    const base = first.streamOffsetBase!;
    first.emitData("t1", "x", base + 150);
    manager.kill("t1");
    infoState = { wasKilled: true, isExited: false };
    manager.spawn("t1", spawnOptions);
    constructed[1].emitData("t1", "y", base + 200);

    first.emitData("t1", "late", base + 160);

    expect(offsetsOf(manager).get("t1")).toBe(base + 200);
  });
});
