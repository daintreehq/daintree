import { createHash } from "node:crypto";
import { z } from "zod/mini";
import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { ProcessDetector, type DetectionResult } from "../ProcessDetector.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { ImagePathProbe } from "./ImagePathProbe.js";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { AgentStateService } from "./AgentStateService.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import {
  type ExitReason,
  type PtySpawnOptions,
  type TerminalInfo,
  type TerminalPublicState,
  type TerminalSnapshot,
  OUTPUT_BUFFER_SIZE,
  DEFAULT_SCROLLBACK,
} from "./types.js";
import { WriteQueue } from "./WriteQueue.js";
import { events } from "../events.js";
import { AgentSpawnedSchema } from "../../schemas/agent.js";
import { destroyPty, type PooledPtyDataHandoff, type PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { handleOscColorQueries } from "./OscResponder.js";
import { Osc94Parser } from "./Osc94Parser.js";
import { SynchronizedFrameDetector } from "./SynchronizedFrameDetector.js";

// Extracted modules
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  getSubmitEnterDelay,
  isBracketedPaste,
  isFocusReport,
  delay,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  OUTPUT_SETTLE_DEBOUNCE_MS,
  OUTPUT_SETTLE_MAX_WAIT_MS,
  OUTPUT_SETTLE_POLL_INTERVAL_MS,
} from "./terminalInput.js";
import type { IBufferCell, IMarker } from "@xterm/headless";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  isSessionPersistSuppressed,
  persistSessionSnapshotSync,
  restoreSessionFromFile,
} from "./terminalSessionPersistence.js";
import { SessionSnapshotter, type SessionSnapshotterHost } from "./SessionSnapshotter.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { ProcessTreeKiller } from "./ProcessTreeKiller.js";
import {
  IdentityWatcher,
  normalizeShellCommandText,
  type IdentityWatcherDelegate,
} from "./IdentityWatcher.js";
import type { SpawnContext } from "./terminalSpawn.js";
import { logIdentityDebug } from "./identityDebug.js";
import { computeDefaultTitle, getLiveAgentId } from "./terminalTitle.js";
import {
  serializeTerminal,
  serializeTerminalAsync,
  serializeForPersistence,
} from "./terminalSerialization.js";
import { ForegroundProcessGroupProbe } from "./ForegroundProcessGroupProbe.js";
import { TerminalExitObservers, type TerminalExitArgs } from "./TerminalExitObservers.js";
import { gracefulShutdown as runGracefulShutdown } from "./TerminalGracefulShutdown.js";
import { handleAgentDetection as runHandleAgentDetection } from "./TerminalAgentDetection.js";
import { TerminalProcessLifecycle } from "./TerminalProcessLifecycle.js";
import {
  createVisibleCellContentSnapshot,
  createVisibleContentSnapshot,
  measureVisibleContentDelta,
  type VisibleContentCell,
  type VisibleContentSnapshot,
} from "./SustainedChangeTracker.js";
import {
  AGENT_OUTPUT_ACTIVITY_LINE_COUNT,
  AgentActivityTemperature,
} from "./AgentActivityTemperature.js";

// Coalescing window for host→main agent:output forwarding. Pending output is
// flushed synchronously before any agent state transition (and on exit) so
// turn-outcome classification still sees the tail in order.
const AGENT_OUTPUT_FLUSH_INTERVAL_MS = 50;

type CursorBufferLine = {
  translateToString: (trimRight?: boolean) => string;
  getCell?: (index: number, cell?: IBufferCell) => IBufferCell | undefined;
};

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getNullCell?: () => IBufferCell;
  getLine: (index: number) => CursorBufferLine | undefined;
};

export interface TerminalProcessCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number, signal?: number) => void;
}

export interface TerminalProcessDependencies {
  agentStateService: AgentStateService;
  ptyPool: PtyPool | null;
  sabModeEnabled?: boolean;
  processTreeCache: ProcessTreeCache | null;
  imagePathProbe?: ImagePathProbe | null;
}

export class TerminalProcess {
  private activityMonitor: ActivityMonitor | null = null;
  // Streaming OSC 9;4 parser (#8701). Created once per TerminalProcess and
  // fed every PTY chunk upstream of `activityMonitor.onData()`. Callbacks
  // route to the current `activityMonitor` if one exists — the parser stays
  // inert before an activity monitor is attached (plain terminals pre-promotion)
  // and resumes seamlessly after promotion. Because the OSC 9;4 stripping in
  // `IdleSequenceFilter` still runs downstream, byte-volume detectors remain
  // unaffected; this is a read-only tap.
  private readonly osc94Parser: Osc94Parser = new Osc94Parser({
    onWorking: (now) => this.activityMonitor?.onOscProgressWorking(now),
    onIdle: (now) => this.activityMonitor?.onOscProgressIdle(now),
  });
  private processDetector: ProcessDetector | null = null;
  private headlineGenerator = new ActivityHeadlineGenerator();
  private lastDetectedProcessIconId: string | undefined;

  private lastWriteErrorLogTime = 0;
  private suppressedWriteErrorCount = 0;

  private semanticBufferManager!: SemanticBufferManager;
  private identityWatcher!: IdentityWatcher;

  private writeQueue!: WriteQueue;
  private readonly processTreeKiller: ProcessTreeKiller;
  private readonly lifecycle = new TerminalProcessLifecycle();

  private readonly foregroundProbe: ForegroundProcessGroupProbe;
  private exitObservers!: TerminalExitObservers;

  private _scrollback: number;
  private ptyDataDisposable: { dispose: () => void } | null = null;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private synchronizedFrameDetector: SynchronizedFrameDetector | null = null;
  private sessionSnapshotter!: SessionSnapshotter;
  private readonly agentOutputTemperature = new AgentActivityTemperature();
  private agentOutputContentSnapshot: VisibleContentSnapshot | undefined;

  private pendingAgentOutput = "";
  private pendingAgentOutputAgentId: string | null = null;
  private agentOutputFlushTimer: NodeJS.Timeout | null = null;

  private readonly terminalInfo: TerminalInfo;

  /**
   * True when an agent is currently observed in this PTY. Used to drive
   * chrome-level decisions (OSC color responder ownership, output fan-out to
   * agent:output listeners). Detection wins, and durable launch affinity keeps
   * cold-launched/restored agents wired until an explicit exit signal arrives.
   */
  private get isAgentLive(): boolean {
    const t = this.terminalInfo;
    if (t.detectedAgentId !== undefined) return true;
    if (t.agentState === "exited" || t.isExited) return false;
    return t.launchAgentId !== undefined;
  }

  // Live identity check for OSC 10/11 color-query responder ownership. Matches
  // isAgentLive so launch-affinity terminals own the responder before
  // process-tree polling has caught up and release it on explicit exit.
  private get shouldHandleOscColorQueries(): boolean {
    return this.isAgentLive;
  }
  private forensicsBuffer = new TerminalForensicsBuffer();
  private _activityTier: "active" | "background" = "active";
  private _restoreBannerStart: IMarker | null = null;
  private _restoreBannerEnd: IMarker | null = null;
  private readonly textDecoder = new TextDecoder();

  private restoreSessionIfPresent(headlessTerminal: HeadlessTerminalType): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    // Terminals launched to run an agent re-inject their command on restart
    // rather than replaying a serialized buffer — session replay would show
    // stale agent output from the previous run.
    if (this.terminalInfo.launchAgentId) return;
    if (this.options.restore === false) return;

    const result = restoreSessionFromFile(headlessTerminal, this.id);
    if (result.restored) {
      this._restoreBannerStart = result.bannerStartMarker;
      this._restoreBannerEnd = result.bannerEndMarker;
    }
  }

  flushEventDrivenSnapshot(): void {
    this.sessionSnapshotter.flushEventDriven();
  }

  private createSessionSnapshotter(): SessionSnapshotter {
    class Host implements SessionSnapshotterHost {
      constructor(private parent: TerminalProcess) {}

      get id(): string {
        return this.parent.id;
      }

      get wasKilled(): boolean {
        return this.parent.terminalInfo.wasKilled === true;
      }

      get launchAgentId(): string | undefined {
        return this.parent.terminalInfo.launchAgentId;
      }

      hasBannerMarkers(): boolean {
        return !!(this.parent._restoreBannerStart || this.parent._restoreBannerEnd);
      }

      getSerializedState(): string | null {
        return this.parent.getSerializedState();
      }

      getSerializedStateAsync(): Promise<string | null> {
        return this.parent.getSerializedStateAsync();
      }

      serializeForPersistence(): string | null {
        return this.parent.serializeForPersistence();
      }
    }

    return new SessionSnapshotter(new Host(this));
  }

  private logWriteError(error: unknown, context: { operation: string; traceId?: string }): void {
    const now = Date.now();
    const THROTTLE_MS = 5000;
    if (now - this.lastWriteErrorLogTime < THROTTLE_MS) {
      this.suppressedWriteErrorCount++;
      return;
    }

    const suppressed = this.suppressedWriteErrorCount;
    this.suppressedWriteErrorCount = 0;
    this.lastWriteErrorLogTime = now;

    console.error(
      `[TerminalProcess] PTY ${context.operation} failed for ${this.id}` +
        (context.traceId ? ` traceId=${context.traceId}` : ""),
      error
    );

    if (suppressed > 0) {
      console.error(
        `[TerminalProcess] Suppressed ${suppressed} additional PTY write errors for ${this.id} in the last ${THROTTLE_MS}ms`
      );
    }
  }

  private ensureHeadlessResponder(): void {
    this.ensureHeadlessTerminal();
    const terminal = this.terminalInfo;

    if (terminal.wasKilled) {
      return;
    }

    if (this.headlessResponderDisposable || !terminal.headlessTerminal) {
      return;
    }

    this.headlessResponderDisposable = installHeadlessResponder(
      terminal.headlessTerminal,
      (data) => {
        if (terminal.wasKilled) return;
        try {
          terminal.ptyProcess.write(data);
        } catch (error) {
          this.logWriteError(error, { operation: "write(headless-responder)" });
        }
      }
    );
  }

  constructor(
    public readonly id: string,
    private options: PtySpawnOptions,
    private callbacks: TerminalProcessCallbacks,
    private deps: TerminalProcessDependencies,
    spawnContext: SpawnContext,
    ptyProcess: pty.IPty,
    /**
     * Output the pooled shell printed before this constructor took ownership
     * of the PTY (prompt, banner, MOTD). Empty for fresh-spawn paths. Replayed
     * through the same data path live PTY output uses, BEFORE installing the
     * live `onData` handler — otherwise the live handler can interleave the
     * first user-typed chunk with the prelude. See PtyPool / acquirePtyProcess.
     */
    prelude: string = "",
    dataHandoff?: PooledPtyDataHandoff
  ) {
    const { shell, args: spawnArgs } = spawnContext;
    const spawnedAt = Date.now();

    // Launch hint: the agent this terminal was asked to run, if any. Not an
    // identity — never drives chrome or capability — see
    // `docs/architecture/terminal-identity.md`.
    const launchAgentId = options.launchAgentId;
    const hasLaunchHint = !!launchAgentId;

    // Every PTY now gets a generous scrollback. The previous "agent tier vs
    // plain tier" split was retired along with the tiered capability model.
    this._scrollback = DEFAULT_SCROLLBACK;

    const headlessTerminal: HeadlessTerminalType = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: this._scrollback,
      allowProposedApi: true,
    });
    // SynchronizedFrameAnalyzer reads cell.width from this buffer; without
    // Unicode 11 widths, emoji and CJK rows would mis-report column counts.
    headlessTerminal.loadAddon(new Unicode11Addon());
    headlessTerminal.unicode.activeVersion = "11";
    const serializeAddon: SerializeAddonType = new SerializeAddon();
    headlessTerminal.loadAddon(serializeAddon);

    // Structural-signal tier (#6668): hook the headless parser for DEC mode
    // 2026 brackets so frame snapshots can drive the analyzer. Lifetime ties
    // to the headless terminal — disposed alongside it in disposeHeadless().
    // The callback resolves activityMonitor lazily so frame events fire even
    // for plain terminals that are promoted to agents post-spawn.
    this.synchronizedFrameDetector = new SynchronizedFrameDetector(headlessTerminal, (snapshot) => {
      this.activityMonitor?.onSynchronizedFrame(snapshot);
    });

    this.terminalInfo = {
      id,
      projectId: options.projectId,
      ptyProcess,
      cwd: options.cwd,
      shell,
      kind: options.kind,
      title: options.title,
      titleMode: options.title ? "default" : "default",
      command: options.command,
      launchAgentId,
      spawnedAt,
      // If we launched an agent, seed its state as "idle" — the activity
      // monitor will update it as soon as the pty produces output. Plain
      // terminals have no agent state.
      agentState: hasLaunchHint ? "idle" : undefined,
      lastStateChange: hasLaunchHint ? spawnedAt : undefined,
      outputBuffer: "",
      lastInputTime: spawnedAt,
      lastOutputTime: spawnedAt,
      lastCheckTime: spawnedAt,
      contentEpoch: 0,
      semanticBuffer: [],
      headlessTerminal,
      serializeAddon,
      restartCount: 0,
      // Analysis is enabled whenever an agent is expected or live. Plain
      // terminals enable it on the fly when the process detector promotes.
      analysisEnabled: hasLaunchHint,
      agentLaunchFlags: options.agentLaunchFlags,
      agentModelId: options.agentModelId,
      worktreeId: options.worktreeId,
      agentPresetId: options.agentPresetId,
      agentPresetColor: options.agentPresetColor,
      originalAgentPresetId: options.originalAgentPresetId ?? options.agentPresetId,
      spawnArgs,
    };

    this.restoreSessionIfPresent(headlessTerminal);

    // NOTE: The headless responder is intentionally NOT installed for agent
    // terminals. It would forward query responses (CSI 6n cursor position,
    // CSI c device attributes) from the headless terminal back to the PTY.
    // But the frontend xterm.js ALSO responds to these same queries when it
    // processes the output, causing double responses that corrupt Crossterm/
    // Ratatui's input parser (Codex, OpenCode) and Ink's state (Claude Code).
    // The frontend xterm.js is the sole query responder for agent terminals.

    this.semanticBufferManager = new SemanticBufferManager(this.terminalInfo);
    this.processTreeKiller = new ProcessTreeKiller(ptyProcess, deps.processTreeCache);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.foregroundProbe = new ForegroundProcessGroupProbe({
      get ptyPid() {
        return ptyProcess.pid;
      },
      get disposed() {
        return self.lifecycle.isDisposed;
      },
    });
    this.writeQueue = new WriteQueue({
      writeToPty: (data) => {
        this.terminalInfo.ptyProcess.write(data);
      },
      isExited: () => !this.lifecycle.isAlive,
      lastOutputTime: () => this.terminalInfo.lastOutputTime,
      performSubmit: (text) => this.performSubmit(text),
      onWriteError: (error, context) => this.logWriteError(error, context),
    });
    this.sessionSnapshotter = this.createSessionSnapshotter();
    this.identityWatcher = new IdentityWatcher(this.createIdentityWatcherDelegate());
    this.exitObservers = new TerminalExitObservers({
      id: this.id,
      terminalInfo: this.terminalInfo,
      forensicsBuffer: this.forensicsBuffer,
      agentStateService: this.deps.agentStateService,
    });

    // Replay any output the pooled shell printed before we took ownership
    // (banner, MOTD, first prompt). Must run BEFORE setupPtyHandlers so the
    // prelude lands in the renderer xterm and the headless serialization
    // buffer in chronological order, ahead of any live PTY chunks. See
    // PtyPool.acquireByKey for why this is necessary.
    if (prelude.length > 0) {
      this.replayPrelude(prelude);
    }

    this.setupPtyHandlers(ptyProcess, dataHandoff);

    const ptyPid = ptyProcess.pid;
    if (ptyPid !== undefined && deps.processTreeCache) {
      this.processDetector = new ProcessDetector(
        id,
        spawnedAt,
        ptyPid,
        (result: DetectionResult, cbSpawnedAt: number) => {
          this.handleAgentDetection(result, cbSpawnedAt);
        },
        deps.processTreeCache,
        Boolean(this.terminalInfo.launchAgentId),
        deps.imagePathProbe ?? null
      );
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
    }
    this.identityWatcher.seed(options.command);

    // If we have a launch hint, start the activity monitor immediately so the
    // cold-launched agent has full observability from the first output. Plain
    // terminals start the monitor only when detection promotes them; see
    // `handleAgentDetection`.
    if (hasLaunchHint) {
      const processStateValidator = createProcessStateValidator(ptyPid, deps.processTreeCache);
      this.activityMonitor = new ActivityMonitor(
        id,
        spawnedAt,
        (_termId, cbSpawnedAt, state, metadata) => {
          if (this.terminalInfo.spawnedAt !== cbSpawnedAt) {
            console.warn(
              `[TerminalProcess] Rejected stale activity state from old monitor ${_termId} ` +
                `(session ${cbSpawnedAt} vs current ${this.terminalInfo.spawnedAt})`
            );
            return;
          }
          this.flushAgentOutput();
          deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
        },
        {
          ...buildActivityMonitorOptions(launchAgentId, {
            getVisibleLines: (n) => this.getVisibleActivityLines(n),
            getVisibleContentSnapshot: (n) => this.getVisibleActivitySnapshot(n),
            getCursorLine: () => this.getCursorLine(),
          }),
          processStateValidator,
          onWaitingTimeout: (_id, _spawnedAt) => {
            this.flushAgentOutput();
            deps.agentStateService.updateAgentState(
              this.terminalInfo,
              { type: "watchdog-timeout" },
              "timeout",
              0.6
            );
          },
          onBootComplete: (timestamp) => this.recordBootComplete(timestamp),
        }
      );
      this.activityMonitor.startPolling();
    }

    if (hasLaunchHint && launchAgentId) {
      const spawnedPayload = {
        agentId: launchAgentId,
        terminalId: id,
        timestamp: spawnedAt,
      };

      const validatedSpawned = AgentSpawnedSchema.safeParse(spawnedPayload);
      if (validatedSpawned.success) {
        events.emit("agent:spawned", validatedSpawned.data);
      } else {
        console.error(
          "[TerminalProcess] Invalid agent:spawned payload:",
          z.prettifyError(validatedSpawned.error)
        );
      }
    }
  }

  private ensureHeadlessTerminal(): void {
    const terminal = this.terminalInfo;

    if (terminal.wasKilled) {
      throw new Error("Terminal was killed");
    }

    if (terminal.headlessTerminal && terminal.serializeAddon) {
      return;
    }

    throw new Error("Headless terminal unavailable (unexpected)");
  }

  private disposeHeadless(): void {
    const terminal = this.terminalInfo;
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
    if (!terminal.headlessTerminal) {
      return;
    }
    if (this.headlessResponderDisposable) {
      try {
        this.headlessResponderDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.headlessResponderDisposable = null;
    }
    if (this.synchronizedFrameDetector) {
      try {
        this.synchronizedFrameDetector.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.synchronizedFrameDetector = null;
    }
    try {
      terminal.headlessTerminal.dispose();
    } catch {
      // Ignore disposal errors
    }
    terminal.headlessTerminal = undefined;
    terminal.serializeAddon = undefined;
  }

  /**
   * Preserved exited terminals don't need a live headless xterm — the buffer
   * is final. Serialize it once, cache the string on `terminalInfo`, and
   * dispose the headless instance (Unicode11 + SerializeAddon + scrollback
   * CircularList, ~15-30 MB per exited terminal). Serialization runs inside a
   * sentinel `write("")` callback so xterm's async parser queue is fully
   * drained first — the tail of the output must land in the buffer, and
   * disposing with queued writes throws against the torn-down core.
   *
   * On serialize failure the live headless instance is kept: serving the
   * existing buffer beats serving nothing, at the cost of the memory.
   */
  private snapshotAndDisposePreserved(): void {
    const terminal = this.terminalInfo;
    const headless = terminal.headlessTerminal;
    if (!headless || !terminal.serializeAddon) {
      return;
    }
    headless.write("", () => {
      if (terminal.headlessTerminal !== headless || !terminal.serializeAddon) {
        return;
      }
      let snapshot: string;
      try {
        snapshot = terminal.serializeAddon.serialize();
      } catch (error) {
        console.error(`[TerminalProcess] Failed to snapshot preserved terminal ${this.id}:`, error);
        return;
      }
      // sessionSnapshotter.dispose() already ran in the onExit handler,
      // cancelling any debounced write — flush the final state to disk
      // directly so crash recovery sees the post-exit buffer (#3177).
      // Banner-aware like flushSyncOnKill; same gates (agent sessions are
      // never replayed by crash recovery).
      if (
        TERMINAL_SESSION_PERSISTENCE_ENABLED &&
        !isSessionPersistSuppressed() &&
        !terminal.launchAgentId
      ) {
        try {
          persistSessionSnapshotSync(this.id, this.serializeForPersistence() ?? snapshot);
        } catch {
          // best-effort only
        }
      }
      terminal.preservedSnapshot = snapshot;
      // The buffer is final from here on: bump the epoch so the next wake
      // serves the preserved snapshot, and zero the parse counter (disposed
      // headless write callbacks never fire) so that serve can serve-mark.
      terminal.contentEpoch++;
      terminal.pendingHeadlessWrites = 0;
      this.disposeHeadless();
    });
  }

  /**
   * Mechanical resource cleanup shared by `kill()`, `dispose()`, and the
   * natural PTY `onExit` handler. Idempotent — the first caller transitions
   * `alive → shutting-down` and clears collaborators/timers; later callers
   * see the state mismatch and return `false`.
   *
   * Critical orderings (lessons #3177 and #3728):
   *
   * 1. The session snapshot flush in `kill()` runs *before* this method, so
   *    that path is preserved by the existing `kill()` ordering — `teardown`
   *    only blocks debounced persistence by clearing the timer here.
   * 2. Activity / process-tree monitors are stopped here so they don't poll
   *    a dying PTY (the recursive timer in ActivityMonitor already guards
   *    its own `disposed` flag, but stopping it here makes the contract
   *    explicit).
   * 3. The headless buffer is *not* torn down here. Callers that need to
   *    preserve it on exit (agent terminal, exit code 0) skip the
   *    `disposeHeadless()` call after teardown returns.
   */
  private teardown(reason: ExitReason): boolean {
    if (!this.lifecycle.transition({ kind: "shutting-down", reason })) {
      return false;
    }

    this.stopProcessDetector();
    this.stopActivityMonitor();
    this.identityWatcher.stop();
    this.semanticBufferManager.flush();
    this.flushAgentOutput();

    if (this.ptyDataDisposable) {
      try {
        this.ptyDataDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.ptyDataDisposable = null;
    }

    this.writeQueue.dispose();
    this.processTreeKiller.abort();

    // Release the master /dev/ptmx fd on Unix. Pooled terminals already do this
    // via destroyPty() on pool teardown; live terminals never called destroy(),
    // leaking the fd on every kill/exit/dispose (#9539). teardown() is reached
    // by all three paths and is idempotent (lifecycle.transition guards
    // re-entry), so destroyPty() fires exactly once per terminal.
    //
    // Windows is excluded (#9551): there is no ptmx fd to release, and node-pty's
    // WindowsTerminal.kill()/destroy() are *deferred* native kills that race the
    // taskkill-driven natural exit run by processTreeKiller above. Adding a
    // pty.kill() here can land on an already-freed pseudoconsole handle and
    // crash the pty-host with STATUS_HEAP_CORRUPTION (0xC0000374). Skipping it
    // restores the proven pre-#9539 Windows teardown, where processTreeKiller +
    // node-pty's own exit handling do all the cleanup. Test mocks expose no
    // `_agent`, so they still run destroyPty() and existing assertions hold.
    const ptyProcess = this.terminalInfo.ptyProcess;
    const isRealWindowsPty =
      process.platform === "win32" &&
      (ptyProcess as unknown as { _agent?: unknown })._agent !== undefined;
    if (!isRealWindowsPty) {
      destroyPty(ptyProcess);
    }

    return true;
  }

  /**
   * Emit `terminal:exited` exactly once per terminal lifetime. Delegates to
   * TerminalExitObservers, which dedupes via its own `hasEmitted` flag and
   * fans out forensics / `agent:completed` / fallback classification.
   * `recentOutput` must be captured before `disposeHeadless()` clears the
   * forensics buffer, since fallback classification scans the tail.
   */
  private emitTerminalExited(args: TerminalExitArgs): void {
    this.flushAgentOutput();
    this.exitObservers.emit(args);
  }

  /** @deprecated Use getPublicState() for IPC-safe data */
  getInfo(): TerminalInfo {
    return this.terminalInfo;
  }

  getPublicState(): TerminalPublicState {
    const t = this.terminalInfo;
    // Derive lifecycle flags from the state machine so disposed terminals
    // reflect `hasPty: false` even when `dispose()` ran without setting
    // the legacy `wasKilled`/`isExited` flags. The legacy flags remain
    // populated where the existing code paths set them (kill, preserve)
    // and we OR them in to keep behaviour identical for those paths.
    const state = this.lifecycle.getState();
    const exitedState = state.kind === "exited" || state.kind === "disposed";
    const killReason =
      (state.kind === "shutting-down" || state.kind === "exited" || state.kind === "disposed") &&
      (state.reason === "kill" ||
        state.reason === "graceful-shutdown" ||
        state.reason === "dispose");
    const wasKilled = t.wasKilled || killReason;
    const isExited = t.isExited || exitedState;
    const hasPty = !wasKilled && !isExited;
    return {
      id: t.id,
      projectId: t.projectId,
      cwd: t.cwd,
      shell: t.shell,
      kind: t.kind,
      launchAgentId: t.launchAgentId,
      title: t.title,
      titleMode: t.titleMode,
      command: t.command,
      spawnedAt: t.spawnedAt,
      firstByteAt: t.firstByteAt,
      bootCompleteAt: t.bootCompleteAt,
      wasKilled,
      isExited,
      agentState: t.agentState,
      waitingReason: t.waitingReason,
      lastStateChange: t.lastStateChange,
      traceId: t.traceId,
      analysisEnabled: t.analysisEnabled,
      lastInputTime: t.lastInputTime,
      lastOutputTime: t.lastOutputTime,
      lastCheckTime: t.lastCheckTime,
      detectedAgentId: t.detectedAgentId,
      detectedProcessIconId: t.detectedProcessIconId,
      everDetectedAgent: t.everDetectedAgent,
      restartCount: t.restartCount,
      activityTier: this._activityTier,
      hasPty,
      agentSessionId: t.agentSessionId,
      agentLaunchFlags: t.agentLaunchFlags,
      agentModelId: t.agentModelId,
      spawnArgs: t.spawnArgs,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
      worktreeId: t.worktreeId,
      lastObservedTitle: t.lastObservedTitle,
      agentPresetId: t.agentPresetId,
      agentPresetColor: t.agentPresetColor,
      originalAgentPresetId: t.originalAgentPresetId,
    };
  }

  /** True when this terminal was spawned with a launch hint (agent launch). */
  hasAgentLaunchHint(): boolean {
    return this.terminalInfo.launchAgentId !== undefined;
  }

  /** True when an agent is currently observed running in this PTY. */
  isAgentCurrentlyLive(): boolean {
    return this.isAgentLive;
  }

  getResizeStrategy(): "default" | "settled" {
    const agentId = getLiveAgentId(this.terminalInfo);
    if (!agentId) return "default";
    const config = getEffectiveAgentConfig(agentId);
    return config?.capabilities?.resizeStrategy ?? "default";
  }

  get analysisEnabled(): boolean {
    return this.terminalInfo.analysisEnabled;
  }

  setAnalysisEnabled(enabled: boolean): void {
    this.terminalInfo.analysisEnabled = enabled;
  }

  setObservedTitle(title: string): void {
    this.terminalInfo.lastObservedTitle = title;
  }

  acknowledgeData(_byteCount: number): void {
    // No-op: SAB-based backpressure in pty-host.ts handles all flow control
  }

  /**
   * Throwing variant of `write` for the small-keystroke fast path. Used by the
   * fleet broadcast loop in pty-host so a synchronous EPIPE/EIO/EBADF on one
   * target produces an actionable per-target failure result instead of being
   * swallowed by `logWriteError`. Returns `{ ok: true }` on success and
   * `{ ok: false, error: NodeJS.ErrnoException }` when `pty.write()` throws.
   *
   * Falls back to `write()` (queued chunking) for payloads >512 bytes; the
   * caller cannot meaningfully observe failures in the chunked async path,
   * but broadcast keystrokes are always single chunks so this is fine.
   */
  tryWrite(data: string, traceId?: string): { ok: boolean; error?: NodeJS.ErrnoException } {
    const terminal = this.terminalInfo;
    if (terminal.isExited) {
      return {
        ok: false,
        error: Object.assign(new Error("terminal exited"), { code: "EBADF" }),
      };
    }
    if (!terminal.ptyProcess) {
      return {
        ok: false,
        error: Object.assign(new Error("terminal has no pty process"), { code: "EBADF" }),
      };
    }

    if (data.length > 512) {
      // Long payloads queue through chunkInput in write(); we lose precise
      // per-call failure visibility but that path isn't used by broadcast.
      this.write(data, traceId);
      return { ok: true };
    }

    terminal.lastInputTime = Date.now();
    if (traceId !== undefined) {
      terminal.traceId = traceId || undefined;
    }
    if (this.activityMonitor) {
      if (isFocusReport(data)) {
        this.handleFocusInput();
      } else {
        this.activityMonitor.onInput(data);
      }
    }

    try {
      terminal.ptyProcess.write(data);
      return { ok: true };
    } catch (error) {
      this.logWriteError(error, { operation: "tryWrite", traceId });
      return { ok: false, error: error as NodeJS.ErrnoException };
    }
  }

  write(data: string, traceId?: string): void {
    const terminal = this.terminalInfo;
    terminal.lastInputTime = Date.now();

    if (terminal.isExited) {
      return;
    }

    if (!terminal.ptyProcess) {
      return;
    }

    if (traceId !== undefined) {
      terminal.traceId = traceId || undefined;
    }

    if (this.activityMonitor) {
      if (isFocusReport(data)) {
        this.handleFocusInput();
      } else {
        this.activityMonitor.onInput(data);
      }
    }

    const bracketedPaste = isBracketedPaste(data);
    const seededCommandText = this.identityWatcher.seededCommandText;
    const isSeededLaunchCommandSubmit =
      !bracketedPaste &&
      seededCommandText !== undefined &&
      /[\r\n]/.test(data) &&
      normalizeShellCommandText(data) === seededCommandText;
    // Shell input capture is only meaningless when a live AGENT owns the PTY
    // (agents have their own input semantics). A plain process badge (npm,
    // pnpm, docker, etc.) does not change the shell semantics — the shell
    // is still the direct recipient of typed commands, and the next command
    // must still be visible to the fallback detector so a follow-up
    // `pnpm build` can re-identify the badge. #5813
    const canCaptureShellInput =
      !bracketedPaste &&
      (this.terminalInfo.detectedAgentId === undefined || isSeededLaunchCommandSubmit);
    const submittedCommandText = canCaptureShellInput
      ? this.identityWatcher.captureInput(data)
      : undefined;
    const pendingFallbackIdentity = this.identityWatcher.pendingFallbackIdentity;
    const isAgentUiPromptResponse =
      !bracketedPaste &&
      submittedCommandText === undefined &&
      pendingFallbackIdentity?.agentType !== undefined &&
      (!this.identityWatcher.isFallbackCommitted ||
        this.identityWatcher.hasAgentUiPromptFalsePositive());

    if (!bracketedPaste && /[\r\n]/.test(data)) {
      if (this.identityWatcher.consumeSuppressSignal()) {
        // Suppression consumed — performSubmit() armed it for its body+enter sequence.
      } else if (isAgentUiPromptResponse) {
        logIdentityDebug(
          `[IdentityDebug] shell-submit-skip term=${this.id.slice(-8)} reason=agent-ui-prompt`
        );
      } else {
        this.identityWatcher.onShellSubmit(submittedCommandText, {
          allowWhenAgentDetected: isSeededLaunchCommandSubmit,
        });
      }
      if (isSeededLaunchCommandSubmit) {
        this.identityWatcher.clearSeededCommandText();
      }
    }

    if (bracketedPaste) {
      try {
        terminal.ptyProcess.write(data);
      } catch (error) {
        this.logWriteError(error, { operation: "write(bracketed-paste)", traceId });
      }
      return;
    }

    if (data.length <= 512) {
      try {
        terminal.ptyProcess.write(data);
      } catch (error) {
        this.logWriteError(error, { operation: "write(fast-path)", traceId });
      }
      return;
    }

    this.writeQueue.enqueueChunked(data);
  }

  submit(text: string): void {
    if (this.terminalInfo.isExited) {
      return;
    }

    // Immediately notify activity monitor of the submission so the working
    // state transitions before the async write sequence in performSubmit().
    // Without this, the split between body write and Enter write causes the
    // character-by-character detection in onInput() to miss the submission.
    if (this.activityMonitor && text.trim().length > 0) {
      this.activityMonitor.notifySubmission();
    }

    this.writeQueue.submit(text);
  }

  /**
   * Stage `text` into the terminal's input WITHOUT submitting it — the no-Enter
   * counterpart to {@link submit}. Reuses the same bracketed-paste / soft-newline
   * encoding `performSubmit` uses for the body, then stops: no Enter is written
   * and no output-settle bookkeeping runs. Multi-line text is always wrapped
   * (bracketed paste when supported, soft newlines otherwise) so a stray `\n`
   * can't trigger the shell-submit detection in {@link write} and auto-execute a
   * line. Trailing newlines in `text` are dropped — staging never submits. Used
   * by `host.sendToActiveAgent(text, { submit: false })` (#10558).
   */
  stage(text: string): void {
    const terminal = this.terminalInfo;
    if (terminal.isExited || !terminal.ptyProcess) {
      return;
    }
    const normalized = normalizeSubmitText(text);
    const { body } = splitTrailingNewlines(normalized);
    if (body.length === 0) {
      return;
    }
    terminal.lastInputTime = Date.now();
    const useBracketedPaste = body.includes("\n") || body.length > PASTE_THRESHOLD_CHARS;
    if (useBracketedPaste && supportsBracketedPaste(terminal)) {
      const pasteBody = body.replace(/\n/g, "\r");
      this.write(`${BRACKETED_PASTE_START}${pasteBody}${BRACKETED_PASTE_END}`);
    } else if (body.includes("\n")) {
      this.write(body.replace(/\n/g, getSoftNewlineSequence(terminal)));
    } else {
      this.write(body);
    }
  }

  private async performSubmit(text: string): Promise<void> {
    const terminal = this.terminalInfo;
    terminal.lastInputTime = Date.now();

    if (terminal.isExited) {
      return;
    }

    if (!terminal.ptyProcess) {
      return;
    }

    // Notify activity monitor at execution time (not just enqueue time) to ensure
    // the working state transition happens even for queued submissions that execute
    // after a potential idle transition. Issue #2185.
    if (this.activityMonitor && text.trim().length > 0) {
      this.activityMonitor.notifySubmission();
    }

    const normalized = normalizeSubmitText(text);
    const { body, enterCount } = splitTrailingNewlines(normalized);
    const enterSuffix = "\r".repeat(enterCount);

    if (body.length === 0) {
      this.identityWatcher.armSuppressSignal();
      this.write(enterSuffix);
      return;
    }

    const useBracketedPaste = body.includes("\n") || body.length > PASTE_THRESHOLD_CHARS;
    const useOutputSettle = !supportsBracketedPaste(terminal);

    if (useBracketedPaste && supportsBracketedPaste(terminal)) {
      const pasteBody = body.replace(/\n/g, "\r");
      const payload = `${BRACKETED_PASTE_START}${pasteBody}${BRACKETED_PASTE_END}`;
      this.write(payload);
    } else {
      if (body.includes("\n") && !supportsBracketedPaste(terminal)) {
        const softNewline = getSoftNewlineSequence(terminal);
        this.write(body.replace(/\n/g, softNewline));
      } else {
        this.write(body);
      }
    }

    await this.writeQueue.waitForInputWriteDrain();

    if (useOutputSettle) {
      await this.writeQueue.waitForOutputSettle({
        debounceMs: OUTPUT_SETTLE_DEBOUNCE_MS,
        maxWaitMs: OUTPUT_SETTLE_MAX_WAIT_MS,
        pollMs: OUTPUT_SETTLE_POLL_INTERVAL_MS,
      });
    } else {
      await delay(getSubmitEnterDelay(terminal));
    }

    if (!this.terminalInfo.ptyProcess) {
      return;
    }

    this.identityWatcher.armSuppressSignal();
    this.identityWatcher.onShellSubmit(body);
    this.write(enterSuffix);
  }

  resize(cols: number, rows: number): void {
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols <= 0 ||
      rows <= 0 ||
      cols !== Math.floor(cols) ||
      rows !== Math.floor(rows)
    ) {
      console.warn(`Invalid terminal dimensions for ${this.id}: ${cols}x${rows}`);
      return;
    }

    const terminal = this.terminalInfo;
    if (terminal.isExited) {
      try {
        if (terminal.headlessTerminal) {
          terminal.headlessTerminal.resize(cols, rows);
          // Reflow rewraps the buffer — invalidate any wake no-change skip.
          terminal.contentEpoch++;
        }
      } catch (error) {
        console.error(`Failed to resize terminal ${this.id}:`, error);
      }
      return;
    }
    try {
      const currentCols = terminal.ptyProcess.cols;
      const currentRows = terminal.ptyProcess.rows;

      if (currentCols === cols && currentRows === rows) {
        return;
      }

      terminal.ptyProcess.resize(cols, rows);

      if (terminal.headlessTerminal) {
        terminal.headlessTerminal.resize(cols, rows);
        // Reflow rewraps the buffer — invalidate any wake no-change skip.
        terminal.contentEpoch++;
      }

      // Notify activity monitor so reflow bytes are suppressed. Issue #2364.
      if (this.activityMonitor) {
        this.activityMonitor.notifyResize();
      }
      this.agentOutputTemperature.noteResize(Date.now());
      this.agentOutputContentSnapshot = undefined;
    } catch (error) {
      console.error(`Failed to resize terminal ${this.id}:`, error);
    }
  }

  gracefulShutdown(): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return runGracefulShutdown({
      terminalInfo: this.terminalInfo,
      get isAgentLive() {
        return self.isAgentLive;
      },
      kill: (reason) => this.kill(reason),
    });
  }

  kill(reason?: string, escalationDelayMs?: number): void {
    const terminal = this.terminalInfo;
    const exitReason: ExitReason = reason === "graceful-shutdown" ? "graceful-shutdown" : "kill";

    // Flush session snapshot synchronously BEFORE teardown.
    // Once teardown disposes the writeQueue and processTreeKiller.abort() fires,
    // debounced writes are lost — so this is the last chance.
    // See lesson #3177.
    this.sessionSnapshotter.flushSyncOnKill();

    if (!this.teardown(exitReason)) {
      return;
    }

    terminal.wasKilled = true;
    this.sessionSnapshotter.dispose();

    if (getLiveAgentId(terminal)) {
      this.deps.agentStateService.updateAgentState(terminal, {
        type: "kill",
      });
      this.deps.agentStateService.emitAgentKilled(terminal, reason);
    }

    // Tear down the headless terminal model (xterm instance, synchronized
    // frame detector, headless responder). The forensic buffer lives on
    // `this.forensicsBuffer` and is *not* touched by disposeHeadless(); the
    // natural onExit handler (or dispose() if onExit never fires) reads
    // `forensicsBuffer.getRecentOutput()` and emits `terminal:exited` with
    // `reason: "kill"` carried through the lifecycle state machine.
    this.disposeHeadless();

    this.processTreeKiller.execute(false, escalationDelayMs);
  }

  checkFlooding(): { flooded: boolean; resumed: boolean } {
    return { flooded: false, resumed: false };
  }

  getSnapshot(): TerminalSnapshot {
    const terminal = this.terminalInfo;
    return {
      id: terminal.id,
      lines: [...terminal.semanticBuffer],
      lastInputTime: terminal.lastInputTime,
      lastOutputTime: terminal.lastOutputTime,
      lastCheckTime: terminal.lastCheckTime,
      launchAgentId: terminal.launchAgentId,
      agentState: terminal.agentState,
      lastStateChange: terminal.lastStateChange,
      spawnedAt: terminal.spawnedAt,
    };
  }

  getLastNLines(n: number): string[] {
    const terminal = this.terminalInfo.headlessTerminal;
    if (!terminal) return [];

    const buffer = terminal.buffer.active;
    if (!buffer) return [];

    const viewportBottom = buffer.baseY + terminal.rows;
    const start = Math.max(buffer.baseY, viewportBottom - n);

    const lines: string[] = [];
    for (let i = start; i < viewportBottom; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines;
  }

  getVisibleActivityLines(n: number): string[] {
    const terminal = this.terminalInfo.headlessTerminal;
    if (!terminal) return [];

    const buffer = terminal.buffer.active as CursorBuffer;
    if (!buffer || typeof buffer.getLine !== "function") return [];

    const viewportTop = buffer.baseY;
    const viewportBottom = buffer.baseY + terminal.rows;
    const end = viewportBottom;
    const start = Math.max(viewportTop, end - n);

    const lines: string[] = [];
    for (let i = start; i < end; i += 1) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines;
  }

  getVisibleActivitySnapshot(n: number): VisibleContentSnapshot | undefined {
    const cells = this.getVisibleActivityCells();
    return cells
      ? createVisibleCellContentSnapshot(cells)
      : createVisibleContentSnapshot(this.getVisibleActivityLines(n));
  }

  private getVisibleActivityCells(): VisibleContentCell[][] | undefined {
    const terminal = this.terminalInfo.headlessTerminal;
    if (!terminal) return undefined;

    const buffer = terminal.buffer.active as CursorBuffer;
    if (
      !buffer ||
      typeof buffer.getLine !== "function" ||
      typeof buffer.getNullCell !== "function"
    ) {
      return undefined;
    }

    const viewportTop = buffer.baseY;
    const viewportBottom = buffer.baseY + terminal.rows;
    const end = viewportBottom;
    // Scan the FULL visible viewport. A cursor-anchored bottom-n window (the
    // v0.19.0 regression) misses spinner/status activity that TUI agents
    // (Claude/Gemini/Codex) stream ABOVE a pinned bottom input box: with the
    // cursor parked low, the window collapsed to the bottom rows and the
    // changing rows above produced changedChars=0, so the temperature decayed
    // and a busy agent flipped to "waiting" during low-output thinking (and
    // waiting→working recovery was starved). Blank cells are skipped below, so
    // scanning the whole viewport costs reads but not allocations. The line
    // budget only constrains the line-based fallback in getVisibleActivitySnapshot.
    const start = viewportTop;
    const reusableCell = buffer.getNullCell();

    const rows: VisibleContentCell[][] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      if (!line || typeof line.getCell !== "function") {
        continue;
      }

      const row: VisibleContentCell[] = [];
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x, reusableCell);
        if (!cell) continue;
        // Same predicate as visibleCellUnit (SustainedChangeTracker): blank
        // cells never contribute a unit, so skip before allocating — most of
        // an idle viewport is whitespace.
        const width = cell.getWidth();
        if (width === 0) continue;
        const chars = cell.getChars();
        if (chars.length === 0 || /^\s*$/u.test(chars)) continue;
        row.push(this.createVisibleContentCell(cell, chars, width));
      }
      rows.push(row);
    }

    return rows;
  }

  private createVisibleContentCell(
    cell: IBufferCell,
    chars: string,
    width: number
  ): VisibleContentCell {
    const attributes =
      (cell.isBold() ? 1 : 0) |
      (cell.isItalic() ? 1 << 1 : 0) |
      (cell.isDim() ? 1 << 2 : 0) |
      (cell.isUnderline() ? 1 << 3 : 0) |
      (cell.isBlink() ? 1 << 4 : 0) |
      (cell.isInverse() ? 1 << 5 : 0) |
      (cell.isInvisible() ? 1 << 6 : 0) |
      (cell.isStrikethrough() ? 1 << 7 : 0) |
      (cell.isOverline() ? 1 << 8 : 0);

    return {
      chars,
      code: cell.getCode(),
      width,
      fgColorMode: cell.getFgColorMode(),
      fgColor: cell.getFgColor(),
      attributes,
    };
  }

  getCursorLine(): string | null {
    const terminal = this.terminalInfo.headlessTerminal;
    if (!terminal) return null;

    const buffer = terminal.buffer.active as CursorBuffer;
    if (!buffer || typeof buffer.getLine !== "function") return null;
    const cursorY = buffer.cursorY ?? 0;
    const line = buffer.getLine(buffer.baseY + cursorY);
    return line ? line.translateToString(true) : null;
  }

  private createIdentityWatcherDelegate(): IdentityWatcherDelegate {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tp = this;
    return {
      get terminalId() {
        return tp.id;
      },
      get isExited() {
        return tp.terminalInfo.isExited ?? false;
      },
      get wasKilled() {
        return tp.terminalInfo.wasKilled ?? false;
      },
      get detectedAgentId() {
        return tp.terminalInfo.detectedAgentId;
      },
      get lastOutputTime() {
        return tp.terminalInfo.lastOutputTime;
      },
      get spawnedAt() {
        return tp.terminalInfo.spawnedAt;
      },
      get lastDetectedProcessIconId() {
        return tp.lastDetectedProcessIconId;
      },
      get processDetector() {
        return tp.processDetector;
      },
      getLastNLines: (n) => tp.getLastNLines(n),
      getCursorLine: () => tp.getCursorLine(),
      getLastCommand: () => tp.semanticBufferManager.getLastCommand(),
      getPtyDescendantCount: () => tp.getPtyDescendantCount(),
      readForegroundProcessGroupSnapshot: () => tp.readForegroundProcessGroupSnapshot(),
      handleAgentDetection: (result, cbSpawnedAt) => tp.handleAgentDetection(result, cbSpawnedAt),
    };
  }

  private getPtyDescendantCount(): number | undefined {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (ptyPid === undefined || !this.deps.processTreeCache) {
      return undefined;
    }
    return this.deps.processTreeCache.getDescendantPids(ptyPid).length;
  }

  // Thin wrapper around ForegroundProcessGroupProbe.readSnapshot(). Kept as
  // a method on TerminalProcess so test suites that override the foreground
  // snapshot via instance-method replacement (`agentDetection.test.ts`) keep
  // working without rewiring the probe.
  private readForegroundProcessGroupSnapshot(): {
    shellPgid: number;
    foregroundPgid: number;
  } | null {
    return this.foregroundProbe.readSnapshot();
  }

  getSerializedState(): string | null {
    return serializeTerminal(this.id, this.terminalInfo);
  }

  getSerializedStateAsync(): Promise<string | null> {
    return serializeTerminalAsync(this.id, this.terminalInfo);
  }

  serializeForPersistence(): string | null {
    return serializeForPersistence(
      this.terminalInfo,
      this._restoreBannerStart,
      this._restoreBannerEnd
    );
  }

  markChecked(): void {
    this.terminalInfo.lastCheckTime = Date.now();
  }

  replayHistory(maxLines: number = 100): number {
    const terminal = this.terminalInfo;
    const bufferSize = terminal.semanticBuffer.length;
    const linesToReplay = Math.min(maxLines, bufferSize);

    if (linesToReplay === 0) {
      return 0;
    }

    const recentLines = terminal.semanticBuffer.slice(-linesToReplay);
    const historyChunk = recentLines.join("\n") + "\n";
    this.callbacks.emitData(this.id, historyChunk);

    return linesToReplay;
  }

  shouldPreserveOnExit(exitCode: number): boolean {
    // Preserve the panel if it ever hosted an agent (either launched with a
    // hint or runtime-promoted). Plain terminals exit-and-trash; terminals
    // that had an agent at some point stay around so the user can inspect
    // the final output before cleaning up.
    if (!this.terminalInfo.launchAgentId && !this.terminalInfo.everDetectedAgent) {
      return false;
    }
    if (this.terminalInfo.wasKilled) {
      return false;
    }
    return exitCode === 0;
  }

  getPtyProcess(): pty.IPty {
    return this.terminalInfo.ptyProcess;
  }

  startProcessDetector(): void {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (ptyPid !== undefined && !this.processDetector && this.deps.processTreeCache) {
      this.processDetector = new ProcessDetector(
        this.id,
        this.terminalInfo.spawnedAt,
        ptyPid,
        (result, cbSpawnedAt) => {
          this.handleAgentDetection(result, cbSpawnedAt);
        },
        this.deps.processTreeCache,
        Boolean(this.terminalInfo.launchAgentId),
        this.deps.imagePathProbe ?? null
      );
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
    }
  }

  stopProcessDetector(): void {
    if (this.processDetector) {
      this.processDetector.stop();
      this.processDetector = null;
      this.terminalInfo.processDetector = undefined;
    }
  }

  startActivityMonitor(options?: { preserveState?: boolean }): void {
    if (!this.activityMonitor) {
      const ptyPid = this.terminalInfo.ptyProcess.pid;
      const processStateValidator = createProcessStateValidator(ptyPid, this.deps.processTreeCache);

      const preserveState = options?.preserveState ?? false;
      const currentAgentState = this.terminalInfo.agentState;
      const initialState = preserveState && currentAgentState === "working" ? "busy" : "idle";

      this.activityMonitor = new ActivityMonitor(
        this.id,
        this.terminalInfo.spawnedAt,
        (_termId, cbSpawnedAt, state, metadata) => {
          if (this.terminalInfo.spawnedAt !== cbSpawnedAt) {
            console.warn(
              `[TerminalProcess] Rejected stale activity state from old monitor ${_termId} ` +
                `(session ${cbSpawnedAt} vs current ${this.terminalInfo.spawnedAt})`
            );
            return;
          }
          this.flushAgentOutput();
          this.deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
        },
        {
          ...buildActivityMonitorOptions(getLiveAgentId(this.terminalInfo), {
            getVisibleLines: (n) => this.getVisibleActivityLines(n),
            getVisibleContentSnapshot: (n) => this.getVisibleActivitySnapshot(n),
            getCursorLine: () => this.getCursorLine(),
          }),
          processStateValidator,
          initialState,
          skipInitialStateEmit: preserveState,
          onWaitingTimeout: (_id, _spawnedAt) => {
            this.flushAgentOutput();
            this.deps.agentStateService.updateAgentState(
              this.terminalInfo,
              { type: "watchdog-timeout" },
              "timeout",
              0.6
            );
          },
          onBootComplete: (timestamp) => this.recordBootComplete(timestamp),
        }
      );
      this.activityMonitor.startPolling();
    }
  }

  stopActivityMonitor(): void {
    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }
    // Clear any in-flight OSC 9;4 fragment so a sequence split across the
    // teardown boundary can't trigger a callback against a stale monitor.
    this.osc94Parser.reset();
  }

  setActivityMonitorTier(tier: "active" | "background", pollingIntervalMs: number): void {
    // The tier is authoritative; the polling interval is only a cadence hint
    // (issue #8596 — VISIBLE-unfocused panes are "active" at 200ms).
    this._activityTier = tier;

    if (this.activityMonitor) {
      this.activityMonitor.setPollingInterval(pollingIntervalMs);
    }
  }

  getActivityTier(): "active" | "background" {
    return this._activityTier;
  }

  setSabModeEnabled(_enabled: boolean): void {
    // No-op: SAB mode is always used, flow control handled by pty-host.ts
  }

  // xterm 6.0 actively resizes the buffer when scrollback shrinks (verified in headless-scrollback-trim.test.ts).
  trimScrollback(targetLines: number): void {
    if (this._scrollback <= targetLines) return;
    if (!this.terminalInfo.headlessTerminal) return;
    this._scrollback = targetLines;
    this.terminalInfo.headlessTerminal.options.scrollback = targetLines;
  }

  growScrollback(targetLines: number): void {
    if (this._scrollback >= targetLines) return;
    if (!this.terminalInfo.headlessTerminal) return;
    this._scrollback = targetLines;
    this.terminalInfo.headlessTerminal.options.scrollback = targetLines;
  }

  /**
   * Current scrollback cap (in lines). Mirrors `headlessTerminal.options.scrollback`
   * but reads the field directly so the resource governor can rank per-terminal
   * buffer-memory contribution without touching the headless instance. Used as the
   * line-count input to the `scrollbackLines × cols × 12` byte estimate.
   */
  getCurrentScrollback(): number {
    return this._scrollback;
  }

  dispose(): void {
    const recentOutput = this.forensicsBuffer.getRecentOutput();
    this.identityWatcher.dispose();

    // Best-effort flush before teardown disposes the writeQueue and tears down
    // the buffer. Only attempted on the alive→dispose path — if we already
    // passed through kill / natural exit, persistence has already been handled.
    this.sessionSnapshotter.flushSyncOnDispose();
    this.sessionSnapshotter.dispose();

    this.teardown("dispose");
    this.semanticBufferManager.dispose();
    this.disposeHeadless();
    this.processTreeKiller.execute(true);

    // If the PTY never fired onExit (LRU eviction, app shutdown, or kill()
    // followed by dispose() before the kernel reaped the child), this is
    // the last chance to notify subscribers. The exit-observers dedupe flag
    // makes a late natural-exit emit a no-op if onExit fires after dispose.
    if (!this.exitObservers.hasEmitted) {
      this.emitTerminalExited({
        code: null,
        reason: this.lifecycle.getExitReason() ?? "dispose",
        recentOutput,
      });
    }

    this.lifecycle.setDisposed(this.lifecycle.getExitReason() ?? "dispose");

    this.exitObservers.dispose();
  }

  private getAgentOutputContentSnapshot(): VisibleContentSnapshot | undefined {
    if (!this.terminalInfo.headlessTerminal) {
      return undefined;
    }
    return this.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
  }

  private noteAgentOutputActivity(beforeSnapshot: VisibleContentSnapshot | undefined): void {
    if (!this.isAgentLive) {
      this.agentOutputTemperature.reset();
      this.agentOutputContentSnapshot = undefined;
      return;
    }

    const state = this.terminalInfo.agentState;
    if (state !== "waiting" && state !== "idle" && state !== "completed") {
      return;
    }

    const afterSnapshot = this.getAgentOutputContentSnapshot();
    if (afterSnapshot === undefined) {
      return;
    }

    const delta = measureVisibleContentDelta(
      beforeSnapshot ?? this.agentOutputContentSnapshot,
      afterSnapshot
    );
    const hadFallbackBaseline = this.agentOutputContentSnapshot !== undefined;
    this.agentOutputContentSnapshot = afterSnapshot;
    if (!hadFallbackBaseline) {
      this.agentOutputTemperature.observeDelta(Date.now(), { changedChars: 0 });
      return;
    }

    const result = this.agentOutputTemperature.observeDelta(Date.now(), {
      changedChars: delta.changedChars,
    });
    // ActivityMonitor.notifyFocus suppresses its own idle→busy paths, but this
    // direct call into agentStateService is a parallel promotion path; gate it
    // on the same window so a focus-triggered TUI repaint can't flip an idle
    // agent to busy (#8865).
    if (this.activityMonitor?.isFocusSuppressed()) {
      return;
    }
    if (result.stateHint === "busy" && this.terminalInfo.agentState === state) {
      this.flushAgentOutput();
      this.deps.agentStateService.handleActivityState(this.terminalInfo, "busy", {
        trigger: "output",
      });
      // Arm the monitor's private busy state so its idle paths can transition
      // the FSM back to waiting — without this the direct promotion above
      // strands the FSM in working (#9875).
      this.activityMonitor?.notifyExternalPromotion();
    }
  }

  // Side-effects shared by both PTY write paths when xterm forwards a CSI I/O
  // focus report. Mirrors the resize handler's pattern (notifyResize +
  // agentOutputTemperature.noteResize): open the ActivityMonitor suppression
  // window AND invalidate the agentOutputTemperature baseline so the redraw
  // that follows the focus event is treated as a fresh comparison point.
  private handleFocusInput(): void {
    this.activityMonitor?.notifyFocus();
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
  }

  /**
   * Wired into `ActivityMonitor` via `onBootComplete`. Captures
   * `bootCompleteAt` on the terminal once per boot cycle and emits a
   * structured `[AgentStartup]` JSON log entry keyed on `(agentId,
   * cwdHash)` so traces from independent launches can be compared. Does
   * nothing for plain (non-agent) terminals.
   */
  private recordBootComplete(timestamp: number): void {
    const terminal = this.terminalInfo;
    // Idempotent: only the first call captures bootCompleteAt and emits the
    // log. The `ActivityMonitor.fireBootComplete` one-shot guard normally
    // already prevents re-entry, but this defends against accidental direct
    // calls and restart paths that re-arm the upstream guard.
    if (terminal.bootCompleteAt !== undefined) return;
    terminal.bootCompleteAt = timestamp;

    const agentId = terminal.launchAgentId;
    if (!agentId) return;

    const spawnedAt = terminal.spawnedAt;
    const firstByteAt = terminal.firstByteAt;
    const cwdHash = createHash("md5").update(terminal.cwd).digest("hex").slice(0, 8);

    const entry: Record<string, unknown> = {
      agentId,
      cwdHash,
      terminalId: terminal.id,
      spawnedAt,
      bootCompleteAt: timestamp,
      bootDurationMs: timestamp - spawnedAt,
    };
    if (firstByteAt !== undefined) {
      entry.firstByteAt = firstByteAt;
      entry.timeToFirstByteMs = firstByteAt - spawnedAt;
    }

    console.log(`[AgentStartup] ${JSON.stringify(entry)}`);
  }

  /**
   * Replay output that a pooled shell emitted before this TerminalProcess
   * owned the PTY. The pool's prelude buffer captures the prompt/banner/MOTD
   * that would otherwise be lost — without this, fast Macs that hit a warm
   * pool slot would attach an xterm to a shell that has already finished
   * printing, leaving the pane visually blank until the user types.
   *
   * Mirrors the data sinks of the live `onData` handler in `setupPtyHandlers`
   * (firstByteAt, lastOutputTime, headless write, renderer emit, forensics,
   * semantic buffer, snapshotter). Skips agent-only state (activityMonitor,
   * agent:output, outputBuffer) — by the time an agent CLI is launched into
   * the PTY the prelude is overwritten on screen anyway, and feeding shell-
   * prompt bytes into agent state machines would mis-classify the session.
   */
  private replayPrelude(prelude: string): void {
    const terminal = this.terminalInfo;
    const now = Date.now();
    if (terminal.firstByteAt === undefined) {
      terminal.firstByteAt = now;
    }
    terminal.lastOutputTime = now;

    if (terminal.headlessTerminal) {
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      terminal.headlessTerminal.write(prelude, () => {
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
      });
    }
    this.sessionSnapshotter.schedule();
    this.emitData(prelude);
    this.forensicsBuffer.capture(prelude);
    this.semanticBufferManager.onData(prelude);
  }

  private handlePtyData(ptyProcess: pty.IPty, data: string): void {
    const terminal = this.terminalInfo;
    if (terminal.ptyProcess !== ptyProcess) {
      return;
    }

    const now = Date.now();
    // One-shot startup metric: wall-clock time of the first PTY data byte.
    // Surfaces in `getPublicState()` and the `[AgentStartup]` structured log.
    if (terminal.firstByteAt === undefined) {
      terminal.firstByteAt = now;
    }
    terminal.lastOutputTime = now;
    // noteAgentOutputActivity only acts on waiting/idle/completed — skip the
    // full-viewport extraction in other states (it would be computed and
    // discarded on every chunk during "working", the heaviest output phase).
    // If the state flips before the async write callback, the
    // `beforeSnapshot ?? this.agentOutputContentSnapshot` fallback covers it.
    const agentState = terminal.agentState;
    const beforeContentSnapshot =
      this.isAgentLive &&
      (agentState === "waiting" || agentState === "idle" || agentState === "completed")
        ? this.getAgentOutputContentSnapshot()
        : undefined;

    // Tap OSC 9;4 progress sequences upstream of the rest of the pipeline so
    // the agent-state signal is viewport-independent (#8701). The parser is
    // a read-only side channel; `IdleSequenceFilter.stripIdleTerminalSequences`
    // still removes the sequence from the ActivityMonitor byte-volume /
    // activity-gate path, so those detectors stay clean (the renderer keeps
    // the raw bytes — see TerminalProcess.osc.test.ts).
    this.osc94Parser.feed(data, now);

    if (this.activityMonitor) {
      this.activityMonitor.onData(data);
    }

    // The headless responder answers device-attribute queries (CSI 6n, 5n)
    // for plain terminals so zsh et al. don't block waiting. When an agent
    // is live the renderer's xterm.js is the sole responder (installing
    // both would double-respond and corrupt TUI parsers), so skip.
    if (!this.isAgentLive && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
      this.ensureHeadlessResponder();
    }

    // OSC 10/11 color queries are answered whenever the terminal is agent-owned
    // (spawn-time agent panel OR runtime-promoted plain terminal). The
    // call-site gate and quick-test heuristic stay here; the responder logic
    // lives in OscResponder. See OscResponder.ts for the strip-on-success
    // contract that keeps the renderer's xterm.js from double-responding.
    let rendererData = data;
    if (this.shouldHandleOscColorQueries && data.includes("\x1b]1")) {
      rendererData = handleOscColorQueries(data, (response) => {
        terminal.ptyProcess.write(response);
      });
    }

    if (terminal.headlessTerminal) {
      // Outstanding-parse counter: the wake path only trusts a serialized
      // snapshot to cover the current contentEpoch when no headless writes
      // are still queued in xterm's async parser.
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      terminal.headlessTerminal.write(data, () => {
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
        this.noteAgentOutputActivity(beforeContentSnapshot);
      });
    } else {
      this.noteAgentOutputActivity(beforeContentSnapshot);
    }
    this.sessionSnapshotter.schedule();

    this.emitData(rendererData);
    this.forensicsBuffer.capture(data);
    this.semanticBufferManager.onData(data);

    // Output mirror for agent consumers: keep a rolling recent-output
    // buffer and emit agent:output whenever an agent is live (launched
    // hint or detection). Plain terminals skip both to save work.
    if (this.isAgentLive) {
      terminal.outputBuffer += data;
      if (terminal.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
        terminal.outputBuffer = terminal.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
      }

      const liveId = getLiveAgentId(terminal);
      if (liveId) {
        this.queueAgentOutput(liveId, data);
      }
    }
  }

  private queueAgentOutput(agentId: string, data: string): void {
    if (this.pendingAgentOutputAgentId !== null && this.pendingAgentOutputAgentId !== agentId) {
      this.flushAgentOutput();
    }
    this.pendingAgentOutputAgentId = agentId;
    this.pendingAgentOutput += data;

    if (this.pendingAgentOutput.length >= OUTPUT_BUFFER_SIZE) {
      this.flushAgentOutput();
      return;
    }
    if (this.agentOutputFlushTimer) {
      return;
    }
    this.agentOutputFlushTimer = setTimeout(() => {
      this.agentOutputFlushTimer = null;
      this.flushAgentOutput();
    }, AGENT_OUTPUT_FLUSH_INTERVAL_MS);
  }

  private flushAgentOutput(): void {
    if (this.agentOutputFlushTimer) {
      clearTimeout(this.agentOutputFlushTimer);
      this.agentOutputFlushTimer = null;
    }
    if (!this.pendingAgentOutput || this.pendingAgentOutputAgentId === null) {
      return;
    }
    const agentId = this.pendingAgentOutputAgentId;
    const data = this.pendingAgentOutput;
    this.pendingAgentOutput = "";
    this.pendingAgentOutputAgentId = null;
    events.emit("agent:output", {
      agentId,
      data,
      timestamp: Date.now(),
      traceId: this.terminalInfo.traceId,
      terminalId: this.id,
    });
  }

  private setupPtyHandlers(ptyProcess: pty.IPty, dataHandoff?: PooledPtyDataHandoff): void {
    const terminal = this.terminalInfo;
    const onData = (data: string) => this.handlePtyData(ptyProcess, data);
    this.ptyDataDisposable = dataHandoff ? dataHandoff.takeOver(onData) : ptyProcess.onData(onData);

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (terminal.ptyProcess !== ptyProcess) {
        return;
      }

      // dispose() may have already emitted terminal:exited and notified
      // the registry via callbacks.onExit. A late OS-delivered exit must
      // not double-fire either path — both downstream subscribers and
      // PtyManager are not idempotent.
      if (this.exitObservers.hasEmitted) {
        return;
      }

      this.identityWatcher.stop();

      // Capture forensic tail before disposeHeadless() clears the buffer.
      // The terminal:exited subscriber reads this via the payload — once
      // `disposeHeadless` runs, `forensicsBuffer.getRecentOutput()` is gone.
      const recentOutput = this.forensicsBuffer.getRecentOutput();

      // teardown() returns false when kill() / dispose() got here first,
      // in which case the prior reason is preserved in lifecycle state. The
      // event payload still carries the actual exit code from the PTY,
      // so subscribers see e.g. `reason: "kill"` with `code: 0`.
      const teardownReason = this.lifecycle.getExitReason() ?? "natural";
      this.teardown("natural");
      this.sessionSnapshotter.dispose();

      const reasonForEvent = this.lifecycle.getExitReason() ?? teardownReason;

      const previousAgent = terminal.detectedAgentId;
      const hadDetectedIdentity =
        previousAgent !== undefined ||
        terminal.detectedProcessIconId !== undefined ||
        this.lastDetectedProcessIconId !== undefined;
      if (hadDetectedIdentity && !terminal.wasKilled) {
        terminal.detectedAgentId = undefined;
        terminal.detectedProcessIconId = undefined;
        this.lastDetectedProcessIconId = undefined;
        if (previousAgent) {
          terminal.analysisEnabled = false;
        }
        const nextTitle = computeDefaultTitle(terminal);
        if (previousAgent && (terminal.titleMode ?? "default") === "default") {
          terminal.title = nextTitle;
        }
        events.emit("agent:exited", {
          terminalId: this.id,
          agentType: previousAgent,
          defaultTitle: previousAgent ? nextTitle : undefined,
          timestamp: Date.now(),
          ...(previousAgent ? { exitKind: "terminal" as const } : {}),
        });
      }

      this.callbacks.onExit(this.id, exitCode ?? 0, signal ?? undefined);

      this.emitTerminalExited({
        code: exitCode ?? 0,
        signal,
        reason: reasonForEvent,
        recentOutput,
      });

      // Persist exit metadata on every natural exit — not just the preserve
      // path. The exit code is the authoritative pass/fail signal an MCP
      // supervisor reads, and gating it on preserve-on-exit left ephemeral
      // terminals with no recorded outcome (#10638). A user kill is not an
      // outcome, so it is still excluded — that path emits agent:killed, not a
      // completion. The write sits inside the ptyProcess identity guard and
      // hasEmitted dedup above, so a stale exit from a respawned PTY cannot
      // overwrite the live session (lesson #5948).
      if (!terminal.wasKilled) {
        terminal.exitCode = exitCode ?? 0;
        terminal.exitSignal = signal;
        terminal.isExited = true;
      }

      const preserve = this.shouldPreserveOnExit(exitCode ?? 0);
      if (preserve) {
        this.lifecycle.setExited({ code: exitCode ?? 0, signal, reason: reasonForEvent });
        this.snapshotAndDisposePreserved();
        return;
      }

      this.disposeHeadless();
      this.lifecycle.setDisposed(reasonForEvent);
    });
  }

  private emitData(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : this.textDecoder.decode(data);
    this.emitDataDirect(text);
  }

  private emitDataDirect(data: string): void {
    this.callbacks.emitData(this.id, data);
  }

  handleAgentDetection(result: DetectionResult, spawnedAt: number): void {
    this.flushAgentOutput();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    runHandleAgentDetection(
      {
        id: this.id,
        terminalInfo: this.terminalInfo,
        agentStateService: this.deps.agentStateService,
        headlineGenerator: this.headlineGenerator,
        semanticBufferManager: this.semanticBufferManager,
        get activityMonitor() {
          return self.activityMonitor;
        },
        get lastDetectedProcessIconId() {
          return self.lastDetectedProcessIconId;
        },
        set lastDetectedProcessIconId(v) {
          self.lastDetectedProcessIconId = v;
        },
        startActivityMonitor: () => this.startActivityMonitor(),
        stopActivityMonitor: () => this.stopActivityMonitor(),
      },
      result,
      spawnedAt
    );
  }
}
