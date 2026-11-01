import { createHash } from "node:crypto";
import { z } from "zod/mini";
import type * as pty from "node-pty";
import type {
  FirstPromptCandidate,
  TerminalResizeResult,
  TerminalSubmitGuard,
  TerminalSubmitStatusState,
} from "../../../shared/types/pty-host.js";
import type { PanelTitleMode, TerminalFirstPrompt } from "../../../shared/types/panel.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { PLAIN_SHELL_SCROLLBACK_MAX } from "../../../shared/config/scrollback.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  ProcessDetector,
  type AgentProcessObservation,
  type DetectionResult,
} from "../ProcessDetector.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { ImagePathProbe } from "./ImagePathProbe.js";
import type { ActivityStateMetadata } from "../ActivityMonitor.js";
import { AgentStateService } from "./AgentStateService.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import {
  type ExitReason,
  type GracefulCaptureLease,
  type PtySpawnOptions,
  type TerminalInfo,
  type TerminalPublicState,
  type TerminalSnapshot,
  DEFAULT_SCROLLBACK,
} from "./types.js";
import { WriteQueue, type SubmitExecutionContext } from "./WriteQueue.js";
import type { TerminalSubmissionRecord } from "../../../shared/types/terminalSubmission.js";
import { AgentOutputForwarder } from "./AgentOutputForwarder.js";
import { TerminalInputController } from "./TerminalInputController.js";
import { HandbackTracker } from "./HandbackTracker.js";
import { findHandback, keepFirstObservation, rawHandbackText } from "./HandbackDetector.js";
import { PtyDataPipeline } from "./PtyDataPipeline.js";
import { PreservedSnapshotCapture } from "./PreservedSnapshotCapture.js";
import { events } from "../events.js";
import { hasRateLimitMessage } from "./WaitingReasonClassifier.js";
import { AgentSpawnedSchema } from "../../schemas/agent.js";
import { destroyPty, type PooledPtyDataHandoff, type PtyPool } from "../PtyPool.js";
import { TERMINAL_SESSION_PERSISTENCE_ENABLED } from "./terminalSessionPersistence.js";
import { SessionSnapshotter, createTerminalSessionSnapshotter } from "./SessionSnapshotter.js";
import { createProcessStateValidator } from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { ProcessTreeKiller, type LineageKillSource } from "./ProcessTreeKiller.js";
import {
  logTerminalKill,
  scheduleSurvivorCheck,
  SURVIVOR_CHECK_DELAY_MS,
} from "./terminalKillAudit.js";
import { IdentityWatcher, type IdentityWatcherDelegate } from "./IdentityWatcher.js";
import { hasAgentProcess } from "./agentProcessTree.js";
import type { SpawnContext } from "./terminalSpawn.js";
import { getLiveAgentId } from "./terminalTitle.js";
import { serializeTerminal, serializeForPersistence } from "./terminalSerialization.js";
import {
  ForegroundProcessGroupProbe,
  type ForegroundSnapshot,
} from "./ForegroundProcessGroupProbe.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import { InThreadAnalysisBackend } from "./analysis/InThreadAnalysisBackend.js";
import type { WorkerAnalysisDelegate } from "./analysis/WorkerAnalysisBackend.js";
import type { AnalysisWorkerPool } from "./analysis/AnalysisWorkerPool.js";
import { OutputProgressTracker } from "./OutputProgressTracker.js";
import type {
  SerializeReadOptions,
  SerializedTerminalSnapshot,
} from "../../../shared/types/terminal.js";
import { TerminalExitObservers, type TerminalExitArgs } from "./TerminalExitObservers.js";
import { TerminalExitHandler } from "./TerminalExitHandler.js";
import { gracefulShutdown as runGracefulShutdown } from "./TerminalGracefulShutdown.js";
import { handleAgentDetection as runHandleAgentDetection } from "./TerminalAgentDetection.js";
import { offerAgentRunArgvSession } from "./agentRunArgv.js";
import { TerminalProcessLifecycle } from "./TerminalProcessLifecycle.js";
import { readScheduledRunRef } from "../../../shared/utils/scheduledRunProvenance.js";
import {
  createVisibleContentSnapshot,
  type VisibleContentSnapshot,
} from "./SustainedChangeTracker.js";

/** Minimum gap between two rate-limit observations from one pane (#12797). */
const RATE_LIMIT_OBSERVATION_COOLDOWN_MS = 60_000;
/**
 * How long a rate-limit banner must sit unchanged, with no output at all,
 * before the pane counts as stopped at it and may fall over (#14370).
 */
export const RATE_LIMIT_SETTLE_MS = 3_000;
/**
 * A banner that hasn't settled this long after it appeared is one the agent
 * kept working past (a retry that went through), so it is never offered.
 */
export const RATE_LIMIT_SETTLE_DEADLINE_MS = 30_000;

export interface TerminalProcessCallbacks {
  /**
   * `streamEnd` is the UTF-8 byte offset, in this process's renderer-bound
   * stream, just past `data`. A live snapshot is stamped with the same offset
   * (#12791) so the renderer can tell which chunks it already contains.
   */
  emitData: (id: string, data: string, streamEnd: number) => void;
  /**
   * Where this process's stream offsets start. The owner carries it over from
   * the previous process at the same id, so offsets never go backwards across
   * a respawn and a restore fence can never cover the new process's output.
   */
  streamOffsetBase?: number;
  onExit: (id: string, exitCode: number, signal?: number) => void;
  /**
   * Fired once the preserved-exit snapshot has actually been captured (after
   * the deferred headless write callback runs). The owner uses this to bound
   * the number of in-memory preserved snapshots (issue #10839); triggering here
   * — rather than in `onExit` — means the just-preserved terminal is already
   * counted, so a burst of exits can't slip past the cap.
   */
  onPreserved?: (id: string) => void;
  /**
   * Fired when a submit crosses the slow/stalled threshold, settles after
   * having done so, or fails (#11875). Absent for the overwhelming majority of
   * submits, which complete well inside the threshold and report nothing.
   */
  onSubmitStatus?: (id: string, state: TerminalSubmitStatusState) => void;
  /**
   * A submission carrying a first-prompt candidate had its Enter written while
   * an agent ran here (#15521). The record holds prompt text: it goes to Main
   * and nowhere else.
   */
  onFirstPromptWritten?: (id: string, firstPrompt: TerminalFirstPrompt) => void;
  /**
   * Opens this terminal's graceful-shutdown capture window (#12432), at most
   * once per teardown. The owner keeps the PTY's reads flowing past its memory
   * and backpressure holds until the lease is closed.
   */
  openGracefulCapture?: (id: string) => GracefulCaptureLease | null;
}

export interface TerminalProcessDependencies {
  agentStateService: AgentStateService;
  ptyPool: PtyPool | null;
  sabModeEnabled?: boolean;
  processTreeCache: ProcessTreeCache | null;
  /**
   * Records descendants while they are still reachable so teardown can reach
   * the ones that have since reparented to PID 1 (#12203). Null disables the
   * widened kill set and restores live-walk-only behavior.
   */
  lineageLedger?: LineageKillSource | null;
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
export function readPtyDimension(read: () => number, fallback: number | null): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export class TerminalProcess {
  // Analysis seam: in-thread (legacy, kill-switch) or worker-pool backed.
  // In worker mode `inThreadAnalysis` stays null and `headlessTerminal` /
  // `serializeAddon` stay undefined on this thread — the stack lives in the
  // worker slot.
  private analysis!: AnalysisBackend;
  private inThreadAnalysis: InThreadAnalysisBackend | null = null;
  private processDetector: ProcessDetector | null = null;
  // The run (`generation:incarnation`) whose argv was already read: argv never
  // changes while a run lives, so one read per run is the whole story.
  private argvReadRun: string | undefined;
  // The agent process last seen, and the run it was seen in.
  private agentProcessSeen: { pid: number; run: string } | undefined;
  private headlineGenerator = new ActivityHeadlineGenerator();
  private lastDetectedProcessIconId: string | undefined;

  private lastWriteErrorLogTime = 0;
  private suppressedWriteErrorCount = 0;

  private semanticBufferManager!: SemanticBufferManager;
  private identityWatcher!: IdentityWatcher;

  private gracefulShutdownInFlight: Promise<string | null> | null = null;
  private gracefulCaptureLease: GracefulCaptureLease | null = null;
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
  // Mirror-vs-pty divergence bookkeeping (#11719): the signature of the split
  // currently being reported (null while the grids agree) so a periodic check
  // logs once per episode, and a cumulative count for triage.
  private mirrorDivergenceSignature: string | null = null;
  private mirrorDivergenceCount = 0;
  private sessionSnapshotter!: SessionSnapshotter;
  private readonly outputProgress = new OutputProgressTracker();
  /**
   * Whether the last viewport read showed a rate-limit banner. An observation
   * fires on the rising edge only, so a banner that sits on screen is one
   * observation rather than one per repaint (#12797).
   */
  private rateLimitBannerVisible = false;
  private lastRateLimitObservedAt = Number.NEGATIVE_INFINITY;
  /**
   * The banner's screen as last read, so a repaint that changes nothing doesn't
   * restart the settle while one that does (a countdown, more output) does.
   */
  private rateLimitSettleFingerprint: string | null = null;
  private rateLimitSettleTimer: NodeJS.Timeout | null = null;
  /** When this banner appeared, and when it was last read off the screen. */
  private rateLimitBannerSince: number | null = null;
  private rateLimitLastSampleAt = 0;
  /**
   * The banner was offered, or outlived its deadline: one decision per
   * appearance, reset when the banner goes.
   */
  private rateLimitFallbackDecided = false;
  /** True only while the exit path settles the mirror's last frame. */
  private samplingFinalFrame = false;

  private agentOutputForwarder!: AgentOutputForwarder;

  private readonly terminalInfo: TerminalInfo;

  /**
   * True when an agent is currently observed in this PTY. Used to drive
   * chrome-level decisions (OSC color responder ownership, the agent output
   * ring and, for the Assistant, agent:output). Detection wins, and durable launch affinity keeps
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
  private readonly textDecoder = new TextDecoder();
  private emittedBytes = 0;

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
        return parent.inThreadAnalysis?.hasRestoreBannerMarkers ?? false;
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

  constructor(
    public readonly id: string,
    options: PtySpawnOptions,
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
    this.emittedBytes = callbacks.streamOffsetBase ?? 0;
    const { shell, args: spawnArgs } = spawnContext;
    const spawnedAt = Date.now();

    // Launch hint: the agent this terminal was asked to run, if any. Not an
    // identity — never drives chrome or capability — see
    // `docs/architecture/terminal-identity.md`.
    const launchAgentId = options.launchAgentId;
    const hasLaunchHint = !!launchAgentId;

    // A plain shell's mirror holds no more than its renderer could ever show;
    // runtime promotion grows it (see TerminalAgentDetection). #14216
    this._scrollback = hasLaunchHint ? DEFAULT_SCROLLBACK : PLAIN_SHELL_SCROLLBACK_MAX;

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
      isAssistantTerminal: options.isAssistantTerminal,
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
      agentIncarnation: 0,
      restartCount: 0,
      // Analysis is enabled whenever an agent is expected or live. Plain
      // terminals enable it on the fly when the process detector promotes.
      analysisEnabled: hasLaunchHint,
      agentLaunchFlags: options.agentLaunchFlags,
      agentModelId: options.agentModelId,
      scheduledRun: readScheduledRunRef(options.scheduledRun),
      // Recorded as the record is built, before the PTY can emit a byte
      // (#11782). The id is knowable up front for agents that accept one at
      // launch, and writing it here — rather than at teardown — is what lets it
      // survive a kill path that never runs `gracefulShutdown()` at all.
      agentSessionId: options.agentSessionId,
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
    // Terminals launched to run an agent re-inject their command on restart
    // rather than replaying a serialized buffer — session replay would show
    // stale agent output from the previous run.
    const restoreSession =
      TERMINAL_SESSION_PERSISTENCE_ENABLED && !hasLaunchHint && options.restore !== false;
    const workerPool = deps.analysisWorkerPool ?? null;
    const workerBackend = workerPool
      ? workerPool.createBackend(
          {
            terminalId: id,
            cols: options.cols,
            rows: options.rows,
            scrollback: this._scrollback,
            restore: restoreSession,
            spawnedAt,
          },
          this.createWorkerAnalysisDelegate()
        )
      : null;
    if (workerBackend) {
      this.analysis = workerBackend;
    } else {
      this.inThreadAnalysis = this.createInThreadAnalysis(options, restoreSession);
      this.analysis = this.inThreadAnalysis;
    }
    if (options.handbackCode !== undefined) {
      this.ensureHandbackTracker().registerDelivered(options.handbackCode);
    }

    // NOTE: The headless responder is intentionally NOT installed for agent
    // terminals. It would forward query responses (CSI 6n cursor position,
    // CSI c device attributes) from the headless terminal back to the PTY.
    // But the frontend xterm.js ALSO responds to these same queries when it
    // processes the output, causing double responses that corrupt Crossterm/
    // Ratatui's input parser (Codex, OpenCode) and Ink's state (Claude Code).
    // The frontend xterm.js is the sole query responder for agent terminals.

    this.semanticBufferManager = new SemanticBufferManager(this.terminalInfo);
    this.processTreeKiller = new ProcessTreeKiller(
      ptyProcess,
      deps.processTreeCache,
      deps.lineageLedger ?? null,
      {
        kind: "terminal",
        id,
        projectId: options.projectId,
        title: options.title,
        panelKind: options.kind,
        launchAgentId,
        spawnedAt,
      }
    );
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
      isExited: () => !this.lifecycle.isAlive,
      lastOutputTime: () => this.terminalInfo.lastOutputTime,
      lastOutputChangeAt: () => this.terminalInfo.lastOutputChangeAt,
      performSubmit: (text, ctx) => this.performSubmit(text, ctx),
      onWriteError: (error, context) => this.logWriteError(error, context),
      onSubmitStatus: (state) => this.callbacks.onSubmitStatus?.(this.id, state),
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
      shouldDiscardCapturedChunk: (data) => self.gracefulCaptureLease?.shouldDiscard(data) ?? false,
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
      this.processDetector.setAgentProcessObserver((observation, cbSpawnedAt) =>
        this.handleAgentProcessObservation(observation, cbSpawnedAt)
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

  /**
   * Builds the in-thread analysis stack. Also the fallback when the worker
   * pool can't provide a slot. Constructed before the rest of the
   * collaborators, so every callback resolves them lazily.
   */
  private createInThreadAnalysis(
    options: PtySpawnOptions,
    restore: boolean
  ): InThreadAnalysisBackend {
    return new InThreadAnalysisBackend({
      terminalId: this.id,
      terminalInfo: this.terminalInfo,
      cols: options.cols,
      rows: options.rows,
      scrollback: this._scrollback,
      restore,
      processTreeCache: this.deps.processTreeCache,
      isAgentLive: () => this.isAgentLive,
      onActivityState: (spawnedAt, state, metadata) =>
        this.handleAnalysisActivityState(spawnedAt, state, metadata),
      onWaitingTimeout: (spawnedAt) => this.handleAnalysisWaitingTimeout(spawnedAt),
      onBootComplete: (timestamp) => this.recordBootComplete(timestamp),
      onPtyResponse: (data) => {
        if (this.terminalInfo.wasKilled) return;
        try {
          this.terminalInfo.ptyProcess.write(data);
        } catch (error) {
          this.logWriteError(error, { operation: "write(headless-responder)" });
        }
      },
      onViewport: (lines) => this.noteOutputProgress(lines),
      onOutputPromotion: () => {
        this.flushAgentOutput();
        this.deps.agentStateService.handleActivityState(this.terminalInfo, "busy", {
          trigger: "output",
        });
      },
    });
  }

  private handleAnalysisActivityState(
    spawnedAt: number,
    state: "busy" | "idle" | "completed",
    metadata?: ActivityStateMetadata
  ): void {
    if (this.terminalInfo.spawnedAt !== spawnedAt) {
      console.warn(
        `[TerminalProcess] Rejected stale activity state from old monitor ${this.id} ` +
          `(session ${spawnedAt} vs current ${this.terminalInfo.spawnedAt})`
      );
      return;
    }
    this.flushAgentOutput();
    this.deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
  }

  private handleAnalysisWaitingTimeout(spawnedAt: number): void {
    // Same session guard as the activity state: after a worker respawn or slot
    // re-registration a late timeout from an old monitor generation must not
    // fire a watchdog transition against the current terminal.
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
  }

  private createWorkerAnalysisDelegate(): WorkerAnalysisDelegate {
    return {
      onActivityState: (spawnedAt, state, metadata) =>
        this.handleAnalysisActivityState(spawnedAt, state, metadata),
      onWaitingTimeout: (spawnedAt) => this.handleAnalysisWaitingTimeout(spawnedAt),
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
      onMirrorGeometry: (cols, rows, replayInFlight) =>
        this.checkMirrorGeometry(cols, rows, replayInFlight),
      onViewport: (lines) => this.noteOutputProgress(lines),
    };
  }

  /**
   * Compare a mirror grid against the PTY's and report a divergence (#11719).
   *
   * The mirror is a third grid: it stamps its own geometry onto every snapshot,
   * so a diverged one is self-consistent — the replay aligns to the claimed
   * grid, every check passes, and the corruption replays forever. Nothing
   * anywhere logged the two side by side, which is why this class of bug has
   * been re-diagnosed from scratch repeatedly.
   *
   * Compares against the PTY's LIVE dims, never the last requested ones: a
   * request that never landed is exactly the case worth catching. Logs once per
   * episode (signature-deduped, cleared on agreement) rather than once per
   * check, since this runs on the worker's sample cadence.
   */
  private checkMirrorGeometry(
    mirrorCols: number,
    mirrorRows: number,
    replayInFlight: boolean
  ): void {
    const terminal = this.terminalInfo;
    if (terminal.isExited) return;
    // A replay deliberately parks the mirror on the snapshot's capture grid
    // (#11552), so its live geometry is EXPECTED to disagree for the duration.
    // Reporting that would manufacture a divergence out of healthy behaviour —
    // and a log that cries wolf is worse than no log, given the whole point is
    // settling the next report from it.
    if (replayInFlight) return;
    const ptyCols = readPtyDimension(() => terminal.ptyProcess.cols, null);
    const ptyRows = readPtyDimension(() => terminal.ptyProcess.rows, null);
    if (ptyCols === null || ptyRows === null) return;

    if (mirrorCols === ptyCols && mirrorRows === ptyRows) {
      this.mirrorDivergenceSignature = null;
      return;
    }

    const signature = `${mirrorCols}x${mirrorRows}:${ptyCols}x${ptyRows}`;
    if (this.mirrorDivergenceSignature !== signature) {
      this.mirrorDivergenceSignature = signature;
      this.mirrorDivergenceCount++;
      console.warn(
        `[TerminalProcess] Mirror grid diverged from the pty for ${this.id}: ` +
          `mirror ${mirrorCols}x${mirrorRows} vs pty ${ptyCols}x${ptyRows} ` +
          `(divergence #${this.mirrorDivergenceCount}); re-asserting the pty grid`
      );
      // The repair reflows the mirror, so a snapshot taken against the pre-
      // repair buffer is stale. Bump once per episode, not once per sample:
      // the repair below runs on every sample while the split persists, and
      // dirtying the epoch each time would defeat the no-change serialize skip
      // for as long as the divergence lasts.
      terminal.contentEpoch++;
    }
    // Repair on EVERY observation, unlike the log. A repair whose post was
    // dropped must get another chance — deduping this too would re-seal the
    // exact divergence it exists to break. The backend no-ops once converged.
    try {
      this.analysis.resyncGeometry(ptyCols, ptyRows);
    } catch (error) {
      console.error(`Failed to resync mirror geometry for ${this.id}:`, error);
    }
  }

  private disposeHeadless(): void {
    // Settle a pending sample against the mirror before it goes: a preserved
    // exit drains its final output first, and that frame is the last change
    // this terminal will ever show.
    this.samplingFinalFrame = true;
    try {
      this.inThreadAnalysis?.flushOutputProgressSample();
    } finally {
      this.samplingFinalFrame = false;
    }
    this.analysis.release();
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
    this.inThreadAnalysis?.cancelAgentOutputNote();
    this.cancelRateLimitSettle();

    if (this.ptyDataDisposable) {
      try {
        this.ptyDataDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.ptyDataDisposable = null;
    }

    this.writeQueue.dispose();
    if (reason === "natural") {
      // The shell exited on its own, so nothing else in this teardown reaps its
      // process tree. Anything it spawned that had already reparented to PID 1
      // is invisible to every live tree walk and would otherwise run forever
      // (#12203) — the lineage ledger is the only record that can still reach
      // it, and this is the only path that consults it on a natural exit.
      const orphans = this.processTreeKiller.reapAfterRootExit();
      if (orphans.length > 0) this.auditKill("root-exit", orphans);
    } else {
      this.processTreeKiller.abort();
      // Every non-natural teardown is followed by a kill, and destroyPty()
      // below hangs up the foreground job first. Read the tree while the
      // detached work under it is still reachable from the shell (#13165).
      this.processTreeKiller.captureTree();
    }

    // Release the master /dev/ptmx fd on Unix. Pooled terminals already do this
    // via destroyPty() on pool teardown; live terminals never called destroy(),
    // leaking the fd on every kill/exit/dispose (#9539). teardown() is reached
    // by all three paths and is idempotent (lifecycle.transition guards
    // re-entry), so destroyPty() fires exactly once per terminal.
    //
    // Windows is excluded (#9551): there is no ptmx fd to release, and node-pty's
    // WindowsTerminal.kill()/destroy() are *deferred* native kills that race the
    // tree-kill-driven natural exit run by processTreeKiller, which releases the
    // pseudoconsole itself once its kill has finished. Adding a
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
      lastOutputChangeAt: t.lastOutputChangeAt,
      traceId: t.traceId,
      analysisEnabled: t.analysisEnabled,
      lastInputTime: t.lastInputTime,
      lastTypedInputAt: t.lastTypedInputAt,
      lastOutputTime: t.lastOutputTime,
      lastCheckTime: t.lastCheckTime,
      detectedAgentId: t.detectedAgentId,
      detectedProcessIconId: t.detectedProcessIconId,
      everDetectedAgent: t.everDetectedAgent,
      agentIncarnation: t.agentIncarnation,
      restartCount: t.restartCount,
      activityTier: this._activityTier,
      hasPty,
      agentSessionId: t.agentSessionId,
      agentLaunchFlags: t.agentLaunchFlags,
      agentModelId: t.agentModelId,
      scheduledRun: t.scheduledRun,
      spawnArgs: t.spawnArgs,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
      lastCheckResult: t.lastCheckResult,
      lastHandback: t.lastHandback,
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

  /**
   * Adopt the conversation Main attributed this run to while it is live
   * (#15268), so the subagent lookup and the exit backstop key off it. Fills
   * only, and only for the incarnation Main matched: a respawn, an id already
   * held, or another agent now running in the pane each mean the answer
   * describes a run this record no longer is. Not marked as a teardown capture,
   * so a quit that never prints its hint still reaches the exit backstop.
   */
  noteLiveAgentSessionId(sessionId: string, launchGeneration: number): void {
    const info = this.terminalInfo;
    if (info.launchGeneration !== launchGeneration || info.agentSessionId) return;
    if (info.agentIncarnation !== 0) return;
    if ((info.detectedAgentId ?? info.launchAgentId) !== info.launchAgentId) return;
    info.agentSessionId = sessionId;
  }

  /**
   * Mirror a renderer-side rename onto the authoritative record. `title` and
   * `titleMode` move together: a title without its mode would still read as
   * `"default"` and be overwritten by the next agent-detection sweep (#10794).
   */
  setTitle(title: string, titleMode: PanelTitleMode): void {
    this.terminalInfo.title = title;
    this.terminalInfo.titleMode = titleMode;
  }

  /**
   * Mirror a renderer-side worktree move onto the authoritative record, so the
   * fleet projection files the run under the worktree it is actually in rather
   * than the one it launched in (#12060).
   *
   * `null` deletes the field rather than storing a blank: an absent worktree is
   * a real state the fleet palette renders on its own terms, and an empty
   * string would read as a worktree whose id is "".
   */
  setWorktreeId(worktreeId: string | null): void {
    if (worktreeId === null) {
      delete this.terminalInfo.worktreeId;
      return;
    }
    this.terminalInfo.worktreeId = worktreeId;
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
   * Falls back to `write()` for payloads >512 bytes, which reports failures
   * through `logWriteError` rather than returning them; broadcast keystrokes
   * are always well under that, so the distinction never bites in practice.
   */
  tryWrite(data: string, traceId?: string): { ok: boolean; error?: NodeJS.ErrnoException } {
    return this.inputController.tryWrite(data, traceId);
  }

  write(data: string, traceId?: string): void {
    this.inputController.write(data, traceId);
  }

  /**
   * `handbackCode` is the code minted for a submission that asked for a
   * handback (#12488); its instruction is already in `text`. A terminal that
   * never asked keeps no tracker, so its submits pay one property read.
   *
   * A submission that reaches the pty drops the last handback: it answered an
   * earlier prompt, and the assistant's close reads its presence as the agent
   * having finished the latest one (#13128).
   *
   * `firstPrompt` is offered as the run's first-prompt record (#15521) once
   * the Enter is written, and only to an agent: a send to the shell an agent
   * left behind was never its prompt.
   */
  submit(
    text: string,
    token?: string,
    handbackCode?: string,
    guard?: TerminalSubmitGuard,
    imagePaths?: readonly string[],
    firstPrompt?: FirstPromptCandidate
  ): void {
    const tracker =
      handbackCode !== undefined ? this.ensureHandbackTracker() : this.terminalInfo.handbackTracker;
    const onTrackerWritten = tracker?.noteSubmission(handbackCode, token);
    const onPtyWritten = (): void => {
      this.terminalInfo.lastHandback = undefined;
      this.terminalInfo.lastHandbackUnpublished = false;
      onTrackerWritten?.();
      if (firstPrompt !== undefined && this.isAgentLive) {
        this.callbacks.onFirstPromptWritten?.(this.id, {
          ...firstPrompt,
          via: "send",
          at: Date.now(),
        });
      }
    };
    this.inputController.submit(text, token, onPtyWritten, guard, imagePaths);
  }

  private ensureHandbackTracker(): HandbackTracker {
    this.terminalInfo.handbackTracker ??= new HandbackTracker((rows) =>
      this.analysis.getViewportLines(rows)
    );
    return this.terminalInfo.handbackTracker;
  }

  /**
   * One tracked submission's correlation record, by the token its caller minted
   * (#12337). `undefined` means this incarnation holds no record for it.
   */
  /** Drop input queued but not yet written, leaving input open (#14454). */
  cancelPendingInput(): void {
    this.inputController.cancelPendingInput();
  }

  /** Withdraw a guarded submission this terminal holds (#12491). */
  withdrawGuardedSubmission(token: string): void {
    this.writeQueue.withdrawGuardedSubmission(token);
  }

  getSubmission(token: string): TerminalSubmissionRecord | undefined {
    return this.writeQueue.getSubmission(token);
  }

  hasPendingSubmission(): boolean {
    return this.writeQueue.hasPendingSubmission();
  }

  analysisObservedSince(): number | null {
    return this.analysis.observedSince();
  }

  isBracketedPasteMode(): boolean {
    return this.analysis.isBracketedPasteMode();
  }

  /**
   * Stage `text` into the terminal's input WITHOUT submitting it — the no-Enter
   * counterpart to {@link submit}. Reuses the same bracketed-paste / soft-newline
   * encoding `performSubmit` uses for the body, then stops: no Enter is written
   * and no output-settle bookkeeping runs. Multi-line text is always wrapped
   * (bracketed paste when supported, soft newlines otherwise) so a stray `\n`
   * can't trigger the shell-submit detection in {@link write} and auto-execute a
   * line. Trailing newlines in `text` are dropped — staging never submits. Used
   * by `host.sendToActiveAgent(text, { submit: false })` (#10558). The write
   * waits its turn in the submit lane, behind every submission already
   * accepted (#15554).
   */
  stage(text: string): void {
    this.inputController.stage(text);
  }

  private async performSubmit(text: string, ctx: SubmitExecutionContext): Promise<void> {
    await this.inputController.performSubmit(text, ctx);
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
        this.outputProgress.noteResize(Date.now());
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
        // The PTY needs no work, but the mirror is a THIRD grid and may have
        // drifted off this one — and this branch is the only thing a later
        // re-assertion of the current size reaches, so skipping it outright is
        // what made mirror divergence permanent (#11719). Re-assert the grid;
        // the backend no-ops when the mirror is already there, so the common
        // case stays free of resize side effects.
        try {
          this.analysis.resyncGeometry(cols, rows);
        } catch (error) {
          console.error(`Failed to resync mirror geometry for ${this.id}:`, error);
        }
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
      this.outputProgress.noteResize(Date.now());
      // Each backend baselines the reflowed frame inside the quiet window.
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

  /**
   * Single-flight: concurrent callers share one teardown rather than each
   * running their own. The entry gates inside `runGracefulShutdown` (`isExited`
   * / `wasKilled`) can't do this — neither is set until the teardown finishes,
   * so two callers arriving together both pass. Overlapping teardowns used to
   * be merely untidy (two `/quit` writes), but a gated key escalation makes
   * them dangerous: each loop counts only its OWN presses, so two loops can
   * write past the cap the agent's config exists to enforce (#11851). Hibernate
   * racing app quit, or a bookmark capture racing a project close, is enough.
   */
  gracefulShutdown(): Promise<string | null> {
    if (this.gracefulShutdownInFlight) {
      return this.gracefulShutdownInFlight;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const inFlight = runGracefulShutdown({
      terminalInfo: this.terminalInfo,
      get isAgentLive() {
        return self.isAgentLive;
      },
      acquireInputLock: () => this.inputController.acquireShutdownInputLock(),
      enterCaptureMode: () => this.enterGracefulCapture(),
      kill: (reason) => this.kill(reason),
    });
    this.gracefulShutdownInFlight = inFlight;
    // Latch cleared on a SEPARATE chain rather than by returning `inFlight
    // .finally(...)`: chaining would add a microtask hop to every caller, and
    // the preassigned path's whole promise is that it settles without spending
    // anything. Cleared only if we are still the current attempt, so a late
    // settle from a superseded promise can't unlatch a newer one. The cost is a
    // one-tick window after settlement where a fresh call gets the finished
    // promise back — which answers with the same captured id, and by then the
    // terminal is killed anyway, so a real second teardown had nothing to do.
    const clear = () => {
      if (self.gracefulShutdownInFlight === inFlight) {
        self.gracefulShutdownInFlight = null;
      }
    };
    void inFlight.then(clear, clear);
    return inFlight;
  }

  private enterGracefulCapture(): () => void {
    const lease = this.callbacks.openGracefulCapture?.(this.id) ?? null;
    if (!lease) return () => {};
    this.gracefulCaptureLease = lease;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (this.gracefulCaptureLease === lease) this.gracefulCaptureLease = null;
      lease.close();
    };
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
    // Everything else the live terminal used goes before the tree kill starts,
    // not when the exit lands: on Windows the pseudoconsole — and with it the
    // exit — waits for that kill to settle, and neither the kill nor the exit
    // report reads these.
    this.identityWatcher.dispose();
    this.semanticBufferManager.dispose();

    const targets = this.processTreeKiller.execute(false, escalationDelayMs);
    this.auditKill(reason ?? "kill", targets, escalationDelayMs);
  }

  /**
   * Record a kill and schedule the check for anything it left running. Callers
   * only reach this after winning the teardown transition, so each terminal
   * logs its kill once however many paths race to tear it down.
   */
  private auditKill(reason: string, targets: number[], escalationDelayMs?: number): void {
    const shellPid = this.terminalInfo.ptyProcess.pid;
    const verifiable = this.processTreeKiller.getKillIdentities().size > 0;
    logTerminalKill(this.id, reason, shellPid > 0 ? shellPid : undefined, targets, verifiable);
    if (!verifiable) return;
    scheduleSurvivorCheck(
      this.id,
      reason,
      () => this.processTreeKiller.getKillIdentities(),
      SURVIVOR_CHECK_DELAY_MS + (escalationDelayMs ?? 0)
    );
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
    return this.inThreadAnalysis?.getVisibleActivityLines(n) ?? [];
  }

  getVisibleActivitySnapshot(n: number): VisibleContentSnapshot | undefined {
    // Worker mode has no local mirror, which reads as an empty screen.
    return this.inThreadAnalysis
      ? this.inThreadAnalysis.getVisibleActivitySnapshot(n)
      : createVisibleContentSnapshot([]);
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
      hasAgentProcess: (agentId) => tp.hasAgentProcess(agentId),
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

  private hasAgentProcess(agentId: string): boolean | undefined {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (!Number.isInteger(ptyPid) || ptyPid <= 0 || !this.deps.processTreeCache) {
      return undefined;
    }
    return hasAgentProcess(this.deps.processTreeCache, ptyPid, agentId);
  }

  // Thin wrapper around ForegroundProcessGroupProbe.readSnapshot(). Kept as
  // a method on TerminalProcess so test suites that override the foreground
  // snapshot via instance-method replacement (`agentDetection.test.ts`) keep
  // working without rewiring the probe.
  private readForegroundProcessGroupSnapshot(): ForegroundSnapshot | null {
    return this.foregroundProbe.readSnapshot();
  }

  getSerializedState(): SerializedTerminalSnapshot | null {
    return serializeTerminal(this.id, this.terminalInfo);
  }

  getSerializedStateAsync(
    options?: SerializeReadOptions
  ): Promise<SerializedTerminalSnapshot | null> {
    const terminal = this.terminalInfo;
    // Preserved snapshot served — stamp access time so eviction (issue #10839)
    // treats it as currently-viewed. Checked host-side in both modes; the
    // in-thread serialize path repeats the check harmlessly.
    if (terminal.preservedSnapshot !== undefined) {
      terminal.preservedSnapshotLastAccessedAt = Date.now();
      return Promise.resolve(terminal.preservedSnapshot);
    }
    // Sampled before the request leaves: every chunk emitted so far has
    // already been fed to the analysis mirror (the pipeline forwards and feeds
    // in the same step), and the serialize below drains exactly those feeds.
    const streamOffset = this.emittedBytes;
    return this.analysis.serialize(options).then((snapshot) => {
      if (!snapshot?.continuation) return snapshot;
      return { ...snapshot, continuation: { ...snapshot.continuation, streamOffset } };
    });
  }

  serializeForPersistence(): SerializedTerminalSnapshot | null {
    // Restore-banner markers only exist on an in-thread mirror; the worker
    // strips its own banner.
    return this.inThreadAnalysis
      ? this.inThreadAnalysis.serializeForPersistenceSync()
      : serializeForPersistence(this.terminalInfo, null, null);
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
    this.emitDataDirect(historyChunk);

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
    // Windows ConPTY can report PID 0 at spawn, leaving the killer's
    // constructor nothing to register. This deferred path is where the real PID
    // lands; without it those terminals silently run with no lineage tracking.
    // registerRoot is idempotent for a PID it already holds.
    this.processTreeKiller.registerRoot(ptyPid);
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
      this.processDetector.setAgentProcessObserver((observation, cbSpawnedAt) =>
        this.handleAgentProcessObservation(observation, cbSpawnedAt)
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
    // No-op: the SAB transport is disabled and MessagePort carries terminal output.
    // Flow control is handled by pty-host.ts.
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

    const wonTeardown = this.teardown("dispose");
    this.semanticBufferManager.dispose();
    this.disposeHeadless();

    // The root-inclusive kill signals the shell PID, which is only safe while
    // that PID still belongs to our shell. After a *natural* exit it does not:
    // a preserved agent terminal sits in the registry until app shutdown, by
    // which point the OS may have handed its number to something unrelated
    // hours earlier. Those get the ledger-only sweep, which signals nothing it
    // has not just re-verified.
    //
    // A prior kill() is the opposite case — the shell is alive and mid-way
    // through its 500ms escalation, which this call must complete synchronously
    // because `process.on("exit")` will not run the timer.
    const alreadyExitedNaturally = !wonTeardown && this.lifecycle.getExitReason() === "natural";
    if (alreadyExitedNaturally) {
      this.processTreeKiller.reapAfterRootExit(true);
    } else {
      const targets = this.processTreeKiller.execute(true);
      if (wonTeardown) this.auditKill("dispose", targets);
    }

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

  private noteOutputProgress(lines: readonly string[]): void {
    const now = Date.now();
    if (this.outputProgress.observe(lines, now)) {
      this.terminalInfo.lastOutputChangeAt = now;
    }
    this.observeRateLimitBanner(lines, now);
    this.observeHandback(now);
  }

  /**
   * Report a handback marker the moment it is complete on screen (#12488),
   * rather than waiting for the agent-state heuristic to call the turn over:
   * for some CLIs that settle lags the reply by a minute or more, and the
   * orchestrator waiting on this marker waits with it. Runs only while a
   * delivered request is outstanding; the detector rejects the echoed
   * instruction, a marker still streaming and one on a spinner's status line.
   *
   * A hit while the agent still reads as working leaves its code open: Grok's
   * thinking preview carries its drafted marker, and a status line can quote
   * one, before the reply itself prints. A later capture that says something
   * different is reported again, and the settle-time check has the last look
   * and retires the code. A hit outside `working` retires it at once.
   */
  private observeHandback(now: number): void {
    const t = this.terminalInfo;
    const tracker = t.handbackTracker;
    if (tracker === undefined || !this.isAgentLive) return;
    const delivered = tracker.deliveredRequests();
    if (delivered.length === 0) return;
    const hit = findHandback(
      [
        { read: () => tracker.screenText(), rendered: true },
        { read: () => rawHandbackText(t.semanticBuffer), rendered: false },
      ],
      delivered,
      now
    );
    if (hit === undefined) return;
    const changed = tracker.noteReported(hit.code, hit.handback.message, hit.handback.truncated);
    // Retired outside `working` even when the capture repeats one already
    // reported, or the code would stay open until the next submission.
    if (t.agentState !== "working") tracker.retire(hit.code);
    if (!changed) return;
    const handback = keepFirstObservation(t.lastHandback, hit.handback);
    t.lastHandback = handback;
    t.lastHandbackUnpublished = true;
    events.emit("agent:handback-observed", {
      terminalId: this.id,
      handback,
      code: hit.code,
      ...(t.lastStateChange !== undefined ? { lastStateChange: t.lastStateChange } : {}),
      timestamp: now,
    });
  }

  /**
   * Report that this pane showed an agent's rate-limit banner. The event is
   * the fact and its time only — never the matched line, which is terminal
   * content (#12797).
   */
  private observeRateLimitBanner(lines: readonly string[], now: number): void {
    // A live agent only, so a shell that outlived its agent is never blamed.
    // The one exception is the exit path's last frame: an agent that prints
    // its limit and exits at once is already marked exited by then.
    const t = this.terminalInfo;
    const hasAgent =
      this.isAgentLive ||
      (this.samplingFinalFrame &&
        (t.detectedAgentId !== undefined || t.launchAgentId !== undefined));
    const visible = hasAgent && hasRateLimitMessage(lines);
    // The cooldown absorbs a TUI repaint that blanks the banner for one frame,
    // which would otherwise read as a fresh appearance each time.
    if (
      visible &&
      !this.rateLimitBannerVisible &&
      now - this.lastRateLimitObservedAt >= RATE_LIMIT_OBSERVATION_COOLDOWN_MS
    ) {
      this.lastRateLimitObservedAt = now;
      events.emit("agent:rate-limit-observed", {
        terminalId: this.id,
        observedAt: now,
        timestamp: now,
      });
    }
    this.rateLimitBannerVisible = visible;
    this.trackRateLimitSettle(visible, lines);
  }

  /**
   * Offer the pane's fallback chain once its rate-limit banner has sat still
   * (#14370). Kept apart from the chip's cooldown: a banner blanked by one
   * repaint restarts the settle without waiting a minute for a new observation.
   * Whether to act is the renderer's call, since only it reads the preset.
   */
  private trackRateLimitSettle(visible: boolean, lines: readonly string[]): void {
    const t = this.terminalInfo;
    // The exit path's last frame belongs to the exit classifier, not to this.
    if (!visible || this.samplingFinalFrame || !t.launchAgentId || !t.agentPresetId) {
      this.cancelRateLimitSettle();
      if (!visible) {
        this.rateLimitFallbackDecided = false;
        this.rateLimitBannerSince = null;
      }
      return;
    }
    const now = Date.now();
    this.rateLimitBannerSince ??= now;
    this.rateLimitLastSampleAt = now;
    if (this.rateLimitFallbackDecided) return;
    const fingerprint = lines.join("\n");
    if (fingerprint === this.rateLimitSettleFingerprint && this.rateLimitSettleTimer) return;
    this.rateLimitSettleFingerprint = fingerprint;
    this.armRateLimitSettle(RATE_LIMIT_SETTLE_MS);
  }

  private armRateLimitSettle(delayMs: number): void {
    if (this.rateLimitSettleTimer) clearTimeout(this.rateLimitSettleTimer);
    this.rateLimitSettleTimer = setTimeout(() => {
      this.rateLimitSettleTimer = null;
      this.settleRateLimit();
    }, delayMs);
    this.rateLimitSettleTimer.unref?.();
  }

  private cancelRateLimitSettle(): void {
    if (this.rateLimitSettleTimer) {
      clearTimeout(this.rateLimitSettleTimer);
      this.rateLimitSettleTimer = null;
    }
    this.rateLimitSettleFingerprint = null;
  }

  private settleRateLimit(): void {
    const t = this.terminalInfo;
    if (!this.rateLimitBannerVisible || !this.isAgentLive || t.isExited) return;
    const agentId = t.launchAgentId;
    const presetId = t.agentPresetId;
    // The preset belongs to the agent it launched; another CLI started in the
    // shell afterwards is not that conversation.
    if (!agentId || !presetId || getLiveAgentId(t) !== agentId) return;
    const now = Date.now();
    if (now - (this.rateLimitBannerSince ?? now) >= RATE_LIMIT_SETTLE_DEADLINE_MS) {
      this.rateLimitFallbackDecided = true;
      this.rateLimitSettleFingerprint = null;
      return;
    }
    // Still drawing: a byte inside the window, a byte the last viewport read
    // hasn't caught up with, or a turn the agent is still working through.
    // Wait the window out again rather than end a conversation that moved on.
    const quietFor = now - t.lastOutputTime;
    if (quietFor < RATE_LIMIT_SETTLE_MS) {
      this.armRateLimitSettle(RATE_LIMIT_SETTLE_MS - quietFor);
      return;
    }
    if (t.lastOutputTime > this.rateLimitLastSampleAt || t.agentState === "working") {
      this.armRateLimitSettle(RATE_LIMIT_SETTLE_MS);
      return;
    }
    this.rateLimitFallbackDecided = true;
    this.rateLimitSettleFingerprint = null;
    events.emit("agent:fallback-triggered", {
      terminalId: this.id,
      agentId,
      fromPresetId: presetId,
      originalPresetId: t.originalAgentPresetId ?? presetId,
      reason: "rate-limit",
      timestamp: now,
    });
  }

  private handlePtyData(ptyProcess: pty.IPty, data: string): void {
    this.ptyDataPipeline.handlePtyData(ptyProcess, data);
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
    this.emittedBytes += Buffer.byteLength(data, "utf8");
    this.callbacks.emitData(this.id, data, this.emittedBytes);
  }

  /**
   * The census process behind the committed agent, every detection pass. Read
   * once per run, and only once this record has promoted the same agent, so
   * the run's incarnation is already the one the process belongs to.
   *
   * A census taken before the last run's process went away can still list it
   * when a typed command promotes the next run at once; that row belongs to
   * the run it was first seen in, and must not spend this run's one read.
   */
  handleAgentProcessObservation(observation: AgentProcessObservation, spawnedAt: number): void {
    const info = this.terminalInfo;
    if (info.spawnedAt !== spawnedAt || info.wasKilled || info.isExited) return;
    if (info.detectedAgentId !== observation.agentType) return;
    const run = `${info.launchGeneration ?? "?"}:${info.agentIncarnation}`;
    if (observation.pid !== undefined) {
      const seen = this.agentProcessSeen;
      if (seen?.pid === observation.pid && seen.run !== run) return;
      this.agentProcessSeen = { pid: observation.pid, run };
    }
    if (this.argvReadRun === run) return;
    this.argvReadRun = run;
    offerAgentRunArgvSession(this.id, info, observation, this.identityWatcher.submittedCommandText);
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
        get forensicsBuffer() {
          return self.forensicsBuffer;
        },
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
        growScrollback: (lines) => this.growScrollback(lines),
      },
      result,
      spawnedAt
    );
  }
}
