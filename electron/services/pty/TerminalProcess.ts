import { spawnSync } from "child_process";
import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
import {
  ProcessDetector,
  detectCommandIdentity,
  redactArgv,
  type CommandIdentity,
  type DetectionResult,
  type DetectionState,
} from "../ProcessDetector.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { AgentStateService } from "./AgentStateService.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import {
  type PtySpawnOptions,
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
  SESSION_SNAPSHOT_MAX_BYTES,
  SESSION_SNAPSHOT_DEBOUNCE_MS,
  restoreSessionFromFile,
  persistSessionSnapshotSync,
  persistSessionSnapshotAsync,
  isSessionPersistSuppressed,
} from "./terminalSessionPersistence.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
  buildPatternConfig,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { ProcessTreeKiller } from "./ProcessTreeKiller.js";
import { detectPrompt } from "./PromptDetector.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import type { SpawnContext } from "./terminalSpawn.js";

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

const EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS = 2000;
const SHELL_IDENTITY_FALLBACK_COMMIT_MS = 1200;
const SHELL_IDENTITY_FALLBACK_POLL_MS = 200;
const SHELL_IDENTITY_FALLBACK_PROMPT_POLLS = 2;
const SHELL_IDENTITY_FALLBACK_SCAN_LINES = 4;
const SHELL_INPUT_BUFFER_MAX = 4096;
const SHELL_PROMPT_PATTERNS = [
  /^\s*[>›❯⟩$#%]\s*$/,
  /^\s*[A-Za-z0-9_.-]+@[\w.-]+(?:\s+[^\r\n]*)?\s*[#$%>]\s*$/,
  /^\s*[➜➤➟➔❯›]\s+.*$/,
] as const;
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

  private writeQueue!: WriteQueue;
  private readonly processTreeKiller: ProcessTreeKiller;
  private shellIdentityFallbackTimer: NodeJS.Timeout | null = null;
  private shellIdentityFallbackSubmittedAt: number | null = null;
  private shellIdentityFallbackCommandText: string | undefined;
  private shellIdentityFallbackIdentity: CommandIdentity | null = null;
  private shellIdentityFallbackCommitted = false;
  private shellIdentityFallbackPromptStreak = 0;
  private shellIdentityFallbackSawPtyDescendant = false;
  private suppressNextShellSubmitSignal = false;
  private shellInputBuffer = "";
  private seededLaunchCommandText: string | undefined;

  private _scrollback: number;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private sessionPersistTimer: NodeJS.Timeout | null = null;
  private sessionPersistDirty = false;
  private sessionPersistInFlight = false;
  private lastEventDrivenFlushAt = -Infinity;

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

  private scheduleSessionPersist(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.terminalInfo.launchAgentId) return;
    if (this.terminalInfo.wasKilled) return;

    this.sessionPersistDirty = true;
    if (this.sessionPersistTimer) return;

    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = null;
      void this.persistSessionSnapshot();
    }, SESSION_SNAPSHOT_DEBOUNCE_MS);
  }

  private async persistSessionSnapshot(): Promise<void> {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.terminalInfo.launchAgentId) return;
    if (this.terminalInfo.wasKilled) return;
    if (!this.sessionPersistDirty) return;
    if (this.sessionPersistInFlight) return;

    this.sessionPersistInFlight = true;
    try {
      this.sessionPersistDirty = false;
      const state =
        this._restoreBannerStart || this._restoreBannerEnd
          ? this._serializeForPersistence()
          : await this.getSerializedStateAsync();
      if (!state) return;
      if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
        return;
      }
      await persistSessionSnapshotAsync(this.id, state);
    } catch (error) {
      console.warn(`[TerminalProcess] Failed to persist session for ${this.id}:`, error);
    } finally {
      this.sessionPersistInFlight = false;
      if (this.sessionPersistDirty) {
        this.scheduleSessionPersist();
      }
    }
  }

  private clearSessionPersistTimer(): void {
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer);
      this.sessionPersistTimer = null;
    }
  }

  flushEventDrivenSnapshot(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (isSessionPersistSuppressed()) return;
    if (this.terminalInfo.wasKilled) return;

    const now = performance.now();
    if (now - this.lastEventDrivenFlushAt < EVENT_DRIVEN_SNAPSHOT_THROTTLE_MS) return;
    this.lastEventDrivenFlushAt = now;

    const state = this.getSerializedState();
    if (!state) return;
    if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;

    persistSessionSnapshotAsync(this.id, state).catch((error) => {
      console.warn(`[TerminalProcess] Event-driven snapshot failed for ${this.id}:`, error);
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
      isExited: () => this.terminalInfo.isExited === true,
      lastOutputTime: () => this.terminalInfo.lastOutputTime,
      performSubmit: (text) => this.performSubmit(text),
      onWriteError: (error, context) => this.logWriteError(error, context),
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
        deps.processTreeCache
      );
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
      this.seedInitialCommandIdentity(options.command);
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

  /** @deprecated Use getPublicState() for IPC-safe data */
  getInfo(): TerminalInfo {
    return this.terminalInfo;
  }

  getPublicState(): TerminalPublicState {
    const t = this.terminalInfo;
    // Terminal has a PTY when it hasn't been killed and hasn't exited
    const hasPty = !t.wasKilled && !t.isExited;
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
      wasKilled: t.wasKilled,
      isExited: t.isExited,
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
    const isSeededLaunchCommandSubmit =
      !bracketedPaste &&
      this.seededLaunchCommandText !== undefined &&
      /[\r\n]/.test(data) &&
      this.normalizeShellCommandText(data) === this.seededLaunchCommandText;
    // Shell input capture is only meaningless when a live AGENT owns the PTY
    // (agents have their own input semantics). A plain process badge (npm,
    // pnpm, docker, etc.) does not change the shell semantics — the shell
    // is still the direct recipient of typed commands, and the next command
    // must still be visible to the fallback detector so a follow-up
    // `pnpm build` can re-identify the badge. #5813
    const canCaptureShellInput =
      !bracketedPaste &&
      (this.terminalInfo.detectedAgentId === undefined || isSeededLaunchCommandSubmit);
    const submittedCommandText = canCaptureShellInput ? this.captureShellInput(data) : undefined;
    const isAgentUiPromptResponse =
      !bracketedPaste &&
      submittedCommandText === undefined &&
      this.shellIdentityFallbackIdentity?.agentType !== undefined &&
      (!this.shellIdentityFallbackCommitted || this.hasAgentUiPromptFalsePositive());

    if (!bracketedPaste && /[\r\n]/.test(data)) {
      if (this.suppressNextShellSubmitSignal) {
        this.suppressNextShellSubmitSignal = false;
      } else if (isAgentUiPromptResponse) {
        logIdentityDebug(
          `[IdentityDebug] shell-submit-skip term=${this.id.slice(-8)} reason=agent-ui-prompt`
        );
      } else {
        this.markShellCommandSubmitted(submittedCommandText, {
          allowWhenAgentDetected: isSeededLaunchCommandSubmit,
        });
      }
      if (isSeededLaunchCommandSubmit) {
        this.seededLaunchCommandText = undefined;
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
      this.suppressNextShellSubmitSignal = true;
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

    this.suppressNextShellSubmitSignal = true;
    this.markShellCommandSubmitted(body);
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

    const liveAgentId = getLiveAgentId(terminal);
    const agentConfig = liveAgentId ? getEffectiveAgentConfig(liveAgentId) : undefined;

    if (!agentConfig?.shutdown) {
      return null;
    }

    const { quitCommand, sessionIdPattern } = agentConfig.shutdown;
    const pattern = new RegExp(sessionIdPattern);

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

        try {
          terminal.ptyProcess.write(quitCommand + "\r");
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

    if (this.processDetector) {
      this.processDetector.stop();
      this.processDetector = null;
      terminal.processDetector = undefined;
    }

    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }

    this.semanticBufferManager.flush();

    this.writeQueue.dispose();

    // Flush session snapshot synchronously before marking as killed.
    // Once wasKilled is set, all persistence paths are blocked, and
    // disposeHeadless() destroys the buffer — so this is the last chance.
    if (
      TERMINAL_SESSION_PERSISTENCE_ENABLED &&
      !this.terminalInfo.launchAgentId &&
      !isSessionPersistSuppressed()
    ) {
      try {
        const state = this.getSerializedState();
        if (state && Buffer.byteLength(state, "utf8") <= SESSION_SNAPSHOT_MAX_BYTES) {
          persistSessionSnapshotSync(this.id, state);
        }
      } catch {
        // best-effort only
      }
    }

    terminal.wasKilled = true;
    this.clearSessionPersistTimer();

    if (getLiveAgentId(terminal)) {
      this.deps.agentStateService.updateAgentState(terminal, {
        type: "kill",
      });
      this.deps.agentStateService.emitAgentKilled(terminal, reason);
    }

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

  private normalizeShellCommandText(commandText?: string): string | undefined {
    if (!commandText) return undefined;
    const normalized = commandText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const line of normalized.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    return undefined;
  }

  private captureShellInput(data: string): string | undefined {
    let submittedCommandText: string | undefined;
    let inEscapeSequence = false;

    for (const char of data) {
      if (inEscapeSequence) {
        if ((char >= "@" && char <= "~") || char === "\u0007") {
          inEscapeSequence = false;
        }
        continue;
      }

      if (char === "\x1b") {
        inEscapeSequence = true;
        continue;
      }

      if (char === "\b" || char === "\x7f") {
        this.shellInputBuffer = this.shellInputBuffer.slice(0, -1);
        continue;
      }

      if (char === "\r" || char === "\n") {
        submittedCommandText = this.normalizeShellCommandText(this.shellInputBuffer);
        this.shellInputBuffer = "";
        continue;
      }

      if (char < " ") {
        continue;
      }

      if (this.shellInputBuffer.length < SHELL_INPUT_BUFFER_MAX) {
        this.shellInputBuffer += char;
      }
    }

    return submittedCommandText;
  }

  private markShellCommandSubmitted(
    commandText?: string,
    options: { allowWhenAgentDetected?: boolean } = {}
  ): void {
    if (this.terminalInfo.isExited || this.terminalInfo.wasKilled) {
      return;
    }

    // Only skip when a live agent is already detected. A stale
    // `lastDetectedProcessIconId` must not block re-arming the fallback — if
    // the user ran `npm run dev` then Ctrl+C then typed `pnpm dev`, the new
    // command must be allowed to restart detection regardless of whether the
    // previous badge was cleared by the process-tree path yet.
    if (this.terminalInfo.detectedAgentId && !options.allowWhenAgentDetected) {
      return;
    }

    this.shellIdentityFallbackSubmittedAt = Date.now();
    this.shellIdentityFallbackCommandText = this.normalizeShellCommandText(commandText);
    this.shellIdentityFallbackIdentity = this.shellIdentityFallbackCommandText
      ? detectCommandIdentity(this.shellIdentityFallbackCommandText)
      : null;
    this.shellIdentityFallbackCommitted = false;
    this.shellIdentityFallbackPromptStreak = 0;
    this.shellIdentityFallbackSawPtyDescendant = false;

    // If the new command has no recognizable identity (e.g. `echo hi` after a
    // prior `npm run dev` that committed `npm`), clear any stale shell
    // evidence on the detector so it doesn't keep the prior identity sticky
    // for the full TTL. Identity-carrying commands overwrite via the
    // watcher's later inject call. #5809
    if (!this.shellIdentityFallbackIdentity) {
      this.processDetector?.clearShellCommandEvidence();
    }

    this.startShellIdentityFallbackWatcher();
  }

  private seedInitialCommandIdentity(commandText?: string): void {
    if (!this.processDetector) return;
    const normalized = this.normalizeShellCommandText(commandText);
    if (!normalized) return;
    const identity = detectCommandIdentity(normalized);
    if (!identity) return;
    this.seededLaunchCommandText = normalized;
    logIdentityDebug(
      `[IdentityDebug] shell-submit term=${this.id.slice(-8)} src=spawn ` +
        `agent=${identity.agentType ?? "<none>"} icon=${identity.processIconId ?? "<none>"} ` +
        `argv0=${redactArgv(normalized)}`
    );
    this.processDetector.injectShellCommandEvidence(identity, normalized);
    this.markShellCommandSubmitted(normalized, { allowWhenAgentDetected: true });
    this.seededLaunchCommandText = undefined;
  }

  private startShellIdentityFallbackWatcher(): void {
    if (this.shellIdentityFallbackTimer) {
      return;
    }
    this.shellIdentityFallbackTimer = setInterval(() => {
      this.pollShellIdentityFallback();
    }, SHELL_IDENTITY_FALLBACK_POLL_MS);
  }

  private stopShellIdentityFallbackWatcher(): void {
    if (this.shellIdentityFallbackTimer) {
      clearInterval(this.shellIdentityFallbackTimer);
      this.shellIdentityFallbackTimer = null;
    }
    this.shellIdentityFallbackSubmittedAt = null;
    this.shellIdentityFallbackCommandText = undefined;
    this.shellIdentityFallbackIdentity = null;
    this.shellIdentityFallbackCommitted = false;
    this.shellIdentityFallbackPromptStreak = 0;
    this.shellIdentityFallbackSawPtyDescendant = false;
  }

  private getPtyDescendantCount(): number | undefined {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (ptyPid === undefined || !this.deps.processTreeCache) {
      return undefined;
    }
    return this.deps.processTreeCache.getDescendantPids(ptyPid).length;
  }

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

    try {
      const result = spawnSync("ps", ["-o", "pgid=,tpgid=", "-p", String(ptyPid)], {
        encoding: "utf8",
        timeout: 750,
      });
      if (result.status !== 0 || result.error) {
        return null;
      }
      const [pgidText, tpgidText] = result.stdout.trim().split(/\s+/);
      const shellPgid = Number.parseInt(pgidText ?? "", 10);
      const foregroundPgid = Number.parseInt(tpgidText ?? "", 10);
      if (!Number.isFinite(shellPgid) || !Number.isFinite(foregroundPgid)) {
        return null;
      }
      return { shellPgid, foregroundPgid };
    } catch {
      return null;
    }
  }

  private isForegroundShellIdleForAgentDemotion(): boolean {
    const snapshot = this.readForegroundProcessGroupSnapshot();
    if (!snapshot) {
      // Non-POSIX and unsupported environments fall back to the legacy prompt
      // path. On macOS/Linux this snapshot is the authoritative demotion gate.
      return true;
    }

    if (snapshot.shellPgid <= 0 || snapshot.foregroundPgid <= 0) {
      return true;
    }

    return snapshot.shellPgid === snapshot.foregroundPgid;
  }

  private hasRecentCommandFailureOutput(): boolean {
    const recent = this.getLastNLines(SHELL_IDENTITY_FALLBACK_SCAN_LINES).join("\n");
    return /(?:command not found|not found|no such file|permission denied)/i.test(recent);
  }

  private hasAgentUiPromptFalsePositive(): boolean {
    const lines = this.getLastNLines(SHELL_IDENTITY_FALLBACK_SCAN_LINES);
    const lastVisibleLine = [...lines]
      .reverse()
      .find((line) => typeof line === "string" && line.trim().length > 0);
    const recent = [this.getCursorLine(), lastVisibleLine]
      .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
      .join("\n");
    return (
      /(?:accessing workspace|yes,\s*i trust this folder|enter to confirm|quick safety check)/i.test(
        recent
      ) || /^\s*[❯›]\s+\d+\./m.test(recent)
    );
  }

  private isShellPromptVisible(): boolean {
    const prompt = detectPrompt(
      this.getLastNLines(SHELL_IDENTITY_FALLBACK_SCAN_LINES),
      {
        promptPatterns: [...SHELL_PROMPT_PATTERNS],
        promptHintPatterns: [],
        promptScanLineCount: SHELL_IDENTITY_FALLBACK_SCAN_LINES,
        promptConfidence: 0.85,
      },
      this.getCursorLine()
    );
    return prompt.isPrompt;
  }

  private pollShellIdentityFallback(): void {
    const submittedAt = this.shellIdentityFallbackSubmittedAt;
    if (submittedAt === null || this.terminalInfo.isExited || this.terminalInfo.wasKilled) {
      this.stopShellIdentityFallbackWatcher();
      return;
    }

    if (!this.shellIdentityFallbackIdentity) {
      const commandText =
        this.shellIdentityFallbackCommandText ??
        (this.terminalInfo.lastOutputTime >= submittedAt
          ? this.semanticBufferManager.getLastCommand()
          : undefined);
      const normalized = this.normalizeShellCommandText(commandText);
      if (normalized) {
        this.shellIdentityFallbackCommandText = normalized;
        this.shellIdentityFallbackIdentity = detectCommandIdentity(normalized);
      }
    }

    const ptyDescendantCount = this.getPtyDescendantCount();
    const hasPtyDescendants = ptyDescendantCount !== undefined && ptyDescendantCount > 0;
    if (hasPtyDescendants) {
      this.shellIdentityFallbackSawPtyDescendant = true;
    }

    const promptVisible = this.isShellPromptVisible();
    // A live identity only pre-empts the fallback commit when it matches what
    // the fallback detected — a stale badge (e.g. a prior `npm run dev` whose
    // icon hasn't been cleared yet) must NOT block the fallback from emitting
    // a fresh `pnpm`/`docker`/etc. detection for the next command. #5813
    const fallbackIdentity = this.shellIdentityFallbackIdentity;
    const liveIdentityMatchesFallback =
      fallbackIdentity !== null &&
      ((fallbackIdentity.agentType !== undefined &&
        this.terminalInfo.detectedAgentId === fallbackIdentity.agentType) ||
        (fallbackIdentity.processIconId !== undefined &&
          this.lastDetectedProcessIconId === fallbackIdentity.processIconId));

    if (!this.shellIdentityFallbackIdentity) {
      if (promptVisible && Date.now() - submittedAt >= SHELL_IDENTITY_FALLBACK_COMMIT_MS) {
        logIdentityDebug(
          `[IdentityDebug] shell-fallback-stop term=${this.id.slice(-8)} reason=no-identity-prompt`
        );
        this.stopShellIdentityFallbackWatcher();
      }
      return;
    }

    if (!this.shellIdentityFallbackCommitted) {
      if (liveIdentityMatchesFallback) {
        this.shellIdentityFallbackCommitted = true;
        return;
      }

      if (promptVisible && !this.shellIdentityFallbackIdentity.agentType) {
        logIdentityDebug(
          `[IdentityDebug] shell-fallback-stop term=${this.id.slice(-8)} ` +
            `reason=prompt-before-commit icon=${this.shellIdentityFallbackIdentity.processIconId ?? "<none>"}`
        );
        this.stopShellIdentityFallbackWatcher();
        return;
      }

      if (Date.now() - submittedAt < SHELL_IDENTITY_FALLBACK_COMMIT_MS) {
        return;
      }

      // Route shell-command evidence through ProcessDetector so the merge with
      // process-tree evidence lives in one place. The detector applies the
      // sticky TTL (~12 s) which anchors this commit through blind-`ps`
      // cycles and short-lived subprocess thrash. If no detector exists
      // (null cache path), fall back to the legacy direct emission so a
      // degraded terminal still surfaces shell-command identity. #5809
      if (this.processDetector) {
        this.processDetector.injectShellCommandEvidence(
          this.shellIdentityFallbackIdentity,
          this.shellIdentityFallbackCommandText
        );
      } else {
        this.handleAgentDetection(
          {
            detectionState: "agent",
            detected: true,
            agentType: this.shellIdentityFallbackIdentity.agentType,
            processIconId: this.shellIdentityFallbackIdentity.processIconId,
            processName: this.shellIdentityFallbackIdentity.processName,
            isBusy: true,
            currentCommand: this.shellIdentityFallbackCommandText,
            evidenceSource: "shell_command",
          },
          this.terminalInfo.spawnedAt
        );
      }
      this.shellIdentityFallbackCommitted = true;
      return;
    }

    if (!promptVisible) {
      this.shellIdentityFallbackPromptStreak = 0;
      return;
    }

    if (
      this.shellIdentityFallbackIdentity.agentType &&
      !this.hasRecentCommandFailureOutput() &&
      !this.isForegroundShellIdleForAgentDemotion()
    ) {
      if (this.shellIdentityFallbackPromptStreak > 0) {
        logIdentityDebug(
          `[IdentityDebug] shell-fallback-hold term=${this.id.slice(-8)} ` +
            `reason=foreground-child-active`
        );
      }
      this.shellIdentityFallbackPromptStreak = 0;
      return;
    }

    if (
      this.shellIdentityFallbackIdentity.agentType &&
      !this.hasRecentCommandFailureOutput() &&
      this.hasAgentUiPromptFalsePositive()
    ) {
      if (this.shellIdentityFallbackPromptStreak > 0) {
        logIdentityDebug(
          `[IdentityDebug] shell-fallback-hold term=${this.id.slice(-8)} ` +
            `reason=agent-ui-prompt count=${ptyDescendantCount ?? "unknown"} ` +
            `sawDescendant=${this.shellIdentityFallbackSawPtyDescendant}`
        );
      }
      this.shellIdentityFallbackPromptStreak = 0;
      return;
    }

    this.shellIdentityFallbackPromptStreak += 1;
    if (this.shellIdentityFallbackPromptStreak < SHELL_IDENTITY_FALLBACK_PROMPT_POLLS) {
      return;
    }

    // Prompt has returned — the command has finished. Clear the injected
    // shell evidence as an explicit lifecycle demotion. Process-tree absence
    // is not authoritative for agent exit; shell prompt return is. When no
    // detector is attached, fall back to the legacy direct emission so the UI
    // still demotes promptly.
    if (this.processDetector) {
      this.processDetector.clearShellCommandEvidence("prompt-return");
    } else {
      this.handleAgentDetection(
        {
          detectionState: "no_agent",
          detected: false,
          isBusy: false,
          currentCommand: undefined,
        },
        this.terminalInfo.spawnedAt
      );
    }
    this.stopShellIdentityFallbackWatcher();
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
        this.deps.processTreeCache
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
    this.stopProcessDetector();
    this.stopActivityMonitor();
    this.stopShellIdentityFallbackWatcher();

    this.semanticBufferManager.dispose();

    if (
      TERMINAL_SESSION_PERSISTENCE_ENABLED &&
      this.sessionPersistDirty &&
      !this.terminalInfo.wasKilled &&
      !isSessionPersistSuppressed()
    ) {
      try {
        const state = this._serializeForPersistence() ?? this.getSerializedState();
        if (state && Buffer.byteLength(state, "utf8") <= SESSION_SNAPSHOT_MAX_BYTES) {
          persistSessionSnapshotSync(this.id, state);
          this.sessionPersistDirty = false;
        }
      } catch {
        // best-effort only
      }
    }

    this.clearSessionPersistTimer();

    this.writeQueue.dispose();

    this.disposeHeadless();

    this.processTreeKiller.execute(true);
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
      this.scheduleSessionPersist();

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

      this.stopProcessDetector();
      this.stopActivityMonitor();
      this.stopShellIdentityFallbackWatcher();
      this.semanticBufferManager.flush();

      this.writeQueue.dispose();

      this.clearSessionPersistTimer();
      this.sessionPersistDirty = false;

      this.processTreeKiller.abort();

      const hadAgent = !!terminal.launchAgentId || !!terminal.everDetectedAgent;
      const liveAgentAtExit = getLiveAgentId(terminal);
      this.forensicsBuffer.logForensics(this.id, exitCode ?? 0, terminal, hadAgent, signal);

      if (hadAgent && !terminal.wasKilled) {
        this.deps.agentStateService.updateAgentState(terminal, {
          type: "exit",
          code: exitCode ?? 0,
          signal: signal ?? undefined,
        });
      }

      if (hadAgent && liveAgentAtExit && !terminal.wasKilled) {
        this.deps.agentStateService.emitAgentCompleted(terminal, exitCode ?? 0);
      }

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

      // Fallback detection: inspect the forensic buffer BEFORE teardown clears
      // anything and emit a fallback-triggered event so the renderer can walk
      // the preset's fallbacks[] chain. Passive observation only — we do not
      // modify the terminal, spawn anything, or touch user config here.
      if (terminal.launchAgentId && terminal.agentPresetId && !terminal.wasKilled) {
        const cls = classifyExitOutput({
          recentOutput: this.forensicsBuffer.getRecentOutput(),
          // Pass through as-is so a null/undefined code (crash, signal) does
          // NOT short-circuit the scan. Only an explicit exit 0 skips the tail.
          exitCode: exitCode,
          wasKilled: terminal.wasKilled,
        });
        if (shouldTriggerFallback(cls)) {
          events.emit("agent:fallback-triggered", {
            terminalId: this.id,
            agentId: terminal.launchAgentId,
            fromPresetId: terminal.agentPresetId,
            originalPresetId: terminal.originalAgentPresetId ?? terminal.agentPresetId,
            reason: cls as "connection" | "auth",
            exitCode: exitCode ?? 0,
            timestamp: Date.now(),
          });
        }
      }

      if (this.shouldPreserveOnExit(exitCode ?? 0)) {
        terminal.exitCode = exitCode ?? 0;
        terminal.isExited = true;
        return;
      }

      this.disposeHeadless();
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
        if (result.evidenceSource !== "shell_command") {
          logIdentityDebug(
            `[IdentityDebug] terminal-demote-hold term=${this.id.slice(-8)} ` +
              `reason=agent-requires-explicit-exit agent=${previousAgent}`
          );
          return;
        }
        logIdentityDebug(
          `[IdentityDebug] terminal-demote-apply term=${this.id.slice(-8)} ` +
            `reason=prompt-return agent=${previousAgent}`
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
