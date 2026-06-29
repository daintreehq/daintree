import { EventEmitter } from "events";
import { execFileSync } from "child_process";
import fs from "fs";
import type { AgentEvent } from "./AgentStateMachine.js";
import type { AgentStateChangeTrigger } from "../schemas/agent.js";
import type { PtyPool } from "./PtyPool.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import type { DetectionResult } from "./ProcessDetector.js";
import type { ImagePathProbe } from "./pty/ImagePathProbe.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("pty-host:PtyManager");
const logDebug = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.debug(msg, ctx) : logger.debug(msg);
const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.info(msg, ctx) : logger.info(msg);
const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.warn(msg, ctx) : logger.warn(msg);
const logError = (msg: string, error?: unknown, ctx?: Record<string, unknown>) =>
  ctx ? logger.error(msg, error, ctx) : logger.error(msg, error);

import {
  TerminalRegistry,
  AgentStateService,
  TerminalProcess,
  type PtySpawnOptions,
  type TerminalInfo,
  TerminalSnapshot,
  type PtyManagerEvents,
  MAX_PRESERVED_TERMINAL_SNAPSHOTS,
} from "./pty/index.js";
import { computeSpawnContext, acquirePtyProcess } from "./pty/terminalSpawn.js";
import { disposeTerminalSerializerService } from "./pty/TerminalSerializerService.js";
import { deleteSessionFile } from "./pty/terminalSessionPersistence.js";
import { persistAgentSession } from "./pty/agentSessionHistory.js";

/**
 * PtyManager - Facade for terminal process management.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Orchestrates the pty subsystem by delegating to specialized services:
 * - TerminalRegistry: Terminal instance management and project filtering
 * - AgentStateService: Agent state transitions and event emission
 * - TerminalProcess: Individual terminal session handling
 *
 * Why this pattern:
 * - Has explicit dispose() method to clean up terminals and listeners
 * - Shared singleton accessed dynamically via getPtyManager() from IPC handlers and services
 * - Lifecycle paired with disposePtyManager() for clean shutdown
 * - Factory function provides control over instantiation timing
 *
 * When to use Pattern C:
 * - Service manages resources that need explicit cleanup (terminals, listeners)
 * - Service is accessed from multiple places but disposal must be coordinated
 * - Factory function provides control over instantiation timing
 * - Dispose function enables clean shutdown without import-time side effects
 */
export class PtyManager extends EventEmitter {
  private registry: TerminalRegistry;
  private agentStateService: AgentStateService;
  private ptyPool: PtyPool | null = null;
  private processTreeCache: ProcessTreeCache | null = null;
  private imagePathProbe: ImagePathProbe | null = null;
  private activeProjectId: string | null = null;
  private sabModeEnabled = false;
  // Resize requests that arrived before the terminal was registered.
  // Applied as initial dims at spawn so the PTY boots at the correct size
  // (no SIGWINCH-after-start), avoiding the race between the renderer's
  // ResizeObserver/MessagePort resize and the slower spawn IPC round-trip.
  private pendingResizes = new Map<string, { cols: number; rows: number }>();

  constructor() {
    super();
    this.registry = new TerminalRegistry();
    this.agentStateService = new AgentStateService();
  }

  setProcessTreeCache(cache: ProcessTreeCache): void {
    this.processTreeCache = cache;
  }

  setImagePathProbe(probe: ImagePathProbe): void {
    this.imagePathProbe = probe;
  }

  /**
   * Enable SharedArrayBuffer mode for flow control.
   * SAB mode uses global backpressure in pty-host for flow control.
   * This is the default and recommended mode. Always enabled when buffers are initialized.
   * Propagates to all existing terminals.
   */
  setSabMode(enabled: boolean): void {
    this.sabModeEnabled = enabled;
    // Propagate to all existing terminals
    for (const terminal of this.registry.getAll()) {
      terminal.setSabModeEnabled(enabled);
    }
    if (process.env.DAINTREE_VERBOSE) {
      logDebug(`SAB mode ${enabled ? "enabled" : "disabled"}`);
    }
  }

  trimScrollback(targetLines: number): void {
    for (const terminal of this.registry.getAll()) {
      terminal.trimScrollback(targetLines);
    }
  }

  /**
   * Per-terminal scrollback dimensions for the resource governor's memory-aware
   * trim/pause ranking. Returns the current scrollback cap and column width so the
   * governor can estimate `scrollbackLines × cols × 12` bytes per terminal without
   * serializing any buffer. `cols` falls back to 80 for a freshly-spawned terminal
   * that hasn't been resized yet, so it never contributes a zero-byte estimate.
   */
  getTerminalBufferSizes(): Array<{ id: string; scrollbackLines: number; cols: number }> {
    return this.registry.getAll().map((terminal) => ({
      id: terminal.id,
      scrollbackLines: terminal.getCurrentScrollback(),
      cols: terminal.getPtyProcess().cols || 80,
    }));
  }

  /**
   * Trim a single terminal's scrollback to `targetLines`. Returns false (rather
   * than throwing) when the terminal is unknown — e.g. it was disposed between the
   * governor's `getTerminalBufferSizes()` snapshot and this call — so a stale id in
   * the targeted-trim map is a silent no-op. The bool is informational; callers may
   * ignore it. Used by the governor's targeted pre-pause reclaim.
   */
  trimTerminalScrollback(id: string, targetLines: number): boolean {
    const terminal = this.registry.get(id);
    if (!terminal) return false;
    terminal.trimScrollback(targetLines);
    return true;
  }

  /**
   * Check if SAB mode is enabled.
   */
  isSabMode(): boolean {
    return this.sabModeEnabled;
  }

  /**
   * Set the active project for IPC event filtering.
   */
  setActiveProject(projectId: string | null): void {
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;

    if (process.env.DAINTREE_VERBOSE) {
      logDebug(`Active project changed: ${previousProjectId || "none"} → ${projectId || "none"}`);
    }
  }

  /**
   * Get the current active project ID.
   */
  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Emit terminal data with project-based filtering.
   * Accepts both string and Uint8Array data for binary optimization.
   */
  private emitData(id: string, data: string | Uint8Array): void {
    const terminalProcess = this.registry.get(id);
    if (!terminalProcess) {
      return;
    }

    if (!this.activeProjectId) {
      this.emit("data", id, data);
      return;
    }

    if (this.registry.terminalBelongsToProject(terminalProcess, this.activeProjectId)) {
      this.emit("data", id, data);
    }
  }

  /**
   * Replay recent terminal history.
   */
  replayHistory(terminalId: string, maxLines: number = 100): number {
    const terminal = this.registry.get(terminalId);
    if (!terminal) {
      return 0;
    }

    const replayed = terminal.replayHistory(maxLines);

    if (process.env.DAINTREE_VERBOSE && replayed > 0) {
      logDebug(`Replayed ${replayed} lines for terminal ${terminalId}`);
    }

    return replayed;
  }

  /**
   * Replay history for all terminals in a project.
   */
  replayProjectHistory(projectId: string, maxLines: number = 100): number {
    let count = 0;
    const terminalIds = this.registry.getForProject(projectId);

    for (const id of terminalIds) {
      const replayed = this.replayHistory(id, maxLines);
      if (replayed > 0) {
        count++;
      }
    }

    if (process.env.DAINTREE_VERBOSE) {
      logDebug(`Replayed history for ${count} terminals in project ${projectId}`);
    }

    return count;
  }

  /**
   * Flush an event-driven session snapshot for an agent terminal.
   */
  flushAgentSnapshot(terminalId: string): void {
    this.registry.get(terminalId)?.flushEventDrivenSnapshot();
  }

  /**
   * Set the PTY pool for terminal reuse.
   */
  setPtyPool(pool: PtyPool): void {
    this.ptyPool = pool;
  }

  /**
   * Spawn a new terminal.
   */
  spawn(id: string, options: PtySpawnOptions): void {
    const pendingResize = this.pendingResizes.get(id);
    if (pendingResize) {
      options = { ...options, cols: pendingResize.cols, rows: pendingResize.rows };
      // Defer the delete until spawn definitively succeeds (just before
      // registry.add) so a thrown acquirePtyProcess / TerminalProcess
      // constructor preserves the buffered dims for a caller retry.
    }

    if (this.registry.has(id)) {
      const existing = this.registry.get(id);
      const existingInfo = existing?.getInfo();
      logWarn(
        `Terminal ${id} already exists (projectId: ${existingInfo?.projectId?.slice(0, 8)}), killing to respawn with new projectId`
      );
      this.kill(id);
    }
    logInfo(
      `Spawning terminal ${id} (kind: ${options.kind}, launchAgentId: ${options.launchAgentId})`
    );

    const spawnContext = computeSpawnContext(id, options);
    const acquired = acquirePtyProcess(
      id,
      options,
      spawnContext.env,
      spawnContext.shell,
      spawnContext.args,
      this.ptyPool,
      (error, context) => {
        console.error(
          `[PtyManager] PTY ${context.operation} failed for ${id} during pool acquisition`,
          error
        );
      }
    );
    const { ptyProcess, prelude, dataHandoff } = acquired;

    let terminalProcess: TerminalProcess;
    try {
      terminalProcess = new TerminalProcess(
        id,
        options,
        {
          emitData: (termId, data) => this.emitData(termId, data),
          onExit: (termId, exitCode, signal) => {
            // Guard against stale exit events from previous terminal with same ID
            if (this.registry.get(termId) !== terminalProcess) {
              return;
            }
            this.emit("exit", termId, exitCode, signal);
            if (!terminalProcess.shouldPreserveOnExit(exitCode)) {
              this.registry.delete(termId);
            }
          },
          onPreserved: (termId) => {
            // Preserved terminals retain their full scrollback snapshot in
            // memory and aren't otherwise removed until trash/kill or project
            // close. Bound the in-memory count so long-lived projects don't
            // accumulate snapshots without limit (issue #10839). Fires after the
            // snapshot is captured, so this terminal is already counted; skipId
            // keeps it (the newest entry) out of the eviction set defensively.
            this.registry.evictPreservedSnapshots(MAX_PRESERVED_TERMINAL_SNAPSHOTS, termId);
          },
        },
        {
          agentStateService: this.agentStateService,
          ptyPool: this.ptyPool,
          sabModeEnabled: this.sabModeEnabled,
          processTreeCache: this.processTreeCache,
          imagePathProbe: this.imagePathProbe,
        },
        spawnContext,
        ptyProcess,
        prelude,
        dataHandoff
      );
    } catch (error) {
      logError(`TerminalProcess constructor failed for ${id}, killing orphaned PTY`, error);
      try {
        dataHandoff?.dispose();
      } catch {
        // Ignore disposal errors
      }
      try {
        ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
      throw error;
    }

    this.pendingResizes.delete(id);
    this.registry.add(id, terminalProcess);
  }

  /**
   * Write data to terminal stdin.
   */
  write(id: string, data: string, traceId?: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) {
      logWarn(`Terminal ${id} not found, cannot write data`);
      return;
    }
    terminal.write(data, traceId);
  }

  /**
   * Write data and return per-call result for the small-keystroke fast path.
   * Used by fleet broadcast so dead-pipe errors on one target don't
   * disappear into `logWriteError` but produce a per-target rejection that
   * the renderer can use to disarm the dead pane.
   */
  tryWrite(
    id: string,
    data: string,
    traceId?: string
  ): { ok: boolean; error?: NodeJS.ErrnoException } {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return {
        ok: false,
        error: Object.assign(new Error(`terminal ${id} not found`), { code: "EBADF" }),
      };
    }
    return terminal.tryWrite(data, traceId);
  }

  /**
   * Submit text as a command to the terminal.
   * Handles bracketed paste and CR timing on the backend for reliable execution.
   */
  submit(id: string, text: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) {
      logWarn(`Terminal ${id} not found, cannot submit`);
      return;
    }
    terminal.submit(text);
  }

  /**
   * Stage text into a terminal's input without submitting it (no Enter). The
   * no-execute counterpart to {@link submit}; see {@link TerminalProcess.stage}.
   */
  stage(id: string, text: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) {
      logWarn(`Terminal ${id} not found, cannot stage`);
      return;
    }
    terminal.stage(text);
  }

  /**
   * Resize terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      logWarn(`Terminal ${id} resize rejected: invalid dims ${cols}x${rows}`);
      return;
    }
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.resize(cols, rows);
    } else {
      // Buffer the dims and apply them at spawn time. Coalesces last-write-wins.
      this.pendingResizes.set(id, { cols, rows });
      logDebug(`Terminal ${id} not yet registered, buffering resize ${cols}x${rows}`);
    }
  }

  /**
   * Acknowledge data processing for flow control.
   * No-op in SAB mode (which is always enabled in production).
   * Kept for backwards compatibility with IPC fallback mode.
   */
  acknowledgeData(id: string, byteCount: number): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.acknowledgeData(byteCount);
    }
  }

  /**
   * Kill a terminal process.
   */
  kill(
    id: string,
    reason?: string,
    options?: { preserveSession?: boolean; escalationDelayMs?: number }
  ): void {
    this.pendingResizes.delete(id);
    this.registry.clearTrashTimeout(id);

    const terminal = this.registry.get(id);
    if (terminal) {
      const wasExited = terminal.getInfo().isExited;
      terminal.kill(reason, options?.escalationDelayMs);
      // Note: deletion handled in onExit callback
      if (wasExited) {
        this.registry.delete(id);
      }
    }

    if (!options?.preserveSession) {
      deleteSessionFile(id).catch((err) => {
        logWarn(`Failed to delete session file for terminal ${id}`, err);
      });
    }
  }

  /**
   * Move a terminal to the trash.
   */
  trash(id: string): void {
    this.pendingResizes.delete(id);
    this.registry.trash(id, (termId) => {
      // Capture terminal info before async kill (info may be unavailable after kill)
      const terminal = this.registry.get(termId);
      const info = terminal?.getInfo();

      void (async () => {
        try {
          const sessionId = await this.gracefulKill(termId);
          if (sessionId && info?.launchAgentId) {
            await persistAgentSession({
              sessionId,
              agentId: info.launchAgentId,
              worktreeId: info.worktreeId ?? null,
              title: info.lastObservedTitle ?? info.title ?? null,
              projectId: info.projectId ?? null,
              agentLaunchFlags: info.agentLaunchFlags,
              agentModelId: info.agentModelId,
            });
          }
        } catch (err) {
          logError("[PtyManager] Failed to persist agent session on trash expiry", err);
          // Ensure the terminal is killed even if gracefulKill failed
          try {
            this.kill(termId, "trash-expired");
          } catch {
            // already dead
          }
        }
      })();
    });
  }

  /**
   * Restore a terminal from the trash.
   */
  restore(id: string): boolean {
    return this.registry.restore(id);
  }

  /**
   * Check if a terminal is in the trash.
   */
  isInTrash(id: string): boolean {
    return this.registry.isInTrash(id);
  }

  /**
   * Get terminal info.
   */
  getTerminal(id: string): TerminalInfo | undefined {
    const info = this.registry.get(id)?.getInfo();
    if (!info) return undefined;

    const isTrashed = this.registry.isInTrash(id);
    const trashExpiresAt = isTrashed ? this.registry.getTrashExpiresAt(id) : undefined;

    return {
      ...info,
      isTrashed,
      trashExpiresAt,
    };
  }

  /**
   * Get all active terminal IDs.
   */
  getActiveTerminalIds(): string[] {
    return this.registry.getAllIds();
  }

  /**
   * Get all active terminals.
   */
  getAll(): TerminalInfo[] {
    return this.registry.getAll().map((t) => t.getInfo());
  }

  /**
   * Check if a terminal exists.
   */
  hasTerminal(id: string): boolean {
    return this.registry.has(id);
  }

  /**
   * Get terminal snapshot for external analysis.
   */
  getTerminalSnapshot(id: string): TerminalSnapshot | null {
    return this.registry.getSnapshot(id);
  }

  /**
   * Get snapshots for all active terminals.
   */
  getAllTerminalSnapshots(): TerminalSnapshot[] {
    return this.registry.getAllSnapshots();
  }

  /**
   * Get serialized terminal state (synchronous).
   */
  getSerializedState(id: string): string | null {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    return terminal.getSerializedState();
  }

  /**
   * Get serialized terminal state (async, uses worker for large terminals).
   */
  async getSerializedStateAsync(id: string): Promise<string | null> {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    return terminal.getSerializedStateAsync();
  }

  private resolveTtyPath(pid: number): string | undefined {
    try {
      if (process.platform === "win32") return undefined;
      if (process.platform === "linux") {
        return fs.readlinkSync(`/proc/${pid}/fd/0`);
      }
      // macOS
      const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], { timeout: 500 })
        .toString()
        .trim();
      if (!tty || tty === "??" || tty === "?") return undefined;
      return `/dev/${tty}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Get terminal information for diagnostic display.
   */
  getTerminalInfo(id: string): import("../../shared/types/ipc.js").TerminalInfoPayload | null {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    const terminalInfo = terminal.getInfo();
    const hasPty = !terminalInfo.wasKilled && !terminalInfo.isExited;
    const ptyProcess = hasPty ? terminalInfo.ptyProcess : undefined;

    return {
      id: terminalInfo.id,
      projectId: terminalInfo.projectId,
      worktreeId: terminalInfo.worktreeId,
      kind: terminalInfo.kind,
      launchAgentId: terminalInfo.launchAgentId,
      title: terminalInfo.title,
      titleMode: terminalInfo.titleMode,
      cwd: terminalInfo.cwd,
      shell: terminalInfo.shell,
      command: terminalInfo.command,
      agentState: terminalInfo.agentState,
      spawnedAt: terminalInfo.spawnedAt,
      lastInputTime: terminalInfo.lastInputTime,
      lastOutputTime: terminalInfo.lastOutputTime,
      lastStateChange: terminalInfo.lastStateChange,
      activityTier: terminal.getActivityTier() === "active" ? "focused" : "background",
      outputBufferSize: terminalInfo.outputBuffer.length,
      semanticBufferLines: terminalInfo.semanticBuffer.length,
      restartCount: terminalInfo.restartCount,
      hasPty,
      agentSessionId: terminalInfo.agentSessionId,
      detectedAgentId: terminalInfo.detectedAgentId,
      analysisEnabled: terminalInfo.analysisEnabled,
      resizeStrategy: terminal.getResizeStrategy(),
      ptyPid: ptyProcess?.pid,
      ptyCols: ptyProcess?.cols,
      ptyRows: ptyProcess?.rows,
      ptyForegroundProcess: ptyProcess?.process,
      ptyTty: ptyProcess ? this.resolveTtyPath(ptyProcess.pid) : undefined,
      spawnArgs: terminalInfo.spawnArgs,
      agentLaunchFlags: terminalInfo.agentLaunchFlags,
      agentModelId: terminalInfo.agentModelId,
      agentPresetId: terminalInfo.agentPresetId,
      agentPresetColor: terminalInfo.agentPresetColor,
      originalAgentPresetId: terminalInfo.originalAgentPresetId,
      exitCode: terminalInfo.exitCode,
      everDetectedAgent: terminalInfo.everDetectedAgent,
    };
  }

  /**
   * Mark terminal's check time.
   */
  markChecked(id: string): void {
    this.registry.markChecked(id);
  }

  /**
   * Store the last observed (non-useless) OSC title for a terminal so that
   * persistAgentSession can capture a meaningful label even if the agent
   * clears its title right before shutdown.
   */
  updateObservedTitle(id: string, title: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) return;
    terminal.setObservedTitle(title);
  }

  /**
   * Enable or disable semantic analysis for a terminal.
   */
  setAnalysisEnabled(id: string, enabled: boolean): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.setAnalysisEnabled(enabled);
    }
  }

  /**
   * Drive the runtime agent-detection pipeline directly. In production, the
   * per-terminal ProcessDetector invokes TerminalProcess.handleAgentDetection;
   * this hook routes the same result through that method synchronously so
   * integration tests can exercise runtime promotion/demotion without depending
   * on a real agent binary being resident in the process tree.
   */
  simulateAgentDetection(id: string, result: DetectionResult): boolean {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return false;
    }
    terminal.handleAgentDetection(result, terminal.getInfo().spawnedAt);
    return true;
  }

  /**
   * Transition agent state from external observer.
   *
   * Returns `boolean` — preserved as the load-bearing contract for the
   * `Promise<boolean>` resolver on the main-side `PtyClient.transitionState`
   * and the production caller at `electron/ipc/handlers/terminal/io.ts:225`.
   *
   * The precise drop reason (hysteresis / stale-session / schema-invalid /
   * no-op) is emitted on the bus as `agent:state-transition-dropped` from
   * inside `AgentStateService`. The bus is the source of truth for
   * diagnostics; the wire carries only the boolean.
   */
  transitionState(
    id: string,
    event: AgentEvent,
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): boolean {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return false;
    }
    return this.agentStateService.transitionState(
      terminal.getInfo(),
      event,
      trigger,
      confidence,
      spawnedAt
    );
  }

  /**
   * Get terminals for a specific project.
   */
  getTerminalsForProject(projectId: string): string[] {
    return this.registry.getForProject(projectId);
  }

  /**
   * Get available terminals (idle or waiting for user input).
   * These terminals can potentially be reused for new tasks.
   * Excludes trashed terminals and terminals without active PTY processes.
   */
  getAvailableTerminals(): TerminalInfo[] {
    return this.registry
      .getAll()
      .filter((t) => {
        const info = t.getInfo();
        const isAvailableState = info.agentState === "idle" || info.agentState === "waiting";
        const hasActivePty = !info.wasKilled && !info.isExited;
        const notTrashed = !info.isTrashed;
        return isAvailableState && hasActivePty && notTrashed;
      })
      .map((t) => t.getInfo());
  }

  /**
   * Get terminals filtered by agent state.
   */
  getTerminalsByState(state: import("../../shared/types/agent.js").AgentState): TerminalInfo[] {
    return this.registry
      .getAll()
      .filter((t) => t.getInfo().agentState === state)
      .map((t) => t.getInfo());
  }

  /**
   * Get project statistics.
   */
  getProjectStats(projectId: string): {
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  } {
    return this.registry.getProjectStats(projectId);
  }

  /**
   * Enumerate live terminals as {terminalId, projectId, rootPid} tuples for the
   * memory rollup.
   */
  getLiveTerminalRoots(): Array<{
    terminalId: string;
    projectId: string | null;
    rootPid: number;
  }> {
    return this.registry.getLiveTerminalRoots();
  }

  /**
   * Gracefully kill a terminal, capturing its session ID if it's an agent terminal.
   * Falls back to immediate kill for non-agent terminals.
   */
  async gracefulKill(id: string, options?: { preserveSession?: boolean }): Promise<string | null> {
    this.pendingResizes.delete(id);
    this.registry.clearTrashTimeout(id);

    const terminal = this.registry.get(id);
    if (!terminal) return null;

    const sessionId = await terminal.gracefulShutdown();

    // gracefulShutdown() calls kill() internally when it has a shutdown config.
    // For non-agent terminals (or agents without shutdown config), it returns null
    // without killing. Fall back to immediate kill in that case.
    if (!terminal.getInfo().wasKilled && !terminal.getInfo().isExited) {
      this.kill(id, "graceful-kill-fallback", options);
    }

    return sessionId;
  }

  /**
   * Gracefully kill all terminals for a project, capturing session IDs.
   */
  async gracefulKillByProject(
    projectId: string,
    options?: { preserveSession?: boolean }
  ): Promise<Array<{ id: string; agentSessionId: string | null }>> {
    const terminalIds = this.registry.getForProject(projectId);
    if (terminalIds.length === 0) return [];

    logInfo(`Gracefully killing ${terminalIds.length} terminal(s) for project ${projectId}`);

    const results = await Promise.all(
      terminalIds.map(async (terminalId) => {
        try {
          const sessionId = await this.gracefulKill(terminalId, options);
          return { id: terminalId, agentSessionId: sessionId };
        } catch (error) {
          logError(`Failed to graceful-kill terminal ${terminalId}`, error);
          try {
            this.kill(terminalId, "graceful-kill-fallback", options);
          } catch {
            // already dead
          }
          return { id: terminalId, agentSessionId: null };
        }
      })
    );

    return results;
  }

  /**
   * Kill all terminals for a project.
   */
  killByProject(projectId: string): number {
    const terminalIds = this.registry.getForProject(projectId);

    if (terminalIds.length === 0) {
      logDebug(`No terminals to kill for project ${projectId}`);
      return 0;
    }

    logInfo(`Killing ${terminalIds.length} terminal(s) for project ${projectId}`);

    let killed = 0;
    for (const terminalId of terminalIds) {
      try {
        this.kill(terminalId, "project-closed");
        killed++;
      } catch (error) {
        logError(`Failed to kill terminal ${terminalId}`, error);
      }
    }

    logInfo(`Killed ${killed}/${terminalIds.length} terminals`);
    return killed;
  }

  /**
   * Start the process detector for a single terminal.
   * Used by the pty-host deferred-PID retry: on Windows, node-pty reports
   * `pid: 0` during the ConPTY connect() window, so detection is skipped at
   * spawn time and re-triggered here once a real PID resolves. Idempotent —
   * `startProcessDetector()` no-ops if a detector already exists.
   */
  startProcessDetectorForTerminal(id: string): void {
    this.registry.get(id)?.startProcessDetector();
  }

  /**
   * Set activity monitoring tier (active vs background).
   */
  setActivityMonitorTier(
    id: string,
    tier: "active" | "background",
    pollingIntervalMs: number
  ): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.setActivityMonitorTier(tier, pollingIntervalMs);
    }
  }

  /**
   * Get the current activity tier for a terminal.
   */
  getActivityTier(id: string): "active" | "background" | undefined {
    const terminal = this.registry.get(id);
    return terminal?.getActivityTier();
  }

  /**
   * Clean up all terminals.
   */
  dispose(): void {
    for (const [_id, terminal] of this.registry.entries()) {
      const terminalInfo = terminal.getInfo();
      if (terminalInfo.launchAgentId) {
        this.agentStateService.emitAgentKilled(terminalInfo, "cleanup");
      }
      terminal.dispose();
    }

    this.registry.dispose();
    this.pendingResizes.clear();
    this.removeAllListeners();

    disposeTerminalSerializerService();
  }
}

// Export singleton instance
let ptyManagerInstance: PtyManager | null = null;

export function getPtyManager(): PtyManager {
  if (!ptyManagerInstance) {
    ptyManagerInstance = new PtyManager();
  }
  return ptyManagerInstance;
}

export function disposePtyManager(): void {
  if (ptyManagerInstance) {
    ptyManagerInstance.dispose();
    ptyManagerInstance = null;
  }
}

// Re-export types for external consumers
export type { PtySpawnOptions, TerminalInfo, TerminalSnapshot, PtyManagerEvents };
