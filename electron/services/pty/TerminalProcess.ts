import * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import type { TerminalType } from "../../../shared/types/domain.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { ProcessDetector, type DetectionResult } from "../ProcessDetector.js";
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
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  SEMANTIC_FLUSH_INTERVAL_MS,
  DEFAULT_SCROLLBACK,
  AGENT_SCROLLBACK,
  WRITE_INTERVAL_MS,
} from "./types.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";
import { events } from "../events.js";
import { AgentSpawnedSchema, AgentStateChangedSchema } from "../../schemas/agent.js";
import type { PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
import { TerminalSyncBuffer } from "./TerminalSyncBuffer.js";
import { styleUrls } from "./UrlStyler.js";

// Extracted modules
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  isBracketedPaste,
  chunkInput,
  delay,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  SUBMIT_ENTER_DELAY_MS,
  OUTPUT_SETTLE_DEBOUNCE_MS,
  OUTPUT_SETTLE_MAX_WAIT_MS,
  OUTPUT_SETTLE_POLL_INTERVAL_MS,
} from "./terminalInput.js";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  SESSION_SNAPSHOT_MAX_BYTES,
  SESSION_SNAPSHOT_DEBOUNCE_MS,
  restoreSessionFromFile,
  persistSessionSnapshotSync,
  persistSessionSnapshotAsync,
} from "./terminalSessionPersistence.js";
import {
  buildPatternConfig,
  buildBootCompletePatterns,
  buildPromptPatterns,
  buildPromptHintPatterns,
  createProcessStateValidator,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import {
  getDefaultShell,
  getDefaultShellArgs,
  buildNonInteractiveEnv,
  AGENT_ENV_EXCLUSIONS,
} from "./terminalShell.js";

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
};

const TERMINAL_DISABLE_URL_STYLING: boolean = process.env.CANOPY_DISABLE_URL_STYLING === "1";
const TERMINAL_FRAME_STABILIZER_ENABLED: boolean =
  process.env.CANOPY_DISABLE_FRAME_STABILIZER !== "1";

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

  private resizeTimestamp = 0;
  private static readonly RESIZE_COOLDOWN_MS = 300;

  private lastWriteErrorLogTime = 0;
  private suppressedWriteErrorCount = 0;

  private pendingSemanticData = "";
  private semanticFlushTimer: NodeJS.Timeout | null = null;

  private inputWriteQueue: string[] = [];
  private inputWriteTimeout: NodeJS.Timeout | null = null;

  private _scrollback: number;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private syncBuffer: TerminalSyncBuffer | null = null;
  private sessionPersistTimer: NodeJS.Timeout | null = null;
  private sessionPersistDirty = false;
  private sessionPersistInFlight = false;

  private readonly terminalInfo: TerminalInfo;
  private readonly isAgentTerminal: boolean;
  private forensicsBuffer = new TerminalForensicsBuffer();
  private _activityTier: "active" | "background" = "active";
  private bufferChangeDisposable: { dispose: () => void } | null = null;

  private restoreSessionIfPresent(headlessTerminal: HeadlessTerminalType): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
    if (this.isAgentTerminal) return;
    if (this.options.restore === false) return;

    restoreSessionFromFile(headlessTerminal, this.id);
  }

  private scheduleSessionPersist(): void {
    if (!TERMINAL_SESSION_PERSISTENCE_ENABLED) return;
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
    if (this.isAgentTerminal) return;
    if (this.terminalInfo.wasKilled) return;
    if (!this.sessionPersistDirty) return;
    if (this.sessionPersistInFlight) return;

    this.sessionPersistInFlight = true;
    try {
      this.sessionPersistDirty = false;
      const state = await this.getSerializedStateAsync();
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
    private deps: TerminalProcessDependencies
  ) {
    const shell = options.shell || getDefaultShell();
    const args = options.args || getDefaultShellArgs(shell);
    const spawnedAt = Date.now();

    const isAgentByKind = options.kind === "agent";
    const isAgentByAgentId = !!options.agentId;
    const isAgentByType = !!(options.type && options.type !== "terminal");
    this.isAgentTerminal = isAgentByKind || isAgentByAgentId || isAgentByType;
    const agentId = this.isAgentTerminal
      ? (options.agentId ?? (options.type !== "terminal" ? options.type : id))
      : undefined;

    const baseEnv = process.env as Record<string, string | undefined>;
    const mergedEnv = { ...baseEnv, ...options.env };

    // For agent terminals, use non-interactive environment to suppress prompts
    // (oh-my-zsh updates, Homebrew notifications, etc.)
    // Pass agentId for agent-specific exclusions (e.g., Gemini CLI is sensitive to CI=1)
    // Then merge agent-specific env vars from the agent registry config,
    // filtering out any excluded vars to prevent bypassing agent-specific safeguards
    const agentConfig = agentId ? getEffectiveAgentConfig(agentId) : undefined;
    const agentEnv = agentConfig?.env ?? {};
    const normalizedAgentId = agentId?.toLowerCase();
    const exclusions = new Set(
      normalizedAgentId ? (AGENT_ENV_EXCLUSIONS[normalizedAgentId] ?? []) : []
    );
    const filteredAgentEnv = Object.fromEntries(
      Object.entries(agentEnv).filter(([key]) => !exclusions.has(key))
    );
    const env = this.isAgentTerminal
      ? { ...buildNonInteractiveEnv(mergedEnv, shell, agentId), ...filteredAgentEnv }
      : (Object.fromEntries(
          Object.entries(mergedEnv).filter(([_, value]) => value !== undefined)
        ) as Record<string, string>);

    const canUsePool =
      deps.ptyPool &&
      !this.isAgentTerminal &&
      !options.shell &&
      !options.env &&
      !options.args &&
      options.kind !== "dev-preview";
    let pooledPty = canUsePool ? deps.ptyPool!.acquire() : null;

    let ptyProcess: pty.IPty;

    if (pooledPty) {
      try {
        pooledPty.resize(options.cols, options.rows);
      } catch (resizeError) {
        console.warn(
          `[TerminalProcess] Failed to resize pooled PTY for ${id}, falling back to spawn:`,
          resizeError
        );
        try {
          pooledPty.kill();
        } catch {
          // Process may already be dead
        }
        pooledPty = null;
      }
    }

    if (pooledPty) {
      ptyProcess = pooledPty;

      if (process.platform === "win32") {
        const shellLower = shell.toLowerCase();
        try {
          if (shellLower.includes("powershell") || shellLower.includes("pwsh")) {
            ptyProcess.write(`Set-Location "${options.cwd.replace(/"/g, '""')}"\r`);
          } else {
            ptyProcess.write(`cd /d "${options.cwd.replace(/"/g, '\\"')}"\r`);
          }
        } catch (error) {
          this.logWriteError(error, { operation: "write(cwd)" });
        }
      } else {
        try {
          ptyProcess.write(`cd "${options.cwd.replace(/"/g, '\\"')}"\r`);
        } catch (error) {
          this.logWriteError(error, { operation: "write(cwd)" });
        }
      }

      if (process.env.CANOPY_VERBOSE) {
        console.log(`[TerminalProcess] Acquired terminal ${id} from pool (instant spawn)`);
      }
    } else {
      try {
        ptyProcess = pty.spawn(shell, args, {
          name: "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env,
        });
      } catch (error) {
        console.error(`Failed to spawn terminal ${id}:`, error);
        throw error;
      }
    }

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

    this.terminalInfo = {
      id,
      projectId: options.projectId,
      ptyProcess,
      cwd: options.cwd,
      shell,
      kind: options.kind,
      type: options.type,
      title: options.title,
      worktreeId: options.worktreeId,
      agentId,
      spawnedAt,
      agentState: this.isAgentTerminal ? "idle" : undefined,
      lastStateChange: this.isAgentTerminal ? spawnedAt : undefined,
      outputBuffer: "",
      lastInputTime: spawnedAt,
      lastOutputTime: spawnedAt,
      lastCheckTime: spawnedAt,
      semanticBuffer: [],
      pendingSemanticData: "",
      semanticFlushTimer: null,
      inputWriteQueue: [],
      inputWriteTimeout: null,
      headlessTerminal,
      serializeAddon,
      rawOutputBuffer: undefined,
      restartCount: 0,
      analysisEnabled: this.isAgentTerminal,
    };

    // NOTE: The headless responder is intentionally NOT installed for agent
    // terminals. It would forward query responses (CSI 6n cursor position,
    // CSI c device attributes) from the headless terminal back to the PTY.
    // But the frontend xterm.js ALSO responds to these same queries when it
    // processes the output, causing double responses that corrupt Crossterm/
    // Ratatui's input parser (Codex, OpenCode) and Ink's state (Claude Code).
    // The frontend xterm.js is the sole query responder for agent terminals.

    if (TERMINAL_FRAME_STABILIZER_ENABLED && this.isAgentTerminal && headlessTerminal) {
      this.syncBuffer = new TerminalSyncBuffer({
        verbose: process.env.CANOPY_VERBOSE === "1",
        terminalId: id,
      });
      this.syncBuffer.attach(headlessTerminal, (data) => {
        if (this.terminalInfo.wasKilled) return;
        this.emitDataDirect(data);
      });

      // Bypass SyncBuffer while in alt screen
      const bufferChangeDisposable = headlessTerminal.buffer.onBufferChange(() => {
        const inAltBuffer = headlessTerminal.buffer.active.type === "alternate";
        this.syncBuffer?.setBypass(inAltBuffer);
      });
      this.bufferChangeDisposable = bufferChangeDisposable;
    }

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
        { ...this.getActivityMonitorOptions(), processStateValidator }
      );
      this.activityMonitor.startPolling();
    }

    if (this.isAgentTerminal && agentId) {
      const spawnedPayload = {
        agentId,
        terminalId: id,
        type: options.type,
        worktreeId: options.worktreeId,
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
    if (this.bufferChangeDisposable) {
      try {
        this.bufferChangeDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.bufferChangeDisposable = null;
    }
    if (this.syncBuffer) {
      this.syncBuffer.detach();
      this.syncBuffer = null;
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
      worktreeId: t.worktreeId,
      spawnedAt: t.spawnedAt,
      wasKilled: t.wasKilled,
      isExited: t.isExited,
      agentState: t.agentState,
      lastStateChange: t.lastStateChange,
      error: t.error,
      traceId: t.traceId,
      analysisEnabled: t.analysisEnabled,
      lastInputTime: t.lastInputTime,
      lastOutputTime: t.lastOutputTime,
      lastCheckTime: t.lastCheckTime,
      detectedAgentType: t.detectedAgentType,
      restartCount: t.restartCount,
      activityTier: this._activityTier,
      hasPty,
    };
  }

  getSyncBufferState(): {
    enabled: boolean;
    bypassed: boolean;
    inSyncMode: boolean;
    framesEmitted: number;
  } | null {
    if (!this.syncBuffer) return null;
    const debug = this.syncBuffer.getDebugState();
    return {
      enabled: true,
      bypassed: debug.bypassed,
      inSyncMode: debug.inSyncMode,
      framesEmitted: debug.framesEmitted,
    };
  }

  getIsAgentTerminal(): boolean {
    return this.isAgentTerminal;
  }

  getResizeStrategy(): "default" | "settled" {
    const agentId = this.terminalInfo.agentId;
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

  acknowledgeData(_charCount: number): void {
    // No-op: SAB-based backpressure in pty-host.ts handles all flow control
  }

  write(data: string, traceId?: string): void {
    const terminal = this.terminalInfo;
    terminal.lastInputTime = Date.now();

    if (data.length <= 64 && !isBracketedPaste(data)) {
      this.syncBuffer?.markInteractive();
    }

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

    if (isBracketedPaste(data)) {
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
      await delay(SUBMIT_ENTER_DELAY_MS);
    }

    if (!this.terminalInfo.ptyProcess) {
      return;
    }

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
      this.resizeTimestamp = Date.now();

      if (terminal.headlessTerminal) {
        terminal.headlessTerminal.resize(cols, rows);
      }
    } catch (error) {
      console.error(`Failed to resize terminal ${this.id}:`, error);
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

    this.flushPendingSemanticData();

    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.inputWriteQueue = [];

    terminal.wasKilled = true;
    this.clearSessionPersistTimer();

    if (terminal.agentId) {
      this.deps.agentStateService.updateAgentState(terminal, {
        type: "error",
        error: reason || "Agent killed by user",
      });
      this.deps.agentStateService.emitAgentKilled(terminal, reason);
    }

    this.disposeHeadless();

    try {
      terminal.ptyProcess.kill();
    } catch {
      // Process may already be dead
    }
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
      worktreeId: terminal.worktreeId,
      agentId: terminal.agentId,
      agentState: terminal.agentState,
      lastStateChange: terminal.lastStateChange,
      error: terminal.error,
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
    if (!this.isAgentTerminal) {
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
    if (this.isAgentTerminal && !this.activityMonitor) {
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
          ...this.getActivityMonitorOptions(),
          processStateValidator,
          initialState,
          skipInitialStateEmit: preserveState,
        }
      );
      this.activityMonitor.startPolling();
    }
  }

  private getActivityMonitorOptions(): import("../ActivityMonitor.js").ActivityMonitorOptions {
    const effectiveAgentId =
      this.terminalInfo.agentId ??
      (this.terminalInfo.type !== "terminal" ? this.terminalInfo.type : undefined);
    const ignoredInputSequences = effectiveAgentId === "codex" ? ["\n", "\x1b\r"] : ["\x1b\r"];

    const detection = effectiveAgentId
      ? getEffectiveAgentConfig(effectiveAgentId)?.detection
      : undefined;
    const patternConfig = buildPatternConfig(detection, effectiveAgentId);
    const bootCompletePatterns = buildBootCompletePatterns(detection, effectiveAgentId);
    const promptPatterns = buildPromptPatterns(detection, effectiveAgentId);
    const promptHintPatterns = buildPromptHintPatterns(detection, effectiveAgentId);

    const outputActivityDetection = {
      enabled: true,
      windowMs: 1000,
      minFrames: 2,
      minBytes: 32,
    };

    const getVisibleLines = effectiveAgentId ? (n: number) => this.getLastNLines(n) : undefined;
    const getCursorLine = effectiveAgentId ? () => this.getCursorLine() : undefined;

    return {
      ignoredInputSequences,
      agentId: effectiveAgentId,
      outputActivityDetection,
      getVisibleLines,
      getCursorLine,
      patternConfig,
      bootCompletePatterns,
      promptPatterns,
      promptHintPatterns,
      promptScanLineCount: detection?.promptScanLineCount,
      promptConfidence: detection?.promptConfidence,
      idleDebounceMs: effectiveAgentId ? (detection?.debounceMs ?? 2000) : undefined,
    };
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

  dispose(): void {
    this.stopProcessDetector();
    this.stopActivityMonitor();

    if (this.semanticFlushTimer) {
      clearTimeout(this.semanticFlushTimer);
      this.semanticFlushTimer = null;
    }

    if (
      TERMINAL_SESSION_PERSISTENCE_ENABLED &&
      this.sessionPersistDirty &&
      !this.terminalInfo.wasKilled
    ) {
      try {
        const state = this.getSerializedState();
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

    try {
      this.terminalInfo.ptyProcess.kill();
    } catch {
      // Ignore kill errors - process may already be dead
    }
  }

  private setupPtyHandlers(ptyProcess: pty.IPty): void {
    const terminal = this.terminalInfo;

    ptyProcess.onData((data) => {
      if (terminal.ptyProcess !== ptyProcess) {
        return;
      }

      terminal.lastOutputTime = Date.now();

      if (this.isAgentTerminal && this.activityMonitor) {
        const inResizeCooldown =
          this.resizeTimestamp > 0 &&
          Date.now() - this.resizeTimestamp < TerminalProcess.RESIZE_COOLDOWN_MS;

        if (inResizeCooldown) {
          this.activityMonitor.onData();
        } else {
          this.activityMonitor.onData(data);
        }
      }

      if (!this.isAgentTerminal && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
        this.ensureHeadlessResponder();
      }

      terminal.headlessTerminal?.write(data);
      this.scheduleSessionPersist();

      this.emitData(data);
      this.forensicsBuffer.capture(data);
      this.debouncedSemanticUpdate(data);

      if (this.isAgentTerminal) {
        terminal.outputBuffer += data;
        if (terminal.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
          terminal.outputBuffer = terminal.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
        }

        if (terminal.agentId) {
          events.emit("agent:output", {
            agentId: terminal.agentId,
            data,
            timestamp: Date.now(),
            traceId: terminal.traceId,
            terminalId: this.id,
            worktreeId: this.options.worktreeId,
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
      this.flushPendingSemanticData();

      if (this.inputWriteTimeout) {
        clearTimeout(this.inputWriteTimeout);
        this.inputWriteTimeout = null;
      }
      this.inputWriteQueue = [];

      if (this.syncBuffer) {
        this.syncBuffer.detach();
        this.syncBuffer = null;
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
        });
      }

      if (
        this.isAgentTerminal &&
        terminal.agentId &&
        !terminal.wasKilled &&
        terminal.agentState !== "failed"
      ) {
        this.deps.agentStateService.emitAgentCompleted(terminal, exitCode ?? 0);
      }

      if (this.shouldPreserveOnExit(exitCode ?? 0)) {
        terminal.isExited = true;
        return;
      }

      this.disposeHeadless();
    });
  }

  private emitData(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);

    if (this.syncBuffer) {
      this.syncBuffer.ingest(text);
      return;
    }

    this.emitDataDirect(text);
  }

  private emitDataDirect(data: string): void {
    if (TERMINAL_DISABLE_URL_STYLING) {
      this.callbacks.emitData(this.id, data);
      return;
    }

    const styled = styleUrls(data);
    this.callbacks.emitData(this.id, styled);
  }

  private handleAgentDetection(result: DetectionResult, spawnedAt: number): void {
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

    if (result.detected && result.agentType) {
      const previousType = terminal.detectedAgentType;

      if (previousType !== result.agentType) {
        terminal.detectedAgentType = result.agentType;
        terminal.type = result.agentType;

        if (!terminal.title || terminal.title === previousType || terminal.title === "Terminal") {
          const agentNames: Record<TerminalType, string> = {
            claude: "Claude",
            gemini: "Gemini",
            codex: "Codex",
            opencode: "OpenCode",
            terminal: "Terminal",
          };
          terminal.title = agentNames[result.agentType];
        }

        events.emit("agent:detected", {
          terminalId: this.id,
          agentType: result.agentType,
          processName: result.processName || result.agentType,
          timestamp: Date.now(),
        });
      }
    } else if (!result.detected && terminal.detectedAgentType) {
      const previousType = terminal.detectedAgentType;
      terminal.detectedAgentType = undefined;
      terminal.type = "terminal";
      terminal.title = "Terminal";

      events.emit("agent:exited", {
        terminalId: this.id,
        agentType: previousType,
        timestamp: Date.now(),
      });
    }

    if (!terminal.agentId) {
      const lastCommand = result.currentCommand || this.getLastCommand();

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
        worktreeId: this.options.worktreeId,
        lastCommand,
      });

      const newState = result.isBusy ? "running" : "idle";

      if (terminal.agentState !== newState) {
        const previousState = terminal.agentState || "idle";
        terminal.agentState = newState;
        terminal.lastStateChange = Date.now();

        const stateChangePayload = {
          agentId: this.terminalInfo.agentId,
          terminalId: this.id,
          state: newState,
          previousState,
          timestamp: terminal.lastStateChange,
          trigger: "activity" as const,
          confidence: 1.0,
          worktreeId: this.options.worktreeId,
        };

        const validated = AgentStateChangedSchema.safeParse(stateChangePayload);
        if (validated.success) {
          events.emit("agent:state-changed", validated.data);
        }
      }
    }
  }

  private getLastCommand(): string | undefined {
    const buffer = this.terminalInfo.semanticBuffer;
    if (buffer.length === 0) return undefined;

    for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 10; i--) {
      let line = buffer[i].trim();

      if (line.length === 0) continue;

      line = line.replace(/^[^@]*@[^:]*:[^\s]*\s*[$>%#]\s*/, "");
      line = line.replace(/^~?[^\s]*[$>%#]\s*/, "");
      line = line.replace(/^[$>%#]\s*/, "");

      if (line.length > 0) {
        return line;
      }
    }
    return undefined;
  }

  private debouncedSemanticUpdate(data: string): void {
    this.pendingSemanticData += data;

    if (this.semanticFlushTimer) {
      return;
    }

    this.semanticFlushTimer = setTimeout(() => {
      if (this.pendingSemanticData) {
        this.updateSemanticBuffer(this.pendingSemanticData);
        this.pendingSemanticData = "";
      }
      this.semanticFlushTimer = null;
    }, SEMANTIC_FLUSH_INTERVAL_MS);
  }

  private updateSemanticBuffer(chunk: string): void {
    const terminal = this.terminalInfo;
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    if (terminal.semanticBuffer.length > 0 && lines.length > 0 && !normalized.startsWith("\n")) {
      terminal.semanticBuffer[terminal.semanticBuffer.length - 1] += lines[0];
      lines.shift();
    }

    const processedLines = lines
      .filter((line) => line.length > 0 || terminal.semanticBuffer.length > 0)
      .map((line) => {
        if (line.length > SEMANTIC_BUFFER_MAX_LINE_LENGTH) {
          return line.substring(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH) + "... [truncated]";
        }
        return line;
      });

    terminal.semanticBuffer.push(...processedLines);

    if (terminal.semanticBuffer.length > SEMANTIC_BUFFER_MAX_LINES) {
      terminal.semanticBuffer = terminal.semanticBuffer.slice(-SEMANTIC_BUFFER_MAX_LINES);
    }
  }

  private flushPendingSemanticData(): void {
    if (this.semanticFlushTimer) {
      clearTimeout(this.semanticFlushTimer);
      this.semanticFlushTimer = null;
    }
    if (this.pendingSemanticData) {
      this.updateSemanticBuffer(this.pendingSemanticData);
      this.pendingSemanticData = "";
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
