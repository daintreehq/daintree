import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  minimalSpawnEnv,
  PluginProcessConcurrencyError,
  PluginProcessManager,
  PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES,
  PLUGIN_PROCESS_EARLY_DATA_RETENTION_MS,
  type ManagedChildProcess,
  type ResolvedDuplexSpawn,
  type ResolvedProcessSpawn,
  type ResolvedPtySpawn,
} from "../PluginProcessManager.js";
import type { ManagedPtyBackend, PluginPtyExit } from "../PluginPtyTransport.js";
import {
  PLUGIN_PROCESS_MAX_CONCURRENT,
  type PluginProcessStreamEvent,
} from "../../../../shared/types/ipc/pluginProcess.js";
import type { PluginProcessDataChunk } from "../../../../shared/types/plugin.js";

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/** Spawn config for the default pipe mode, so each test names only what it cares about. */
function pipeConfig(overrides: Partial<ResolvedProcessSpawn> = {}): ResolvedProcessSpawn {
  return {
    mode: "pipe",
    command: "node",
    args: [],
    cwd: undefined,
    env: {},
    panelId: null,
    ...overrides,
  } as ResolvedProcessSpawn;
}

/**
 * Spawn config for duplex mode (#11871) — a plain child like pipe mode, but with
 * a writable stdin. Modelled on a stdio JSON-RPC peer.
 */
function duplexConfig(overrides: Partial<ResolvedDuplexSpawn> = {}): ResolvedDuplexSpawn {
  return {
    mode: "duplex",
    command: "codex",
    args: ["app-server", "--stdio"],
    cwd: undefined,
    env: {},
    panelId: null,
    ...overrides,
  };
}

/** Spawn config for interactive mode. */
function ptyConfig(overrides: Partial<ResolvedPtySpawn> = {}): ResolvedPtySpawn {
  return {
    mode: "pty",
    command: "flutter",
    args: ["daemon", "--machine"],
    cwd: undefined,
    env: {},
    panelId: null,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

/**
 * Controllable fake child. Drives stdout/stderr via the passthroughs and a
 * manual `emitExit` so tests can assert streaming + the real exit code/signal.
 */
function makeFakeChild(opts?: { pid?: number; duplex?: boolean }) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Only a duplex child has a writable input, mirroring Node handing back `null`
  // for a stdio slot spawned as "ignore".
  const stdin = opts?.duplex === true ? new PassThrough() : null;
  const stdinWrites: string[] = [];
  if (stdin) {
    stdin.setEncoding("utf-8");
    stdin.on("data", (chunk: string) => stdinWrites.push(chunk));
  }
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  let exited = false;

  const child: ManagedChildProcess = {
    pid: opts?.pid ?? 4242,
    stdout,
    stderr,
    stdin,
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
    /** Everything the manager has written to this child's stdin, in order. */
    stdinWrites,
    stdin,
    writeStdout: (chunk: string) => stdout.write(chunk),
    writeStderr: (chunk: string) => stderr.write(chunk),
    /**
     * A normal child's terminal sequence: Node reaps it (`exit`), then closes
     * its stdio (`close`). Both fire, in that order — see
     * `emitExitWithoutClose` for the child that never releases its pipes.
     */
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      emitter.emit("exit", code, signal);
      emitter.emit("close");
    },
    /**
     * A child that exits while a surviving grandchild still holds its stdout,
     * so `close` never arrives. Only the drain cap settles this one.
     */
    emitExitWithoutClose: (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      emitter.emit("exit", code, signal);
    },
    /** Release the pipes after an `emitExitWithoutClose`. */
    emitClose: () => emitter.emit("close"),
    emitError: (err: Error) => emitter.emit("error", err),
  };
}

/**
 * Controllable fake PTY backend. Records every operation the manager issues and
 * lets a test drive data/exit from the "host" side.
 */
function makeFakePty(opts?: { pid?: number }) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(info: PluginPtyExit) => void>();
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const kills: Array<"SIGTERM" | "SIGKILL"> = [];
  let disposed = false;

  const backend: ManagedPtyBackend = {
    pid: opts?.pid ?? 9001,
    write: (data) => writes.push(data),
    resize: (cols, rows) => resizes.push({ cols, rows }),
    kill: (signal) => kills.push(signal),
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      dataListeners.clear();
      exitListeners.clear();
    },
  };

  return {
    backend,
    writes,
    resizes,
    kills,
    get disposed() {
      return disposed;
    },
    emitData: (data: string) => {
      for (const listener of [...dataListeners]) listener(data);
    },
    emitExit: (info: PluginPtyExit) => {
      for (const listener of [...exitListeners]) listener(info);
    },
  };
}

interface Harness {
  manager: PluginProcessManager;
  events: Array<{ pluginId: string; event: PluginProcessStreamEvent; panelId: string | null }>;
  spawnConfigs: ResolvedProcessSpawn[];
  ptyConfigs: Array<{ config: ResolvedPtySpawn; id: string; generation: number }>;
  fakes: ReturnType<typeof makeFakeChild>[];
  ptys: ReturnType<typeof makeFakePty>[];
  auditCalls: Array<{ pluginId: string; command: string }>;
  /** Set to reject the next PTY allocation, simulating a host-side spawn failure. */
  failNextPtySpawn: { value: Error | null };
}

function makeHarness(opts?: {
  killGraceMs?: number;
  noPtySpawner?: boolean;
  stdioDrainMs?: number;
}): Harness {
  const events: Harness["events"] = [];
  const spawnConfigs: ResolvedProcessSpawn[] = [];
  const ptyConfigs: Harness["ptyConfigs"] = [];
  const fakes: ReturnType<typeof makeFakeChild>[] = [];
  const ptys: ReturnType<typeof makeFakePty>[] = [];
  const auditCalls: Harness["auditCalls"] = [];
  const failNextPtySpawn: { value: Error | null } = { value: null };
  const manager = new PluginProcessManager({
    streamSink: (pluginId, event, panelId) => events.push({ pluginId, event, panelId }),
    spawner: (config) => {
      spawnConfigs.push(config);
      // Build the child the requested mode implies, so a test can't assert a
      // write landed on a stdin the real spawner would never have opened.
      const fake = makeFakeChild({ duplex: config.mode === "duplex" });
      fakes.push(fake);
      return fake.child;
    },
    ptySpawner: opts?.noPtySpawner
      ? null
      : async (config, context) => {
          ptyConfigs.push({ config, id: context.id, generation: context.generation });
          if (failNextPtySpawn.value) {
            const err = failNextPtySpawn.value;
            failNextPtySpawn.value = null;
            throw err;
          }
          const fake = makeFakePty();
          ptys.push(fake);
          return fake.backend;
        },
    auditor: ({ pluginId, command }) => auditCalls.push({ pluginId, command }),
    killGraceMs: opts?.killGraceMs ?? 50,
    stdioDrainMs: opts?.stdioDrainMs ?? 50,
  });
  return { manager, events, spawnConfigs, ptyConfigs, fakes, ptys, auditCalls, failNextPtySpawn };
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

  it("reads PATH live so a post-boot PATH refresh reaches later spawns", () => {
    const prev = process.env.PATH;
    try {
      process.env.PATH = "/first";
      expect(minimalSpawnEnv().PATH).toBe("/first");
      // A snapshot taken at module load would still say "/first" here.
      process.env.PATH = "/second";
      expect(minimalSpawnEnv().PATH).toBe("/second");
    } finally {
      process.env.PATH = prev;
    }
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
    const handle = await h.manager.spawn(
      "acme.tool",
      pipeConfig({ args: ["server.js"], cwd: "/repo" })
    );

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

  it("spawns pipe mode by default with stdin closed and no interactive backend", async () => {
    const h = makeHarness();
    const handle = await h.manager.spawn("acme.tool", pipeConfig());
    expect(handle.mode).toBe("pipe");
    expect(h.spawnConfigs[0]?.mode).toBe("pipe");
    // No PTY was allocated for a default spawn.
    expect(h.ptyConfigs).toHaveLength(0);
    // write/resize on a pipe process are inert, not a throw.
    expect(() => handle.write("x")).not.toThrow();
    expect(() => handle.resize(10, 10)).not.toThrow();
    expect(h.ptys).toHaveLength(0);
  });

  it("fires onCrash with the real signal on an unexpected termination", async () => {
    const h = makeHarness();
    const handle = await h.manager.spawn("acme.tool", pipeConfig());
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
    const handle = await h.manager.spawn("acme.tool", pipeConfig({ command: "sleep" }));
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
    const h = makeHarness({ killGraceMs: 30 });
    const handle = await h.manager.spawn("acme.tool", pipeConfig({ command: "stubborn" }));
    vi.useFakeTimers();
    handle.kill();
    expect(h.fakes[0]!.killSignals).toEqual(["SIGTERM"]);
    // Child has not exited; advancing past the grace window escalates.
    vi.advanceTimersByTime(31);
    expect(h.fakes[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("restart() respawns with the same config and bumps the restart counter", async () => {
    const h = makeHarness();
    const handle = await h.manager.spawn(
      "acme.tool",
      pipeConfig({ args: ["a.js"], cwd: "/repo", env: { FOO: "1" } })
    );
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

  it("denies a spawn past the per-plugin concurrency cap", async () => {
    const h = makeHarness();
    for (let i = 0; i < PLUGIN_PROCESS_MAX_CONCURRENT; i++) {
      await h.manager.spawn("acme.tool", pipeConfig());
    }
    expect(h.manager.runningCount("acme.tool")).toBe(PLUGIN_PROCESS_MAX_CONCURRENT);
    await expect(h.manager.spawn("acme.tool", pipeConfig())).rejects.toBeInstanceOf(
      PluginProcessConcurrencyError
    );

    // The cap is per-plugin — a different plugin still gets its own budget.
    await expect(h.manager.spawn("other.tool", pipeConfig())).resolves.toBeDefined();
  });

  it("counts an interactive process against the same cap while it is still allocating", async () => {
    const h = makeHarness();
    // Fire every allowed spawn concurrently without awaiting: the record must be
    // registered before the PTY allocation settles, or a burst sails past the cap.
    const inFlight = Array.from({ length: PLUGIN_PROCESS_MAX_CONCURRENT }, () =>
      h.manager.spawn("acme.tool", ptyConfig())
    );
    await expect(h.manager.spawn("acme.tool", ptyConfig())).rejects.toBeInstanceOf(
      PluginProcessConcurrencyError
    );
    await Promise.all(inFlight);
  });

  it("frees a concurrency slot when a process exits", async () => {
    const h = makeHarness();
    const handle = await h.manager.spawn("acme.tool", pipeConfig());
    expect(h.manager.runningCount("acme.tool")).toBe(1);
    h.fakes[0]!.emitExit(0, null);
    await flushMicrotasks();
    expect(h.manager.runningCount("acme.tool")).toBe(0);

    void handle; // keep the handle referenced
  });

  it("killAll terminates every outstanding process for a plugin", async () => {
    const h = makeHarness();
    await h.manager.spawn("acme.tool", pipeConfig({ command: "a" }));
    await h.manager.spawn("acme.tool", pipeConfig({ command: "b" }));
    await h.manager.spawn("other.tool", pipeConfig({ command: "c" }));

    h.manager.killAll("acme.tool");

    expect(h.fakes[0]!.killSignals).toContain("SIGTERM");
    expect(h.fakes[1]!.killSignals).toContain("SIGTERM");
    // The other plugin's process is untouched.
    expect(h.fakes[2]!.killSignals).toHaveLength(0);
  });

  it("killAll tears down interactive processes exactly like pipe ones", async () => {
    const h = makeHarness();
    await h.manager.spawn("acme.tool", ptyConfig());
    await h.manager.spawn("other.tool", ptyConfig());

    h.manager.killAll("acme.tool");

    expect(h.ptys[0]!.kills).toContain("SIGTERM");
    expect(h.ptys[1]!.kills).toHaveLength(0);
  });

  it("records an audit entry per spawn", async () => {
    const h = makeHarness();
    await h.manager.spawn("acme.tool", pipeConfig());
    expect(h.auditCalls).toEqual([{ pluginId: "acme.tool", command: "node" }]);
  });

  describe("stdio drain before terminal settle (#12216)", () => {
    it("delivers output written between exit and close", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((chunk) => chunks.push(chunk));
      await flushMicrotasks();

      const fake = h.fakes[0]!;
      // A one-shot linter's verdict: written as the process is going away, so
      // it lands after `exit` but before the pipes close. Settling on `exit`
      // dropped exactly this.
      fake.emitExitWithoutClose(0, null);
      fake.writeStdout("2 problems found\n");
      await flushMicrotasks();

      expect(chunks.map((c) => c.chunk).join("")).toContain("2 problems found");
    });

    it("holds the terminal outcome until close, then reports the exit code", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const exits: Array<{ exitCode: number | null }> = [];
      handle.onExit((info) => exits.push({ exitCode: info.exitCode }));

      const fake = h.fakes[0]!;
      fake.emitExitWithoutClose(7, null);
      await flushMicrotasks();
      expect(exits).toEqual([]);

      fake.emitClose();
      await flushMicrotasks();
      // The code came from `exit` — `close` only says the pipes are done.
      expect(exits).toEqual([{ exitCode: 7 }]);
      expect(h.manager.list("acme.tool")[0]!.status).toBe("exited");
    });

    it("settles on the drain cap when close never arrives", async () => {
      // The daemonizing case: the child exits but a surviving grandchild keeps
      // its stdout open, so `close` is never emitted. Without the cap the
      // handle would sit in `running` for the rest of the session.
      const h = makeHarness({ stdioDrainMs: 20 });
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const exits: Array<{ exitCode: number | null }> = [];
      handle.onExit((info) => exits.push({ exitCode: info.exitCode }));

      h.fakes[0]!.emitExitWithoutClose(0, null);
      await flushMicrotasks();
      expect(exits).toEqual([]);

      await new Promise((r) => setTimeout(r, 40));
      expect(exits).toEqual([{ exitCode: 0 }]);
      expect(h.manager.list("acme.tool")[0]!.status).toBe("exited");
    });

    it("ignores a close from a child a restart already replaced", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const first = h.fakes[0]!;
      first.emitExit(0, null);
      await flushMicrotasks();

      await h.manager.restart(handle.id);
      const second = h.fakes[1]!;

      const exits: Array<{ exitCode: number | null }> = [];
      handle.onExit((info) => exits.push({ exitCode: info.exitCode }));
      exits.length = 0;

      // A late settle from the outgoing incarnation must not terminate the
      // live one.
      first.emitClose();
      await flushMicrotasks();
      expect(h.manager.list("acme.tool")[0]!.status).toBe("running");

      second.emitExit(0, null);
      await flushMicrotasks();
      expect(h.manager.list("acme.tool")[0]!.status).toBe("exited");
    });
  });

  describe("shutdownAll (app quit) (#12216)", () => {
    it("SIGTERMs every plugin's children and resolves once they exit", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", pipeConfig({ command: "a" }));
      await h.manager.spawn("other.tool", pipeConfig({ command: "b" }));

      const swept = h.manager.shutdownAll();
      // Unlike killAll, this is not scoped to one plugin — quit takes them all.
      expect(h.fakes[0]!.killSignals).toContain("SIGTERM");
      expect(h.fakes[1]!.killSignals).toContain("SIGTERM");

      h.fakes[0]!.emitExit(0, "SIGTERM");
      h.fakes[1]!.emitExit(0, "SIGTERM");
      await swept;

      expect(h.fakes[0]!.killSignals).not.toContain("SIGKILL");
      expect(h.fakes[1]!.killSignals).not.toContain("SIGKILL");
    });

    it("escalates to SIGKILL for a child that outlives the grace window", async () => {
      // The escalation `killAll` arms rides an unref'd timer that can never
      // fire before the app exits. This one is referenced, so a child that
      // ignores SIGTERM is actually force-killed rather than orphaned.
      const h = makeHarness({ killGraceMs: 20 });
      await h.manager.spawn("acme.tool", pipeConfig());

      await h.manager.shutdownAll();

      expect(h.fakes[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("signals interactive processes without waiting on the pty host", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", ptyConfig());

      // Resolves without any PTY exit being delivered: the pty-host owns
      // reaping those, and quit must not block on its round trip.
      await h.manager.shutdownAll();

      expect(h.ptys[0]!.kills).toContain("SIGTERM");
    });

    it("resolves immediately when nothing is running", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.emitExit(0, null);
      await flushMicrotasks();

      await expect(h.manager.shutdownAll()).resolves.toBeUndefined();
    });

    it("refuses a spawn admitted after the sweep", async () => {
      const h = makeHarness();
      await h.manager.shutdownAll();

      await expect(h.manager.spawn("acme.tool", pipeConfig())).rejects.toThrow(/shutting down/);
    });
  });

  it("delivers the recorded outcome to a late onExit subscriber", async () => {
    const h = makeHarness();
    const handle = await h.manager.spawn("acme.tool", pipeConfig());
    h.fakes[0]!.emitExit(3, null);
    await flushMicrotasks();

    const late: Array<{ exitCode: number | null }> = [];
    handle.onExit((info) => late.push({ exitCode: info.exitCode }));
    await flushMicrotasks();
    expect(late).toEqual([{ exitCode: 3 }]);
  });

  describe("panel routing", () => {
    it("passes a spawn-time panelId through to every stream event", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig({ panelId: "panel-7" }));
      h.fakes[0]!.writeStdout("out");
      await flushMicrotasks();
      h.fakes[0]!.emitExit(0, null);
      await flushMicrotasks();
      void handle;

      expect(h.events.length).toBeGreaterThan(0);
      // Both the output chunks and the terminal event carry the target.
      expect(h.events.every((e) => e.panelId === "panel-7")).toBe(true);
    });

    it("broadcasts (null panelId) when no panel was named", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.writeStdout("out");
      await flushMicrotasks();
      // Assert a specific event exists first — `every` on an empty array is
      // vacuously true and would pass with the feature removed.
      expect(h.events.some((e) => e.event.kind === "stdout")).toBe(true);
      expect(h.events.every((e) => e.panelId === null)).toBe(true);
    });

    it("routes two processes of one plugin to their own panels", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", pipeConfig({ panelId: "panel-a" }));
      await h.manager.spawn("acme.tool", pipeConfig({ panelId: "panel-b" }));
      h.fakes[0]!.writeStdout("from-a");
      h.fakes[1]!.writeStdout("from-b");
      await flushMicrotasks();

      const a = h.events.find((e) => e.event.kind === "stdout" && e.event.chunk === "from-a");
      const b = h.events.find((e) => e.event.kind === "stdout" && e.event.chunk === "from-b");
      expect(a?.panelId).toBe("panel-a");
      expect(b?.panelId).toBe("panel-b");
    });
  });

  describe("onData", () => {
    it("delivers pipe stdout/stderr to the plugin's own callback, tagged by stream", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((chunk) => chunks.push(chunk));
      await flushMicrotasks();

      h.fakes[0]!.writeStdout("out");
      h.fakes[0]!.writeStderr("err");
      await flushMicrotasks();

      expect(chunks).toEqual([
        { stream: "stdout", chunk: "out" },
        { stream: "stderr", chunk: "err" },
      ]);
    });

    it("replays output produced before the first subscriber attached", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      // The daemon greets immediately — before the plugin has subscribed.
      h.fakes[0]!.writeStdout('{"event":"daemon.connected"}');
      await flushMicrotasks();

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((chunk) => chunks.push(chunk));
      await flushMicrotasks();

      expect(chunks).toEqual([{ stream: "stdout", chunk: '{"event":"daemon.connected"}' }]);
    });

    it("replays only once — a second subscriber gets live output only", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.writeStdout("early");
      await flushMicrotasks();

      const first: PluginProcessDataChunk[] = [];
      handle.onData((c) => first.push(c));
      await flushMicrotasks();

      const second: PluginProcessDataChunk[] = [];
      handle.onData((c) => second.push(c));
      await flushMicrotasks();

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);

      h.fakes[0]!.writeStdout("live");
      await flushMicrotasks();
      expect(second).toEqual([{ stream: "stdout", chunk: "live" }]);
    });

    it("bounds the pre-subscription buffer, dropping the oldest output", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const chunkSize = 8 * 1024;
      const chunkCount = Math.ceil(PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES / chunkSize) + 4;
      for (let i = 0; i < chunkCount; i++) {
        h.fakes[0]!.writeStdout(String(i).padEnd(chunkSize, "."));
      }
      await flushMicrotasks();

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((c) => chunks.push(c));
      await flushMicrotasks();

      const bufferedBytes = chunks.reduce((n, c) => n + c.chunk.length, 0);
      expect(bufferedBytes).toBeLessThanOrEqual(PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES);
      // The oldest chunks were dropped, so the newest one survived.
      expect(chunks.at(-1)?.chunk.startsWith(String(chunkCount - 1))).toBe(true);
      expect(chunks[0]?.chunk.startsWith("0")).toBe(false);
    });

    it("still replays to a subscriber that attaches after the process exited", async () => {
      // A short-lived process can produce its whole output and exit before the
      // worker's onData subscription has round-tripped. Clearing the buffer on
      // exit would break the replay contract for exactly those processes.
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.writeStdout("all-of-it");
      await flushMicrotasks();
      h.fakes[0]!.emitExit(0, null);
      await flushMicrotasks();

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((c) => chunks.push(c));
      await flushMicrotasks();
      expect(chunks).toEqual([{ stream: "stdout", chunk: "all-of-it" }]);
    });

    it("releases the post-exit replay buffer after its retention window", async () => {
      // Exited records live until the plugin unloads, so an unbounded buffer
      // would let a plugin running many short jobs accumulate the cap per job.
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.writeStdout("never-read");
      await flushMicrotasks();
      vi.useFakeTimers();
      h.fakes[0]!.emitExit(0, null);
      await vi.advanceTimersByTimeAsync(PLUGIN_PROCESS_EARLY_DATA_RETENTION_MS + 1);
      vi.useRealTimers();

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((c) => chunks.push(c));
      await flushMicrotasks();
      expect(chunks).toHaveLength(0);
    });

    it("does not replay to a subscriber disposed before the replay ran", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      h.fakes[0]!.writeStdout("buffered");
      await flushMicrotasks();

      const chunks: PluginProcessDataChunk[] = [];
      // Subscribe and immediately dispose — the replay is queued in a microtask,
      // so delivering it would be a use-after-dispose.
      const off = handle.onData((c) => chunks.push(c));
      off();
      await flushMicrotasks();
      expect(chunks).toHaveLength(0);
    });

    it("measures the replay cap in BYTES, not UTF-16 code units", async () => {
      // "界".repeat(n) has length n but 3n bytes in UTF-8. A code-unit budget
      // would let the buffer grow ~3x past the cap it advertises.
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const wide = "界".repeat(8 * 1024);
      const chunkCount = Math.ceil(PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES / (wide.length * 3)) + 3;
      for (let i = 0; i < chunkCount; i++) h.fakes[0]!.writeStdout(wide);
      await flushMicrotasks();

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((c) => chunks.push(c));
      await flushMicrotasks();

      const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.chunk, "utf-8"), 0);
      expect(bytes).toBeLessThanOrEqual(PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES);
    });

    it("stops delivering after the disposer runs", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());
      const chunks: PluginProcessDataChunk[] = [];
      const dispose = handle.onData((c) => chunks.push(c));
      await flushMicrotasks();
      dispose();
      h.fakes[0]!.writeStdout("after");
      await flushMicrotasks();
      expect(chunks).toHaveLength(0);
    });
  });

  describe("interactive (pty) mode", () => {
    it("rejects pty mode when the host has no interactive backend", async () => {
      const h = makeHarness({ noPtySpawner: true });
      await expect(h.manager.spawn("acme.tool", ptyConfig())).rejects.toThrow(/unavailable/);
    });

    it("allocates a PTY with the requested geometry and reports mode on the handle", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn(
        "acme.tool",
        ptyConfig({ cols: 120, rows: 40, cwd: "/repo" })
      );
      expect(handle.mode).toBe("pty");
      expect(h.ptyConfigs).toHaveLength(1);
      expect(h.ptyConfigs[0]!.config).toMatchObject({
        command: "flutter",
        args: ["daemon", "--machine"],
        cwd: "/repo",
        cols: 120,
        rows: 40,
      });
      // No pipe child was created for an interactive spawn.
      expect(h.spawnConfigs).toHaveLength(0);
    });

    it("emits PTY output as a single combined `data` stream", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig({ panelId: "panel-1" }));
      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((c) => chunks.push(c));
      await flushMicrotasks();

      h.ptys[0]!.emitData("$ ");
      await flushMicrotasks();

      expect(chunks).toEqual([{ stream: "data", chunk: "$ " }]);
      const panelEvent = h.events.find((e) => e.event.kind === "data");
      expect(panelEvent?.panelId).toBe("panel-1");
      // A PTY never reports the stdout/stderr split.
      expect(h.events.some((e) => e.event.kind === "stdout" || e.event.kind === "stderr")).toBe(
        false
      );
    });

    it("relays write and resize to the live backend", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      handle.write("q\n");
      handle.resize(100, 30);
      expect(h.ptys[0]!.writes).toEqual(["q\n"]);
      expect(h.ptys[0]!.resizes).toEqual([{ cols: 100, rows: 30 }]);
    });

    it("ignores a resize with non-positive or non-integer dimensions", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      handle.resize(0, 24);
      handle.resize(80, -1);
      handle.resize(80.5, 24);
      expect(h.ptys[0]!.resizes).toHaveLength(0);
    });

    it("never resizes a PTY that has already exited", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      h.ptys[0]!.emitExit({ exitCode: 0, signal: null });
      await flushMicrotasks();
      handle.resize(120, 40);
      // Resizing a dead PTY is a documented crash risk — nothing must be sent.
      expect(h.ptys[0]!.resizes).toHaveLength(0);
    });

    it("applies a resize that raced the allocation once the PTY is live", async () => {
      const h = makeHarness();
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = new PluginProcessManager({
        streamSink: () => {},
        ptySpawner: async (config, context) => {
          h.ptyConfigs.push({ config, id: context.id, generation: context.generation });
          await gate;
          const fake = makeFakePty();
          h.ptys.push(fake);
          return fake.backend;
        },
      });
      const pending = manager.spawn("acme.tool", ptyConfig());
      // The plugin resizes while the allocation is still in flight. The spawn
      // message is already gone, so this CANNOT become the initial size — it
      // has to land as a real SIGWINCH the moment the PTY comes up, and exactly
      // once (a dropped or duplicated one both misreport the window).
      const id = manager.list("acme.tool")[0]!.id;
      manager.resize(id, 132, 50);
      release?.();
      const handle = await pending;

      expect(handle.mode).toBe("pty");
      expect(h.ptyConfigs.at(-1)!.config).toMatchObject({ cols: 80, rows: 24 });
      expect(h.ptys.at(-1)!.resizes).toEqual([{ cols: 132, rows: 50 }]);
    });

    it("does not replay a mid-flight resize a second time after the PTY is up", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      handle.resize(132, 50);
      // Restarting folds the current geometry into the replacement's spawn
      // options; the buffered value must be consumed, not also fired as a
      // SIGWINCH on a PTY that was already born at that size.
      await handle.restart();
      expect(h.ptyConfigs.at(-1)!.config).toMatchObject({ cols: 132, rows: 50 });
      expect(h.ptys.at(-1)!.resizes).toHaveLength(0);
    });

    it("records a failed PTY allocation as a crash rather than rejecting the spawn", async () => {
      const h = makeHarness();
      h.failNextPtySpawn.value = new Error("ENOENT: flutter not found");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      const crashes: PluginPtyExit[] = [];
      handle.onCrash((info) => crashes.push(info));
      await flushMicrotasks();

      expect(crashes).toEqual([{ exitCode: null, signal: null }]);
      // The slot is released so a retry isn't blocked by a process that never ran.
      expect(h.manager.runningCount("acme.tool")).toBe(0);
      errorSpy.mockRestore();
    });

    it("drops output and exit from the incarnation a restart replaced", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      const chunks: PluginProcessDataChunk[] = [];
      const exits: PluginPtyExit[] = [];
      handle.onData((c) => chunks.push(c));
      handle.onExit((info) => exits.push(info));
      await flushMicrotasks();

      const first = h.ptys[0]!;
      await handle.restart();
      expect(h.ptys).toHaveLength(2);
      // The predecessor is force-killed and released, not left to linger.
      expect(first.kills).toContain("SIGKILL");
      expect(first.disposed).toBe(true);

      // A late event from the replaced PTY must not reach the successor's handle.
      first.emitData("stale");
      first.emitExit({ exitCode: 1, signal: null });
      await flushMicrotasks();
      expect(chunks).toHaveLength(0);
      expect(exits).toHaveLength(0);
      expect(h.manager.list("acme.tool")[0]?.status).toBe("running");

      // The live successor still works.
      h.ptys[1]!.emitData("fresh");
      await flushMicrotasks();
      expect(chunks).toEqual([{ stream: "data", chunk: "fresh" }]);
    });

    it("carries the current geometry across a restart", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig({ cols: 80, rows: 24 }));
      handle.resize(140, 45);
      await handle.restart();
      expect(h.ptyConfigs.at(-1)!.config).toMatchObject({ cols: 140, rows: 45 });
    });

    it("bumps the generation on every restart so the transport can filter", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      await handle.restart();
      await handle.restart();
      expect(h.ptyConfigs.map((c) => c.generation)).toEqual([0, 1, 2]);
      // Same public id across incarnations.
      expect(new Set(h.ptyConfigs.map((c) => c.id)).size).toBe(1);
    });

    it("kill() SIGTERMs then escalates to SIGKILL after the grace window", async () => {
      const h = makeHarness({ killGraceMs: 30 });
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      vi.useFakeTimers();
      handle.kill();
      expect(h.ptys[0]!.kills).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(31);
      expect(h.ptys[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("a killed PTY exits into the killed state without firing onCrash", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", ptyConfig());
      const crashes: unknown[] = [];
      handle.onCrash(() => crashes.push(true));
      handle.kill();
      h.ptys[0]!.emitExit({ exitCode: null, signal: "SIGTERM" });
      await flushMicrotasks();

      expect(crashes).toHaveLength(0);
      expect(h.manager.list("acme.tool")[0]?.status).toBe("killed");
      // The backend was released, so its host-side entry can be torn down.
      expect(h.ptys[0]!.disposed).toBe(true);
    });

    it("force-kills the predecessor BEFORE releasing it on restart", async () => {
      // The backend's own guards go false once dispose() drops its transport
      // entry, so a kill issued afterwards is silently swallowed and the
      // predecessor survives unowned, outside the concurrency cap.
      const killOrder: string[] = [];
      const ptys: ReturnType<typeof makeFakePty>[] = [];
      const manager = new PluginProcessManager({
        streamSink: () => {},
        ptySpawner: () => {
          const fake = makeFakePty();
          const backend = fake.backend;
          ptys.push(fake);
          return Promise.resolve({
            ...backend,
            kill: (signal) => {
              killOrder.push(`kill:${signal}`);
              backend.kill(signal);
            },
            dispose: () => {
              killOrder.push("dispose");
              backend.dispose();
            },
          });
        },
      });
      const handle = await manager.spawn("acme.tool", ptyConfig());
      killOrder.length = 0;
      await handle.restart();
      expect(killOrder.slice(0, 2)).toEqual(["kill:SIGKILL", "dispose"]);
    });

    it("does not report a crash when an allocation fails after the host asked it down", async () => {
      let release: ((error: Error) => void) | undefined;
      const manager = new PluginProcessManager({
        streamSink: () => {},
        ptySpawner: () =>
          new Promise<ManagedPtyBackend>((_resolve, reject) => {
            release = reject;
          }),
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const pending = manager.spawn("acme.tool", ptyConfig());
      manager.killAll("acme.tool");
      release?.(new Error("host gone"));
      const handle = await pending;
      const crashes: unknown[] = [];
      const exits: unknown[] = [];
      handle.onCrash(() => crashes.push(true));
      handle.onExit(() => exits.push(true));
      await flushMicrotasks();

      // The plugin requested the teardown — reporting onCrash would blame the
      // command for an unload.
      expect(crashes).toHaveLength(0);
      expect(exits).toHaveLength(1);
      expect(manager.list("acme.tool")[0]?.status).toBe("killed");
      errorSpy.mockRestore();
    });

    it("kills a PTY that finishes allocating after the process was torn down", async () => {
      let release: ((backend: ManagedPtyBackend) => void) | undefined;
      const ptys: ReturnType<typeof makeFakePty>[] = [];
      const manager = new PluginProcessManager({
        streamSink: () => {},
        ptySpawner: () =>
          new Promise<ManagedPtyBackend>((resolve) => {
            release = resolve;
          }),
      });
      const pending = manager.spawn("acme.tool", ptyConfig());
      // Unload tears everything down while the PTY is still allocating.
      manager.killAll("acme.tool");
      const fake = makeFakePty();
      ptys.push(fake);
      release?.(fake.backend);
      await pending;

      expect(fake.kills).toContain("SIGKILL");
      expect(fake.disposed).toBe(true);
    });
  });

  describe("duplex mode (#11871)", () => {
    it("keeps stdout and stderr apart instead of merging them like a PTY", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());

      expect(handle.mode).toBe("duplex");
      expect(h.spawnConfigs[0]?.mode).toBe("duplex");
      // No PTY involved — that is the whole point: a PTY would merge the streams.
      expect(h.ptyConfigs).toHaveLength(0);

      const chunks: PluginProcessDataChunk[] = [];
      handle.onData((chunk) => chunks.push(chunk));

      const fake = h.fakes[0]!;
      fake.writeStdout('{"jsonrpc":"2.0","id":1}\n');
      fake.writeStderr("debug: listening\n");
      await flushMicrotasks();

      // Group by stream rather than assuming one write is one event.
      const byStream = (name: string): string =>
        chunks
          .filter((c) => c.stream === name)
          .map((c) => c.chunk)
          .join("");
      expect(byStream("stdout")).toBe('{"jsonrpc":"2.0","id":1}\n');
      expect(byStream("stderr")).toBe("debug: listening\n");
      // The diagnostic never contaminates the protocol stream.
      expect(byStream("stdout")).not.toContain("debug");
      // "data" is the PTY-only combined stream; duplex must never emit it.
      expect(chunks.some((c) => c.stream === "data")).toBe(false);
    });

    it("delivers write() to the child's stdin verbatim", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());

      handle.write('{"jsonrpc":"2.0","method":"initialize"}\n');
      handle.write('{"jsonrpc":"2.0","method":"ping"}\n');
      await flushMicrotasks();

      // Verbatim and in order — the host adds no framing of its own.
      expect(h.fakes[0]!.stdinWrites.join("")).toBe(
        '{"jsonrpc":"2.0","method":"initialize"}\n{"jsonrpc":"2.0","method":"ping"}\n'
      );
    });

    it("ignores a non-string write without reaching stdin", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());

      (handle.write as (data: unknown) => void)(42);
      (handle.write as (data: unknown) => void)(undefined);
      await flushMicrotasks();

      expect(h.fakes[0]!.stdinWrites).toEqual([]);
    });

    it("makes write() a no-op after the child exits rather than throwing", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());
      const fake = h.fakes[0]!;

      fake.emitExit(0, null);
      await flushMicrotasks();

      // Fire-and-forget contract: a write racing the exit behaves like kill() on
      // a dead process, not an exception thrown inside a plugin's timer.
      expect(() => handle.write("late\n")).not.toThrow();
      expect(fake.stdinWrites).toEqual([]);
    });

    it("makes write() a no-op once stdin has been destroyed", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());
      const fake = h.fakes[0]!;

      // The child died and Node tore its pipe down, but the manager has not yet
      // seen the 'exit' event — the guard, not the status check, must catch this.
      fake.stdin!.destroy();
      expect(() => handle.write("orphaned\n")).not.toThrow();
      await flushMicrotasks();
      expect(fake.stdinWrites).toEqual([]);
    });

    it("respawns as duplex on restart and writes reach the replacement stdin", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());
      const first = h.fakes[0]!;

      await handle.restart();
      const second = h.fakes[1]!;
      expect(second).toBeDefined();
      // The restart must not silently demote the child to pipe mode.
      expect(h.spawnConfigs[1]?.mode).toBe("duplex");

      handle.write("after-restart\n");
      await flushMicrotasks();

      expect(second.stdinWrites.join("")).toBe("after-restart\n");
      // The detached predecessor receives nothing.
      expect(first.stdinWrites).toEqual([]);
    });

    it("counts duplex processes against the per-plugin concurrency cap", async () => {
      const h = makeHarness();
      for (let i = 0; i < PLUGIN_PROCESS_MAX_CONCURRENT; i++) {
        await h.manager.spawn("acme.tool", duplexConfig());
      }
      expect(h.manager.runningCount("acme.tool")).toBe(PLUGIN_PROCESS_MAX_CONCURRENT);
      await expect(h.manager.spawn("acme.tool", duplexConfig())).rejects.toThrow(
        PluginProcessConcurrencyError
      );
    });

    it("records duplex spawns in the audit trail", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", duplexConfig({ command: "codex" }));
      expect(h.auditCalls).toEqual([{ pluginId: "acme.tool", command: "codex" }]);
    });

    it("tears duplex children down on unload", async () => {
      const h = makeHarness();
      await h.manager.spawn("acme.tool", duplexConfig());
      await h.manager.spawn("acme.tool", duplexConfig());

      h.manager.killAll("acme.tool");

      expect(h.fakes[0]!.killSignals).toContain("SIGTERM");
      expect(h.fakes[1]!.killSignals).toContain("SIGTERM");
    });

    it("leaves resize inert on a duplex process — there is no terminal", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", duplexConfig());
      expect(() => handle.resize(120, 40)).not.toThrow();
      expect(h.ptys).toHaveLength(0);
    });

    it("leaves pipe-mode writes inert even though the write path now exists", async () => {
      const h = makeHarness();
      const handle = await h.manager.spawn("acme.tool", pipeConfig());

      expect(() => handle.write("x")).not.toThrow();
      expect(h.fakes[0]!.stdinWrites).toEqual([]);
    });

    it("no-ops when stdin has ended rather than writing after end", async () => {
      const writes: string[] = [];
      // Isolates the `writableEnded` branch. A real PassThrough that has been
      // `end()`ed also reports destroyed and writable:false, so asserting
      // against one would pass even with this branch deleted; this fake trips
      // ONLY writableEnded. Writing to a genuinely ended stream would raise
      // ERR_STREAM_WRITE_AFTER_END.
      const stdin = {
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        writable: true,
        writableEnded: true,
        destroyed: false,
        on: () => undefined,
      } as unknown as NodeJS.WritableStream;
      const manager = new PluginProcessManager({
        streamSink: () => {},
        spawner: () => ({ ...makeFakeChild({ duplex: true }).child, stdin }),
      });

      const handle = await manager.spawn("acme.tool", duplexConfig());
      expect(() => handle.write("after-end\n")).not.toThrow();
      expect(writes).toEqual([]);
    });

    it("no-ops when the stream reports itself no longer writable", async () => {
      const writes: string[] = [];
      // Reports `writable: false` while NOT being ended or destroyed — the third
      // guard branch, which the PassThrough-based fakes can't reach.
      const stdin = {
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        writable: false,
        writableEnded: false,
        destroyed: false,
        on: () => undefined,
      } as unknown as NodeJS.WritableStream;
      const manager = new PluginProcessManager({
        streamSink: () => {},
        spawner: () => ({ ...makeFakeChild({ duplex: true }).child, stdin }),
      });

      const handle = await manager.spawn("acme.tool", duplexConfig());
      expect(() => handle.write("nope\n")).not.toThrow();
      expect(writes).toEqual([]);
    });

    it("no-ops when a duplex child came back without a stdin at all", async () => {
      const manager = new PluginProcessManager({
        streamSink: () => {},
        // A spawner that hands back a child with no stdin despite duplex mode.
        spawner: () => ({ ...makeFakeChild().child, stdin: null }),
      });

      const handle = await manager.spawn("acme.tool", duplexConfig());
      expect(() => handle.write("nowhere\n")).not.toThrow();
    });

    it("absorbs an EPIPE raised by the write itself instead of crashing", async () => {
      const errorListeners: Array<(err: Error) => void> = [];
      // Reports itself fully open, so `write()` clears every guard and actually
      // calls through — then fails the way a child that died mid-write does.
      // Without the once-per-child listener installed in startChild, this error
      // would surface unhandled and take the main process down.
      const stdin = {
        write: () => {
          const err = new Error("write EPIPE") as Error & { code: string };
          err.code = "EPIPE";
          for (const listener of errorListeners) listener(err);
          return false;
        },
        writable: true,
        writableEnded: false,
        destroyed: false,
        on: (event: string, listener: (err: Error) => void) => {
          if (event === "error") errorListeners.push(listener);
          return undefined;
        },
      } as unknown as NodeJS.WritableStream;
      const manager = new PluginProcessManager({
        streamSink: () => {},
        spawner: () => ({ ...makeFakeChild({ duplex: true }).child, stdin }),
      });

      const handle = await manager.spawn("acme.tool", duplexConfig());
      // Exactly one listener, installed at spawn — not one per write, which
      // would accumulate on a chatty plugin.
      expect(errorListeners).toHaveLength(1);

      expect(() => handle.write("boom\n")).not.toThrow();
      handle.write("boom-again\n");
      expect(errorListeners).toHaveLength(1);
    });

    // The one test that exercises the REAL default spawner. Asserting the
    // `stdio` array the implementation passes would be tautological; driving an
    // actual child proves fd 0 is genuinely piped, that fd 1 and fd 2 arrive
    // separately, and that minimalSpawnEnv still filters the host environment.
    it("drives a real child over stdio with a filtered environment", async () => {
      const SECRET = "DAINTREE_TEST_DUPLEX_SECRET";
      const previousSecret = process.env[SECRET];
      process.env[SECRET] = "must-not-leak";
      const events: Array<{ event: PluginProcessStreamEvent }> = [];
      // No `spawner` override — this uses the production defaultSpawner.
      const manager = new PluginProcessManager({
        streamSink: (_pluginId, event) => events.push({ event }),
      });

      const byKind = (kind: "stdout" | "stderr"): string =>
        events
          .map((e) => e.event)
          .filter((e) => e.kind === kind)
          .map((e) => (e.kind === kind ? e.chunk : ""))
          .join("");

      try {
        // Echoes the line back on stdout and reports what it can see of the
        // environment on stderr. It deliberately does NOT call process.exit():
        // writes to a pipe are asynchronous, so exiting on top of them can
        // truncate the output and Node's 'exit' can beat the parent's last
        // 'data' event. Waiting on the bytes we actually assert on — rather
        // than on exit — keeps this deterministic. The child is killed below.
        const script = [
          "let buf = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (d) => {",
          "  buf += d;",
          "  const i = buf.indexOf('\\n');",
          "  if (i === -1) return;",
          "  const line = buf.slice(0, i);",
          "  buf = buf.slice(i + 1);",
          "  process.stdout.write('echo:' + line + '\\n');",
          "  process.stderr.write('flag=' + String(process.env.PLUGIN_FLAG) +",
          "    ' secret=' + String(process.env." + SECRET + ") + '\\n');",
          "});",
        ].join("");

        const handle = await manager.spawn("acme.tool", {
          mode: "duplex",
          command: process.execPath,
          args: ["-e", script],
          cwd: undefined,
          env: { PLUGIN_FLAG: "on" },
          panelId: null,
        });

        handle.write("hello\n");

        // Poll until BOTH streams have delivered, bounded well inside the
        // test timeout so a failure still runs `finally` and reports what did
        // arrive instead of hanging until the framework kills the test.
        const deadline = Date.now() + 10_000;
        // The stderr predicate waits for the COMPLETE expected string, not a
        // `secret=` prefix: a chunk boundary can land mid-value, and stopping
        // there would assert against a partial read and fail spuriously.
        while (!(
          byKind("stdout").includes("echo:hello") && byKind("stderr").includes("secret=undefined")
        )) {
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 10));
        }

        // fd 0 really was piped: the child received what we wrote and answered.
        expect(byKind("stdout")).toContain("echo:hello");
        // fd 2 arrived on its own stream, NOT mixed into the protocol stream.
        expect(byKind("stderr")).toContain("flag=on");
        expect(byKind("stdout")).not.toContain("flag=");
        // minimalSpawnEnv still applies: the explicit plugin entry reached the
        // child, but the host-only secret did not.
        expect(byKind("stderr")).toContain("secret=undefined");
      } finally {
        // Runs even when an assertion above throws, so no real child outlives
        // the test and no env mutation leaks into another file's worker.
        manager.killAll("acme.tool");
        if (previousSecret === undefined) delete process.env[SECRET];
        else process.env[SECRET] = previousSecret;
      }
    }, 20_000);
  });
});
