import * as pty from "node-pty";
import { destroyPty } from "../../services/PtyPool.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import type {
  PluginPtyHostEvent,
  PluginPtyHostSpawnOptions,
} from "../../../shared/types/pty-host.js";

/**
 * Owns the raw pseudo-terminals a plugin spawned via `host.process.spawn({ mode:
 * "pty" })` (#11300). Lives in the pty-host utility process purely for crash
 * isolation — a native node-pty failure kills this process, which the host
 * already knows how to respawn, instead of taking the whole app down.
 *
 * It is deliberately a dumb executor. Capability checks, JIT consent,
 * plugin-liveness gates, the per-plugin concurrency cap, and the environment
 * allowlist all run in Main before a spawn message is ever sent; a utility
 * process has no plugin registry to re-derive any of them from. Nothing here
 * touches `PtyManager`/`TerminalProcess`, so a plugin PTY never acquires
 * terminal-panel semantics: no pooling, agent detection, resource governance,
 * session persistence, or launch ledger.
 *
 * Every entry is keyed by `(id, generation)`. `restart()` in Main bumps the
 * generation, so output and exits from a replaced incarnation are dropped
 * rather than delivered against its successor.
 */
export class PluginPtyProcessManager {
  private readonly entries = new Map<string, PluginPtyEntry>();

  constructor(private readonly sendEvent: (event: PluginPtyHostEvent) => void) {}

  spawn(id: string, generation: number, options: PluginPtyHostSpawnOptions): void {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.generation >= generation) {
        // A duplicate or stale spawn for a live incarnation. Refuse rather than
        // orphaning the running PTY by overwriting the map entry.
        this.sendEvent({
          type: "plugin-pty-spawn-result",
          id,
          generation,
          result: { success: false, error: `plugin pty "${id}" already running` },
        });
        return;
      }
      // A newer generation supersedes a still-live predecessor (Main detached
      // it during restart) — tear the old one down before allocating.
      this.teardownEntry(existing, "superseded");
    }

    let child: pty.IPty;
    try {
      child = pty.spawn(options.command, options.args, {
        cwd: options.cwd,
        // Reduced again here rather than trusted blindly: this process reads the
        // same allowlist Main does, so a message that somehow carried extra keys
        // still cannot widen a plugin child's environment.
        env: minimalSpawnEnv(options.env) as Record<string, string>,
        cols: options.cols,
        rows: options.rows,
        name: "xterm-256color",
      });
    } catch (error) {
      this.sendEvent({
        type: "plugin-pty-spawn-result",
        id,
        generation,
        result: { success: false, error: errorText(error) },
      });
      return;
    }

    const entry: PluginPtyEntry = {
      id,
      generation,
      pty: child,
      disposables: [],
      exited: false,
      tornDown: false,
    };
    this.entries.set(id, entry);

    // Wire output and exit BEFORE announcing the spawn, so a command that
    // greets the moment it starts cannot emit into a void.
    entry.disposables.push(
      child.onData((data) => {
        if (entry.tornDown) return;
        this.sendEvent({ type: "plugin-pty-data", id, generation, data });
      })
    );
    entry.disposables.push(
      child.onExit(({ exitCode, signal }) => {
        entry.exited = true;
        this.sendEvent({
          type: "plugin-pty-exit",
          id,
          generation,
          exitCode: typeof exitCode === "number" ? exitCode : null,
          signal: typeof signal === "number" ? signal : null,
        });
        this.teardownEntry(entry, "exit");
      })
    );

    this.sendEvent({
      type: "plugin-pty-spawn-result",
      id,
      generation,
      result: { success: true, pid: typeof child.pid === "number" ? child.pid : null },
    });
  }

  write(id: string, generation: number, data: string): void {
    const entry = this.liveEntry(id, generation);
    if (!entry) return;
    try {
      entry.pty.write(data);
    } catch (error) {
      console.warn(`[PluginPty] write to "${id}" failed:`, errorText(error));
    }
  }

  /**
   * Resize a live PTY. Guarded on both liveness and dimensions: node-pty can
   * fault when asked to resize a handle whose child has already exited, and a
   * non-positive dimension is rejected outright.
   */
  resize(id: string, generation: number, cols: number, rows: number): void {
    const entry = this.liveEntry(id, generation);
    if (!entry) return;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return;
    try {
      entry.pty.resize(cols, rows);
    } catch (error) {
      console.warn(`[PluginPty] resize of "${id}" failed:`, errorText(error));
    }
  }

  /**
   * Signal a PTY down. `SIGTERM` is the polite ask and leaves the handle live so
   * the child can exit on its own terms (its `onExit` then runs teardown);
   * `SIGKILL` is Main's escalation after the grace window, so it force-releases
   * the native handle through the teardown chokepoint immediately.
   */
  kill(id: string, generation: number, signal: "SIGTERM" | "SIGKILL"): void {
    const entry = this.liveEntry(id, generation);
    if (!entry) return;
    if (signal === "SIGTERM") {
      try {
        entry.pty.kill("SIGTERM");
      } catch {
        // Already gone — the exit handler does the bookkeeping.
      }
      return;
    }
    // SIGKILL is Main's escalation after the grace window, so on Unix it must
    // actually be SIGKILL: `destroyPty`'s bare `kill()` is
    // `process.kill(pid, signal || "SIGHUP")` in node-pty, and a child that
    // ignores HUP would survive, outliving the map entry and its listeners with
    // nothing tracking it.
    //
    // NOT on Windows. ConPTY has no signals — `WindowsTerminal.kill()` ignores
    // the argument and routes into the same deferred native kill `destroyPty`
    // is about to issue, so an extra call here would double-free the
    // pseudoconsole and crash the pty-host with STATUS_HEAP_CORRUPTION (#9551).
    // There, `destroyPty`'s single guarded kill is both sufficient and the safe
    // maximum.
    if (process.platform !== "win32") {
      try {
        entry.pty.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    this.teardownEntry(entry, "kill");
  }

  /** Tear down every live plugin PTY. Called on host shutdown / dispatcher disposal. */
  disposeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.teardownEntry(entry, "dispose");
    }
    this.entries.clear();
  }

  /** Live-and-current lookup: wrong generation, exited, or unknown all return undefined. */
  private liveEntry(id: string, generation: number): PluginPtyEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.generation !== generation) return undefined;
    if (entry.exited || entry.tornDown) return undefined;
    return entry;
  }

  /**
   * The single end-of-life route for a plugin PTY — natural exit, requested
   * kill, supersede, and host disposal all land here. Releasing the native
   * handle goes through {@link destroyPty}, the same hardened primitive the
   * terminal path uses: a bare `kill()` leaks the master fd on Unix (#9544), and
   * `destroyPty` also carries the Windows ConPTY double-free guard (#9551).
   * Idempotent — a kill racing the child's own exit must not double-free.
   */
  private teardownEntry(entry: PluginPtyEntry, reason: string): void {
    if (entry.tornDown) return;
    entry.tornDown = true;
    // A forced teardown disposes the `onExit` listener before node-pty would
    // have fired it, so nothing else will ever tell Main this process ended.
    // Without this ack the managed record sits in `running` forever: `onExit`
    // never fires and its concurrency slot is never released. The `exited` latch
    // keeps it exactly-once against a real exit that already reported.
    if (!entry.exited) {
      entry.exited = true;
      this.sendEvent({
        type: "plugin-pty-exit",
        id: entry.id,
        generation: entry.generation,
        exitCode: null,
        signal: 9,
      });
    }
    for (const disposable of entry.disposables) {
      try {
        disposable.dispose();
      } catch {
        // best-effort
      }
    }
    entry.disposables.length = 0;
    try {
      destroyPty(entry.pty);
    } catch (error) {
      console.warn(`[PluginPty] teardown (${reason}) of "${entry.id}" failed:`, errorText(error));
    }
    // Only drop the map entry if it still points at this incarnation — a
    // supersede has already installed the successor by the time exit lands.
    if (this.entries.get(entry.id) === entry) {
      this.entries.delete(entry.id);
    }
  }
}

interface PluginPtyEntry {
  id: string;
  generation: number;
  pty: pty.IPty;
  disposables: pty.IDisposable[];
  /** Set by `onExit` so a racing write/resize/kill sees a dead handle. */
  exited: boolean;
  /** Set by the teardown chokepoint so it runs exactly once per incarnation. */
  tornDown: boolean;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
