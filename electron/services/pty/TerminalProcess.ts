import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
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
  DEFAULT_SCROLLBACK,
  AGENT_SCROLLBACK,
  WRITE_INTERVAL_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
} from "./types.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";
import { events } from "../events.js";
import { AgentSpawnedSchema, AgentStateChangedSchema } from "../../schemas/agent.js";
import type { PtyPool } from "../PtyPool.js";
import { installHeadlessResponder } from "./headlessResponder.js";
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
import type { IMarker } from "@xterm/headless";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  SESSION_SNAPSHOT_MAX_BYTES,
  SESSION_SNAPSHOT_DEBOUNCE_MS,
  restoreSessionFromFile,
  persistSessionSnapshotSync,
  persistSessionSnapshotAsync,
} from "./terminalSessionPersistence.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
} from "./terminalActivityPatterns.js";
import { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { SemanticBufferManager } from "./SemanticBufferManager.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import { getDefaultShell, getDefaultShellArgs } from "./terminalShell.js";
import { buildTerminalEnv, acquirePtyProcess } from "./terminalSpawn.js";

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
};

const TERMINAL_DISABLE_URL_STYLING: boolean = process.env.CANOPY_DISABLE_URL_STYLING === "1";

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

  private _scrollback: number;
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private sessionPersistTimer: NodeJS.Timeout | null = null;
  private sessionPersistDirty = false;
  private sessionPersistInFlight = false;

  private readonly terminalInfo: TerminalInfo;
  private readonly isAgentTerminal: boolean;
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

    const env = buildTerminalEnv(options, id, shell, this.isAgentTerminal, agentId);
    const ptyProcess = acquirePtyProcess(
      id,
      options,
      env,
      shell,
      args,
      this.isAgentTerminal,
      deps.ptyPool,
      (error, context) => this.logWriteError(error, context)
    );

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
      exitCode: t.exitCode,
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

    const agentConfig = terminal.agentId ? getEffectiveAgentConfig(terminal.agentId) : undefined;

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

      try {
        terminal.ptyProcess.write(quitCommand + "\r");
      } catch {
        origOnData.dispose();
        origOnExit.dispose();
        finish(null);
      }
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

    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.inputWriteQueue = [];

    // Flush session snapshot synchronously before marking as killed.
    // Once wasKilled is set, all persistence paths are blocked, and
    // disposeHeadless() destroys the buffer — so this is the last chance.
    if (TERMINAL_SESSION_PERSISTENCE_ENABLED && !this.isAgentTerminal) {
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

  dispose(): void {
    this.stopProcessDetector();
    this.stopActivityMonitor();

    this.semanticBufferManager.dispose();

    if (
      TERMINAL_SESSION_PERSISTENCE_ENABLED &&
      this.sessionPersistDirty &&
      !this.terminalInfo.wasKilled
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
        this.activityMonitor.onData(data);
      }

      if (!this.isAgentTerminal && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
        this.ensureHeadlessResponder();
      }

      // Respond to OSC 10/11 (foreground/background color queries) for agent terminals.
      // xterm.js does not respond to these OSC queries, so there is no double-response
      // risk with the frontend. Without this, termenv (used by Bubble Tea / OpenCode)
      // blocks for 5 seconds PER query waiting for responses that never come.
      if (this.isAgentTerminal && data.includes("\x1b]1")) {
        try {
          if (data.includes("\x1b]10;?")) {
            terminal.ptyProcess.write("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
          }
          if (data.includes("\x1b]11;?")) {
            terminal.ptyProcess.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
          }
        } catch (error) {
          this.logWriteError(error, { operation: "write(osc-color-response)" });
        }
      }

      terminal.headlessTerminal?.write(data);
      this.scheduleSessionPersist();

      this.emitData(data);
      this.forensicsBuffer.capture(data);
      this.semanticBufferManager.onData(data);

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
      this.semanticBufferManager.flush();

      if (this.inputWriteTimeout) {
        clearTimeout(this.inputWriteTimeout);
        this.inputWriteTimeout = null;
      }
      this.inputWriteQueue = [];

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
          const config = AGENT_REGISTRY[result.agentType];
          terminal.title =
            config?.name ?? (result.agentType === "terminal" ? "Terminal" : result.agentType);
        }

        this.lastDetectedProcessIconId = result.processIconId;
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
        terminal.detectedAgentType = undefined;
        terminal.type = "terminal";
        terminal.title = "Terminal";
        events.emit("agent:exited", {
          terminalId: this.id,
          agentType: previousType,
          timestamp: Date.now(),
        });
      }
      if (this.lastDetectedProcessIconId !== result.processIconId) {
        this.lastDetectedProcessIconId = result.processIconId;
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
        terminal.detectedAgentType = undefined;
        terminal.type = "terminal";
        terminal.title = "Terminal";
      }

      this.lastDetectedProcessIconId = undefined;
      events.emit("agent:exited", {
        terminalId: this.id,
        agentType: previousType,
        timestamp: Date.now(),
      });
    }

    if (!terminal.agentId) {
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
