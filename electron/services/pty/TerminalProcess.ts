import { execFile } from "child_process";
import { promisify } from "node:util";
import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { ProcessDetector, type DetectionResult, type DetectionState } from "../ProcessDetector.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { AgentStateService } from "./AgentStateService.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import {
  type ExitReason,
  type PtySpawnOptions,
  type PtyState,
  type TerminalInfo,
  type TerminalPublicState,
  type TerminalSnapshot,
  OUTPUT_BUFFER_SIZE,
  DEFAULT_SCROLLBACK,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
} from "./types.js";
import { WriteQueue } from "./WriteQueue.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";
import { events } from "../events.js";
import { AgentSpawnedSchema } from "../../schemas/agent.js";
import type { PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { handleOscColorQueries } from "./OscResponder.js";
import { classifyExitOutput, shouldTriggerFallback } from "./FallbackErrorClassifier.js";

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
  buildPatternConfig,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { ProcessTreeKiller } from "./ProcessTreeKiller.js";
import {
  IdentityWatcher,
  normalizeShellCommandText,
  type IdentityWatcherDelegate,
} from "./IdentityWatcher.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import type { SpawnContext } from "./terminalSpawn.js";

const execFileAsync = promisify(execFile);

// Soft-stale: trigger an async background refresh once the cached snapshot is
// older than this. Hard-max: callers receive null past this age and fall back
// to the legacy prompt path.
const FOREGROUND_SNAPSHOT_SOFT_STALE_MS = 500;
const FOREGROUND_SNAPSHOT_MAX_AGE_MS = 1500;
const FOREGROUND_SNAPSHOT_PROBE_TIMEOUT_MS = 750;

// Sentinel returned on POSIX before the first probe resolves. Returning null
// during the warm-up window would drop into the IdentityWatcher's
// "Windows / unsupported" fallback branch and falsely mark the shell idle for
// demotion. Any value where shellPgid !== foregroundPgid (and both > 0) keeps
// the demotion gate closed; the real probe overwrites this within a few ms.
const INITIAL_FOREGROUND_SENTINEL = Object.freeze({
  shellPgid: 1,
  foregroundPgid: 2,
});

const IDENTITY_DEBUG_ENABLED =
  process.env.NODE_ENV === "development" || Boolean(process.env.DAINTREE_DEBUG);

function logIdentityDebug(message: string): void {
  if (IDENTITY_DEBUG_ENABLED) {
    console.log(message);
  }
}

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
};

// Backend-side identity for internal decisions (activity monitor pattern
// lookup, event routing). Detection wins; during the boot window the launch
// hint is used so cold-launched terminals start monitoring before the
// process-tree poll has caught up.
function getLiveAgentId(terminal: TerminalInfo): string | undefined {
  return terminal.detectedAgentId ?? terminal.launchAgentId;
}

/**
 * Compute the default panel title for a terminal given its current chrome
 * identity. Used by the PTY host so the renderer can sync `panel.title` when
 * `titleMode === "default"`. Kept in lockstep with the renderer's
 * renderer terminal chrome rule: detection wins; launch affinity remains
 * agent-branded until an explicit exited state says the agent has ended.
 */
function computeDefaultTitle(terminal: TerminalInfo): string {
  const chromeId =
    terminal.detectedAgentId ??
    (terminal.agentState === "exited" || terminal.isExited ? undefined : terminal.launchAgentId);
  if (!chromeId) return "Terminal";
  const config = AGENT_REGISTRY[chromeId];
  return config?.name ?? String(chromeId);
}

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
  private _ptyState: PtyState = { kind: "alive" };
  private _exitEventEmitted = false;

  private _foregroundSnapshot: { shellPgid: number; foregroundPgid: number } | null = null;
  private _foregroundSnapshotUpdatedAt = 0;
  private _foregroundSnapshotRefreshing = false;
  private _foregroundSnapshotCheckId = 0;

  private _scrollback: number;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
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
    this.writeQueue = new WriteQueue({
      writeToPty: (data) => {
        this.terminalInfo.ptyProcess.write(data);
      },
      isExited: () => this._ptyState.kind !== "alive",
      lastOutputTime: () => this.terminalInfo.lastOutputTime,
      performSubmit: (text) => this.performSubmit(text),
      onWriteError: (error, context) => this.logWriteError(error, context),
    });
    this.sessionSnapshotter = this.createSessionSnapshotter();
    this.identityWatcher = new IdentityWatcher(this.createIdentityWatcherDelegate());
    this._subscribeExitObservers();
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
    try {
      terminal.headlessTerminal.dispose();
    } catch {
      // Ignore disposal errors
    }
    terminal.headlessTerminal = undefined;
    terminal.serializeAddon = undefined;
  }

  /**
   * Replace the lifecycle state. Returns `false` (no-op) when the requested
   * transition is illegal — most importantly when something tries to enter
   * `shutting-down` while we are already past `alive`. This is what makes
   * `teardown()`, `kill()`, and `dispose()` idempotent: the second caller
   * sees `false` and returns immediately.
   */
  private transition(next: PtyState): boolean {
    const current = this._ptyState;
    if (current.kind === next.kind) {
      return false;
    }

    let valid = false;
    switch (current.kind) {
      case "alive":
        valid = next.kind === "shutting-down";
        break;
      case "shutting-down":
        valid = next.kind === "exited" || next.kind === "disposed";
        break;
      case "exited":
        valid = next.kind === "disposed";
        break;
      case "disposed":
        valid = false;
        break;
    }

    if (!valid) {
      return false;
    }

    this._ptyState = next;
    return true;
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
    if (!this.transition({ kind: "shutting-down", reason })) {
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
   * Emit `terminal:exited` exactly once per terminal lifetime. Forensics,
   * `agent:completed`, and fallback classification subscribe to this event
   * (see `_subscribeExitObservers`) instead of running inline inside the
   * PTY `onExit` callback. `recentOutput` must be captured before the
   * headless buffer is torn down — `disposeHeadless()` clears the
   * forensics buffer, and a fallback subscriber that scans exit-time
   * output cannot recover it once cleared.
   */
  private emitTerminalExited(args: {
    code: number | null;
    signal?: number;
    reason: ExitReason;
    recentOutput: string;
  }): void {
    if (this._exitEventEmitted) return;
    this._exitEventEmitted = true;

    const terminal = this.terminalInfo;
    const liveAgentAtExit = getLiveAgentId(terminal);
    const hadAgent = !!terminal.launchAgentId || !!terminal.everDetectedAgent;

    events.emit("terminal:exited", {
      terminalId: this.id,
      spawnedAt: terminal.spawnedAt,
      code: args.code,
      signal: args.signal,
      reason: args.reason,
      recentOutput: args.recentOutput,
      hadAgent,
      liveAgentAtExit,
      launchAgentId: terminal.launchAgentId,
      agentPresetId: terminal.agentPresetId,
      originalAgentPresetId: terminal.originalAgentPresetId,
      timestamp: Date.now(),
    });
  }

  /**
   * Subscribe forensics logging, agent-completion emission, and fallback
   * classification to the `terminal:exited` event. Registered once during
   * construction and torn down when the event fires (or in `dispose()` if
   * the terminal is destroyed without ever emitting).
   *
   * Filters by `terminalId` so the singleton event bus can fan out to many
   * terminals without each subscriber re-checking.
   */
  private _exitObserverDisposable: { dispose: () => void } | null = null;
  private _subscribeExitObservers(): void {
    const sessionToken = this.terminalInfo.spawnedAt;
    const off = events.on("terminal:exited", (payload) => {
      // Filter on terminalId AND the session token. Without spawnedAt, an
      // old PTY's exit (after `PtyManager.spawn(id)` killed it and
      // respawned under the same id) would consume the new instance's
      // listener and silence its real exit later.
      if (payload.terminalId !== this.id || payload.spawnedAt !== sessionToken) return;

      // Forensics: log abnormal exits with the tail captured at exit time.
      // `wasKilled` is encoded in the reason — kill / graceful-shutdown
      // paths suppress the abnormal-exit log even if the exit code was
      // non-zero, matching the prior inline behaviour.
      this.forensicsBuffer.logForensics(
        this.id,
        payload.code ?? 0,
        this.terminalInfo,
        payload.hadAgent,
        payload.signal
      );

      // Agent state machine: only natural exits update agent state and
      // emit agent:completed. kill / graceful-shutdown route through the
      // kill path which has already emitted agent:killed before teardown.
      if (payload.reason === "natural" && payload.hadAgent) {
        this.deps.agentStateService.updateAgentState(this.terminalInfo, {
          type: "exit",
          code: payload.code ?? 0,
          signal: payload.signal,
        });
      }

      if (payload.reason === "natural" && payload.hadAgent && payload.liveAgentAtExit) {
        this.deps.agentStateService.emitAgentCompleted(this.terminalInfo, payload.code ?? 0);
      }

      // Fallback classification: only fires for natural exits of agent
      // terminals with a launched preset. Killed agents never trigger
      // fallback (the user explicitly stopped them).
      if (
        payload.reason === "natural" &&
        payload.launchAgentId &&
        payload.agentPresetId &&
        payload.code !== null
      ) {
        const cls = classifyExitOutput({
          recentOutput: payload.recentOutput,
          // Pass through as-is so a null/undefined code (crash, signal) does
          // NOT short-circuit the scan. Only an explicit exit 0 skips the tail.
          exitCode: payload.code,
          wasKilled: false,
        });
        if (shouldTriggerFallback(cls)) {
          events.emit("agent:fallback-triggered", {
            terminalId: this.id,
            agentId: payload.launchAgentId,
            fromPresetId: payload.agentPresetId,
            originalPresetId: payload.originalAgentPresetId ?? payload.agentPresetId,
            reason: cls as "connection" | "auth",
            exitCode: payload.code,
            timestamp: Date.now(),
          });
        }
      }

      this._exitObserverDisposable?.dispose();
      this._exitObserverDisposable = null;
    });

    this._exitObserverDisposable = { dispose: off };
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
    const state = this._ptyState;
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

  async gracefulShutdown(): Promise<string | null> {
    const terminal = this.terminalInfo;

    if (terminal.isExited || terminal.wasKilled) {
      return null;
    }

    // Don't inject quit into terminals whose agent already exited — e.g.
    // user typed /quit and the terminal demoted to a plain shell. The
    // launchAgentId persists for identity, but the agent is gone.
    if (!this.isAgentLive) {
      return null;
    }

    const liveAgentId = getLiveAgentId(terminal);
    const agentConfig = liveAgentId ? getEffectiveAgentConfig(liveAgentId) : undefined;
    const resume = agentConfig?.resume;

    // Nothing to send — agent has no resume config or the config supplies
    // neither a quit command nor a key sequence we can emit on shutdown.
    if (!resume) {
      return null;
    }
    const quitCommand = resume.quitCommand;
    const shutdownKeySequence = resume.shutdownKeySequence;
    if (!quitCommand && !shutdownKeySequence) {
      return null;
    }

    // Only `session-id` triggers the post-quit pattern-match capture loop —
    // other kinds (rolling-history, named-target, project-scoped) just send
    // the quit signal and resolve null. Lesson from #4781: never run the
    // capture loop for non-`session-id` agents — directory-scoped sessions
    // (Kiro) don't emit IDs and the ghost regex would either time out or
    // false-positive on unrelated output.
    const pattern = resume.kind === "session-id" ? new RegExp(resume.sessionIdPattern) : null;

    let shutdownBuffer = "";
    let resolved = false;

    return new Promise<string | null>((resolve) => {
      const finish = (sessionId: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        if (sessionId) {
          terminal.agentSessionId = sessionId;
        }

        this.kill("graceful-shutdown");
        resolve(sessionId);
      };

      const timer = setTimeout(() => finish(null), GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      const origOnData = terminal.ptyProcess.onData((data: string) => {
        if (resolved) return;
        if (!pattern) return;

        shutdownBuffer += data;
        if (shutdownBuffer.length > GRACEFUL_SHUTDOWN_BUFFER_SIZE) {
          shutdownBuffer = shutdownBuffer.slice(-GRACEFUL_SHUTDOWN_BUFFER_SIZE);
        }

        const stripped = stripAnsiCodes(shutdownBuffer);
        const match = pattern.exec(stripped);
        if (match?.[1]) {
          origOnData.dispose();
          finish(match[1]);
        }
      });

      const origOnExit = terminal.ptyProcess.onExit(() => {
        origOnExit.dispose();
        origOnData.dispose();

        if (!pattern) {
          finish(null);
          return;
        }
        const stripped = stripAnsiCodes(shutdownBuffer);
        const match = pattern.exec(stripped);
        finish(match?.[1] ?? null);
      });

      // Clear any partial user input at the agent prompt before issuing the quit command.
      // Without this prelude, concatenated input (e.g. "half-typed/quit") is treated as a
      // chat message by the agent and the session-ID line is never emitted. See #5785.
      //   \x05 — Ctrl-E: move cursor to end of line
      //   \x15 — Ctrl-U: erase from cursor to beginning of line
      // ESC is avoided because it navigates/dismisses TUI state in bubbletea and ink CLIs.
      (async () => {
        try {
          terminal.ptyProcess.write("\x05\x15");
        } catch {
          origOnData.dispose();
          origOnExit.dispose();
          finish(null);
          return;
        }

        await new Promise<void>((r) => setTimeout(r, GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS));

        if (resolved) return;

        // Re-check liveness: if the agent demoted during the clear-delay
        // window (e.g. user typed /quit milliseconds before shutdown), the
        // pending write would land in a plain shell.
        if (!this.isAgentLive) {
          origOnData.dispose();
          origOnExit.dispose();
          finish(null);
          return;
        }

        try {
          if (shutdownKeySequence) {
            terminal.ptyProcess.write(shutdownKeySequence);
          }
          if (quitCommand) {
            terminal.ptyProcess.write(quitCommand + "\r");
          }
        } catch {
          origOnData.dispose();
          origOnExit.dispose();
          finish(null);
        }
      })();
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

  /**
   * Sync read against a per-terminal stale-while-revalidate cache. The actual
   * `ps` probe runs asynchronously so the IdentityWatcher poll tick never
   * blocks the pty-host event loop. Soft-stale schedules a background refresh;
   * past the hard-max age we return null so callers fall back to the legacy
   * prompt path (matches the pre-existing non-POSIX behavior).
   */
  private readForegroundProcessGroupSnapshot(): {
    shellPgid: number;
    foregroundPgid: number;
  } | null {
    if (process.platform === "win32") {
      return null;
    }

    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (ptyPid === undefined) {
      return null;
    }

    const hasEverProbed = this._foregroundSnapshotUpdatedAt > 0;
    const age = hasEverProbed ? Date.now() - this._foregroundSnapshotUpdatedAt : 0;

    if (
      !this._foregroundSnapshotRefreshing &&
      (!hasEverProbed || age > FOREGROUND_SNAPSHOT_SOFT_STALE_MS)
    ) {
      void this._refreshForegroundProcessGroupSnapshot(ptyPid);
    }

    // Probe pending: keep the demotion gate closed (see sentinel comment).
    if (!hasEverProbed) {
      return INITIAL_FOREGROUND_SENTINEL;
    }

    if (age > FOREGROUND_SNAPSHOT_MAX_AGE_MS) {
      return null;
    }
    return this._foregroundSnapshot;
  }

  private async _refreshForegroundProcessGroupSnapshot(ptyPid: number): Promise<void> {
    this._foregroundSnapshotRefreshing = true;
    const checkId = ++this._foregroundSnapshotCheckId;
    let nextSnapshot: { shellPgid: number; foregroundPgid: number } | null = null;
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "pgid=,tpgid=", "-p", String(ptyPid)], {
        encoding: "utf8",
        shell: false,
        signal: AbortSignal.timeout(FOREGROUND_SNAPSHOT_PROBE_TIMEOUT_MS),
      });
      const [pgidText, tpgidText] = stdout.trim().split(/\s+/);
      const shellPgid = Number.parseInt(pgidText ?? "", 10);
      const foregroundPgid = Number.parseInt(tpgidText ?? "", 10);
      if (Number.isFinite(shellPgid) && Number.isFinite(foregroundPgid)) {
        nextSnapshot = { shellPgid, foregroundPgid };
      }
    } catch {
      // ps -p races (process exited) and aborts both surface here. Persisting
      // null with a fresh timestamp prevents tight-retry and lets the caller
      // fall back to the legacy prompt path until the next refresh window.
      nextSnapshot = null;
    } finally {
      // Disposed-instance guard: never write back to a torn-down terminal.
      // Stale-write guard via monotonic checkId is belt-and-suspenders given
      // the in-flight boolean, but cheap and matches the repo's checkId
      // pattern (see CliAvailabilityService).
      if (this._ptyState.kind !== "disposed" && checkId === this._foregroundSnapshotCheckId) {
        this._foregroundSnapshot = nextSnapshot;
        this._foregroundSnapshotUpdatedAt = Date.now();
      }
      this._foregroundSnapshotRefreshing = false;
    }
  }

  getSerializedState(): string | null {
    try {
      return this.terminalInfo.serializeAddon!.serialize();
    } catch (error) {
      console.error(`[TerminalProcess] Failed to serialize terminal ${this.id}:`, error);
      return null;
    }
  }

  async getSerializedStateAsync(): Promise<string | null> {
    const terminal = this.terminalInfo;

    try {
      const lineCount = terminal.headlessTerminal!.buffer.active.length;
      const serializerService = getTerminalSerializerService();

      if (serializerService.shouldUseAsync(lineCount)) {
        return await serializerService.serializeAsync(this.id, () =>
          terminal.serializeAddon!.serialize()
        );
      }

      return terminal.serializeAddon!.serialize();
    } catch (error) {
      console.error(`[TerminalProcess] Failed to serialize terminal ${this.id}:`, error);
      return null;
    }
  }

  private _serializeForPersistence(): string | null {
    const addon = this.terminalInfo.serializeAddon;
    const terminal = this.terminalInfo.headlessTerminal;
    if (!addon || !terminal) return null;

    const startMarker = this._restoreBannerStart;
    const endMarker = this._restoreBannerEnd;

    if (!startMarker || !endMarker || startMarker.line < 0 || endMarker.line < 0) {
      return addon.serialize();
    }

    try {
      const bufLen = terminal.buffer.active.length;
      const bannerStart = startMarker.line;
      const bannerEnd = endMarker.line;

      const beforePart =
        bannerStart > 0 ? addon.serialize({ range: { start: 0, end: bannerStart - 1 } }) : "";
      const afterPart =
        bannerEnd < bufLen - 1
          ? addon.serialize({ range: { start: bannerEnd, end: bufLen - 1 } })
          : "";

      if (beforePart && afterPart) return beforePart + "\r\n" + afterPart;
      return beforePart || afterPart || addon.serialize();
    } catch {
      return addon.serialize();
    }
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
    // the last chance to notify subscribers. `_exitEventEmitted` makes a
    // late natural-exit emit a no-op if onExit fires after dispose.
    if (!this._exitEventEmitted) {
      this.emitTerminalExited({
        code: null,
        reason: this.getExitReason() ?? "dispose",
        recentOutput,
      });
    }

    if (this._ptyState.kind !== "disposed") {
      this._ptyState = { kind: "disposed", reason: this.getExitReason() ?? "dispose" };
    }

    this._exitObserverDisposable?.dispose();
    this._exitObserverDisposable = null;
  }

  /**
   * Read the exit reason captured by `teardown()` if available. Returns
   * `null` for terminals that are still `alive` — primarily useful when
   * `dispose()` runs after a prior `kill()` or natural exit and needs to
   * preserve the original reason in the final `disposed` state.
   */
  private getExitReason(): ExitReason | null {
    const s = this._ptyState;
    if (s.kind === "shutting-down" || s.kind === "exited" || s.kind === "disposed") {
      return s.reason;
    }
    return null;
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
      if (this._exitEventEmitted) {
        return;
      }

      this.identityWatcher.stop();

      // Capture forensic tail before disposeHeadless() clears the buffer.
      // The terminal:exited subscriber reads this via the payload — once
      // `disposeHeadless` runs, `forensicsBuffer.getRecentOutput()` is gone.
      const recentOutput = this.forensicsBuffer.getRecentOutput();

      // teardown() returns false when kill() / dispose() got here first,
      // in which case the prior reason is preserved in `_ptyState`. The
      // event payload still carries the actual exit code from the PTY,
      // so subscribers see e.g. `reason: "kill"` with `code: 0`.
      const teardownReason = this.getExitReason() ?? "natural";
      this.teardown("natural");
      this.sessionSnapshotter.dispose();

      const reasonForEvent = this.getExitReason() ?? teardownReason;

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
        this._ptyState = {
          kind: "exited",
          code: exitCode ?? 0,
          signal,
          reason: reasonForEvent,
        };
        return;
      }

      this.disposeHeadless();
      this._ptyState = { kind: "disposed", reason: reasonForEvent };
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
    if (this.terminalInfo.spawnedAt !== spawnedAt) {
      console.warn(
        `[TerminalProcess] Rejected stale detection from old ProcessDetector ${this.id} ` +
          `(session ${spawnedAt} vs current ${this.terminalInfo.spawnedAt})`
      );
      return;
    }

    const terminal = this.terminalInfo;

    if (terminal.wasKilled) {
      return;
    }

    // Normalize legacy callers that only set `detected`. Callers that set
    // `detectionState` win; fall back to mapping `detected: boolean` onto
    // the four-state enum. This preserves existing test call sites while
    // new code branches on the richer enum. #5809
    const state: DetectionState = result.detectionState ?? (result.detected ? "agent" : "no_agent");

    // `unknown` and `ambiguous` are HOLD states — no evidence change, no
    // committed-state transition. Skip all branches so a blind `ps` cycle
    // doesn't silently demote a confirmed agent every HYSTERESIS window,
    // and a two-source conflict holds rather than flips. Precedent:
    // #4153 — make uncertain events no-ops in the state machine. #5809
    if (state === "unknown" || state === "ambiguous") {
      return;
    }

    const isDetected = state === "agent";

    // Set when we clear a runtime agent detection on this tick so the block
    // below can suppress a same-tick shell-headline emission that would
    // otherwise overwrite the "Exited" completion cue emitted by
    // updateAgentState. The next detector poll emits the shell headline
    // instead. #5773
    let justClearedDetection = false;

    if (isDetected && result.agentType && isBuiltInAgentId(result.agentType)) {
      const detectedAgentId: BuiltInAgentId = result.agentType;
      const previous = terminal.detectedAgentId;
      terminal.everDetectedAgent = true;

      if (previous !== detectedAgentId) {
        if (terminal.agentState === "exited") {
          this.deps.agentStateService.updateAgentState(terminal, { type: "respawn" });
        }

        terminal.detectedAgentId = detectedAgentId;

        const detection = getEffectiveAgentConfig(detectedAgentId)?.detection;
        const patternConfig = buildPatternConfig(detection, detectedAgentId);
        if (this.activityMonitor) {
          this.activityMonitor.reconfigure(detectedAgentId, patternConfig);
        } else {
          // Runtime promotion: plain terminal now hosts an agent. Start the
          // activity monitor immediately so the renderer sees state
          // transitions from the first tick forward.
          if (terminal.agentState === undefined) {
            terminal.agentState = "idle";
            terminal.lastStateChange = Date.now();
          }
          terminal.analysisEnabled = true;
          this.startActivityMonitor();
        }

        // Title sync: write the default-mode title so the renderer can pick
        // it up via the agent-detected event payload. User-renamed panels
        // (titleMode === "custom") are left alone.
        const nextTitle = computeDefaultTitle(terminal);
        if ((terminal.titleMode ?? "default") === "default") {
          terminal.title = nextTitle;
        }

        this.lastDetectedProcessIconId = result.processIconId;
        terminal.detectedProcessIconId = result.processIconId;
        events.emit("agent:detected", {
          terminalId: this.id,
          agentType: detectedAgentId,
          processIconId: result.processIconId,
          processName: result.processName || detectedAgentId,
          defaultTitle: nextTitle,
          timestamp: Date.now(),
        });
      }
    } else if (isDetected && !result.agentType && result.processIconId) {
      // Non-agent process detected (npm, python, docker, etc.)
      if (terminal.detectedAgentId) {
        logIdentityDebug(
          `[IdentityDebug] terminal-demote-hold term=${this.id.slice(-8)} ` +
            `reason=agent-requires-explicit-exit agent=${terminal.detectedAgentId} ` +
            `processIcon=${result.processIconId}`
        );
        return;
      }
      if (this.lastDetectedProcessIconId !== result.processIconId) {
        this.lastDetectedProcessIconId = result.processIconId;
        terminal.detectedProcessIconId = result.processIconId;
        events.emit("agent:detected", {
          terminalId: this.id,
          processIconId: result.processIconId,
          processName: result.processName || result.processIconId,
          timestamp: Date.now(),
        });
      }
    } else if (!isDetected && (terminal.detectedAgentId || this.lastDetectedProcessIconId)) {
      const previousAgent = terminal.detectedAgentId;
      if (previousAgent) {
        // The "agent-requires-explicit-exit" guard exists to keep durable
        // launch-affinity chrome stable through transient detection gaps —
        // process-tree blindness, blind-`ps` cycles, argv rewrites. It only
        // applies when the agent identity is anchored by `launchAgentId`
        // (toolbar/cold-launched). Runtime-promoted agents (user typed the
        // CLI into a plain shell) have no durable anchor: when `no_agent`
        // arrives we must demote regardless of evidence source, otherwise
        // a process-tree-absence tick after Ctrl+C can land here without
        // `evidenceSource: "shell_command"` and the chrome stays stuck on
        // `claude` until terminal teardown. Issue: v0.8.0 release E2E.
        if (terminal.launchAgentId && result.evidenceSource !== "shell_command") {
          logIdentityDebug(
            `[IdentityDebug] terminal-demote-hold term=${this.id.slice(-8)} ` +
              `reason=agent-requires-explicit-exit agent=${previousAgent}`
          );
          return;
        }
        logIdentityDebug(
          `[IdentityDebug] terminal-demote-apply term=${this.id.slice(-8)} ` +
            `reason=${result.evidenceSource === "shell_command" ? "prompt-return" : "no-agent-detected"} ` +
            `agent=${previousAgent} runtime=${terminal.launchAgentId ? "launch-anchored" : "runtime-promoted"}`
        );
        this.deps.agentStateService.updateAgentState(terminal, { type: "exit", code: 0 });
        terminal.detectedAgentId = undefined;
        justClearedDetection = true;
      }

      this.lastDetectedProcessIconId = undefined;
      terminal.detectedProcessIconId = undefined;
      this.stopActivityMonitor();
      if (previousAgent) {
        terminal.analysisEnabled = false;
      }
      const nextTitle = computeDefaultTitle(terminal);
      if (previousAgent && (terminal.titleMode ?? "default") === "default") {
        terminal.title = nextTitle;
      }
      // Emit `agent:exited` to clear the renderer's live-detection fields
      // (`detectedAgentId`, `detectedProcessId`). Stamp `exitKind: "subcommand"`
      // only when an actual agent process exited so the renderer can distinguish
      // from plain process-icon clearings (npm/vite/etc.).
      events.emit("agent:exited", {
        terminalId: this.id,
        agentType: previousAgent,
        defaultTitle: previousAgent ? nextTitle : undefined,
        timestamp: Date.now(),
        ...(previousAgent ? { exitKind: "subcommand" as const } : {}),
      });
    }

    // Route to shell-style headlines when no agent is live. Covers plain
    // terminals (no launch hint, no detection) and agent-launched terminals
    // whose agent exited — which keep an active shell PTY and should surface
    // shell activity rather than a stale "Agent working" headline. Skip on
    // the exact tick we just emitted an "Exited" completion cue so it isn't
    // overwritten.
    const hasLiveAgent =
      !!terminal.detectedAgentId || (!!terminal.launchAgentId && terminal.agentState !== "exited");
    if (!justClearedDetection && !hasLiveAgent) {
      const lastCommand = result.currentCommand || this.semanticBufferManager.getLastCommand();

      const { headline, status, type } = this.headlineGenerator.generate({
        terminalId: this.id,
        activity: result.isBusy ? "busy" : "idle",
        lastCommand,
      });

      events.emit("terminal:activity", {
        terminalId: this.id,
        headline,
        status,
        type,
        confidence: 1.0,
        timestamp: Date.now(),
        lastCommand,
      });
    }
  }
}
