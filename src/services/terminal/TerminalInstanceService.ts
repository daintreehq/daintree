import { Terminal } from "@xterm/xterm";
import { terminalClient, systemClient } from "@/clients";
import { TerminalRefreshTier, TerminalType } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  ResizeJobId,
  AgentStateCallback,
  TIER_DOWNGRADE_HYSTERESIS_MS,
} from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalDataBuffer } from "./TerminalDataBuffer";
import { createThrottledWriter } from "./ThrottledWriter";
import { TerminalParserHandler } from "./TerminalParserHandler";

const START_DEBOUNCING_THRESHOLD = 200;
const HORIZONTAL_DEBOUNCE_MS = 100;
const VERTICAL_THROTTLE_MS = 150;
const IDLE_CALLBACK_TIMEOUT_MS = 1000;

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private dataBuffer: TerminalDataBuffer;
  private suppressedExitUntil = new Map<string, number>();

  constructor() {
    this.dataBuffer = new TerminalDataBuffer((id, data) => this.writeToTerminal(id, data));
    this.dataBuffer.initialize();
  }

  /**
   * Suppress the next exit event for a terminal ID.
   *
   * Used during terminal restarts: we intentionally kill the old PTY, but its exit event can race
   * and arrive after the new xterm instance has attached, causing a stale "[exit 0]" UI state.
   */
  suppressNextExit(id: string, ttlMs: number = 2000): void {
    this.suppressedExitUntil.set(id, Date.now() + ttlMs);
  }

  private shouldSuppressExit(id: string): boolean {
    const until = this.suppressedExitUntil.get(id);
    if (!until) return false;
    if (Date.now() > until) {
      this.suppressedExitUntil.delete(id);
      return false;
    }
    this.suppressedExitUntil.delete(id);
    return true;
  }

  stopPolling(): void {
    this.dataBuffer.stopPolling();
  }

  isSharedBufferEnabled(): boolean {
    return this.dataBuffer.isEnabled();
  }

  /**
   * Centralized method to write data to a terminal.
   * Used by both the SharedArrayBuffer poller and the IPC fallback listener.
   */
  private writeToTerminal(id: string, data: string | Uint8Array): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Capture SAB mode decision before write to avoid mode-flip ambiguity during callback
    const shouldAck = !this.dataBuffer.isEnabled();

    // Write data and apply flow control acknowledgement after xterm processes the buffer update
    const terminal = managed.terminal;
    terminal.write(data, () => {
      // Guard against stale callback after destroy/restart
      if (this.instances.get(id) !== managed) return;

      // Flow control: Only send acknowledgements in IPC fallback mode.
      // In SAB mode, flow control is handled globally via SAB backpressure.
      if (shouldAck) {
        const len = typeof data === "string" ? data.length : data.byteLength;
        terminalClient.acknowledgeData(id, len);
      }

      // Notify output subscribers (for tall canvas scroll sync)
      if (managed.outputSubscribers.size > 0) {
        managed.outputSubscribers.forEach((cb) => cb());
      }

      // Focus-aware scroll behavior: only snap deselected terminals to bottom
      if (!managed.isFocused) {
        const buffer = terminal.buffer.active;
        const isAtBottom = buffer.baseY - buffer.viewportY < 1;
        if (!isAtBottom) {
          terminal.scrollToBottom();
        }
      }
    });
  }

  setVisible(id: string, isVisible: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.isVisible !== isVisible) {
      managed.isVisible = isVisible;
      managed.lastActiveTime = Date.now();

      if (isVisible) {
        const rect = managed.hostElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const widthChanged = Math.abs(managed.lastWidth - rect.width) >= 1;
          const heightChanged = Math.abs(managed.lastHeight - rect.height) >= 1;

          if (widthChanged || heightChanged) {
            managed.lastWidth = 0;
            managed.lastHeight = 0;
          }
        }
        this.applyRendererPolicy(id, managed.getRefreshTier());
      }
    }
  }

  getOrCreate(
    id: string,
    type: TerminalType,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED,
    onInput?: (data: string) => void
  ): ManagedTerminal {
    const existing = this.instances.get(id);
    if (existing) {
      existing.getRefreshTier = getRefreshTier;
      return existing;
    }

    const openLink = (url: string) => {
      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      systemClient.openExternal(normalizedUrl).catch((error) => {
        console.error("[TerminalInstanceService] Failed to open URL:", error);
      });
    };

    const terminalOptions = {
      ...options,
      linkHandler: {
        activate: (_event: MouseEvent, text: string) => openLink(text),
      },
    };

    const terminal = new Terminal(terminalOptions);
    const addons = setupTerminalAddons(terminal, openLink);

    const hostElement = document.createElement("div");
    hostElement.style.width = "100%";
    hostElement.style.height = "100%";
    hostElement.style.display = "flex";
    hostElement.style.flexDirection = "column";

    const throttledWriter = createThrottledWriter(id, terminal, getRefreshTier, () =>
      this.dataBuffer.isEnabled()
    );

    const listeners: Array<() => void> = [];
    const exitSubscribers = new Set<(exitCode: number) => void>();
    const outputSubscribers = new Set<() => void>();
    const agentStateSubscribers = new Set<AgentStateCallback>();

    const unsubData = terminalClient.onData(id, (data: string | Uint8Array) => {
      if (this.dataBuffer.isPolling()) return;
      this.dataBuffer.bufferData(id, data);
    });
    listeners.push(unsubData);

    const unsubExit = terminalClient.onExit((termId, exitCode) => {
      if (termId !== id) return;
      if (this.shouldSuppressExit(id)) {
        return;
      }
      throttledWriter.dispose();
      terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      exitSubscribers.forEach((cb) => cb(exitCode));
    });
    listeners.push(unsubExit);

    const kind = type === "claude" || type === "gemini" || type === "codex" ? "agent" : "terminal";
    const agentId = kind === "agent" ? type : undefined;

    const managed: ManagedTerminal = {
      terminal,
      type,
      kind,
      agentId,
      agentState: undefined,
      agentStateSubscribers,
      ...addons,
      hostElement,
      isOpened: false,
      listeners,
      exitSubscribers,
      outputSubscribers,
      throttledWriter,
      getRefreshTier,
      keyHandlerInstalled: false,
      lastAttachAt: 0,
      lastDetachAt: 0,
      isVisible: false,
      lastActiveTime: Date.now(),
      lastWidth: 0,
      lastHeight: 0,
      lastYResizeTime: 0,
      latestCols: 0,
      latestRows: 0,
      latestWasAtBottom: true,
      isFocused: false,
    };

    managed.parserHandler = new TerminalParserHandler(managed);

    const inputDisposable = terminal.onData((data) => {
      throttledWriter.notifyInput();
      terminalClient.write(id, data);
      if (onInput) {
        onInput(data);
      }
    });
    listeners.push(() => inputDisposable.dispose());

    this.instances.set(id, managed);

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.applyRendererPolicy(id, initialTier);
    return managed;
  }

  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    if (managed.hostElement.parentElement !== container) {
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;
    }
    managed.lastAttachAt = Date.now();

    return managed;
  }

  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container) return;

    if (managed.hostElement.parentElement === container) {
      container.removeChild(managed.hostElement);
    }
    managed.lastDetachAt = Date.now();
  }

  fit(id: string): { cols: number; rows: number } | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    try {
      managed.fitAddon.fit();
      const { cols, rows } = managed.terminal;
      terminalClient.resize(id, cols, rows);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  flushResize(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.resizeXJob || managed.resizeYJob) {
      this.clearResizeJobs(managed);
      this.applyResize(id, managed.latestCols, managed.latestRows);
    }
  }

  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    if (Math.abs(managed.lastWidth - width) < 1 && Math.abs(managed.lastHeight - height) < 1) {
      return null;
    }

    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.baseY - buffer.viewportY < 1;

    try {
      // @ts-expect-error - internal API
      const proposed = managed.fitAddon.proposeDimensions?.({ width, height });

      if (!proposed) {
        managed.fitAddon.fit();
        const cols = managed.terminal.cols;
        const rows = managed.terminal.rows;
        managed.lastWidth = width;
        managed.lastHeight = height;
        managed.latestCols = cols;
        managed.latestRows = rows;
        managed.latestWasAtBottom = wasAtBottom;
        if (!managed.isFocused && !wasAtBottom) {
          this.scrollToBottom(id);
        }
        terminalClient.resize(id, cols, rows);
        return { cols, rows };
      }

      const cols = proposed.cols;
      const rows = proposed.rows;

      if (managed.terminal.cols === cols && managed.terminal.rows === rows) {
        return null;
      }

      managed.lastWidth = width;
      managed.lastHeight = height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;

      const bufferLineCount = this.getBufferLineCount(id);

      if (options.immediate || bufferLineCount < START_DEBOUNCING_THRESHOLD) {
        this.clearResizeJobs(managed);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      if (!managed.isVisible) {
        this.scheduleIdleResize(id, managed);
        return { cols, rows };
      }

      this.throttleResizeY(id, managed, rows);
      this.debounceResizeX(id, managed, cols);

      return { cols, rows };
    } catch (error) {
      console.warn(`[TerminalInstanceService] Resize failed for ${id}:`, error);
      return null;
    }
  }

  scrollToBottom(id: string): void {
    const managed = this.instances.get(id);
    if (managed) {
      managed.terminal.scrollToBottom();
    }
  }

  getSelectionRow(id: string): number | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    const selection = managed.terminal.getSelectionPosition();
    if (!selection) return null;

    return selection.start.y;
  }

  setAgentState(id: string, state: AgentState): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const previousState = managed.agentState;
    if (previousState === state) return;

    managed.agentState = state;

    // Notify subscribers synchronously
    for (const callback of managed.agentStateSubscribers) {
      try {
        callback(state);
      } catch (err) {
        console.error("[TerminalInstanceService] Agent state callback error:", err);
      }
    }
  }

  getAgentState(id: string): AgentState | undefined {
    const managed = this.instances.get(id);
    return managed?.agentState;
  }

  addAgentStateListener(id: string, callback: AgentStateCallback): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.agentStateSubscribers.add(callback);

    // Fire immediately with current state if available
    if (managed.agentState !== undefined) {
      try {
        callback(managed.agentState);
      } catch (err) {
        console.error("[TerminalInstanceService] Agent state callback error:", err);
      }
    }

    return () => {
      managed.agentStateSubscribers.delete(callback);
    };
  }

  private applyResize(id: string, cols: number, rows: number): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.dataBuffer.resetForTerminal(id);
    managed.terminal.resize(cols, rows);

    terminalClient.resize(id, cols, rows);
  }

  setFocused(id: string, isFocused: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isFocused = isFocused;
    managed.lastActiveTime = Date.now();
  }

  private clearResizeJobs(managed: ManagedTerminal): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }
    if (managed.resizeYJob) {
      this.clearJob(managed.resizeYJob);
      managed.resizeYJob = undefined;
    }
  }

  private clearJob(job: ResizeJobId): void {
    if (job.type === "idle") {
      const win = window as typeof window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      win.cancelIdleCallback?.(job.id);
    } else {
      clearTimeout(job.id);
    }
  }

  private scheduleIdleResize(id: string, managed: ManagedTerminal): void {
    const win = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdleCallback = typeof win.requestIdleCallback === "function";

    if (!managed.resizeXJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.instances.get(id);
            if (current) {
              this.dataBuffer.resetForTerminal(id);
              current.terminal.resize(current.latestCols, current.terminal.rows);
              terminalClient.resize(id, current.latestCols, current.terminal.rows);
              current.resizeXJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeXJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (current) {
            this.dataBuffer.resetForTerminal(id);
            current.terminal.resize(current.latestCols, current.terminal.rows);
            terminalClient.resize(id, current.latestCols, current.terminal.rows);
            current.resizeXJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeXJob = { type: "timeout", id: timeoutId };
      }
    }

    if (!managed.resizeYJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.instances.get(id);
            if (current) {
              this.dataBuffer.resetForTerminal(id);
              current.terminal.resize(current.latestCols, current.latestRows);
              terminalClient.resize(id, current.latestCols, current.latestRows);
              current.resizeYJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeYJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (current) {
            this.dataBuffer.resetForTerminal(id);
            current.terminal.resize(current.latestCols, current.latestRows);
            terminalClient.resize(id, current.latestCols, current.latestRows);
            current.resizeYJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeYJob = { type: "timeout", id: timeoutId };
      }
    }
  }

  private debounceResizeX(id: string, managed: ManagedTerminal, cols: number): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }

    const timeoutId = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (current) {
        this.dataBuffer.resetForTerminal(id);
        current.terminal.resize(cols, current.terminal.rows);
        terminalClient.resize(id, cols, current.terminal.rows);
        current.resizeXJob = undefined;
      }
    }, HORIZONTAL_DEBOUNCE_MS);
    managed.resizeXJob = { type: "timeout", id: timeoutId };
  }

  private throttleResizeY(id: string, managed: ManagedTerminal, rows: number): void {
    const now = Date.now();
    const timeSinceLastY = now - managed.lastYResizeTime;

    if (timeSinceLastY >= VERTICAL_THROTTLE_MS) {
      managed.lastYResizeTime = now;
      if (managed.resizeYJob) {
        this.clearJob(managed.resizeYJob);
        managed.resizeYJob = undefined;
      }
      this.dataBuffer.resetForTerminal(id);
      managed.terminal.resize(managed.latestCols, rows);
      terminalClient.resize(id, managed.latestCols, rows);
      return;
    }

    if (!managed.resizeYJob) {
      const remainingTime = VERTICAL_THROTTLE_MS - timeSinceLastY;
      const timeoutId = window.setTimeout(() => {
        const current = this.instances.get(id);
        if (current) {
          current.lastYResizeTime = Date.now();
          this.dataBuffer.resetForTerminal(id);
          current.terminal.resize(current.latestCols, current.latestRows);
          terminalClient.resize(id, current.latestCols, current.latestRows);
          current.resizeYJob = undefined;
        }
      }, remainingTime);
      managed.resizeYJob = { type: "timeout", id: timeoutId };
    }
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    managed?.terminal.focus();
  }

  refresh(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    try {
      managed.fitAddon.fit();
    } catch (error) {
      console.warn("[TerminalInstanceService] Refresh fit failed:", error);
    }
  }

  resetRenderer(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    try {
      if (!managed.hostElement.isConnected) return;
      if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) return;

      managed.terminal.clearTextureAtlas();
      managed.terminal.refresh(0, managed.terminal.rows - 1);

      const dims = this.fit(id);
      if (dims) {
        terminalClient.resize(id, dims.cols, dims.rows);
      }
    } catch (error) {
      console.error(`[TerminalInstanceService] resetRenderer failed for ${id}:`, error);
    }
  }

  resetAllRenderers(): void {
    this.instances.forEach((_managed, id) => this.resetRenderer(id));
  }

  /**
   * Called when the PTY backend restarts after a crash.
   * Resets all xterm renderers to fix the "white text" glitch
   * caused by incomplete ANSI sequences or renderer state desync.
   */
  handleBackendRecovery(): void {
    this.instances.forEach((managed, id) => {
      try {
        // Allow resets temporarily so DECSTR can clear state
        managed.parserHandler?.setAllowResets(true);

        // 1. Send soft terminal reset to clear stuck ANSI state
        // \x1b[!p = DECSTR (Soft Terminal Reset)
        // Resets colors, cursor, scrolling regions but keeps text
        managed.terminal.write("\x1b[!p", () => {
          managed.parserHandler?.setAllowResets(false);
        });

        // 2. Reset the renderer (canvas refresh)
        this.resetRenderer(id);

        // 3. Force fit to recalculate dimensions
        managed.fitAddon?.fit();

        // 4. Inject recovery message for visibility
        const timestamp = new Date().toLocaleTimeString();
        managed.terminal.write(
          `\r\n\x1b[33m[${timestamp}] Terminal backend reconnected\x1b[0m\r\n`
        );
      } catch (error) {
        console.error(`[TerminalInstanceService] Failed to recover terminal ${id}:`, error);
      }
    });
  }

  refreshAll(): void {
    this.instances.forEach((_, id) => {
      this.fit(id);
    });
  }

  updateOptions(id: string, options: Partial<Terminal["options"]>): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    Object.entries(options).forEach(([key, value]) => {
      // @ts-expect-error xterm options are indexable
      managed.terminal.options[key] = value;
    });

    if (textMetricsChanged) {
      managed.lastWidth = 0;
      managed.lastHeight = 0;
    }
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    this.instances.forEach((managed) => {
      Object.entries(options).forEach(([key, value]) => {
        // @ts-expect-error xterm options are indexable
        managed.terminal.options[key] = value;
      });

      if (textMetricsChanged) {
        managed.lastWidth = 0;
        managed.lastHeight = 0;
      }
    });
  }

  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (tier === TerminalRefreshTier.FOCUSED || tier === TerminalRefreshTier.BURST) {
      managed.lastActiveTime = Date.now();
    }

    const currentAppliedTier =
      managed.lastAppliedTier ?? managed.getRefreshTier() ?? TerminalRefreshTier.FOCUSED;

    if (tier === currentAppliedTier) {
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
        managed.pendingTier = undefined;
      }
      return;
    }

    const isUpgrade = tier < currentAppliedTier;

    if (isUpgrade) {
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
      }
      managed.pendingTier = undefined;
      this.applyRendererPolicyImmediate(managed, tier);
      return;
    }

    if (managed.pendingTier === tier && managed.tierChangeTimer !== undefined) {
      return;
    }

    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
    }

    managed.pendingTier = tier;
    managed.tierChangeTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (current && current.pendingTier === tier) {
        this.applyRendererPolicyImmediate(current, tier);
        current.pendingTier = undefined;
      }
      if (current) {
        current.tierChangeTimer = undefined;
      }
    }, TIER_DOWNGRADE_HYSTERESIS_MS);
  }

  private applyRendererPolicyImmediate(managed: ManagedTerminal, tier: TerminalRefreshTier): void {
    managed.lastAppliedTier = tier;
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.getRefreshTier = provider;
    managed.throttledWriter.updateProvider(provider);
  }

  boostRefreshRate(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.throttledWriter.boost();
    this.applyRendererPolicy(id, TerminalRefreshTier.BURST);
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  addOutputListener(id: string, cb: () => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.outputSubscribers.add(cb);
    return () => managed.outputSubscribers.delete(cb);
  }

  destroy(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Prevent future lookups from treating this id as active
    this.instances.delete(id);

    // Synchronously stop all listeners (IPC + xterm input) before other cleanup
    for (const unsub of managed.listeners) {
      try {
        unsub();
      } catch (error) {
        console.warn("[TerminalInstanceService] Error unsubscribing listener:", error);
      }
    }
    managed.listeners.length = 0;

    this.clearResizeJobs(managed);
    this.dataBuffer.resetForTerminal(id);

    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }

    managed.exitSubscribers.clear();
    managed.outputSubscribers.clear();
    managed.agentStateSubscribers.clear();

    managed.parserHandler?.dispose();
    managed.throttledWriter.dispose();

    managed.terminal.dispose();

    if (managed.hostElement.parentElement) {
      managed.hostElement.parentElement.removeChild(managed.hostElement);
    }
  }

  dispose(): void {
    this.stopPolling();
    this.instances.forEach((_, id) => this.destroy(id));
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    try {
      const serializedState = await terminalClient.getSerializedState(id);
      if (!serializedState) {
        console.warn(`[TerminalInstanceService] No serialized state for terminal ${id}`);
        return false;
      }
      return this.restoreFromSerialized(id, serializedState);
    } catch (error) {
      console.error(`[TerminalInstanceService] Failed to fetch state for terminal ${id}:`, error);
      return false;
    }
  }

  restoreFromSerialized(id: string, serializedState: string): boolean {
    const managed = this.instances.get(id);
    if (!managed) {
      console.warn(`[TerminalInstanceService] Cannot restore: terminal ${id} not found`);
      return false;
    }

    try {
      // Clear pending output and reset terminal state for idempotent restoration
      managed.throttledWriter.clear();
      managed.terminal.reset();

      // The serialized state is a sequence of escape codes that reconstructs
      // the terminal buffer, colors, and cursor position when written
      managed.terminal.write(serializedState);
      return true;
    } catch (error) {
      console.error(`[TerminalInstanceService] Failed to restore terminal ${id}:`, error);
      return false;
    }
  }

  private getBufferLineCount(id: string): number {
    const managed = this.instances.get(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  }
}

export const terminalInstanceService = new TerminalInstanceService();
