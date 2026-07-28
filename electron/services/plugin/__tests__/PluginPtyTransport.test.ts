import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PluginPtyTransport, type PluginPtyClientLike } from "../PluginPtyTransport.js";
import type {
  PluginPtyHostEvent,
  PluginPtyHostSpawnOptions,
} from "../../../../shared/types/pty-host.js";

function options(overrides: Partial<PluginPtyHostSpawnOptions> = {}): PluginPtyHostSpawnOptions {
  return {
    command: "flutter",
    args: ["daemon", "--machine"],
    cwd: "/repo",
    env: { PATH: "/usr/bin" },
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

interface SentMessage {
  kind: "spawn" | "write" | "resize" | "kill";
  id: string;
  generation: number;
  payload?: unknown;
}

/**
 * Fake PtyClient that records what Main sent and lets a test emit host events.
 * `respondOnSpawn` fires the spawn result SYNCHRONOUSLY from inside the spawn
 * call — the shape that proves the transport attached its listener first.
 */
function makeClient(opts?: { respondOnSpawn?: boolean }) {
  const emitter = new EventEmitter();
  const sent: SentMessage[] = [];
  let respond = opts?.respondOnSpawn ?? true;

  const client: PluginPtyClientLike = {
    spawnPluginPty: (id, generation, spawnOptions) => {
      sent.push({ kind: "spawn", id, generation, payload: spawnOptions });
      if (!respond) return;
      emitter.emit("plugin-pty", {
        type: "plugin-pty-spawn-result",
        id,
        generation,
        result: { success: true, pid: 4242 },
      } satisfies PluginPtyHostEvent);
    },
    writePluginPty: (id, generation, data) =>
      sent.push({ kind: "write", id, generation, payload: data }),
    resizePluginPty: (id, generation, cols, rows) =>
      sent.push({ kind: "resize", id, generation, payload: { cols, rows } }),
    killPluginPty: (id, generation, signal) =>
      sent.push({ kind: "kill", id, generation, payload: signal }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return client;
    },
    off: (event, listener) => {
      emitter.off(event, listener);
      return client;
    },
  };

  return {
    client,
    sent,
    setRespond: (value: boolean) => {
      respond = value;
    },
    emit: (event: PluginPtyHostEvent) => emitter.emit("plugin-pty", event),
    emitHostCrash: (code = -1) => emitter.emit("host-crash", code),
    emitHostCrashDetails: () => emitter.emit("host-crash-details", { crashType: "crashed" }),
    get listenerCount() {
      return (
        emitter.listenerCount("plugin-pty") +
        emitter.listenerCount("host-crash") +
        emitter.listenerCount("host-crash-details")
      );
    },
  };
}

describe("PluginPtyTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a spawn whose result arrives synchronously from the send", async () => {
    // `spawnPluginPty` is void and the host can answer on the same tick, so the
    // listener must already be attached when the send happens.
    const c = makeClient({ respondOnSpawn: true });
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    expect(backend.pid).toBe(4242);
    expect(c.sent[0]).toMatchObject({ kind: "spawn", id: "p1", generation: 0 });
  });

  it("rejects when the host reports a failed allocation", async () => {
    const c = makeClient({ respondOnSpawn: false });
    const transport = new PluginPtyTransport(c.client);
    const pending = transport.spawn("p1", 0, options());
    c.emit({
      type: "plugin-pty-spawn-result",
      id: "p1",
      generation: 0,
      result: { success: false, error: "ENOENT" },
    });
    await expect(pending).rejects.toThrow("ENOENT");
  });

  it("times out, kills the exact generation, and rejects", async () => {
    vi.useFakeTimers();
    const c = makeClient({ respondOnSpawn: false });
    const transport = new PluginPtyTransport(c.client, 100);
    const pending = transport.spawn("p1", 3, options());
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    // A late success must not strand an unowned PTY in the host.
    expect(c.sent).toContainEqual({
      kind: "kill",
      id: "p1",
      generation: 3,
      payload: "SIGKILL",
    });
  });

  it("ignores events for another process id", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const chunks: string[] = [];
    backend.onData((d) => chunks.push(d));

    c.emit({ type: "plugin-pty-data", id: "other", generation: 0, data: "nope" });
    c.emit({ type: "plugin-pty-data", id: "p1", generation: 0, data: "yes" });
    expect(chunks).toEqual(["yes"]);
  });

  it("ignores events from a stale generation", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 2, options());
    const chunks: string[] = [];
    const exits: unknown[] = [];
    backend.onData((d) => chunks.push(d));
    backend.onExit((info) => exits.push(info));

    // Both belong to the incarnation a restart already replaced.
    c.emit({ type: "plugin-pty-data", id: "p1", generation: 1, data: "stale" });
    c.emit({ type: "plugin-pty-exit", id: "p1", generation: 1, exitCode: 1, signal: null });
    expect(chunks).toHaveLength(0);
    expect(exits).toHaveLength(0);
  });

  it("maps a raw signal number to its name on exit", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    backend.onExit((info) => exits.push(info));

    c.emit({ type: "plugin-pty-exit", id: "p1", generation: 0, exitCode: null, signal: 15 });
    expect(exits).toEqual([{ exitCode: null, signal: "SIGTERM" }]);
  });

  it("reports a normal exit with a null signal", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    backend.onExit((info) => exits.push(info));

    c.emit({ type: "plugin-pty-exit", id: "p1", generation: 0, exitCode: 0, signal: null });
    expect(exits).toEqual([{ exitCode: 0, signal: null }]);
  });

  it("stops relaying write/resize/kill once the process has exited", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    c.emit({ type: "plugin-pty-exit", id: "p1", generation: 0, exitCode: 0, signal: null });

    backend.write("x");
    backend.resize(100, 30);
    backend.kill("SIGTERM");
    expect(c.sent.filter((m) => m.kind !== "spawn")).toHaveLength(0);
  });

  it("drops a resize with invalid dimensions before it reaches the host", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    backend.resize(0, 24);
    backend.resize(80, 0);
    backend.resize(80.5, 24);
    expect(c.sent.filter((m) => m.kind === "resize")).toHaveLength(0);
  });

  it("settles on a recoverable host crash, not only on give-up", async () => {
    // PtyClient emits `host-crash` ONLY after the restart budget is exhausted;
    // an ordinary crash-and-restart emits `host-crash-details`. Listening to the
    // former alone leaves every plugin PTY wedged in `running` through the
    // crashes that actually happen.
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const exits: unknown[] = [];
    backend.onExit((info) => exits.push(info));

    c.emitHostCrashDetails();
    expect(exits).toHaveLength(1);
  });

  it("holds output that arrives before the caller subscribes, then drains it in order", async () => {
    // The host wires its onData before announcing the spawn, so a daemon that
    // greets immediately emits before `spawn()` resolves and the manager
    // subscribes. Dropping it would lose a `--machine` handshake.
    const c = makeClient({ respondOnSpawn: false });
    const transport = new PluginPtyTransport(c.client);
    const pending = transport.spawn("p1", 0, options());
    c.emit({ type: "plugin-pty-data", id: "p1", generation: 0, data: "greet-1" });
    c.emit({ type: "plugin-pty-data", id: "p1", generation: 0, data: "greet-2" });
    c.emit({
      type: "plugin-pty-spawn-result",
      id: "p1",
      generation: 0,
      result: { success: true, pid: 1 },
    });
    const backend = await pending;

    const chunks: string[] = [];
    backend.onData((d) => chunks.push(d));
    expect(chunks).toEqual(["greet-1", "greet-2"]);

    c.emit({ type: "plugin-pty-data", id: "p1", generation: 0, data: "live" });
    expect(chunks).toEqual(["greet-1", "greet-2", "live"]);
  });

  it("settles a displaced allocation immediately instead of leaving it to time out", async () => {
    // Two restarts issued without awaiting the first: generation 1's result is
    // filtered out by generation 2, so nothing would ever settle its promise.
    vi.useFakeTimers();
    const c = makeClient({ respondOnSpawn: false });
    const transport = new PluginPtyTransport(c.client, 10_000);
    const firstAttempt = transport.spawn("p1", 1, options());
    const secondAttempt = transport.spawn("p1", 2, options());
    c.emit({
      type: "plugin-pty-spawn-result",
      id: "p1",
      generation: 2,
      result: { success: true, pid: 7 },
    });

    await expect(firstAttempt).rejects.toThrow();
    await expect(secondAttempt).resolves.toBeDefined();
    // The displaced incarnation is force-killed so a late allocation for it
    // can't survive unowned.
    expect(c.sent).toContainEqual({ kind: "kill", id: "p1", generation: 1, payload: "SIGKILL" });
  });

  it("synthesizes an exit for every live PTY when the pty-host crashes", async () => {
    // The host takes its PTYs with it and will never send their exits — without
    // this the handle sits in `running` forever, pinning a concurrency slot.
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const a = await transport.spawn("p1", 0, options());
    const b = await transport.spawn("p2", 0, options());
    const exits: Array<{ id: string; signal: string | null }> = [];
    a.onExit((info) => exits.push({ id: "p1", signal: info.signal }));
    b.onExit((info) => exits.push({ id: "p2", signal: info.signal }));

    c.emitHostCrash();

    expect(exits).toEqual([
      { id: "p1", signal: "SIGKILL" },
      { id: "p2", signal: "SIGKILL" },
    ]);
  });

  it("rejects a spawn still in flight when the host crashes", async () => {
    const c = makeClient({ respondOnSpawn: false });
    const transport = new PluginPtyTransport(c.client);
    const pending = transport.spawn("p1", 0, options());
    c.emitHostCrash();
    await expect(pending).rejects.toThrow(/terminated before spawn/);
  });

  it("dispose() drops the client subscriptions and kills every live PTY", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const exits: unknown[] = [];
    backend.onExit((info) => exits.push(info));
    expect(c.listenerCount).toBeGreaterThan(0);

    transport.dispose();

    expect(c.sent).toContainEqual({ kind: "kill", id: "p1", generation: 0, payload: "SIGKILL" });
    expect(exits).toHaveLength(1);
    expect(c.listenerCount).toBe(0);
  });

  it("rejects a spawn after dispose", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    transport.dispose();
    await expect(transport.spawn("p1", 0, options())).rejects.toThrow(/disposed/);
  });

  it("delivers only one exit even when the host and a crash both report it", async () => {
    const c = makeClient();
    const transport = new PluginPtyTransport(c.client);
    const backend = await transport.spawn("p1", 0, options());
    const exits: unknown[] = [];
    backend.onExit((info) => exits.push(info));

    c.emit({ type: "plugin-pty-exit", id: "p1", generation: 0, exitCode: 0, signal: null });
    c.emitHostCrash();
    expect(exits).toHaveLength(1);
  });
});
