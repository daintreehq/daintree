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
  INCREMENTAL_RESTORE_CONFIG,
} from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalOutputIngestService } from "./TerminalOutputIngestService";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { TerminalUnseenOutputTracker, UnseenOutputSnapshot } from "./TerminalUnseenOutputTracker";

const START_DEBOUNCING_THRESHOLD = 200;
const HORIZONTAL_DEBOUNCE_MS = 100;
const VERTICAL_THROTTLE_MS = 150;
const IDLE_CALLBACK_TIMEOUT_MS = 1000;

// Maximum time a resize lock can be held (safety net for stuck locks)
const RESIZE_LOCK_TTL_MS = 5000;

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private dataBuffer: TerminalOutputIngestService;
  private suppressedExitUntil = new Map<string, number>();
  private hiddenContainer: HTMLDivElement | null = null;
  private offscreenSlots = new Map<string, HTMLDivElement>();
  private resizeLocks = new Map<string, number>(); // Stores expiry timestamp, not boolean
  private lastBackendTier = new Map<string, "active" | "background">();
  private unseenTracker = new TerminalUnseenOutputTracker();
  private cwdProviders = new Map<string, () => string>();
  private readinessWaiters = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: Error) => void; timeout: number }>
  >();

  constructor() {
    this.dataBuffer = new TerminalOutputIngestService((id, data) => this.writeToTerminal(id, data));
    this.dataBuffer.initialize();
  }

  notifyUserInput(id: string): void {
    this.onUserInput(id);
  }

  private onUserInput(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // We expect an immediate echo. Wake the SAB poller and enable the interactive fast-lane
    // for a short window so typing never feels "sleepy" after idle.
    this.dataBuffer.markInteractive(id);
    this.dataBuffer.boost();

    this.applyRendererPolicy(id, TerminalRefreshTier.BURST);

    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
    }
    managed.inputBurstTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (!current) return;
      current.inputBurstTimer = undefined;
      this.applyRendererPolicy(id, current.getRefreshTier());
    }, 1000);
  }

  private ensureHiddenContainer(): HTMLDivElement | null {
    if (this.hiddenContainer) return this.hiddenContainer;
    if (typeof document === "undefined") return null;

    const container = document.createElement("div");
    container.className = "terminal-offscreen-container";
    container.style.cssText = [
      "position: fixed",
      "left: -20000px",
      "top: 0",
      "width: 2000px",
      "height: 2000px",
      "overflow: hidden",
      "opacity: 0",
      "pointer-events: none",
    ].join(";");
    document.body.appendChild(container);

    this.hiddenContainer = container;
    return this.hiddenContainer;
  }

  private getOrCreateOffscreenSlot(id: string, widthPx: number, heightPx: number): HTMLDivElement {
    if (typeof document === "undefined") {
      throw new Error("Offscreen slot requires DOM");
    }

    const existing = this.offscreenSlots.get(id);
    if (existing) {
      existing.style.width = `${widthPx}px`;
      existing.style.height = `${heightPx}px`;
      return existing;
    }

    const hiddenContainer = this.ensureHiddenContainer();
    if (!hiddenContainer) {
      throw new Error("Offscreen container unavailable");
    }

    const slot = document.createElement("div");
    slot.dataset.terminalId = id;
    slot.style.width = `${widthPx}px`;
    slot.style.height = `${heightPx}px`;
    slot.style.position = "absolute";
    slot.style.left = "0";
    slot.style.top = "0";
    hiddenContainer.appendChild(slot);

    this.offscreenSlots.set(id, slot);
    return slot;
  }

  /**
   * Ensure a renderer-side xterm instance exists and is subscribed to output immediately.
   * If `offscreen` is enabled, the terminal is opened into a hidden DOM slot and fit/resized
   * so the PTY starts with correct dimensions even before any UI mounts.
   */
  prewarmTerminal(
    id: string,
    type: TerminalType,
    options: ConstructorParameters<typeof Terminal>[0],
    params: { offscreen?: boolean; widthPx?: number; heightPx?: number } = {}
  ): ManagedTerminal {
    const managed = this.getOrCreate(
      id,
      type,
      options,
      () => TerminalRefreshTier.BACKGROUND,
      undefined
    );

    if (!params.offscreen) {
      return managed;
    }

    const widthPx = params.widthPx ?? 800;
    const heightPx = params.heightPx ?? 600;
    const slot = this.getOrCreateOffscreenSlot(id, widthPx, heightPx);
    this.attach(id, slot);

    // Establish correct geometry early so TUIs don't render using the 80x24 spawn default.
    this.fit(id);
    return managed;
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
   *
   * IMPORTANT: We always write data to xterm.js regardless of tier.
   * Xterm is optimized - writing to a hidden terminal is cheap (parsing only).
   * Dropping data based on stale tier state caused terminal freezes.
   */
  private writeToTerminal(id: string, data: string | Uint8Array): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.isSerializedRestoreInProgress) {
      managed.deferredOutput.push(data);
      return;
    }

    // Always write - never drop data. Stale tier state caused freezes.
    // Xterm.js is optimized for hidden terminals (parsing is cheap, rendering is skipped).
    this.unseenTracker.incrementUnseen(id, managed.isUserScrolledBack);

    // Capture SAB mode decision before write to avoid mode-flip ambiguity during callback
    const shouldAck = !this.dataBuffer.isEnabled();

    // Write data and apply flow control acknowledgement after xterm processes the buffer update
    const terminal = managed.terminal;
    managed.pendingWrites = (managed.pendingWrites ?? 0) + 1;
    terminal.write(data, () => {
      // Guard against stale callback after destroy/restart
      if (this.instances.get(id) !== managed) return;

      managed.pendingWrites = Math.max(0, (managed.pendingWrites ?? 1) - 1);

      // Flow control: Only send acknowledgements in IPC fallback mode.
      // In SAB mode, flow control is handled globally via SAB backpressure.
      if (shouldAck) {
        const len = typeof data === "string" ? data.length : data.byteLength;
        terminalClient.acknowledgeData(id, len);
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

        // Re-evaluate tier when visibility changes to wake up backgrounded terminals.
        // This catches terminals that initialized in BACKGROUND before the observer fired.
        const tier = managed.getRefreshTier ? managed.getRefreshTier() : TerminalRefreshTier.VISIBLE;
        this.applyRendererPolicy(id, tier);
      }
    }
  }

  lockResize(id: string, locked: boolean): void {
    if (locked) {
      // Store expiry timestamp instead of boolean - TTL prevents stuck locks
      this.resizeLocks.set(id, Date.now() + RESIZE_LOCK_TTL_MS);
    } else {
      this.resizeLocks.delete(id);
    }
  }

  private isResizeLocked(id: string): boolean {
    const expiry = this.resizeLocks.get(id);
    if (!expiry) return false;

    // Check if lock has expired (safety net for forgotten unlocks)
    if (Date.now() > expiry) {
      this.resizeLocks.delete(id);
      return false;
    }
    return true;
  }

  private setBackendTier(id: string, tier: "active" | "background"): void {
    const prev = this.lastBackendTier.get(id);
    if (prev === tier) return;
    this.lastBackendTier.set(id, tier);
    terminalClient.setActivityTier(id, tier);
  }

  private async wakeAndRestore(id: string): Promise<void> {
    const managed = this.instances.get(id);
    if (!managed) return;

    try {
      const { state } = await terminalClient.wake(id);
      if (!state) return;

      if (state.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        await this.restoreFromSerializedIncremental(id, state);
      } else {
        this.restoreFromSerialized(id, state);
      }

      if (this.instances.get(id) === managed) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    } catch (error) {
      console.warn(`[TerminalInstanceService] wakeAndRestore failed for ${id}:`, error);
    }
  }

  wake(id: string): void {
    void this.wakeAndRestore(id);
  }

  getOrCreate(
    id: string,
    type: TerminalType,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED,
    onInput?: (data: string) => void,
    getCwd?: () => string
  ): ManagedTerminal {
    const existing = this.instances.get(id);
    if (existing) {
      existing.getRefreshTier = getRefreshTier;
      if (getCwd) {
        this.cwdProviders.set(id, getCwd);
      }
      // Keep existing terminal instance but sync its options to match the latest UI/config.
      if (options) {
        this.updateOptions(id, options);
      }
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
    this.cwdProviders.set(id, getCwd ?? (() => ""));
    const addons = setupTerminalAddons(terminal, openLink, () =>
      (this.cwdProviders.get(id) ?? (() => ""))()
    );

    const hostElement = document.createElement("div");
    hostElement.style.width = "100%";
    hostElement.style.height = "100%";
    hostElement.style.display = "flex";
    hostElement.style.flexDirection = "column";

    const listeners: Array<() => void> = [];
    const exitSubscribers = new Set<(exitCode: number) => void>();
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
      getRefreshTier,
      keyHandlerInstalled: false,
      wheelHandlerInstalled: false,
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
      isUserScrolledBack: false,
      isFocused: false,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
    };

    managed.parserHandler = new TerminalParserHandler(managed);

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.baseY - buffer.viewportY < 1;
      managed.latestWasAtBottom = isAtBottom;
      managed.isUserScrolledBack = !isAtBottom;

      if (isAtBottom) {
        this.unseenTracker.clearUnseen(id, false);
      } else {
        this.unseenTracker.updateScrollState(id, true);
      }
    });
    listeners.push(() => scrollDisposable.dispose());

    const inputDisposable = terminal.onData((data) => {
      if (!managed.isInputLocked) {
        this.onUserInput(id);
        terminalClient.write(id, data);
        if (onInput) {
          onInput(data);
        }
      }
    });
    listeners.push(() => inputDisposable.dispose());

    this.instances.set(id, managed);

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.applyRendererPolicy(id, initialTier);

    this.notifyReadinessWaiters(id);

    return managed;
  }

  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  waitForInstance(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const existing = this.instances.get(id);
    if (existing) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeReadinessWaiter(id, resolve);
        reject(new Error(`Terminal ${id} frontend readiness timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiters = this.readinessWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.readinessWaiters.set(id, waiters);
    });
  }

  private notifyReadinessWaiters(id: string): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }

    this.readinessWaiters.delete(id);
  }

  private removeReadinessWaiter(id: string, resolve: () => void): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.readinessWaiters.delete(id);
    }
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    const wasReparented = managed.hostElement.parentElement !== container;
    if (wasReparented) {
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;
    }
    managed.lastAttachAt = Date.now();

    // Force refresh and fit after reparenting to prevent blank terminals.
    // xterm.js can lose its render context when moved between DOM containers.
    if (wasReparented && managed.isOpened) {
      requestAnimationFrame(() => {
        if (this.instances.get(id) !== managed) return;
        if (!managed.terminal.element) return;
        managed.terminal.refresh(0, managed.terminal.rows - 1);
        this.fit(id);
      });
    }

    return managed;
  }

  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container) return;

    if (managed.hostElement.parentElement === container) {
      // Preserve renderer state by reparenting into the offscreen container rather than removing.
      const slot = this.offscreenSlots.get(id);
      if (slot) {
        slot.appendChild(managed.hostElement);
      } else {
        const hiddenContainer = this.ensureHiddenContainer();
        if (hiddenContainer) {
          hiddenContainer.appendChild(managed.hostElement);
        } else {
          container.removeChild(managed.hostElement);
        }
      }
    }
    managed.lastDetachAt = Date.now();
  }

  fit(id: string): { cols: number; rows: number } | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    // Guard: Skip fitting if terminal is in the offscreen container.
    // The offscreen container is positioned at left: -20000px and has fixed dimensions (2000x2000).
    // Fitting in this state would calculate wrong dimensions and corrupt the PTY layout.
    const rect = managed.hostElement.getBoundingClientRect();
    if (rect.left < -10000 || rect.width < 50 || rect.height < 50) {
      return null;
    }

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

    if (this.isResizeLocked(id)) {
      return null;
    }

    const currentTier =
      managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED;
    // Reliability: avoid resizing terminals in BACKGROUND tier (dock/trash) to prevent
    // hard-wrap/reflow corruption and unnecessary churn while a terminal is not actively viewed.
    if (currentTier === TerminalRefreshTier.BACKGROUND && !managed.isFocused) {
      return null;
    }

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
        managed.isUserScrolledBack = !wasAtBottom;
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
      managed.isUserScrolledBack = !wasAtBottom;

      const bufferLineCount = this.getBufferLineCount(id);

      if (options.immediate || managed.isFocused || bufferLineCount < START_DEBOUNCING_THRESHOLD) {
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

  subscribeUnseenOutput(id: string, listener: () => void): () => void {
    return this.unseenTracker.subscribe(id, listener);
  }

  getUnseenOutputSnapshot(id: string): UnseenOutputSnapshot {
    return this.unseenTracker.getSnapshot(id);
  }

  resumeAutoScroll(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.unseenTracker.clearUnseen(id, false);
    this.scrollToBottom(id);
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

    if (this.isResizeLocked(id)) {
      return;
    }

    this.dataBuffer.flushForTerminal(id);
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
              this.dataBuffer.flushForTerminal(id);
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
            this.dataBuffer.flushForTerminal(id);
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
              this.dataBuffer.flushForTerminal(id);
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
            this.dataBuffer.flushForTerminal(id);
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
        this.dataBuffer.flushForTerminal(id);
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
      this.dataBuffer.flushForTerminal(id);
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
          this.dataBuffer.flushForTerminal(id);
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
      if (!managed.hostElement.isConnected) {
        console.log(`[TERM_DEBUG] resetRenderer skipped for ${id}: not connected`);
        return;
      }
      if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) {
        console.log(`[TERM_DEBUG] resetRenderer skipped for ${id}: too small (${managed.hostElement.clientWidth}x${managed.hostElement.clientHeight})`);
        return;
      }

      console.log(`[TERM_DEBUG] resetRenderer running for ${id}`);

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
        // 1. Send soft terminal reset to clear stuck ANSI state
        // \x1b[!p = DECSTR (Soft Terminal Reset)
        // Resets colors, cursor, scrolling regions but keeps text
        managed.terminal.write("\x1b[!p");

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
      this.applyRendererPolicyImmediate(id, managed, tier);
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
        this.applyRendererPolicyImmediate(id, current, tier);
        current.pendingTier = undefined;
      }
      if (current) {
        current.tierChangeTimer = undefined;
      }
    }, TIER_DOWNGRADE_HYSTERESIS_MS);
  }

  private applyRendererPolicyImmediate(
    id: string,
    managed: ManagedTerminal,
    tier: TerminalRefreshTier
  ): void {
    managed.lastAppliedTier = tier;

    // Backend streaming tier:
    // - Focused/Visible/Burst => active stream
    // - Background => stop streaming; rely on headless snapshot + wake for fidelity
    const backendTier: "active" | "background" =
      tier === TerminalRefreshTier.BACKGROUND ? "background" : "active";
    const prevBackendTier = this.lastBackendTier.get(id) ?? "active";
    this.setBackendTier(id, backendTier);

    // On upgrade to active, only wake if we actually dropped data while backgrounded.
    // This prevents unnecessary wake+restore cycles during layout churn that causes
    // tier transitions but doesn't actually miss any data.
    if (backendTier === "active" && prevBackendTier !== "active") {
      if (managed.needsWake) {
        managed.needsWake = false;
        void this.wakeAndRestore(id).catch(() => {
          // On failure, restore the flag so we retry next time
          const current = this.instances.get(id);
          if (current) current.needsWake = true;
        });
      }
    }
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.getRefreshTier = provider;
  }

  boostRefreshRate(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    this.applyRendererPolicy(id, TerminalRefreshTier.BURST);
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  destroy(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const waiters = this.readinessWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before frontend became ready`));
      }
      this.readinessWaiters.delete(id);
    }

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
    this.unseenTracker.destroy(id);

    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
      managed.inputBurstTimer = undefined;
    }

    managed.restoreGeneration++;
    managed.isSerializedRestoreInProgress = false;
    managed.deferredOutput = [];

    managed.exitSubscribers.clear();
    managed.agentStateSubscribers.clear();

    managed.parserHandler?.dispose();

    try {
      managed.fileLinksDisposable?.dispose();
    } catch (error) {
      console.warn("[TerminalInstanceService] Error disposing file links:", error);
    }

    managed.terminal.dispose();

    if (managed.hostElement.parentElement) {
      managed.hostElement.parentElement.removeChild(managed.hostElement);
    }

    const slot = this.offscreenSlots.get(id);
    if (slot && slot.parentElement) {
      slot.parentElement.removeChild(slot);
    }
    this.offscreenSlots.delete(id);
    this.resizeLocks.delete(id);
    this.lastBackendTier.delete(id);
    this.suppressedExitUntil.delete(id);
    this.cwdProviders.delete(id);
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

      if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        return await this.restoreFromSerializedIncremental(id, serializedState);
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
      if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        void this.restoreFromSerializedIncremental(id, serializedState);
        return true;
      }

      // Set restore flag to defer incoming output during reset+write.
      // This makes the restore atomic - no blank terminal between reset and write completion.
      managed.isSerializedRestoreInProgress = true;

      managed.terminal.reset();
      managed.terminal.write(serializedState, () => {
        // Guard against stale callback after destroy/restart
        const current = this.instances.get(id);
        if (current !== managed) return;

        current.isSerializedRestoreInProgress = false;

        // Flush any output that arrived during restore
        const deferred = current.deferredOutput;
        current.deferredOutput = [];
        for (const data of deferred) {
          this.writeToTerminal(id, data);
        }
      });
      return true;
    } catch (error) {
      // Ensure flag is cleared on error
      managed.isSerializedRestoreInProgress = false;
      console.error(`[TerminalInstanceService] Failed to restore terminal ${id}:`, error);
      return false;
    }
  }

  private async restoreFromSerializedIncremental(
    id: string,
    serializedState: string
  ): Promise<boolean> {
    const managed = this.instances.get(id);
    if (!managed) {
      console.warn(`[TerminalInstanceService] Cannot restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = ++managed.restoreGeneration;
    managed.isSerializedRestoreInProgress = true;

    const task = async (): Promise<boolean> => {
      try {
        if (this.instances.get(id) !== managed || managed.restoreGeneration !== restoreGeneration) {
          return false;
        }

        managed.terminal.reset();

        let offset = 0;
        const total = serializedState.length;

        while (offset < total) {
          if (
            this.instances.get(id) !== managed ||
            managed.restoreGeneration !== restoreGeneration
          ) {
            return false;
          }

          const chunkSize = Math.min(INCREMENTAL_RESTORE_CONFIG.chunkBytes, total - offset);
          const chunk = serializedState.substring(offset, offset + chunkSize);
          offset += chunkSize;

          await Promise.race([
            new Promise<void>((resolve, reject) => {
              try {
                managed.terminal.write(chunk, () => resolve());
              } catch (err) {
                reject(err);
              }
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Write timeout")), 5000)
            ),
          ]);

          if (offset < total) {
            await this.yieldToUI();
          }
        }

        return true;
      } catch (error) {
        console.error(`[TerminalInstanceService] Incremental restore failed for ${id}:`, error);
        return false;
      } finally {
        if (this.instances.get(id) === managed && managed.restoreGeneration === restoreGeneration) {
          managed.isSerializedRestoreInProgress = false;

          const deferredData = managed.deferredOutput;
          managed.deferredOutput = [];

          for (const data of deferredData) {
            this.writeToTerminal(id, data);
          }
        }
      }
    };

    const writePromise = managed.writeChain.then(task).catch((err) => {
      console.error(`[TerminalInstanceService] Write chain error for ${id}:`, err);
      return false;
    });

    managed.writeChain = writePromise.then(() => {});

    return writePromise;
  }

  private yieldToUI(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(() => resolve(), { timeout: INCREMENTAL_RESTORE_CONFIG.timeBudgetMs });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  private getBufferLineCount(id: string): number {
    const managed = this.instances.get(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  }

  setInputLocked(id: string, locked: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isInputLocked = locked;
    managed.terminal.options.disableStdin = locked;
  }

  getInputLocked(id: string): boolean {
    const managed = this.instances.get(id);
    return managed?.isInputLocked ?? false;
  }
}

export const terminalInstanceService = new TerminalInstanceService();
