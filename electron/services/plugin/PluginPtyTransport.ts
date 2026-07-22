import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  PluginPtyHostEvent,
  PluginPtyHostSpawnOptions,
} from "../../../shared/types/pty-host.js";

/** How long to wait for a `plugin-pty-spawn-result` before giving up on the host. */
export const PLUGIN_PTY_SPAWN_TIMEOUT_MS = 10_000;

/**
 * Cap on output held between the host emitting it and the manager subscribing.
 * Small — this window is a single IPC round-trip, not a user-visible wait; the
 * plugin-facing replay buffer in `PluginProcessManager` is the larger one.
 */
export const PLUGIN_PTY_PRE_ADOPTION_CAP_BYTES = 64 * 1024;

/** Terminal outcome of a plugin PTY, shaped like the pipe path's exit info. */
export interface PluginPtyExit {
  exitCode: number | null;
  signal: string | null;
}

/**
 * A live plugin PTY as {@link import("./PluginProcessManager.js").PluginProcessManager}
 * consumes it — the interactive counterpart to `ManagedChildProcess`. Every
 * method is safe to call after exit (no-op).
 */
export interface ManagedPtyBackend {
  readonly pid: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** `SIGTERM` asks politely; `SIGKILL` force-releases the native handle. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (info: PluginPtyExit) => void): () => void;
  /** Drop every listener without signalling the child. */
  dispose(): void;
}

/**
 * The subset of `PtyClient` this transport drives — narrowed so tests can fake
 * it without an EventEmitter subclass. `on`/`off` use the broad EventEmitter
 * shape deliberately: a narrower listener parameter would make the real
 * `PtyClient` (whose `on` accepts `(...args: any[])`) fail to satisfy this.
 */
export interface PluginPtyClientLike {
  spawnPluginPty(id: string, generation: number, options: PluginPtyHostSpawnOptions): void;
  writePluginPty(id: string, generation: number, data: string): void;
  resizePluginPty(id: string, generation: number, cols: number, rows: number): void;
  killPluginPty(id: string, generation: number, signal: "SIGTERM" | "SIGKILL"): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Bridges the pty-host's fire-and-forget plugin-PTY protocol to the awaitable
 * backend the process manager wants (#11300).
 *
 * Three things this owns that the manager must not have to think about:
 *
 *  - **Listener before send.** `spawnPluginPty` is void and its result arrives
 *    as an event that can land synchronously, so the listener is attached before
 *    the call, filtered by `(id, generation)`, and bounded by a timeout.
 *  - **Generation filtering.** `restart()` bumps the generation; data and exits
 *    from the replaced incarnation are dropped rather than delivered against its
 *    successor.
 *  - **Host-crash synthesis.** When the pty-host dies it takes every plugin PTY
 *    with it and will never send their exits. Without a synthetic exit the
 *    handle would sit in `running` forever, pinning a concurrency slot and never
 *    firing `onCrash`. Interactive processes are deliberately NOT auto-respawned
 *    — an explicit `handle.restart()` uses the recovered host.
 */
export class PluginPtyTransport {
  private readonly live = new Map<string, LiveEntry>();
  private readonly onHostEvent: (event: PluginPtyHostEvent) => void;
  private readonly onHostCrash: () => void;
  private disposed = false;

  constructor(
    private readonly client: PluginPtyClientLike,
    private readonly spawnTimeoutMs: number = PLUGIN_PTY_SPAWN_TIMEOUT_MS
  ) {
    this.onHostEvent = (event) => this.handleEvent(event);
    this.onHostCrash = () => this.handleHostCrash();
    this.client.on("plugin-pty", this.onHostEvent as (...args: unknown[]) => void);
    // BOTH crash signals, because they mean different things and only their
    // union covers us. `host-crash-details` fires on every classified default-
    // shard crash — the common case, where the host dies and is restarted;
    // `host-crash` fires only once the restart budget is exhausted. Listening to
    // the latter alone would leave a plugin's PTYs wedged in `running` (slot
    // pinned, no `onCrash`) through the first crashes, which are the ones that
    // actually happen. `settleExit` is idempotent, so the overlap is harmless.
    this.client.on("host-crash-details", this.onHostCrash as (...args: unknown[]) => void);
    this.client.on("host-crash", this.onHostCrash as (...args: unknown[]) => void);
  }

  /**
   * Allocate a PTY in the host. Rejects on a host-reported failure, on timeout,
   * or if the transport is disposed mid-flight. The returned backend is already
   * wired for data/exit — nothing is dropped between allocation and the caller
   * attaching its listeners, because the entry's listener sets exist first.
   */
  async spawn(
    id: string,
    generation: number,
    options: PluginPtyHostSpawnOptions
  ): Promise<ManagedPtyBackend> {
    if (this.disposed) {
      throw new Error("plugin pty transport is disposed");
    }
    const entry: LiveEntry = {
      id,
      generation,
      pid: null,
      exited: false,
      dataListeners: new Set(),
      exitListeners: new Set(),
      preAdoptionData: [],
      preAdoptionBytes: 0,
      pending: null,
    };
    // Registered BEFORE the send: `plugin-pty-spawn-result` can arrive on the
    // same tick, and an unregistered entry would drop it on the floor.
    // A displaced entry (two restarts issued without awaiting the first) would
    // otherwise never see its result — every later event filters on the new
    // generation — and its promise would hang until the spawn timeout. Settle it
    // now instead, and force-kill its generation so a late allocation for it
    // can't survive unowned.
    const displaced = this.live.get(id);
    if (displaced && displaced !== entry) {
      this.client.killPluginPty(displaced.id, displaced.generation, "SIGKILL");
      this.settleExit(displaced, { exitCode: null, signal: "SIGKILL" });
    }
    this.live.set(id, entry);

    try {
      const pid = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pending = null;
          // The host may yet allocate it — kill this exact generation so a late
          // success can't strand an unowned PTY.
          this.client.killPluginPty(id, generation, "SIGKILL");
          reject(new Error(`plugin pty spawn timed out after ${this.spawnTimeoutMs}ms`));
        }, this.spawnTimeoutMs);
        timer.unref?.();
        entry.pending = {
          resolve: (value) => {
            clearTimeout(timer);
            entry.pending = null;
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            entry.pending = null;
            reject(error);
          },
        };
        this.client.spawnPluginPty(id, generation, options);
      });
      entry.pid = pid;
    } catch (error) {
      if (this.live.get(id) === entry) this.live.delete(id);
      throw error;
    }

    if (this.disposed) {
      this.client.killPluginPty(id, generation, "SIGKILL");
      if (this.live.get(id) === entry) this.live.delete(id);
      throw new Error("plugin pty transport is disposed");
    }

    return this.buildBackend(entry);
  }

  private buildBackend(entry: LiveEntry): ManagedPtyBackend {
    const guard = (): boolean => !entry.exited && this.live.get(entry.id) === entry;
    return {
      get pid() {
        return entry.pid;
      },
      write: (data) => {
        if (!guard() || data.length === 0) return;
        this.client.writePluginPty(entry.id, entry.generation, data);
      },
      resize: (cols, rows) => {
        // Guarded here as well as in the host: resizing an exited PTY is a
        // documented crash risk, and Main knows about the exit first.
        if (!guard()) return;
        if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return;
        this.client.resizePluginPty(entry.id, entry.generation, cols, rows);
      },
      kill: (signal) => {
        if (!guard()) return;
        this.client.killPluginPty(entry.id, entry.generation, signal);
      },
      onData: (listener) => {
        const first = entry.dataListeners.size === 0;
        entry.dataListeners.add(listener);
        if (first && entry.preAdoptionData.length > 0) {
          const buffered = entry.preAdoptionData;
          entry.preAdoptionData = [];
          entry.preAdoptionBytes = 0;
          // Synchronous and in order: this is output the child already produced,
          // and it must reach the plugin ahead of anything that arrives next.
          for (const data of buffered) {
            try {
              listener(data);
            } catch (error) {
              console.error(
                `[PluginPtyTransport] buffered data listener for "${entry.id}" threw:`,
                formatErrorMessage(error, "listener error")
              );
            }
          }
        }
        return () => entry.dataListeners.delete(listener);
      },
      onExit: (listener) => {
        entry.exitListeners.add(listener);
        return () => entry.exitListeners.delete(listener);
      },
      dispose: () => {
        entry.dataListeners.clear();
        entry.exitListeners.clear();
        if (this.live.get(entry.id) === entry) this.live.delete(entry.id);
      },
    };
  }

  private handleEvent(event: PluginPtyHostEvent): void {
    const entry = this.live.get(event.id);
    // Stale generation: an event about an incarnation `restart()` already
    // replaced. Dropping it is the whole point of carrying the generation.
    if (!entry || entry.generation !== event.generation) return;

    switch (event.type) {
      case "plugin-pty-spawn-result": {
        const pending = entry.pending;
        if (!pending) return;
        if (event.result.success) {
          pending.resolve(event.result.pid);
        } else {
          pending.reject(new Error(event.result.error));
        }
        return;
      }
      case "plugin-pty-data": {
        if (entry.exited) return;
        // The host wires its `onData` before announcing the spawn (so an eager
        // greeting isn't lost there), which means data can legitimately arrive
        // BEFORE `spawn()` resolves and the manager subscribes. Hold it until
        // the first listener attaches, or a `--machine` daemon's handshake dies
        // in the gap between the two.
        if (entry.dataListeners.size === 0) {
          entry.preAdoptionData.push(event.data);
          entry.preAdoptionBytes += Buffer.byteLength(event.data, "utf-8");
          while (
            entry.preAdoptionBytes > PLUGIN_PTY_PRE_ADOPTION_CAP_BYTES &&
            entry.preAdoptionData.length > 0
          ) {
            const dropped = entry.preAdoptionData.shift();
            entry.preAdoptionBytes -= dropped ? Buffer.byteLength(dropped, "utf-8") : 0;
          }
          return;
        }
        for (const listener of [...entry.dataListeners]) {
          try {
            listener(event.data);
          } catch (error) {
            console.error(
              `[PluginPtyTransport] data listener for "${entry.id}" threw:`,
              formatErrorMessage(error, "listener error")
            );
          }
        }
        return;
      }
      case "plugin-pty-exit": {
        this.settleExit(entry, {
          exitCode: event.exitCode,
          // node-pty reports the raw OS signal number; the plugin-facing
          // contract is a string, matching the pipe path's `NodeJS.Signals`.
          signal: event.signal === null ? null : signalName(event.signal),
        });
        return;
      }
    }
  }

  /**
   * A pty-host crash takes every plugin PTY with it and no exit will ever
   * arrive. Synthesize one per live entry so the concurrency slot is released
   * and `onCrash` fires — reported as a signalled death, which is what it is.
   */
  private handleHostCrash(): void {
    for (const entry of [...this.live.values()]) {
      this.settleExit(entry, { exitCode: null, signal: "SIGKILL" });
    }
  }

  private settleExit(entry: LiveEntry, info: PluginPtyExit): void {
    if (entry.exited) return;
    entry.exited = true;
    entry.pid = null;
    if (this.live.get(entry.id) === entry) this.live.delete(entry.id);
    // A spawn still in flight when the host dies must reject, not hang.
    entry.pending?.reject(new Error("plugin pty host terminated before spawn completed"));
    const listeners = [...entry.exitListeners];
    entry.dataListeners.clear();
    entry.exitListeners.clear();
    entry.preAdoptionData = [];
    entry.preAdoptionBytes = 0;
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (error) {
        console.error(
          `[PluginPtyTransport] exit listener for "${entry.id}" threw:`,
          formatErrorMessage(error, "listener error")
        );
      }
    }
  }

  /** Drop the client subscriptions and kill every live PTY. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.off("plugin-pty", this.onHostEvent as (...args: unknown[]) => void);
    this.client.off("host-crash-details", this.onHostCrash as (...args: unknown[]) => void);
    this.client.off("host-crash", this.onHostCrash as (...args: unknown[]) => void);
    for (const entry of [...this.live.values()]) {
      this.client.killPluginPty(entry.id, entry.generation, "SIGKILL");
      this.settleExit(entry, { exitCode: null, signal: "SIGKILL" });
    }
    this.live.clear();
  }
}

interface LiveEntry {
  id: string;
  generation: number;
  pid: number | null;
  exited: boolean;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(info: PluginPtyExit) => void>;
  /** Output that arrived before the manager adopted the backend and subscribed. */
  preAdoptionData: string[];
  preAdoptionBytes: number;
  pending: { resolve: (pid: number | null) => void; reject: (error: Error) => void } | null;
}

/**
 * Map the raw OS signal number node-pty reports to its name, so the plugin-facing
 * exit info matches the pipe path's string signal. Only the signals a managed
 * teardown can actually produce are named; anything else is reported numerically
 * rather than guessed at (numbering is not portable across platforms).
 */
function signalName(signal: number): string {
  switch (signal) {
    case 1:
      return "SIGHUP";
    case 2:
      return "SIGINT";
    case 9:
      return "SIGKILL";
    case 15:
      return "SIGTERM";
    default:
      return `SIG${signal}`;
  }
}
