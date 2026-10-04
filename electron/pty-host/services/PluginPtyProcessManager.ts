import * as pty from "node-pty";
import { destroyPty } from "../../services/PtyPool.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { PLUGIN_PROCESS_KILL_GRACE_MS } from "../../../shared/types/ipc/pluginProcess.js";
import type { ProcessTreeKiller, ProcessTreeKillTarget } from "../../services/pty/ProcessTreeKiller.js";
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
 *
 * Teardown does share one thing with terminals: the process-tree killer and
 * the lineage ledger behind it (#13173). A plugin running `npm run dev` here is
 * a shell-shaped tree like any terminal's, and signalling only the root PID
 * left its server running after every unload and quit — and, with the root
 * never registered, after a crash too, which the ledger's persisted record now
 * covers on the next launch.
 */
export class PluginPtyProcessManager {
  private readonly entries = new Map<string, PluginPtyEntry>();
  /**
   * Killers whose root has exited but which still owe their tree a SIGKILL on
   * an unref'd timer — a graceful kill's escalation, or a natural exit's
   * orphan reap. Their entries are gone, so this is what lets host disposal
   * finish that work instead of leaving it to a timer that may never fire.
   */
  private readonly lingeringKillers = new Map<PluginPtyTreeKiller, LingeringKill>();

  constructor(
    private readonly sendEvent: (event: PluginPtyHostEvent) => void,
    private readonly createTreeKiller: PluginPtyTreeKillerFactory | null = null
  ) {}

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
        result: {
          success: false,
          error: formatErrorMessage(error, "Failed to spawn plugin process"),
        },
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
      killer: null,
      rootRegistered: false,
      treeKill: "none",
      nativeReleased: false,
    };
    this.entries.set(id, entry);
    entry.killer = this.buildTreeKiller(entry);
    this.ensureRootRegistered(entry);

    // Wire output and exit BEFORE announcing the spawn, so a command that
    // greets the moment it starts cannot emit into a void.
    entry.disposables.push(
      child.onData((data) => {
        if (entry.tornDown) return;
        this.ensureRootRegistered(entry);
        this.sendEvent({ type: "plugin-pty-data", id, generation, data });
      })
    );
    entry.disposables.push(
      child.onExit(({ exitCode, signal }) => {
        entry.exited = true;
        // A tree already being killed keeps its identity-checked escalation
        // armed; one whose root just ended on its own still owes a sweep of
        // whatever it left behind, which only the lineage ledger can reach.
        this.settleKillerOnExit(entry);
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
      console.warn(
        `[PluginPty] write to "${id}" failed:`,
        formatErrorMessage(error, "write failed")
      );
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
      console.warn(
        `[PluginPty] resize of "${id}" failed:`,
        formatErrorMessage(error, "resize failed")
      );
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
      if (entry.killer) {
        // Descendants first, then the root, with the killer's own SIGKILL
        // escalation armed for the same grace window Main gives the root.
        this.killTree(entry, false);
        return;
      }
      try {
        entry.pty.kill("SIGTERM");
      } catch {
        // Already gone — the exit handler does the bookkeeping.
      }
      return;
    }
    this.killTree(entry, true);
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

  getLiveCount(): number {
    return this.entries.size;
  }

  /** Tear down every live plugin PTY. Called on host shutdown / dispatcher disposal. */
  disposeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.teardownEntry(entry, "dispose");
    }
    this.entries.clear();
    const now = Date.now();
    for (const [killer, lingering] of this.lingeringKillers) {
      if (lingering.untilMs < now) continue;
      try {
        if (lingering.mode === "escalate") killer.execute(true);
        else killer.reapAfterRootExit(true);
      } catch (error) {
        console.warn(
          "[PluginPty] final tree kill failed:",
          formatErrorMessage(error, "tree kill failed")
        );
      }
    }
    this.lingeringKillers.clear();
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
    // Supersede and host disposal end a live process like a forced kill does.
    // Signalling the tree before the native release matters: releasing hangs
    // up the root, and its children reparent out of the walk's reach.
    if (reason !== "exit") this.killTree(entry, true);
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
      this.releaseNative(entry);
    } catch (error) {
      console.warn(
        `[PluginPty] teardown (${reason}) of "${entry.id}" failed:`,
        formatErrorMessage(error, "teardown failed")
      );
    }
    // Only drop the map entry if it still points at this incarnation — a
    // supersede has already installed the successor by the time exit lands.
    if (this.entries.get(entry.id) === entry) {
      this.entries.delete(entry.id);
    }
  }

  /**
   * A tree already being killed keeps its identity-checked escalation armed;
   * one whose root just ended on its own still owes a sweep of whatever it
   * left behind, which only the lineage ledger can reach. Either way the
   * killer is kept until that work is due, for {@link disposeAll}.
   */
  private settleKillerOnExit(entry: PluginPtyEntry): void {
    const killer = entry.killer;
    if (!killer || entry.treeKill === "forced") return;
    const now = Date.now();
    for (const [stale, lingering] of this.lingeringKillers) {
      if (lingering.untilMs < now) this.lingeringKillers.delete(stale);
    }
    if (entry.treeKill === "none") {
      try {
        killer.reapAfterRootExit();
      } catch (error) {
        console.warn(
          `[PluginPty] orphan reap of "${entry.id}" failed:`,
          formatErrorMessage(error, "reap failed")
        );
      }
    }
    this.lingeringKillers.set(killer, {
      mode: entry.treeKill === "none" ? "reap" : "escalate",
      untilMs: now + PLUGIN_PROCESS_KILL_GRACE_MS,
    });
  }

  /**
   * ConPTY can report PID 0 at spawn, leaving the killer's constructor nothing
   * to register; the real PID lands later. Idempotent in the killer.
   */
  private ensureRootRegistered(entry: PluginPtyEntry): void {
    if (entry.rootRegistered || !entry.killer) return;
    const pid = entry.pty.pid;
    if (!Number.isInteger(pid) || pid <= 0) return;
    entry.rootRegistered = true;
    entry.killer.registerRoot(pid);
  }

  private buildTreeKiller(entry: PluginPtyEntry): PluginPtyTreeKiller | null {
    if (!this.createTreeKiller) return null;
    const target: ProcessTreeKillTarget = {
      get pid() {
        return entry.pty.pid;
      },
      // The root's own signal. On Windows it is the native release, routed
      // through the one-shot below so the killer's fallback and the teardown
      // chokepoint can never both reach ConPTY (#9551).
      kill: () => {
        if (process.platform === "win32") {
          this.releaseNative(entry);
          return;
        }
        // Once reaped, the root's PID may belong to anything.
        if (entry.exited) return;
        entry.pty.kill("SIGTERM");
      },
    };
    try {
      return this.createTreeKiller(target);
    } catch (error) {
      console.warn(
        `[PluginPty] tree killer for "${entry.id}" unavailable:`,
        formatErrorMessage(error, "tree killer failed")
      );
      return null;
    }
  }

  /**
   * Signal the entry's whole process tree. `immediate` SIGKILLs now (finishing
   * a graceful kill's pending escalation if there is one); otherwise the
   * killer SIGTERMs and escalates after the plugin grace window itself, so
   * grandchildren that ignore SIGTERM die even when the root exits promptly.
   *
   * Windows has no graceful step — `taskkill /T /F` is the whole kill — so the
   * tree is killed at most once there: a second pass would taskkill a PID the
   * OS may already have handed to something else.
   */
  private killTree(entry: PluginPtyEntry, immediate: boolean): void {
    const killer = entry.killer;
    if (!killer || entry.treeKill === "forced") return;
    if (process.platform === "win32" && entry.treeKill !== "none") return;
    this.ensureRootRegistered(entry);
    entry.treeKill = immediate ? "forced" : "graceful";
    try {
      if (immediate) killer.execute(true);
      else killer.execute(false, PLUGIN_PROCESS_KILL_GRACE_MS);
    } catch (error) {
      console.warn(
        `[PluginPty] tree kill of "${entry.id}" failed:`,
        formatErrorMessage(error, "tree kill failed")
      );
    }
  }

  /** Release the native handle exactly once per incarnation (#9544, #9551). */
  private releaseNative(entry: PluginPtyEntry): void {
    if (entry.nativeReleased) return;
    entry.nativeReleased = true;
    destroyPty(entry.pty);
  }
}

/** The kill-side surface of {@link ProcessTreeKiller} a plugin PTY uses. */
export type PluginPtyTreeKiller = Pick<
  ProcessTreeKiller,
  "execute" | "reapAfterRootExit" | "registerRoot"
>;

interface LingeringKill {
  mode: "escalate" | "reap";
  /** Past this the killer's own timer has run, and nothing is owed. */
  untilMs: number;
}

/** Builds one killer per plugin PTY incarnation, bound to the pty-host's cache and ledger. */
export type PluginPtyTreeKillerFactory = (target: ProcessTreeKillTarget) => PluginPtyTreeKiller;

interface PluginPtyEntry {
  id: string;
  generation: number;
  pty: pty.IPty;
  disposables: pty.IDisposable[];
  /** Set by `onExit` so a racing write/resize/kill sees a dead handle. */
  exited: boolean;
  /** Set by the teardown chokepoint so it runs exactly once per incarnation. */
  tornDown: boolean;
  /** Null when the host runs without tree teardown (unit tests). */
  killer: PluginPtyTreeKiller | null;
  /** Whether a real PID has been handed to the killer's ledger root. */
  rootRegistered: boolean;
  /** How far tree teardown has gone, so a repeat only ever escalates. */
  treeKill: "none" | "graceful" | "forced";
  /** Latch for {@link PluginPtyProcessManager.releaseNative}. */
  nativeReleased: boolean;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
