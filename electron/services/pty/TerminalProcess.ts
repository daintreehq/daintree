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
import type { TerminalResizeResult } from "../../../shared/types/pty-host.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { applyXtermReflowFastpath } from "../../../shared/utils/xtermReflowFastpath.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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
  DEFAULT_SCROLLBACK,
} from "./types.js";
import { WriteQueue } from "./WriteQueue.js";
import { AgentOutputForwarder } from "./AgentOutputForwarder.js";
import { TerminalInputController } from "./TerminalInputController.js";
import { PtyDataPipeline } from "./PtyDataPipeline.js";
import { PreservedSnapshotCapture } from "./PreservedSnapshotCapture.js";
import { events } from "../events.js";
import { AgentSpawnedSchema } from "../../schemas/agent.js";
import { destroyPty, type PooledPtyDataHandoff, type PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { headlessMirrorScheduler } from "./HeadlessMirrorScheduler.js";
import { Osc94Parser } from "./Osc94Parser.js";
import { SynchronizedFrameDetector } from "./SynchronizedFrameDetector.js";

import type { IMarker } from "@xterm/headless";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  resizeMirror,
  restoreSessionFromFile,
} from "./terminalSessionPersistence.js";
import { SessionSnapshotter, createTerminalSessionSnapshotter } from "./SessionSnapshotter.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { ProcessTreeKiller } from "./ProcessTreeKiller.js";
import { IdentityWatcher, type IdentityWatcherDelegate } from "./IdentityWatcher.js";
import type { SpawnContext } from "./terminalSpawn.js";
import { getLiveAgentId } from "./terminalTitle.js";
import {
  serializeTerminal,
  serializeTerminalAsync,
  serializeForPersistence,
} from "./terminalSerialization.js";
import { ForegroundProcessGroupProbe } from "./ForegroundProcessGroupProbe.js";
import type { AnalysisBackend, MonitorStartOptions } from "./analysis/AnalysisBackend.js";
import {
  InThreadAnalysisBackend,
  type InThreadAnalysisHost,
} from "./analysis/InThreadAnalysisBackend.js";
import type { WorkerAnalysisDelegate } from "./analysis/WorkerAnalysisBackend.js";
import type { AnalysisWorkerPool } from "./analysis/AnalysisWorkerPool.js";
import {
  readCursorLine,
  readLastNLines,
  readVisibleActivityLines,
  ViewportSnapshotCache,
} from "./analysis/headlessViewport.js";
import type { AnalysisFinalCapture } from "./analysis/AnalysisBackend.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { TerminalExitObservers, type TerminalExitArgs } from "./TerminalExitObservers.js";
import { TerminalExitHandler } from "./TerminalExitHandler.js";
import { gracefulShutdown as runGracefulShutdown } from "./TerminalGracefulShutdown.js";
import { handleAgentDetection as runHandleAgentDetection } from "./TerminalAgentDetection.js";
import { TerminalProcessLifecycle } from "./TerminalProcessLifecycle.js";
import {
  measureVisibleContentDelta,
  type VisibleContentSnapshot,
} from "./SustainedChangeTracker.js";
import {
  AGENT_OUTPUT_ACTIVITY_LINE_COUNT,
  AgentActivityTemperature,
} from "./AgentActivityTemperature.js";

// Floor between agent-output content comparisons (noteAgentOutputActivity).
// Each comparison costs two full viewport extractions from the headless mirror
// plus a char diff, and it runs exactly while an agent is waiting/idle — i.e.
// while the user may be wheel-scrolling a mouse-reporting TUI whose every
// redraw chunk lands here. The temperature model needs a sustained-activity
// signal, not per-chunk granularity, so redraw-rate extraction is pure waste.
// A trailing timer preserves the final comparison of a burst; the persistent
// `agentOutputContentSnapshot` baseline makes the skipped chunks' delta
// accumulate into it rather than being lost.
const AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS = 50;

export interface TerminalProcessCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number, signal?: number) => void;
  /**
   * Fired once the preserved-exit snapshot has actually been captured (after
   * the deferred headless write callback runs). The owner uses this to bound
   * the number of in-memory preserved snapshots (issue #10839); triggering here
   * — rather than in `onExit` — means the just-preserved terminal is already
   * counted, so a burst of exits can't slip past the cap.
   */
  onPreserved?: (id: string) => void;
}

export interface TerminalProcessDependencies {
  agentStateService: AgentStateService;
  ptyPool: PtyPool | null;
  sabModeEnabled?: boolean;
  processTreeCache: ProcessTreeCache | null;
  imagePathProbe?: ImagePathProbe | null;
  /**
   * When set, the analysis stack (headless mirror + ActivityMonitor) runs in
   * a persistent worker_threads pool instead of on this thread. Absent/null →
   * legacy in-thread path (the DAINTREE_DISABLE_ANALYSIS_WORKERS fallback).
   */
  analysisWorkerPool?: AnalysisWorkerPool | null;
}

/**
 * Read one dimension node-pty holds. Returns null when the getter throws or
 * reports nonsense (the pty can be torn down between the resize and the
 * read-back) — an unknown geometry must never be reported as a known one.
 */
function readPtyDimension(read: () => number, fallback: number | null): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export class TerminalProcess {
  // Analysis seam: in-thread (legacy, kill-switch) or worker-pool backed.
  // In worker mode `activityMonitor`, `headlessTerminal`, and `serializeAddon`
  // stay null/undefined on this thread — the stack lives in the worker slot.
  private analysis!: AnalysisBackend;
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
  private inputController!: TerminalInputController;
  private ptyDataPipeline!: PtyDataPipeline;
  private preservedSnapshotCapture!: PreservedSnapshotCapture;
  private readonly processTreeKiller: ProcessTreeKiller;
  private readonly lifecycle = new TerminalProcessLifecycle();

  private readonly foregroundProbe: ForegroundProcessGroupProbe;
  private exitObservers!: TerminalExitObservers;
  private exitHandler!: TerminalExitHandler;

  private _scrollback: number;
  private ptyDataDisposable: { dispose: () => void } | null = null;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private synchronizedFrameDetector: SynchronizedFrameDetector | null = null;
  private sessionSnapshotter!: SessionSnapshotter;
  private readonly agentOutputTemperature = new AgentActivityTemperature();
  private agentOutputContentSnapshot: VisibleContentSnapshot | undefined;
  // In-thread analysis only (worker mode has no local headless mirror).
  // Shared by the monitor's polling cycle and noteAgentOutputActivity so the
  // full-viewport extract+hash runs once per parse, not once per consumer per
  // tick (PERF-035).
  private readonly viewportSnapshotCache = new ViewportSnapshotCache();
  // -Infinity so the first comparison is never throttled regardless of where
  // the clock starts (fake test clocks sit at 0).
  private lastAgentOutputNoteAt = Number.NEGATIVE_INFINITY;
  private agentOutputNoteTimer: NodeJS.Timeout | null = null;

  private agentOutputForwarder!: AgentOutputForwarder;

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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const parent = this;
    return createTerminalSessionSnapshotter({
      get id() {
        return parent.id;
      },
      get isWorkerAnalysis() {
        return parent.analysis.kind === "worker";
      },
      get wasKilled() {
        return parent.terminalInfo.wasKilled === true;
      },
      get launchAgentId() {
        return parent.terminalInfo.launchAgentId;
      },
      get contentEpoch() {
        return parent.terminalInfo.contentEpoch;
      },
      get hasRestoreBannerMarkers() {
        return !!(parent._restoreBannerStart || parent._restoreBannerEnd);
      },
      getSerializedState: () => parent.getSerializedState(),
      getSerializedStateAsync: () => parent.getSerializedStateAsync(),
      serializeForPersistence: () => parent.serializeForPersistence(),
      serializeForPersistenceViaAnalysis: () => parent.analysis.serializeForPersistence(),
    });
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

    this.terminalInfo = {
      id,
      projectId: options.projectId,
      ptyProcess,
      cwd: options.cwd,
      shell,
      kind: options.kind,
      title: options.title,
      titleMode: options.titleMode ?? "default",
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
      launchGeneration: options.launchGeneration,
      spawnArgs,
    };

    // Analysis backend selection: worker pool when available, else the legacy
    // in-thread stack. The worker slot performs its own session restore (the
    // banner markers live with the buffer, wherever it is).
    const workerPool = deps.analysisWorkerPool ?? null;
    const workerBackend = workerPool
      ? workerPool.createBackend(
          {
            terminalId: id,
            cols: options.cols,
            rows: options.rows,
            scrollback: this._scrollback,
            restore:
              TERMINAL_SESSION_PERSISTENCE_ENABLED && !hasLaunchHint && options.restore !== false,
            spawnedAt,
          },
          this.createWorkerAnalysisDelegate()
        )
      : null;
    this.analysis = workerBackend ?? this.setupInThreadAnalysis(options);

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
    this.agentOutputForwarder = new AgentOutputForwarder({
      get terminalId() {
        return self.id;
      },
      get traceId() {
        return self.terminalInfo.traceId;
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
    this.inputController = new TerminalInputController({
      get id() {
        return self.id;
      },
      get terminalInfo() {
        return self.terminalInfo;
      },
      get analysis() {
        return self.analysis;
      },
      get identityWatcher() {
        return self.identityWatcher;
      },
      get writeQueue() {
        return self.writeQueue;
      },
      logWriteError: (error, context) => self.logWriteError(error, context),
    });
    this.ptyDataPipeline = new PtyDataPipeline({
      get terminalInfo() {
        return self.terminalInfo;
      },
      get analysis() {
        return self.analysis;
      },
      get sessionSnapshotter() {
        return self.sessionSnapshotter;
      },
      get forensicsBuffer() {
        return self.forensicsBuffer;
      },
      get identityWatcher() {
        return self.identityWatcher;
      },
      get semanticBufferManager() {
        return self.semanticBufferManager;
      },
      get isAgentLive() {
        return self.isAgentLive;
      },
      get shouldHandleOscColorQueries() {
        return self.shouldHandleOscColorQueries;
      },
      emitData: (data) => self.emitData(data),
      queueAgentOutput: (agentId, data) => self.queueAgentOutput(agentId, data),
    });
    this.preservedSnapshotCapture = new PreservedSnapshotCapture({
      get id() {
        return self.id;
      },
      get terminalInfo() {
        return self.terminalInfo;
      },
      get analysis() {
        return self.analysis;
      },
      get isDisposed() {
        return self.lifecycle.isDisposed;
      },
      serializeForPersistence: () => self.serializeForPersistence(),
      disposeHeadless: () => self.disposeHeadless(),
      onPreserved: () => self.callbacks.onPreserved?.(self.id),
    });
    this.exitObservers = new TerminalExitObservers({
      id: this.id,
      terminalInfo: this.terminalInfo,
      forensicsBuffer: this.forensicsBuffer,
      agentStateService: this.deps.agentStateService,
    });
    this.exitHandler = new TerminalExitHandler({
      get id() {
        return self.id;
      },
      get terminalInfo() {
        return self.terminalInfo;
      },
      get exitObservers() {
        return self.exitObservers;
      },
      get identityWatcher() {
        return self.identityWatcher;
      },
      get forensicsBuffer() {
        return self.forensicsBuffer;
      },
      get lifecycle() {
        return self.lifecycle;
      },
      get sessionSnapshotter() {
        return self.sessionSnapshotter;
      },
      get lastDetectedProcessIconId() {
        return self.lastDetectedProcessIconId;
      },
      set lastDetectedProcessIconId(v) {
        self.lastDetectedProcessIconId = v;
      },
      teardown: (reason) => self.teardown(reason),
      emitTerminalExited: (args) => self.emitTerminalExited(args),
      shouldPreserveOnExit: (exitCode) => self.shouldPreserveOnExit(exitCode),
      snapshotAndDisposePreserved: () => self.snapshotAndDisposePreserved(),
      disposeHeadless: () => self.disposeHeadless(),
      onExit: (id, exitCode, signal) => self.callbacks.onExit(id, exitCode, signal),
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
    // A PTY PID is usable only once positive — Windows ConPTY reports `pid: 0`
    // during connect(). Skipping construction here avoids spawning a
    // ProcessDetector that would spam "Invalid PTY PID" on every refresh tick;
    // the pty-host re-triggers detection once the real PID resolves.
    if (Number.isInteger(ptyPid) && ptyPid > 0 && deps.processTreeCache) {
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
      this.analysis.startMonitor({
        agentId: launchAgentId,
        initialState: "idle",
        skipInitialStateEmit: false,
      });
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

  /**
   * Builds the legacy in-thread analysis stack: headless xterm + addons +
   * synchronized-frame detector, then wraps it behind the AnalysisBackend
   * seam. Also the fallback when the worker pool can't provide a slot.
   */
  private setupInThreadAnalysis(options: PtySpawnOptions): InThreadAnalysisBackend {
    const headlessTerminal: HeadlessTerminalType = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: this._scrollback,
      allowProposedApi: true,
    });
    applyXtermReflowFastpath(headlessTerminal);
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

    this.terminalInfo.headlessTerminal = headlessTerminal;
    this.terminalInfo.serializeAddon = serializeAddon;
    this.viewportSnapshotCache.attach(headlessTerminal);
    this.restoreSessionIfPresent(headlessTerminal);

    return new InThreadAnalysisBackend(this.createInThreadAnalysisHost());
  }

  private createInThreadAnalysisHost(): InThreadAnalysisHost {
    return {
      feedChunk: (data) => this.feedChunkInThread(data),
      feedPrelude: (data) => this.feedPreludeInThread(data),
      resize: (cols, rows) => this.resizeAnalysisInThread(cols, rows),
      handleFocus: () => this.handleFocusInThread(),
      getMonitor: () => this.activityMonitor,
      startMonitor: (opts) => this.startMonitorInThread(opts),
      stopMonitor: () => this.stopMonitorInThread(),
      setScrollback: (lines) => {
        if (!this.terminalInfo.headlessTerminal) return false;
        this.terminalInfo.headlessTerminal.options.scrollback = lines;
        // A scrollback shrink can trim the buffer; viewport-relative reads
        // should not trust a snapshot taken before the trim.
        this.viewportSnapshotCache.invalidate();
        return true;
      },
      readViewportLines: (n) => readLastNLines(this.terminalInfo.headlessTerminal, n),
      readCursorLine: () => readCursorLine(this.terminalInfo.headlessTerminal),
      serialize: () => serializeTerminalAsync(this.id, this.terminalInfo),
      serializeForPersistence: () => this.serializeForPersistence(),
      captureFinalSnapshot: async (): Promise<AnalysisFinalCapture> => {
        const snapshot = await serializeTerminalAsync(this.id, this.terminalInfo);
        return { snapshot, persistence: this.serializeForPersistence() };
      },
      releaseHeadless: () => this.disposeHeadlessInThread(),
    };
  }

  private createWorkerAnalysisDelegate(): WorkerAnalysisDelegate {
    return {
      onActivityState: (spawnedAt, state, metadata) => {
        if (this.terminalInfo.spawnedAt !== spawnedAt) {
          console.warn(
            `[TerminalProcess] Rejected stale activity state from old monitor ${this.id} ` +
              `(session ${spawnedAt} vs current ${this.terminalInfo.spawnedAt})`
          );
          return;
        }
        this.flushAgentOutput();
        this.deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
      },
      onWaitingTimeout: (spawnedAt) => {
        // Same session guard as onActivityState: after a worker respawn or
        // slot re-registration a late timeout from an old monitor generation
        // must not fire a watchdog transition against the current terminal.
        if (this.terminalInfo.spawnedAt !== spawnedAt) {
          console.warn(
            `[TerminalProcess] Rejected stale waiting-timeout from old monitor ${this.id} ` +
              `(session ${spawnedAt} vs current ${this.terminalInfo.spawnedAt})`
          );
          return;
        }
        this.flushAgentOutput();
        this.deps.agentStateService.updateAgentState(
          this.terminalInfo,
          { type: "watchdog-timeout" },
          "timeout",
          0.6
        );
      },
      onBootComplete: (timestamp) => this.recordBootComplete(timestamp),
      onPtyResponse: (data) => {
        if (this.terminalInfo.wasKilled || !this.lifecycle.isAlive) return;
        try {
          this.terminalInfo.ptyProcess.write(data);
        } catch (error) {
          this.logWriteError(error, { operation: "write(analysis-responder)" });
        }
      },
      getProcessState: () => {
        const validator = createProcessStateValidator(
          this.terminalInfo.ptyProcess.pid,
          this.deps.processTreeCache
        );
        if (!validator) return null;
        return {
          hasActiveChildren: validator.hasActiveChildren(),
          cpuUsage: validator.getDescendantsCpuUsage?.() ?? 0,
        };
      },
      getAgentContext: () => ({
        agentLive: this.isAgentLive,
        agentState: this.terminalInfo.agentState,
      }),
    };
  }

  private startMonitorInThread(opts: MonitorStartOptions): void {
    if (this.activityMonitor) return;
    const processStateValidator = createProcessStateValidator(
      this.terminalInfo.ptyProcess.pid,
      this.deps.processTreeCache
    );
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
        ...buildActivityMonitorOptions(opts.agentId, {
          getVisibleLines: (n) => this.getVisibleActivityLines(n),
          getVisibleContentSnapshot: (n) => this.getVisibleActivitySnapshot(n),
          getCursorLine: () => this.getCursorLine(),
        }),
        processStateValidator,
        initialState: opts.initialState,
        skipInitialStateEmit: opts.skipInitialStateEmit,
        onWaitingTimeout: (_id, cbSpawnedAt) => {
          // Structurally the in-thread monitor can't outlive its session
          // (stopMonitorInThread disposes it synchronously and spawnedAt is
          // immutable per TerminalProcess), but keep the same guard the
          // worker delegate and both activity-state paths use.
          if (this.terminalInfo.spawnedAt !== cbSpawnedAt) {
            console.warn(
              `[TerminalProcess] Rejected stale waiting-timeout from old monitor ${this.id} ` +
                `(session ${cbSpawnedAt} vs current ${this.terminalInfo.spawnedAt})`
            );
            return;
          }
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

  private stopMonitorInThread(): void {
    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }
    // Clear any in-flight OSC 9;4 fragment so a sequence split across the
    // teardown boundary can't trigger a callback against a stale monitor.
    this.osc94Parser.reset();
  }

  private handleFocusInThread(): void {
    this.activityMonitor?.notifyFocus();
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
  }

  private resizeAnalysisInThread(cols: number, rows: number): void {
    const terminal = this.terminalInfo;
    if (terminal.headlessTerminal) {
      // Parked, not applied, while a session replay owns the grid — the replay
      // reflows to this geometry instead of to the one it opened on (#11552).
      resizeMirror(terminal.headlessTerminal, cols, rows);
      // Reflow rewraps the buffer — invalidate any wake no-change skip.
      terminal.contentEpoch++;
    }
    // Notify activity monitor so reflow bytes are suppressed. Issue #2364.
    if (this.activityMonitor) {
      this.activityMonitor.notifyResize();
    }
    this.agentOutputTemperature.noteResize(Date.now());
    this.agentOutputContentSnapshot = undefined;
  }

  private disposeHeadless(): void {
    this.analysis.release();
  }

  private disposeHeadlessInThread(): void {
    const terminal = this.terminalInfo;
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
    this.viewportSnapshotCache.detach();
    if (!terminal.headlessTerminal) {
      return;
    }
    // Drop any feeds still held for this mirror — queued-slice callbacks are
    // discarded (matching disposed-xterm write callbacks never firing) and the
    // scheduler's aggregate in-flight accounting is released.
    headlessMirrorScheduler.clear(this.id);
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

  private snapshotAndDisposePreserved(): void {
    this.preservedSnapshotCapture.snapshotAndDispose();
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
    if (this.agentOutputNoteTimer) {
      clearTimeout(this.agentOutputNoteTimer);
      this.agentOutputNoteTimer = null;
    }

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
      lastCheckResult: t.lastCheckResult,
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
    return this.inputController.tryWrite(data, traceId);
  }

  write(data: string, traceId?: string): void {
    this.inputController.write(data, traceId);
  }

  submit(text: string): void {
    this.inputController.submit(text);
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
    this.inputController.stage(text);
  }

  private async performSubmit(text: string): Promise<void> {
    await this.inputController.performSubmit(text);
  }

  /**
   * Geometry node-pty holds right now, without touching it. Lets a caller that
   * sized the PTY outside {@link resize} — spawn adopting a buffered resize as
   * its boot geometry — report the same read-back rather than echoing back the
   * dimensions it asked for (#11641). A dimension reads `null` when the getter
   * throws or reports nonsense.
   */
  readPtyGeometry(): { cols: number | null; rows: number | null } {
    const terminal = this.terminalInfo;
    if (terminal.isExited) return { cols: null, rows: null };
    return {
      cols: readPtyDimension(() => terminal.ptyProcess.cols, null),
      rows: readPtyDimension(() => terminal.ptyProcess.rows, null),
    };
  }

  /**
   * Apply a resize and report what the PTY ended up holding. Every path returns
   * a result — including the no-op shortcut and the throwing path — because the
   * caller cannot otherwise distinguish "the PTY is at the geometry you asked
   * for" from "the PTY never moved" (#11641).
   */
  resize(cols: number, rows: number): Omit<TerminalResizeResult, "launchGeneration"> {
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols <= 0 ||
      rows <= 0 ||
      cols !== Math.floor(cols) ||
      rows !== Math.floor(rows)
    ) {
      console.warn(`Invalid terminal dimensions for ${this.id}: ${cols}x${rows}`);
      return {
        requestedCols: cols,
        requestedRows: rows,
        appliedCols: null,
        appliedRows: null,
        outcome: "rejected",
      };
    }

    const terminal = this.terminalInfo;
    if (terminal.isExited) {
      try {
        this.analysis.resize(cols, rows);
        if (this.analysis.kind === "worker") {
          // Reflow rewraps the buffer — invalidate any wake no-change skip.
          // (The in-thread path bumps the epoch itself, gated on a live buffer.)
          terminal.contentEpoch++;
        }
      } catch (error) {
        console.error(`Failed to resize terminal ${this.id}:`, error);
      }
      return {
        requestedCols: cols,
        requestedRows: rows,
        appliedCols: null,
        appliedRows: null,
        outcome: "exited",
      };
    }

    let currentCols: number | null = null;
    let currentRows: number | null = null;
    try {
      currentCols = terminal.ptyProcess.cols;
      currentRows = terminal.ptyProcess.rows;

      if (currentCols === cols && currentRows === rows) {
        return {
          requestedCols: cols,
          requestedRows: rows,
          appliedCols: currentCols,
          appliedRows: currentRows,
          outcome: "unchanged",
        };
      }

      terminal.ptyProcess.resize(cols, rows);
    } catch (error) {
      // A throw here means the PTY did NOT move — report the geometry it still
      // holds so the renderer sees the real split rather than the request.
      console.error(`Failed to resize terminal ${this.id}:`, error);
      return {
        requestedCols: cols,
        requestedRows: rows,
        appliedCols: currentCols,
        appliedRows: currentRows,
        outcome: "failed",
        error: formatErrorMessage(error, "pty resize failed"),
      };
    }

    // Read back before the analysis resize: a throw from analysis must not
    // relabel a PTY resize that genuinely landed.
    const appliedCols = readPtyDimension(() => terminal.ptyProcess.cols, null);
    const appliedRows = readPtyDimension(() => terminal.ptyProcess.rows, null);
    // node-pty's Windows backend QUEUES resize until ConPTY signals ready and
    // only updates its cached dims inside that deferred callback, so a
    // pre-ready resize leaves the getters reporting the OLD grid. Reporting
    // that as `applied` would be a lie in the dangerous direction: the watchdog
    // would compare a stale geometry against xterm, see agreement, and miss the
    // split once the queued resize finally lands. Confirm the read-back matches
    // what we asked for; when it doesn't, say we don't know rather than guess.
    const confirmed = appliedCols === cols && appliedRows === rows;

    try {
      this.analysis.resize(cols, rows);
      if (this.analysis.kind === "worker") {
        terminal.contentEpoch++;
      }
    } catch (error) {
      console.error(`Failed to resize terminal ${this.id}:`, error);
    }

    return {
      requestedCols: cols,
      requestedRows: rows,
      appliedCols: confirmed ? appliedCols : null,
      appliedRows: confirmed ? appliedRows : null,
      outcome: confirmed ? "applied" : "deferred",
    };
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

  kill(
    reason?: string,
    escalationDelayMs?: number,
    options?: { skipFinalSessionPersist?: boolean }
  ): void {
    const terminal = this.terminalInfo;
    const exitReason: ExitReason = reason === "graceful-shutdown" ? "graceful-shutdown" : "kill";

    // Flush session snapshot synchronously BEFORE teardown.
    // Once teardown disposes the writeQueue and processTreeKiller.abort() fires,
    // debounced writes are lost — so this is the last chance.
    // See lesson #3177.
    //
    // Worker-mode caveat: the flush degrades to an async worker round-trip,
    // which would race — and lose to — PtyManager.kill's deleteSessionFile,
    // resurrecting a file the caller intends to delete. When the caller is
    // about to delete the session anyway (skipFinalSessionPersist), skip the
    // deferred flush; the in-thread path keeps its sync persist-then-delete
    // ordering unchanged.
    if (!(options?.skipFinalSessionPersist && this.analysis.kind === "worker")) {
      this.sessionSnapshotter.flushSyncOnKill();
    }

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

  // Serves IdentityWatcher's sync reads: in-thread it reads the live headless
  // buffer; in worker mode it reads the throttled viewport mirror pushed by
  // the analysis worker.
  getLastNLines(n: number): string[] {
    return this.analysis.getViewportLines(n);
  }

  getVisibleActivityLines(n: number): string[] {
    return readVisibleActivityLines(this.terminalInfo.headlessTerminal, n);
  }

  getVisibleActivitySnapshot(n: number): VisibleContentSnapshot | undefined {
    return this.viewportSnapshotCache.read(this.terminalInfo.headlessTerminal, n);
  }

  getCursorLine(): string | null {
    return this.analysis.getCursorLine();
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
      getRecentOutput: () => tp.forensicsBuffer.getRecentOutput(),
      getLastCommand: () => tp.semanticBufferManager.getLastCommand(),
      getPtyDescendantCount: () => tp.getPtyDescendantCount(),
      readForegroundProcessGroupSnapshot: () => tp.readForegroundProcessGroupSnapshot(),
      handleAgentDetection: (result, cbSpawnedAt) => tp.handleAgentDetection(result, cbSpawnedAt),
    };
  }

  private getPtyDescendantCount(): number | undefined {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (!Number.isInteger(ptyPid) || ptyPid <= 0 || !this.deps.processTreeCache) {
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

  getSerializedState(): SerializedTerminalSnapshot | null {
    return serializeTerminal(this.id, this.terminalInfo);
  }

  getSerializedStateAsync(): Promise<SerializedTerminalSnapshot | null> {
    const terminal = this.terminalInfo;
    // Preserved snapshot served — stamp access time so eviction (issue #10839)
    // treats it as currently-viewed. Checked host-side in both modes; the
    // in-thread serialize path repeats the check harmlessly.
    if (terminal.preservedSnapshot !== undefined) {
      terminal.preservedSnapshotLastAccessedAt = Date.now();
      return Promise.resolve(terminal.preservedSnapshot);
    }
    return this.analysis.serialize();
  }

  serializeForPersistence(): SerializedTerminalSnapshot | null {
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
    if (
      Number.isInteger(ptyPid) &&
      ptyPid > 0 &&
      !this.processDetector &&
      this.deps.processTreeCache
    ) {
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
    if (this.analysis.hasMonitor()) return;
    const preserveState = options?.preserveState ?? false;
    const currentAgentState = this.terminalInfo.agentState;
    const initialState = preserveState && currentAgentState === "working" ? "busy" : "idle";
    this.analysis.startMonitor({
      agentId: getLiveAgentId(this.terminalInfo),
      initialState,
      skipInitialStateEmit: preserveState,
    });
  }

  stopActivityMonitor(): void {
    this.analysis.stopMonitor();
  }

  setActivityMonitorTier(tier: "active" | "background", pollingIntervalMs: number): void {
    // The tier is authoritative; the polling interval is only a cadence hint
    // (issue #8596 — VISIBLE-unfocused panes are "active" at 200ms). Output is
    // never coalesced anymore (it streams live through PtyDataPipeline), so this
    // only adjusts the headless agent-state poll cadence.
    this._activityTier = tier;

    this.analysis.setPollingInterval(pollingIntervalMs);
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
    if (!this.analysis.setScrollback(targetLines)) return;
    this._scrollback = targetLines;
  }

  growScrollback(targetLines: number): void {
    if (this._scrollback >= targetLines) return;
    if (!this.analysis.setScrollback(targetLines)) return;
    this._scrollback = targetLines;
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

  private noteAgentOutputActivity(): void {
    if (!this.isAgentLive) {
      this.agentOutputTemperature.reset();
      this.agentOutputContentSnapshot = undefined;
      return;
    }

    const state = this.terminalInfo.agentState;
    if (state !== "waiting" && state !== "idle" && state !== "completed") {
      return;
    }

    // Throttle: viewport extraction + diff at most once per interval. Skipped
    // chunks aren't lost — the diff runs against the stored baseline from the
    // last accepted comparison, so it covers everything since then. (A per-chunk
    // "before" viewport walk used to seed a fresher baseline; it was dropped —
    // a second full rows×cols extraction per note, running precisely in the
    // settled-agent states where the user scrolls a full-screen TUI, bought
    // only a marginally tighter diff window.)
    const now = Date.now();
    const sinceLastNote = now - this.lastAgentOutputNoteAt;
    if (sinceLastNote < AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS) {
      if (!this.agentOutputNoteTimer) {
        this.agentOutputNoteTimer = setTimeout(() => {
          this.agentOutputNoteTimer = null;
          this.noteAgentOutputActivity();
        }, AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS - sinceLastNote);
      }
      return;
    }
    this.lastAgentOutputNoteAt = now;

    const afterSnapshot = this.getAgentOutputContentSnapshot();
    if (afterSnapshot === undefined) {
      return;
    }

    const delta = measureVisibleContentDelta(this.agentOutputContentSnapshot, afterSnapshot);
    const hadFallbackBaseline = this.agentOutputContentSnapshot !== undefined;
    this.agentOutputContentSnapshot = afterSnapshot;
    if (!hadFallbackBaseline) {
      this.agentOutputTemperature.observeDelta(Date.now(), { changedChars: 0 });
      return;
    }

    const result = this.agentOutputTemperature.observeDelta(Date.now(), {
      changedChars: delta.changedChars,
    });
    // ActivityMonitor suppresses its own idle→busy paths on focus repaints
    // (#8865) and on recent user input (#10925), but this direct call into
    // agentStateService is a parallel promotion path; gate it on both windows
    // so neither a focus-triggered TUI repaint nor a mouse-report-driven redraw
    // from scrolling a mouse-reporting TUI can flip a settled agent to busy.
    if (this.activityMonitor?.isFocusSuppressed() || this.activityMonitor?.isRecentUserInput()) {
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

    this.analysis.feedPrelude(prelude);
    this.sessionSnapshotter.schedule();
    this.emitData(prelude);
    this.forensicsBuffer.capture(prelude);
    this.semanticBufferManager.onData(prelude);
  }

  private feedPreludeInThread(prelude: string): void {
    const terminal = this.terminalInfo;
    if (terminal.headlessTerminal) {
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      headlessMirrorScheduler.enqueue(this.id, terminal.headlessTerminal, prelude, () => {
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
      });
    }
  }

  private handlePtyData(ptyProcess: pty.IPty, data: string): void {
    this.ptyDataPipeline.handlePtyData(ptyProcess, data);
  }

  private feedChunkInThread(data: string): void {
    const terminal = this.terminalInfo;

    // Tap OSC 9;4 progress sequences upstream of the rest of the analysis so
    // the agent-state signal is viewport-independent (#8701). The parser is
    // a read-only side channel; `IdleSequenceFilter.stripIdleTerminalSequences`
    // still removes the sequence from the ActivityMonitor byte-volume /
    // activity-gate path, so those detectors stay clean (the renderer keeps
    // the raw bytes — see TerminalProcess.osc.test.ts). This runs per-chunk for
    // backgrounded terminals too so the heartbeat never lags (#8753, #10744).
    this.osc94Parser.feed(data, Date.now());

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

    if (terminal.headlessTerminal) {
      // Outstanding-parse counter: the wake path only trusts a serialized
      // snapshot to cover the current contentEpoch when no headless writes
      // are still queued (scheduler hold + xterm's async parser both count —
      // the callback fires only after the chunk has actually parsed).
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      headlessMirrorScheduler.enqueue(this.id, terminal.headlessTerminal, data, () => {
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
        // Invalidate before noteAgentOutputActivity reads the viewport: xterm
        // fires per-write callbacks before the onWriteParsed event the cache
        // subscribes to, and a stale hit here would diff a pre-parse snapshot.
        this.viewportSnapshotCache.invalidate();
        this.noteAgentOutputActivity();
      });
    } else {
      this.noteAgentOutputActivity();
    }
  }

  private queueAgentOutput(agentId: string, data: string): void {
    this.agentOutputForwarder.queue(agentId, data);
  }

  private flushAgentOutput(): void {
    this.agentOutputForwarder.flush();
  }

  private setupPtyHandlers(ptyProcess: pty.IPty, dataHandoff?: PooledPtyDataHandoff): void {
    const onData = (data: string) => this.handlePtyData(ptyProcess, data);
    this.ptyDataDisposable = dataHandoff ? dataHandoff.takeOver(onData) : ptyProcess.onData(onData);

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.exitHandler.handleExit(ptyProcess, exitCode, signal);
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
        get hasActivityMonitor() {
          return self.analysis.hasMonitor();
        },
        reconfigureActivityMonitor: (agentId, patternConfig) =>
          this.analysis.reconfigureMonitor(agentId, patternConfig),
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
