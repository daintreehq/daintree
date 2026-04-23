import { spawnSync } from "child_process";
import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import {
  ProcessDetector,
  detectCommandIdentity,
  type CommandIdentity,
  type DetectionResult,
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
  AGENT_SCROLLBACK,
  WRITE_INTERVAL_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
} from "./types.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";
import { events } from "../events.js";
import { AgentSpawnedSchema } from "../../schemas/agent.js";
import type { PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { classifyExitOutput, shouldTriggerFallback } from "./FallbackErrorClassifier.js";

// Extracted modules
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  getSubmitEnterDelay,
  isBracketedPaste,
  chunkInput,
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
import { detectPrompt } from "./PromptDetector.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import type { SpawnContext } from "./terminalSpawn.js";

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

// OSC 10/11 "?" queries terminated by BEL (\x07) or ST (\x1b\\).
// Trigger and strip must use the same terminator-requiring pattern: if we
// responded on an unterminated fragment but stripped only terminated ones,
// a split chunk would leak the fragment to the renderer and double-respond
// once xterm.js re-assembles the sequence.
// eslint-disable-next-line no-control-regex
const OSC_10_QUERY_RE = /\x1b\]10;\?(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const OSC_11_QUERY_RE = /\x1b\]11;\?(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const OSC_10_QUERY_STRIP_RE = /\x1b\]10;\?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OSC_11_QUERY_STRIP_RE = /\x1b\]11;\?(?:\x07|\x1b\\)/g;

// Live agent identity — prefers launch intent (`agentId`) but falls back to
// runtime-detected identity (`detectedAgentType`) so consumers observe the
// agent that is currently running in this PTY without forcing the detection
// code to mutate the sealed `agentId` field. See #5803 and
// `docs/architecture/terminal-identity.md`.
function getLiveAgentId(terminal: TerminalInfo): string | undefined {
  return terminal.agentId ?? terminal.detectedAgentType;
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
  private submitQueue: string[] = [];
  private submitInFlight = false;
  private headlineGenerator = new ActivityHeadlineGenerator();
  private lastDetectedProcessIconId: string | undefined;

  private lastWriteErrorLogTime = 0;
  private suppressedWriteErrorCount = 0;

  private semanticBufferManager!: SemanticBufferManager;

  private inputWriteQueue: string[] = [];
  private inputWriteTimeout: NodeJS.Timeout | null = null;
  private killTreeTimer: NodeJS.Timeout | null = null;
  private shellIdentityFallbackTimer: NodeJS.Timeout | null = null;
  private shellIdentityFallbackSubmittedAt: number | null = null;
  private shellIdentityFallbackCommandText: string | undefined;
  private shellIdentityFallbackIdentity: CommandIdentity | null = null;
  private shellIdentityFallbackCommitted = false;
  private shellIdentityFallbackPromptStreak = 0;
  private suppressNextShellSubmitSignal = false;
  private shellInputBuffer = "";

  private _scrollback: number;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private sessionPersistTimer: NodeJS.Timeout | null = null;
  private sessionPersistDirty = false;
  private sessionPersistInFlight = false;
  private lastEventDrivenFlushAt = -Infinity;

  private readonly terminalInfo: TerminalInfo;
  private readonly isAgentTerminal: boolean;
  // Live identity check for OSC 10/11 color-query responder ownership.
  // Spawn-time agents (kind="agent") own the responder from construction;
  // plain terminals promoted at runtime via handleAgentDetection own it while
  // detectedAgentType is set and release it on demotion.
  private get shouldHandleOscColorQueries(): boolean {
    return this.isAgentTerminal || this.terminalInfo.detectedAgentType !== undefined;
  }
  private forensicsBuffer = new TerminalForensicsBuffer();
  private _activityTier: "active" | "background" = "active";
  private _restoreBannerStart: IMarker | null = null;
  private _restoreBannerEnd: IMarker | null = null;
  private readonly textDecoder = new TextDecoder();

  private restoreSessionIfPresent(headlessTerminal: HeadlessTerminalType): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (this.isAgentTerminal) return;
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
    if (this.isAgentTerminal) return;
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
    if (this.isAgentTerminal) return;
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
    const { shell, args: spawnArgs, isAgentTerminal, agentId } = spawnContext;
    const spawnedAt = Date.now();

    this.isAgentTerminal = isAgentTerminal;

    this._scrollback = this.isAgentTerminal ? AGENT_SCROLLBACK : DEFAULT_SCROLLBACK;

    const headlessTerminal: HeadlessTerminalType = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: this._scrollback,
      allowProposedApi: true,
    });
    const serializeAddon: SerializeAddonType = new SerializeAddon();
    headlessTerminal.loadAddon(serializeAddon);
    this.restoreSessionIfPresent(headlessTerminal);

    // Sealed-at-spawn capability mode (#5804). Derived from launch intent: a
    // cold-launched agent terminal whose `agentId` is a built-in agent gets
    // `full` capability; plain shells and non-built-in agents do not. Never
    // mutated by runtime process detection — `handleAgentDetection` may flip
    // chrome-facing fields like `detectedAgentType`, but this stays sealed.
    const capabilityAgentId =
      this.isAgentTerminal && isBuiltInAgentId(agentId) ? agentId : undefined;

    this.terminalInfo = {
      id,
      projectId: options.projectId,
      ptyProcess,
      cwd: options.cwd,
      shell,
      kind: options.kind,
      type: options.type,
      title: options.title,
      agentId,
      capabilityAgentId,
      spawnedAt,
      agentState: this.isAgentTerminal ? "idle" : undefined,
      lastStateChange: this.isAgentTerminal ? spawnedAt : undefined,
      outputBuffer: "",
      lastInputTime: spawnedAt,
      lastOutputTime: spawnedAt,
      lastCheckTime: spawnedAt,
      semanticBuffer: [],
      inputWriteQueue: [],
      inputWriteTimeout: null,
      headlessTerminal,
      serializeAddon,
      rawOutputBuffer: undefined,
      restartCount: 0,
      analysisEnabled: this.isAgentTerminal,
      agentLaunchFlags: options.agentLaunchFlags,
      agentModelId: options.agentModelId,
      worktreeId: options.worktreeId,
      agentPresetId: options.agentPresetId,
      originalAgentPresetId: options.originalAgentPresetId ?? options.agentPresetId,
      spawnArgs,
    };

    // NOTE: The headless responder is intentionally NOT installed for agent
    // terminals. It would forward query responses (CSI 6n cursor position,
    // CSI c device attributes) from the headless terminal back to the PTY.
    // But the frontend xterm.js ALSO responds to these same queries when it
    // processes the output, causing double responses that corrupt Crossterm/
    // Ratatui's input parser (Codex, OpenCode) and Ink's state (Claude Code).
    // The frontend xterm.js is the sole query responder for agent terminals.

    this.semanticBufferManager = new SemanticBufferManager(this.terminalInfo);
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
    }

    if (this.isAgentTerminal) {
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
          ...buildActivityMonitorOptions(
            this.terminalInfo.agentId ??
              (this.terminalInfo.type !== "terminal" ? this.terminalInfo.type : undefined),
            {
              getVisibleLines: (n) => this.getLastNLines(n),
              getCursorLine: () => this.getCursorLine(),
            }
          ),
          processStateValidator,
        }
      );
      this.activityMonitor.startPolling();
    }

    if (this.isAgentTerminal && agentId) {
      const spawnedPayload = {
        agentId,
        terminalId: id,
        type: options.type,
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
      type: t.type,
      agentId: t.agentId,
      title: t.title,
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
      detectedAgentType: t.detectedAgentType,
      detectedProcessIconId: t.detectedProcessIconId,
      everDetectedAgent: t.everDetectedAgent,
      capabilityAgentId: t.capabilityAgentId,
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
    };
  }

  getIsAgentTerminal(): boolean {
    return this.isAgentTerminal;
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
    // Shell input capture is only meaningless when a live AGENT owns the PTY
    // (agents have their own input semantics). A plain process badge (npm,
    // pnpm, docker, etc.) does not change the shell semantics — the shell
    // is still the direct recipient of typed commands, and the next command
    // must still be visible to the fallback detector so a follow-up
    // `pnpm build` can re-identify the badge. #5813
    const canCaptureShellInput =
      !bracketedPaste && this.terminalInfo.detectedAgentType === undefined;
    const submittedCommandText = canCaptureShellInput ? this.captureShellInput(data) : undefined;

    if (!bracketedPaste && /[\r\n]/.test(data)) {
      if (this.suppressNextShellSubmitSignal) {
        this.suppressNextShellSubmitSignal = false;
      } else {
        this.markShellCommandSubmitted(submittedCommandText);
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

    const chunks = chunkInput(data);
    this.inputWriteQueue.push(...chunks);
    this.startWrite();
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

    this.submitQueue.push(text);
    if (this.submitInFlight) {
      return;
    }
    this.submitInFlight = true;
    void this.drainSubmitQueue();
  }

  private async drainSubmitQueue(): Promise<void> {
    try {
      while (this.submitQueue.length > 0) {
        const next = this.submitQueue.shift();
        if (next === undefined) {
          continue;
        }
        await this.performSubmit(next);
      }
    } finally {
      this.submitInFlight = false;
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

    await this.waitForInputWriteDrain();

    if (useOutputSettle) {
      await this.waitForOutputSettle();
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

  private async waitForInputWriteDrain(): Promise<void> {
    if (this.inputWriteQueue.length === 0 && this.inputWriteTimeout === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.terminalInfo.isExited || !this.terminalInfo.ptyProcess) {
          resolve();
          return;
        }
        if (this.inputWriteQueue.length === 0 && this.inputWriteTimeout === null) {
          resolve();
          return;
        }
        setTimeout(check, 0);
      };
      check();
    });
  }

  private async waitForOutputSettle(): Promise<void> {
    const startWait = Date.now();
    const terminal = this.terminalInfo;

    while (true) {
      if (terminal.isExited || !terminal.ptyProcess || terminal.wasKilled) {
        return;
      }

      const settleFrom = Math.max(startWait, terminal.lastOutputTime);
      const timeSinceOutput = Date.now() - settleFrom;

      if (timeSinceOutput >= OUTPUT_SETTLE_DEBOUNCE_MS) {
        return;
      }

      if (Date.now() - startWait > OUTPUT_SETTLE_MAX_WAIT_MS) {
        return;
      }

      await delay(OUTPUT_SETTLE_POLL_INTERVAL_MS);
    }
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

  /**
   * Kill the entire process tree rooted at the PTY shell.
   * Sends SIGTERM to all descendants bottom-up (leaves first), then kills the shell.
   * @param immediate If true, SIGKILL is sent synchronously (for process.on("exit") context
   *   where timers don't fire). If false, SIGKILL escalation fires after 500ms.
   */
  private killProcessTree(immediate: boolean): void {
    // Clear any pending escalation timer from a prior kill() call
    if (this.killTreeTimer) {
      clearTimeout(this.killTreeTimer);
      this.killTreeTimer = null;
    }

    const shellPid = this.terminalInfo.ptyProcess.pid;

    if (shellPid === undefined || shellPid <= 0) {
      try {
        this.terminalInfo.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
      return;
    }

    // Windows: use taskkill /T /F which handles the entire tree atomically
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(shellPid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
      } catch {
        // taskkill may fail if process already exited
      }
      try {
        this.terminalInfo.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
      return;
    }

    // Unix: SIGTERM descendants bottom-up, then kill the shell
    const descendants = this.deps.processTreeCache?.getDescendantPids(shellPid) ?? [];

    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ESRCH: process already exited
      }
    }

    try {
      this.terminalInfo.ptyProcess.kill();
    } catch {
      // Process may already be dead
    }

    // SIGKILL escalation for any survivors
    const allPids = [...descendants, shellPid];
    const sigkillSweep = (): void => {
      for (const pid of allPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ESRCH: process already exited
        }
      }
    };

    if (immediate) {
      sigkillSweep();
    } else {
      this.killTreeTimer = setTimeout(() => {
        this.killTreeTimer = null;
        sigkillSweep();
      }, 500);
    }
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

    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.inputWriteQueue = [];

    // Flush session snapshot synchronously before marking as killed.
    // Once wasKilled is set, all persistence paths are blocked, and
    // disposeHeadless() destroys the buffer — so this is the last chance.
    if (
      TERMINAL_SESSION_PERSISTENCE_ENABLED &&
      !this.isAgentTerminal &&
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

    this.killProcessTree(false);
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
      type: terminal.type,
      agentId: terminal.agentId,
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

  private markShellCommandSubmitted(commandText?: string): void {
    if (this.terminalInfo.isExited || this.terminalInfo.wasKilled) {
      return;
    }

    // Only skip when a live agent is already detected. A stale
    // `lastDetectedProcessIconId` must not block re-arming the fallback — if
    // the user ran `npm run dev` then Ctrl+C then typed `pnpm dev`, the new
    // command must be allowed to restart detection regardless of whether the
    // previous badge was cleared by the process-tree path yet.
    if (this.terminalInfo.detectedAgentType) {
      return;
    }

    this.shellIdentityFallbackSubmittedAt = Date.now();
    this.shellIdentityFallbackCommandText = this.normalizeShellCommandText(commandText);
    this.shellIdentityFallbackIdentity = this.shellIdentityFallbackCommandText
      ? detectCommandIdentity(this.shellIdentityFallbackCommandText)
      : null;
    this.shellIdentityFallbackCommitted = false;
    this.shellIdentityFallbackPromptStreak = 0;
    this.startShellIdentityFallbackWatcher();
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

    const promptVisible = this.isShellPromptVisible();
    // A live identity only pre-empts the fallback commit when it matches what
    // the fallback detected — a stale badge (e.g. a prior `npm run dev` whose
    // icon hasn't been cleared yet) must NOT block the fallback from emitting
    // a fresh `pnpm`/`docker`/etc. detection for the next command. #5813
    const fallbackIdentity = this.shellIdentityFallbackIdentity;
    const liveIdentityMatchesFallback =
      fallbackIdentity !== null &&
      ((fallbackIdentity.agentType !== undefined &&
        this.terminalInfo.detectedAgentType === fallbackIdentity.agentType) ||
        (fallbackIdentity.processIconId !== undefined &&
          this.lastDetectedProcessIconId === fallbackIdentity.processIconId));

    if (!this.shellIdentityFallbackIdentity) {
      if (promptVisible && Date.now() - submittedAt >= SHELL_IDENTITY_FALLBACK_COMMIT_MS) {
        this.stopShellIdentityFallbackWatcher();
      }
      return;
    }

    if (!this.shellIdentityFallbackCommitted) {
      if (liveIdentityMatchesFallback) {
        this.shellIdentityFallbackCommitted = true;
        return;
      }

      if (promptVisible) {
        this.stopShellIdentityFallbackWatcher();
        return;
      }

      if (Date.now() - submittedAt < SHELL_IDENTITY_FALLBACK_COMMIT_MS) {
        return;
      }

      this.handleAgentDetection(
        {
          detected: true,
          agentType: this.shellIdentityFallbackIdentity.agentType,
          processIconId: this.shellIdentityFallbackIdentity.processIconId,
          processName: this.shellIdentityFallbackIdentity.processName,
          isBusy: true,
          currentCommand: this.shellIdentityFallbackCommandText,
        },
        this.terminalInfo.spawnedAt
      );
      this.shellIdentityFallbackCommitted = true;
      return;
    }

    if (!promptVisible) {
      this.shellIdentityFallbackPromptStreak = 0;
      return;
    }

    this.shellIdentityFallbackPromptStreak += 1;
    if (this.shellIdentityFallbackPromptStreak < SHELL_IDENTITY_FALLBACK_PROMPT_POLLS) {
      return;
    }

    this.handleAgentDetection(
      {
        detected: false,
        isBusy: false,
        currentCommand: undefined,
      },
      this.terminalInfo.spawnedAt
    );
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
    if (!this.isAgentTerminal && !this.terminalInfo.everDetectedAgent) {
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
          ...buildActivityMonitorOptions(
            this.terminalInfo.agentId ??
              (this.terminalInfo.type !== "terminal" ? this.terminalInfo.type : undefined),
            {
              getVisibleLines: (n) => this.getLastNLines(n),
              getCursorLine: () => this.getCursorLine(),
            }
          ),
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

    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }

    this.disposeHeadless();

    this.killProcessTree(true);
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

      if (!this.isAgentTerminal && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
        this.ensureHeadlessResponder();
      }

      // Respond to OSC 10/11 (foreground/background color queries) whenever the
      // terminal is agent-owned — spawn-time agent panel OR runtime-promoted
      // plain terminal. Without this, termenv (Bubble Tea / OpenCode / Gemini CLI)
      // blocks for 5 seconds PER query waiting for responses that never come.
      // The renderer's xterm.js (@xterm/xterm BrowserTerminal) also replies to
      // OSC 10/11 by default; to keep exactly one responder active, we strip
      // queries whose backend response succeeded from data forwarded to the
      // renderer. If a write fails, we leave that query intact so the renderer
      // can still satisfy it and the TUI agent does not hang.
      let rendererData = data;
      if (this.shouldHandleOscColorQueries && data.includes("\x1b]1")) {
        const has10 = OSC_10_QUERY_RE.test(data);
        const has11 = OSC_11_QUERY_RE.test(data);
        let handled10 = false;
        let handled11 = false;
        if (has10) {
          try {
            terminal.ptyProcess.write("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
            handled10 = true;
          } catch (error) {
            this.logWriteError(error, { operation: "write(osc-color-response)" });
          }
        }
        if (has11) {
          try {
            terminal.ptyProcess.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
            handled11 = true;
          } catch (error) {
            this.logWriteError(error, { operation: "write(osc-color-response)" });
          }
        }
        if (handled10) rendererData = rendererData.replace(OSC_10_QUERY_STRIP_RE, "");
        if (handled11) rendererData = rendererData.replace(OSC_11_QUERY_STRIP_RE, "");
      }

      terminal.headlessTerminal?.write(data);
      this.scheduleSessionPersist();

      this.emitData(rendererData);
      this.forensicsBuffer.capture(data);
      this.semanticBufferManager.onData(data);

      if (this.isAgentTerminal) {
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

      if (this.inputWriteTimeout) {
        clearTimeout(this.inputWriteTimeout);
        this.inputWriteTimeout = null;
      }
      this.inputWriteQueue = [];

      this.clearSessionPersistTimer();
      this.sessionPersistDirty = false;

      if (this.killTreeTimer) {
        clearTimeout(this.killTreeTimer);
        this.killTreeTimer = null;
      }

      this.callbacks.onExit(this.id, exitCode ?? 0);
      this.forensicsBuffer.logForensics(
        this.id,
        exitCode ?? 0,
        terminal,
        this.isAgentTerminal,
        signal
      );

      if (this.isAgentTerminal && !terminal.wasKilled) {
        this.deps.agentStateService.updateAgentState(terminal, {
          type: "exit",
          code: exitCode ?? 0,
          signal: signal ?? undefined,
        });
      }

      if (this.isAgentTerminal && getLiveAgentId(terminal) && !terminal.wasKilled) {
        this.deps.agentStateService.emitAgentCompleted(terminal, exitCode ?? 0);
      }

      // Fallback detection: inspect the forensic buffer BEFORE teardown clears
      // anything and emit a fallback-triggered event so the renderer can walk
      // the preset's fallbacks[] chain. Passive observation only — we do not
      // modify the terminal, spawn anything, or touch user config here.
      if (
        this.isAgentTerminal &&
        terminal.agentId &&
        terminal.agentPresetId &&
        !terminal.wasKilled
      ) {
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
            agentId: terminal.agentId,
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

    // Set when we clear a runtime agent detection on this tick so the block
    // below can suppress a same-tick shell-headline emission that would
    // otherwise overwrite the "Exited" completion cue emitted by
    // updateAgentState. The next detector poll emits the shell headline
    // instead. #5773
    let justClearedDetection = false;

    if (result.detected && result.agentType) {
      const previousType = terminal.detectedAgentType;
      terminal.everDetectedAgent = true;

      if (previousType !== result.agentType) {
        if (terminal.agentState === "exited") {
          this.deps.agentStateService.updateAgentState(terminal, { type: "respawn" });
        }

        // Runtime-promoted plain terminals were spawned with DEFAULT_SCROLLBACK and
        // pool-stripped env. Detection-buffer growth is the only in-process repair
        // available — env cannot propagate into the already-running child. The
        // user-visible "restart for full agent support" cue is surfaced by the
        // renderer banner.
        if (!this.isAgentTerminal) {
          this.growScrollback(AGENT_SCROLLBACK);
        }

        terminal.detectedAgentType = result.agentType;
        terminal.type = result.agentType;

        const detection = getEffectiveAgentConfig(result.agentType)?.detection;
        const patternConfig = buildPatternConfig(detection, result.agentType);
        if (this.activityMonitor) {
          this.activityMonitor.reconfigure(result.agentType, patternConfig);
        } else {
          // Runtime promotion: plain terminal now hosts an agent.
          // Seed agent state before startPolling() fires its initial tick,
          // then start the monitor BEFORE emitting "agent:detected" so the
          // main-process monitor is live before the renderer IPC arrives.
          //
          // Launch identity (`terminal.agentId`) is sealed at spawn and is
          // NOT rewritten here — runtime detection lives on
          // `detectedAgentType`. AgentStateService and lifecycle event guards
          // observe the live agent via `agentId ?? detectedAgentType`. #5803
          if (terminal.agentState === undefined) {
            terminal.agentState = "idle";
            terminal.lastStateChange = Date.now();
          }
          terminal.analysisEnabled = true;
          this.startActivityMonitor();
        }

        if (!terminal.title || terminal.title === previousType || terminal.title === "Terminal") {
          const config = AGENT_REGISTRY[result.agentType];
          terminal.title =
            config?.name ?? (result.agentType === "terminal" ? "Terminal" : result.agentType);
        }

        this.lastDetectedProcessIconId = result.processIconId;
        terminal.detectedProcessIconId = result.processIconId;
        events.emit("agent:detected", {
          terminalId: this.id,
          agentType: result.agentType,
          processIconId: result.processIconId,
          processName: result.processName || result.agentType,
          timestamp: Date.now(),
        });
      }
    } else if (result.detected && !result.agentType && result.processIconId) {
      // Non-agent process detected (npm, python, docker, etc.)
      // If we're transitioning directly from an agent, clear agent state first
      if (terminal.detectedAgentType) {
        const previousType = terminal.detectedAgentType;
        this.deps.agentStateService.updateAgentState(terminal, { type: "exit", code: 0 });
        terminal.detectedAgentType = undefined;
        terminal.type = "terminal";
        terminal.title = "Terminal";
        this.stopActivityMonitor();
        // "Terminals are the unit": the live agent surface demotes to a plain
        // terminal now that the detected agent has exited. `this.isAgentTerminal`
        // remains a historical fact about how the PTY was born, and
        // `terminal.agentId` remains sealed at its launch-intent value — runtime
        // detection no longer mutates it. #5803
        terminal.analysisEnabled = false;
        events.emit("agent:exited", {
          terminalId: this.id,
          agentType: previousType,
          timestamp: Date.now(),
          exitKind: "subcommand",
        });
        justClearedDetection = true;
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
    } else if (!result.detected && (terminal.detectedAgentType || this.lastDetectedProcessIconId)) {
      const previousType = terminal.detectedAgentType;
      if (previousType) {
        this.deps.agentStateService.updateAgentState(terminal, { type: "exit", code: 0 });
        terminal.detectedAgentType = undefined;
        terminal.type = "terminal";
        terminal.title = "Terminal";
        justClearedDetection = true;
      }

      this.lastDetectedProcessIconId = undefined;
      terminal.detectedProcessIconId = undefined;
      this.stopActivityMonitor();
      // Only disable analysis when an AGENT exited. This branch also fires for
      // plain process-icon exits (npm/vite/etc.) where previousType is
      // undefined. `terminal.agentId` is never mutated here — launch identity
      // is sealed at spawn. #5803
      if (previousType) {
        terminal.analysisEnabled = false;
      }
      // Emit `agent:exited` to clear the renderer's live-detection fields
      // (`detectedAgentId`, `detectedProcessId`). Only stamp
      // `exitKind: "subcommand"` when an actual agent process exited —
      // plain process-icon clearings (npm/vite/etc.) go out without it so
      // downstream consumers can distinguish the two cases. #5807
      events.emit("agent:exited", {
        terminalId: this.id,
        agentType: previousType,
        timestamp: Date.now(),
        ...(previousType ? { exitKind: "subcommand" as const } : {}),
      });
    }

    // Route to shell-style headlines when no live agent is running. This covers
    // plain terminals (no agentId, no detection) and persisted agent panels
    // whose agent exited (agentState === "exited") — which keep an active
    // shell PTY and should surface shell activity rather than a stale
    // "Agent working" headline. Skip on the exact tick we just emitted an
    // "Exited" completion cue so it isn't overwritten. #5773
    const hasLiveAgent =
      !!terminal.detectedAgentType || (!!terminal.agentId && terminal.agentState !== "exited");
    if (!justClearedDetection && !hasLiveAgent) {
      const lastCommand = result.currentCommand || this.semanticBufferManager.getLastCommand();

      const { headline, status, type } = this.headlineGenerator.generate({
        terminalId: this.id,
        terminalType: terminal.type,
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

  private startWrite(): void {
    if (this.inputWriteTimeout !== null || this.inputWriteQueue.length === 0) {
      return;
    }

    this.doWrite();

    if (this.inputWriteQueue.length > 0) {
      this.inputWriteTimeout = setTimeout(() => {
        this.inputWriteTimeout = null;
        this.startWrite();
      }, WRITE_INTERVAL_MS);
    }
  }

  private doWrite(): void {
    if (this.inputWriteQueue.length === 0) {
      return;
    }

    const chunk = this.inputWriteQueue.shift()!;
    const terminal = this.terminalInfo;
    if (terminal.isExited) {
      return;
    }
    if (!terminal.ptyProcess) {
      return;
    }
    try {
      terminal.ptyProcess.write(chunk);
    } catch (error) {
      this.logWriteError(error, { operation: "write(chunk)" });
    }
  }
}
