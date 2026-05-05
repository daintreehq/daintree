import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { ProcessDetector, type DetectionResult } from "../ProcessDetector.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
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
import type { PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { handleOscColorQueries } from "./OscResponder.js";
import { SynchronizedFrameDetector } from "./SynchronizedFrameDetector.js";

// Extracted modules
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  getSubmitEnterDelay,
  isBracketedPaste,
  delay,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  OUTPUT_SETTLE_DEBOUNCE_MS,
  OUTPUT_SETTLE_MAX_WAIT_MS,
  OUTPUT_SETTLE_POLL_INTERVAL_MS,
} from "./terminalInput.js";
import type { IMarker } from "@xterm/headless";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
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

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
};

export interface TerminalProcessCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number) => void;
}

export interface TerminalProcessDependencies {
  agentStateService: AgentStateService;
  ptyPool: PtyPool | null;
  sabModeEnabled?: boolean;
  processTreeCache: ProcessTreeCache | null;
}

export class TerminalProcess {
  private activityMonitor: ActivityMonitor | null = null;
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
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private synchronizedFrameDetector: SynchronizedFrameDetector | null = null;
  private sessionSnapshotter!: SessionSnapshotter;

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
        return this.parent._serializeForPersistence();
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
    ptyProcess: pty.IPty
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
      semanticBuffer: [],
      headlessTerminal,
      serializeAddon,
      rawOutputBuffer: undefined,
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
    this.setupPtyHandlers(ptyProcess);

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
        Boolean(this.terminalInfo.launchAgentId)
      );
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
      this.identityWatcher.seed(options.command);
    }

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
          deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
        },
        {
          ...buildActivityMonitorOptions(launchAgentId, {
            getVisibleLines: (n) => this.getLastNLines(n),
            getCursorLine: () => this.getCursorLine(),
          }),
          processStateValidator,
          onWaitingTimeout: (_id, _spawnedAt) => {
            deps.agentStateService.updateAgentState(
              this.terminalInfo,
              { type: "watchdog-timeout" },
              "timeout",
              0.6
            );
          },
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
          validatedSpawned.error.format()
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

    this.writeQueue.dispose();
    this.processTreeKiller.abort();

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
      spawnedAt: t.spawnedAt,
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

  acknowledgeData(_charCount: number): void {
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
      this.activityMonitor.onInput(data);
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
      this.activityMonitor.onInput(data);
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
        terminal.headlessTerminal?.resize(cols, rows);
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
      }

      // Notify activity monitor so reflow bytes are suppressed. Issue #2364.
      if (this.activityMonitor) {
        this.activityMonitor.notifyResize();
      }
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

  kill(reason?: string): void {
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

    // Capture forensic tail before disposeHeadless() clears the buffer so
    // any subscriber that runs synchronously after the natural-exit
    // emit-path can still read it. The kill path emits no `terminal:exited`
    // here — natural onExit will fire (or `dispose()` will emit if it
    // doesn't), carrying `reason: "kill"` through the exit-reason carried
    // by the state machine.
    this.disposeHeadless();

    this.processTreeKiller.execute(false);
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

  private _serializeForPersistence(): string | null {
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
        Boolean(this.terminalInfo.launchAgentId)
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
          this.deps.agentStateService.handleActivityState(this.terminalInfo, state, metadata);
        },
        {
          ...buildActivityMonitorOptions(getLiveAgentId(this.terminalInfo), {
            getVisibleLines: (n) => this.getLastNLines(n),
            getCursorLine: () => this.getCursorLine(),
          }),
          processStateValidator,
          initialState,
          skipInitialStateEmit: preserveState,
          onWaitingTimeout: (_id, _spawnedAt) => {
            this.deps.agentStateService.updateAgentState(
              this.terminalInfo,
              { type: "watchdog-timeout" },
              "timeout",
              0.6
            );
          },
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
  }

  setActivityMonitorTier(pollingIntervalMs: number): void {
    // Track activity tier based on polling interval:
    // 50ms = active (foreground), 500ms = background (project switched away)
    this._activityTier = pollingIntervalMs <= 50 ? "active" : "background";

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

  private noteAgentOutputActivity(data: string): void {
    if (!data || !this.isAgentLive) {
      return;
    }

    const state = this.terminalInfo.agentState;
    if (state !== "waiting" && state !== "idle" && state !== "completed") {
      return;
    }

    this.deps.agentStateService.handleActivityState(this.terminalInfo, "busy", {
      trigger: "output",
    });
  }

  private setupPtyHandlers(ptyProcess: pty.IPty): void {
    const terminal = this.terminalInfo;

    ptyProcess.onData((data) => {
      if (terminal.ptyProcess !== ptyProcess) {
        return;
      }

      terminal.lastOutputTime = Date.now();

      if (this.activityMonitor) {
        this.activityMonitor.onData(data);
      }
      this.noteAgentOutputActivity(data);

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

      terminal.headlessTerminal?.write(data);
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
          events.emit("agent:output", {
            agentId: liveId,
            data,
            timestamp: Date.now(),
            traceId: terminal.traceId,
            terminalId: this.id,
          });
        }
      }
    });

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

      this.callbacks.onExit(this.id, exitCode ?? 0);

      this.emitTerminalExited({
        code: exitCode ?? 0,
        signal,
        reason: reasonForEvent,
        recentOutput,
      });

      const preserve = this.shouldPreserveOnExit(exitCode ?? 0);
      if (preserve) {
        terminal.exitCode = exitCode ?? 0;
        terminal.isExited = true;
        this.lifecycle.setExited({ code: exitCode ?? 0, signal, reason: reasonForEvent });
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
