import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  minimalSpawnEnv,
  PluginProcessConcurrencyError,
  PluginProcessManager,
  type ManagedChildProcess,
  type ResolvedProcessSpawn,
} from "../PluginProcessManager.js";
import {
  PLUGIN_PROCESS_MAX_CONCURRENT,
  type PluginProcessStreamEvent,
} from "../../../../shared/types/ipc/pluginProcess.js";

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/**
 * Controllable fake child. Drives stdout/stderr via the passthroughs and a
 * manual `emitExit` so tests can assert streaming + the real exit code/signal.
 */
function makeFakeChild(opts?: { pid?: number }) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  let exited = false;

  const child: ManagedChildProcess = {
    pid: opts?.pid ?? 4242,
    stdout,
    stderr,
    kill(signal) {
      killSignals.push(signal);
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
      return child;
    }) as ManagedChildProcess["on"],
  };

  return {
    child,
    killSignals,
    writeStdout: (chunk: string) => stdout.write(chunk),
    writeStderr: (chunk: string) => stderr.write(chunk),
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      emitter.emit("exit", code, signal);
    },
    emitError: (err: Error) => emitter.emit("error", err),
  };
}

interface Harness {
  manager: PluginProcessManager;
  events: Array<{ pluginId: string; event: PluginProcessStreamEvent }>;
  spawnConfigs: ResolvedProcessSpawn[];
  fakes: ReturnType<typeof makeFakeChild>[];
  auditCalls: Array<{ pluginId: string; command: string }>;
}

function makeHarness(opts?: { killGraceMs?: number }): Harness {
  const events: Harness["events"] = [];
  const spawnConfigs: ResolvedProcessSpawn[] = [];
  const fakes: ReturnType<typeof makeFakeChild>[] = [];
  const auditCalls: Harness["auditCalls"] = [];
  const manager = new PluginProcessManager({
    streamSink: (pluginId, event) => events.push({ pluginId, event }),
    spawner: (config) => {
      spawnConfigs.push(config);
      const fake = makeFakeChild();
      fakes.push(fake);
      return fake.child;
    },
    auditor: ({ pluginId, command }) => auditCalls.push({ pluginId, command }),
    killGraceMs: opts?.killGraceMs ?? 50,
  });
  return { manager, events, spawnConfigs, fakes, auditCalls };
}

describe("minimalSpawnEnv", () => {
  it("passes through PATH but drops arbitrary host secrets", () => {
    const SECRET = "DAINTREE_TEST_SECRET_TOKEN";
    const prev = process.env[SECRET];
    process.env[SECRET] = "super-secret";
    try {
      const env = minimalSpawnEnv({ MY_FLAG: "1" });
      // Essentials for the child to run survive…
      expect(env.PATH).toBe(process.env.PATH);
      // …plugin-provided env is merged…
      expect(env.MY_FLAG).toBe("1");
      // …but the main process's secret does NOT leak to the child.
      expect(env[SECRET]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[SECRET];
      else process.env[SECRET] = prev;
    }
  });

  it("lets plugin-provided env override an allowlisted key", () => {
    const env = minimalSpawnEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });
});

describe("PluginProcessManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams stdout/stderr to the sink and resolves onExit with the exit code", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "node",
      args: ["server.js"],
      cwd: "/repo",
      env: {},
    });

    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    handle.onExit((info) => exits.push(info));

    const fake = h.fakes[0]!;
    fake.writeStdout("hello ");
    fake.writeStdout("world");
    fake.writeStderr("warn");
    await flushMicrotasks();

    const stdoutChunks = h.events
      .filter((e) => e.event.kind === "stdout")
      .map((e) => (e.event.kind === "stdout" ? e.event.chunk : ""));
    expect(stdoutChunks.join("")).toBe("hello world");
    expect(h.events.some((e) => e.event.kind === "stderr" && e.event.chunk === "warn")).toBe(true);

    fake.emitExit(0, null);
    await flushMicrotasks();

    expect(exits).toEqual([{ exitCode: 0, signal: null }]);
    // A clean exit (code 0) is NOT a crash — no crash stream event.
    expect(h.events.some((e) => e.event.kind === "crash")).toBe(false);
    expect(h.events.some((e) => e.event.kind === "exit" && e.event.exitCode === 0)).toBe(true);
    // The handle is no longer counted as running.
    expect(h.manager.runningCount("acme.tool")).toBe(0);
  });

  it("fires onCrash with the real signal on an unexpected termination", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "node",
      args: [],
      cwd: undefined,
      env: {},
    });
    const crashes: Array<{ exitCode: number | null; signal: string | null }> = [];
    handle.onCrash((info) => crashes.push(info));

    h.fakes[0]!.emitExit(null, "SIGSEGV");
    await flushMicrotasks();

    expect(crashes).toEqual([{ exitCode: null, signal: "SIGSEGV" }]);
    expect(h.events.some((e) => e.event.kind === "crash" && e.event.signal === "SIGSEGV")).toBe(
      true
    );
  });

  it("kill() SIGTERMs and resolves the handle into a killed terminal state (no crash)", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "sleep",
      args: ["100"],
      cwd: undefined,
      env: {},
    });
    const crashes: unknown[] = [];
    handle.onCrash(() => crashes.push(true));

    handle.kill();
    expect(h.fakes[0]!.killSignals).toContain("SIGTERM");

    // A SIGTERM the host requested is not a crash even though the signal is set.
    h.fakes[0]!.emitExit(null, "SIGTERM");
    await flushMicrotasks();

    expect(crashes).toHaveLength(0);
    expect(h.manager.list("acme.tool")[0]?.status).toBe("killed");
  });

  it("escalates to SIGKILL after the grace window when the child ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ killGraceMs: 30 });
    const handle = h.manager.spawn("acme.tool", {
      command: "stubborn",
      args: [],
      cwd: undefined,
      env: {},
    });
    handle.kill();
    expect(h.fakes[0]!.killSignals).toEqual(["SIGTERM"]);
    // Child has not exited; advancing past the grace window escalates.
    vi.advanceTimersByTime(31);
    expect(h.fakes[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("restart() respawns with the same config and bumps the restart counter", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "node",
      args: ["a.js"],
      cwd: "/repo",
      env: { FOO: "1" },
    });
    expect(h.spawnConfigs).toHaveLength(1);

    await handle.restart();
    expect(h.spawnConfigs).toHaveLength(2);
    expect(h.spawnConfigs[1]).toEqual(h.spawnConfigs[0]);
    expect(h.fakes[0]!.killSignals).toContain("SIGTERM");

    const info = h.manager.list("acme.tool")[0]!;
    expect(info.restartCount).toBe(1);
    expect(info.status).toBe("running");
    // Same handle id across the restart.
    expect(info.id).toBe(handle.id);
  });

  it("denies a spawn past the per-plugin concurrency cap", () => {
    const h = makeHarness();
    for (let i = 0; i < PLUGIN_PROCESS_MAX_CONCURRENT; i++) {
      h.manager.spawn("acme.tool", { command: "node", args: [], cwd: undefined, env: {} });
    }
    expect(h.manager.runningCount("acme.tool")).toBe(PLUGIN_PROCESS_MAX_CONCURRENT);
    expect(() =>
      h.manager.spawn("acme.tool", { command: "node", args: [], cwd: undefined, env: {} })
    ).toThrow(PluginProcessConcurrencyError);

    // The cap is per-plugin — a different plugin still gets its own budget.
    expect(() =>
      h.manager.spawn("other.tool", { command: "node", args: [], cwd: undefined, env: {} })
    ).not.toThrow();
  });

  it("frees a concurrency slot when a process exits", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "node",
      args: [],
      cwd: undefined,
      env: {},
    });
    expect(h.manager.runningCount("acme.tool")).toBe(1);
    h.fakes[0]!.emitExit(0, null);
    await flushMicrotasks();
    expect(h.manager.runningCount("acme.tool")).toBe(0);

    void handle; // keep the handle referenced
  });

  it("killAll terminates every outstanding process for a plugin", () => {
    const h = makeHarness();
    h.manager.spawn("acme.tool", { command: "a", args: [], cwd: undefined, env: {} });
    h.manager.spawn("acme.tool", { command: "b", args: [], cwd: undefined, env: {} });
    h.manager.spawn("other.tool", { command: "c", args: [], cwd: undefined, env: {} });

    h.manager.killAll("acme.tool");

    expect(h.fakes[0]!.killSignals).toContain("SIGTERM");
    expect(h.fakes[1]!.killSignals).toContain("SIGTERM");
    // The other plugin's process is untouched.
    expect(h.fakes[2]!.killSignals).toHaveLength(0);
  });

  it("records an audit entry per spawn", () => {
    const h = makeHarness();
    h.manager.spawn("acme.tool", { command: "node", args: [], cwd: undefined, env: {} });
    expect(h.auditCalls).toEqual([{ pluginId: "acme.tool", command: "node" }]);
  });

  it("delivers the recorded outcome to a late onExit subscriber", async () => {
    const h = makeHarness();
    const handle = h.manager.spawn("acme.tool", {
      command: "node",
      args: [],
      cwd: undefined,
      env: {},
    });
    h.fakes[0]!.emitExit(3, null);
    await flushMicrotasks();

    const late: Array<{ exitCode: number | null }> = [];
    handle.onExit((info) => late.push({ exitCode: info.exitCode }));
    await flushMicrotasks();
    expect(late).toEqual([{ exitCode: 3 }]);
  });
});
