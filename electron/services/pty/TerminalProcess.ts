import * as pty from "node-pty";
import { existsSync } from "fs";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import type { TerminalType } from "../../../shared/types/domain.js";
import { ProcessDetector, type DetectionResult } from "../ProcessDetector.js";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { AgentStateService } from "./AgentStateService.js";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import {
  type PtySpawnOptions,
  type TerminalInfo,
  type TerminalSnapshot,
  OUTPUT_BUFFER_SIZE,
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  SEMANTIC_FLUSH_INTERVAL_MS,
  SCROLLBACK_BY_TYPE,
  DEFAULT_SCROLLBACK,
  WRITE_MAX_CHUNK_SIZE,
  WRITE_INTERVAL_MS,
} from "./types.js";
import { events } from "../events.js";
import { AgentSpawnedSchema, AgentStateChangedSchema } from "../../schemas/agent.js";
import type { PtyPool } from "../PtyPool.js";
import { styleUrls } from "./UrlStyler.js";

// Flow Control Constants (VS Code values)
const HIGH_WATERMARK_CHARS = 100000;
const LOW_WATERMARK_CHARS = 5000;

/**
 * Split input into chunks for safe PTY writing.
 * Chunks at max size OR before escape sequences to prevent mid-sequence splits.
 */
function chunkInput(data: string): string[] {
  if (data.length === 0) {
    return [];
  }
  if (data.length <= WRITE_MAX_CHUNK_SIZE) {
    return [data];
  }

  const chunks: string[] = [];
  let start = 0;

  for (let i = 0; i < data.length - 1; i++) {
    if (i - start + 1 >= WRITE_MAX_CHUNK_SIZE || data[i + 1] === "\x1b") {
      chunks.push(data.substring(start, i + 1));
      start = i + 1;
    }
  }

  if (start < data.length) {
    chunks.push(data.substring(start));
  }

  return chunks;
}

export interface TerminalProcessCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number) => void;
}

export interface TerminalProcessDependencies {
  agentStateService: AgentStateService;
  ptyPool: PtyPool | null;
}

/**
 * Encapsulates a single terminal session with all associated state and helpers.
 * Handles PTY spawning, output throttling, agent detection, and activity monitoring.
 */
export class TerminalProcess {
  private activityMonitor: ActivityMonitor | null = null;
  private processDetector: ProcessDetector | null = null;
  private headlineGenerator = new ActivityHeadlineGenerator();

  // Flow control state
  private _unacknowledgedCharCount = 0;
  private _isPtyPaused = false;

  // Semantic buffer state
  private pendingSemanticData = "";
  private semanticFlushTimer: NodeJS.Timeout | null = null;

  // Input write queue for chunked writes
  private inputWriteQueue: string[] = [];
  private inputWriteTimeout: NodeJS.Timeout | null = null;

  private readonly terminalInfo: TerminalInfo;
  private readonly isAgentTerminal: boolean;

  constructor(
    public readonly id: string,
    private options: PtySpawnOptions,
    private callbacks: TerminalProcessCallbacks,
    private deps: TerminalProcessDependencies
  ) {
    const shell = options.shell || this.getDefaultShell();
    const args = options.args || this.getDefaultShellArgs(shell);
    const spawnedAt = Date.now();

    this.isAgentTerminal =
      options.type === "claude" || options.type === "gemini" || options.type === "codex";
    const agentId = this.isAgentTerminal ? id : undefined;

    // Merge environment
    const baseEnv = process.env as Record<string, string | undefined>;
    const mergedEnv = { ...baseEnv, ...options.env };
    const env = Object.fromEntries(
      Object.entries(mergedEnv).filter(([_, value]) => value !== undefined)
    ) as Record<string, string>;

    // Try to acquire from pool for shell terminals
    const canUsePool =
      deps.ptyPool && !this.isAgentTerminal && !options.shell && !options.env && !options.args;
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
          // Ignore kill errors
        }
        pooledPty = null;
      }
    }

    if (pooledPty) {
      ptyProcess = pooledPty;

      // Change directory if needed
      if (process.platform === "win32") {
        const shellLower = shell.toLowerCase();
        if (shellLower.includes("powershell") || shellLower.includes("pwsh")) {
          ptyProcess.write(`Set-Location "${options.cwd.replace(/"/g, '""')}"\r`);
        } else {
          ptyProcess.write(`cd /d "${options.cwd.replace(/"/g, '\\"')}"\r`);
        }
      } else {
        ptyProcess.write(`cd "${options.cwd.replace(/"/g, '\\"')}"\r`);
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to spawn terminal ${id}:`, errorMessage);
        throw new Error(`Failed to spawn terminal: ${errorMessage}`);
      }
    }

    // Create headless terminal
    const scrollback = options.type
      ? (SCROLLBACK_BY_TYPE[options.type] ?? DEFAULT_SCROLLBACK)
      : DEFAULT_SCROLLBACK;
    const headlessTerminal = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback,
      allowProposedApi: true,
    });
    const serializeAddon = new SerializeAddon();
    headlessTerminal.loadAddon(serializeAddon);

    // Create terminal info
    this.terminalInfo = {
      id,
      projectId: options.projectId,
      ptyProcess,
      cwd: options.cwd,
      shell,
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
      restartCount: 0,
    };

    // Set up PTY event handlers
    this.setupPtyHandlers(ptyProcess);

    // Create activity monitor for agent terminals
    if (this.isAgentTerminal) {
      this.activityMonitor = new ActivityMonitor(id, (_termId, state) => {
        deps.agentStateService.handleActivityState(this.terminalInfo, state);
      });
    }

    // Start process detection
    const ptyPid = ptyProcess.pid;
    if (ptyPid !== undefined) {
      this.processDetector = new ProcessDetector(id, ptyPid, (result: DetectionResult) => {
        this.handleAgentDetection(result);
      });
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
    }

    // Emit agent:spawned event
    if (this.isAgentTerminal && agentId && options.type) {
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

  /**
   * Get the terminal info object.
   */
  getInfo(): TerminalInfo {
    return this.terminalInfo;
  }

  /**
   * Acknowledge data processing from frontend (Flow Control).
   */
  acknowledgeData(charCount: number): void {
    if (this.terminalInfo.wasKilled) {
      return;
    }

    this._unacknowledgedCharCount = Math.max(0, this._unacknowledgedCharCount - charCount);

    if (this._isPtyPaused && this._unacknowledgedCharCount < LOW_WATERMARK_CHARS) {
      if (process.env.CANOPY_VERBOSE) {
        console.log(
          `[TerminalProcess] Flow control: Resuming ${this.id} (${this._unacknowledgedCharCount} < ${LOW_WATERMARK_CHARS})`
        );
      }
      try {
        this.terminalInfo.ptyProcess.resume();
      } catch {
        // Process might be dead
      }
      this._isPtyPaused = false;
    }
  }

  /**
   * Write data to terminal stdin with chunking.
   */
  write(data: string, traceId?: string): void {
    const terminal = this.terminalInfo;
    terminal.lastInputTime = Date.now();

    // If the PTY has already exited or been disposed, ignore input
    if (!terminal.ptyProcess) {
      return;
    }

    if (traceId !== undefined) {
      terminal.traceId = traceId || undefined;
    }

    // Notify activity monitor of input
    if (this.activityMonitor) {
      this.activityMonitor.onInput(data);
    }

    // Chunk input and queue for writing
    const chunks = chunkInput(data);
    this.inputWriteQueue.push(...chunks);
    this.startWrite();
  }

  /**
   * Resize terminal.
   */
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
    try {
      const currentCols = terminal.ptyProcess.cols;
      const currentRows = terminal.ptyProcess.rows;

      if (currentCols === cols && currentRows === rows) {
        return;
      }

      terminal.ptyProcess.resize(cols, rows);
      terminal.headlessTerminal.resize(cols, rows);
    } catch (error) {
      console.error(`Failed to resize terminal ${this.id}:`, error);
    }
  }

  /**
   * Kill the terminal process.
   */
  kill(reason?: string): void {
    const terminal = this.terminalInfo;

    // Stop process detector
    if (this.processDetector) {
      this.processDetector.stop();
      this.processDetector = null;
      terminal.processDetector = undefined;
    }

    // Dispose activity monitor
    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }

    // Flush pending data
    this.flushPendingSemanticData();

    // Clear pending input writes
    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.inputWriteQueue = [];

    // Mark as killed
    terminal.wasKilled = true;

    // Update agent state
    if (terminal.agentId) {
      this.deps.agentStateService.updateAgentState(terminal, {
        type: "error",
        error: reason || "Agent killed by user",
      });
      this.deps.agentStateService.emitAgentKilled(terminal, reason);
    }

    // Dispose headless terminal
    terminal.headlessTerminal.dispose();

    // Kill PTY process
    terminal.ptyProcess.kill();
  }

  /**
   * Set buffering mode.
   */
  flushBuffer(): void {
    // No-op in baseline: output is emitted immediately.
  }

  // Flood protection is handled via higher-level flow control; always no-op here.
  checkFlooding(): { flooded: boolean; resumed: boolean } {
    return { flooded: false, resumed: false };
  }

  /**
   * Get terminal snapshot for external analysis.
   */
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

  /**
   * Get serialized terminal state for fast restoration.
   */
  getSerializedState(): string | null {
    try {
      return this.terminalInfo.serializeAddon.serialize();
    } catch (error) {
      console.error(`[TerminalProcess] Failed to serialize terminal ${this.id}:`, error);
      return null;
    }
  }

  /**
   * Mark terminal's check time.
   */
  markChecked(): void {
    this.terminalInfo.lastCheckTime = Date.now();
  }

  /**
   * Replay history from semantic buffer.
   */
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

  /**
   * Get PTY process reference (for external use).
   */
  getPtyProcess(): pty.IPty {
    return this.terminalInfo.ptyProcess;
  }

  /**
   * Start/restart process detector.
   */
  startProcessDetector(): void {
    const ptyPid = this.terminalInfo.ptyProcess.pid;
    if (ptyPid !== undefined && !this.processDetector) {
      this.processDetector = new ProcessDetector(this.id, ptyPid, (result) => {
        this.handleAgentDetection(result);
      });
      this.terminalInfo.processDetector = this.processDetector;
      this.processDetector.start();
    }
  }

  /**
   * Stop process detector.
   */
  stopProcessDetector(): void {
    if (this.processDetector) {
      this.processDetector.stop();
      this.processDetector = null;
      this.terminalInfo.processDetector = undefined;
    }
  }

  /**
   * Start activity monitor for agent terminals.
   */
  startActivityMonitor(): void {
    if (this.isAgentTerminal && !this.activityMonitor) {
      this.activityMonitor = new ActivityMonitor(this.id, (_termId, state) => {
        this.deps.agentStateService.handleActivityState(this.terminalInfo, state);
      });
    }
  }

  /**
   * Stop activity monitor.
   */
  stopActivityMonitor(): void {
    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.stopProcessDetector();
    this.stopActivityMonitor();

    if (this.semanticFlushTimer) {
      clearTimeout(this.semanticFlushTimer);
      this.semanticFlushTimer = null;
    }

    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.terminalInfo.headlessTerminal.dispose();

    try {
      this.terminalInfo.ptyProcess.kill();
    } catch {
      // Ignore kill errors - process may already be dead
    }
  }

  private setupPtyHandlers(ptyProcess: pty.IPty): void {
    const terminal = this.terminalInfo;

    ptyProcess.onData((data) => {
      // Verify this is still the active terminal
      if (terminal.ptyProcess !== ptyProcess) {
        return;
      }

      // Flow Control: Pause if backlog is too high
      this._unacknowledgedCharCount += data.length;
      if (!this._isPtyPaused && this._unacknowledgedCharCount > HIGH_WATERMARK_CHARS) {
        if (process.env.CANOPY_VERBOSE) {
          console.log(
            `[TerminalProcess] Flow control: Pausing ${this.id} (${this._unacknowledgedCharCount} > ${HIGH_WATERMARK_CHARS})`
          );
        }
        try {
          ptyProcess.pause();
        } catch {
          // Process might be dead
        }
        this._isPtyPaused = true;
      }

      terminal.lastOutputTime = Date.now();

      // Write to headless terminal for authoritative state
      terminal.headlessTerminal.write(data);

      // Emit data to host/renderer immediately. Flow control is handled
      // via char-count acknowledgements from the renderer.
      this.emitData(data);

      // Always keep a semantic buffer for activity headlines and history replay
      this.debouncedSemanticUpdate(data);

      // For agent terminals, handle additional processing
      if (this.isAgentTerminal) {
        // Update sliding window buffer
        terminal.outputBuffer += data;
        if (terminal.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
          terminal.outputBuffer = terminal.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
        }

        // Notify activity monitor
        if (this.activityMonitor) {
          this.activityMonitor.onData();
        }

        // Emit agent:output event
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

    ptyProcess.onExit(({ exitCode }) => {
      // Verify this is still the active terminal
      if (terminal.ptyProcess !== ptyProcess) {
        return;
      }

      // Stop detectors
      this.stopProcessDetector();
      this.stopActivityMonitor();

      // Flush pending semantic data
      this.flushPendingSemanticData();

      // Clear pending input writes
      if (this.inputWriteTimeout) {
        clearTimeout(this.inputWriteTimeout);
        this.inputWriteTimeout = null;
      }
      this.inputWriteQueue = [];

      this.callbacks.onExit(this.id, exitCode ?? 0);

      // Update agent state on exit
      if (this.isAgentTerminal && !terminal.wasKilled) {
        this.deps.agentStateService.updateAgentState(terminal, {
          type: "exit",
          code: exitCode ?? 0,
        });
      }

      // Emit agent:completed event
      if (
        this.isAgentTerminal &&
        terminal.agentId &&
        !terminal.wasKilled &&
        terminal.agentState !== "failed"
      ) {
        this.deps.agentStateService.emitAgentCompleted(terminal, exitCode ?? 0);
      }

      // Dispose headless terminal
      terminal.headlessTerminal.dispose();
    });
  }

  private emitData(data: string | Uint8Array): void {
    // Apply URL styling to string data
    if (typeof data === "string") {
      const styled = styleUrls(data);
      this.callbacks.emitData(this.id, styled);
    } else {
      // For Uint8Array, decode to string, style, and re-encode
      const text = new TextDecoder().decode(data);
      const styled = styleUrls(text);
      this.callbacks.emitData(this.id, styled);
    }
  }

  private handleAgentDetection(result: DetectionResult): void {
    const terminal = this.terminalInfo;

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

    // Handle busy/idle for shell terminals
    if (!terminal.agentId) {
      // 1. Trust the process detector's command first.
      // 2. Fallback to semantic buffer heuristic if process detection found activity but no name.
      const lastCommand = result.currentCommand || this.getLastCommand();

      const { headline, status, type } = this.headlineGenerator.generate({
        terminalId: this.id,
        terminalType: terminal.type,
        activity: result.isBusy ? "busy" : "idle",
        lastCommand, // Pass the detected command to the generator
      });

      // EMIT ACTIVITY EVENT
      events.emit("terminal:activity", {
        terminalId: this.id,
        headline,
        status,
        type,
        confidence: 1.0,
        timestamp: Date.now(),
        worktreeId: this.options.worktreeId,
        lastCommand, // Important: This populates the pill in the UI
      });

      // UPDATE STATE
      // Map isBusy -> 'running' | 'idle'
      const newState = result.isBusy ? "running" : "idle";

      if (terminal.agentState !== newState) {
        const previousState = terminal.agentState || "idle";
        terminal.agentState = newState;
        terminal.lastStateChange = Date.now();

        // Emit state change to update the icon spin state
        const stateChangePayload = {
          agentId: this.id,
          terminalId: this.id,
          state: newState,
          previousState,
          timestamp: terminal.lastStateChange,
          trigger: "activity" as const,
          confidence: 1.0,
          worktreeId: this.options.worktreeId,
        };

        // Validated emit
        const validated = AgentStateChangedSchema.safeParse(stateChangePayload);
        if (validated.success) {
          events.emit("agent:state-changed", validated.data);
        }
      }
    }
  }

  /**
   * Get the last command executed in this terminal (for headline generation).
   */
  private getLastCommand(): string | undefined {
    const buffer = this.terminalInfo.semanticBuffer;
    if (buffer.length === 0) return undefined;

    // Look for command-like lines in the recent buffer
    for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 10; i--) {
      let line = buffer[i].trim();

      // Skip empty lines
      if (line.length === 0) continue;

      // Strip common prompt prefixes (user@host, paths, prompt symbols)
      // Match patterns like "user@host:~/path $", "~/path %", etc.
      line = line.replace(/^[^@]*@[^:]*:[^\s]*\s*[$>%#]\s*/, "");
      line = line.replace(/^~?[^\s]*[$>%#]\s*/, "");
      line = line.replace(/^[$>%#]\s*/, "");

      // After stripping prompts, accept whatever is left as the command
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
    if (!terminal.ptyProcess) {
      return;
    }
    try {
      terminal.ptyProcess.write(chunk);
    } catch {
      // Process may already be dead; swallow write errors
    }
  }

  private getDefaultShell(): string {
    if (process.platform === "win32") {
      return process.env.COMSPEC || "powershell.exe";
    }

    if (process.env.SHELL) {
      return process.env.SHELL;
    }

    const commonShells = ["/bin/zsh", "/bin/bash", "/bin/sh"];
    for (const shell of commonShells) {
      try {
        if (existsSync(shell)) {
          return shell;
        }
      } catch {
        // Continue to next shell
      }
    }

    return "/bin/sh";
  }

  private getDefaultShellArgs(shell: string): string[] {
    const shellName = shell.toLowerCase();

    if (process.platform !== "win32") {
      if (shellName.includes("zsh") || shellName.includes("bash")) {
        return ["-l"];
      }
    }

    return [];
  }
}
