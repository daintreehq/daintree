import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier, TerminalType } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  INCREMENTAL_RESTORE_CONFIG,
} from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalOutputIngestService } from "./TerminalOutputIngestService";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { TerminalUnseenOutputTracker, UnseenOutputSnapshot } from "./TerminalUnseenOutputTracker";
import { TerminalOffscreenManager } from "./TerminalOffscreenManager";
import { TerminalLinkHandler } from "./TerminalLinkHandler";
import { TerminalResizeController } from "./TerminalResizeController";
import { TerminalRendererPolicy } from "./TerminalRendererPolicy";
import { TerminalWakeManager } from "./TerminalWakeManager";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private dataBuffer = new TerminalOutputIngestService((id, data) =>
    this.writeToTerminal(id, data)
  );
  private readonly textEncoder = new TextEncoder();
  private perfWriteSampleCounter = 0;
  private suppressedExitUntil = new Map<string, number>();
  private unseenTracker = new TerminalUnseenOutputTracker();
  private cwdProviders = new Map<string, () => string>();
  private readinessWaiters = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: Error) => void; timeout: number }>
  >();
  private offscreenManager = new TerminalOffscreenManager();
  private linkHandler = new TerminalLinkHandler();
  private resizeController: TerminalResizeController;
  private rendererPolicy: TerminalRendererPolicy;
  private wakeManager: TerminalWakeManager;

  constructor() {
    this.dataBuffer.initialize();

    this.resizeController = new TerminalResizeController({
      getInstance: (id) => this.instances.get(id),
      dataBuffer: this.dataBuffer,
    });

    this.wakeManager = new TerminalWakeManager({
      getInstance: (id) => this.instances.get(id),
      hasInstance: (id) => this.instances.has(id),
      restoreFromSerialized: (id, state) => this.restoreFromSerialized(id, state),
      restoreFromSerializedIncremental: (id, state) =>
        this.restoreFromSerializedIncremental(id, state),
    });

    this.rendererPolicy = new TerminalRendererPolicy({
      getInstance: (id) => this.instances.get(id),
      wakeAndRestore: (id) => this.wakeManager.wakeAndRestore(id),
      onPostWake: (id) => this.handlePostWake(id),
    });
  }

  notifyUserInput(id: string): void {
    this.onUserInput(id);
  }

  private onUserInput(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);

    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
    }
    managed.inputBurstTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (!current) return;
      current.inputBurstTimer = undefined;
      this.rendererPolicy.applyRendererPolicy(id, current.getRefreshTier());
    }, 1000);
  }

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
    const slot = this.offscreenManager.getOrCreateOffscreenSlot(id, widthPx, heightPx);
    this.attach(id, slot);

    this.resizeController.fit(id);
    return managed;
  }

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

  private writeToTerminal(id: string, data: string | Uint8Array): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.isSerializedRestoreInProgress) {
      managed.deferredOutput.push(data);
      return;
    }

    this.unseenTracker.incrementUnseen(id, managed.isUserScrolledBack);

    this.perfWriteSampleCounter += 1;
    const shouldSample = this.perfWriteSampleCounter % 64 === 0;

    const sampledBytes = shouldSample
      ? typeof data === "string"
        ? data.length
        : data.byteLength
      : 0;
    const acknowledgedBytes =
      typeof data === "string"
        ? this.textEncoder.encode(data).length
        : data.byteLength;

    if (shouldSample) {
      markRendererPerformance(PERF_MARKS.TERMINAL_DATA_PARSED, {
        terminalId: id,
        bytes: sampledBytes,
      });
    }

    const terminal = managed.terminal;
    managed.pendingWrites = (managed.pendingWrites ?? 0) + 1;
    const writeQueuedAt = shouldSample
      ? typeof performance !== "undefined"
        ? performance.now()
        : Date.now()
      : 0;
    terminal.write(data, () => {
      if (this.instances.get(id) !== managed) return;

      managed.pendingWrites = Math.max(0, (managed.pendingWrites ?? 1) - 1);

      terminalClient.acknowledgeData(id, acknowledgedBytes);

      if (shouldSample) {
        const writeDurationMs =
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - writeQueuedAt;
        markRendererPerformance("terminal_write_duration_sample", {
          terminalId: id,
          bytes: sampledBytes,
          durationMs: Number(writeDurationMs.toFixed(3)),
          pendingWrites: managed.pendingWrites ?? 0,
        });
        markRendererPerformance(PERF_MARKS.TERMINAL_DATA_RENDERED, {
          terminalId: id,
          bytes: sampledBytes,
        });
      }
    });
  }

  setVisible(id: string, isVisible: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const wasVisible = managed.isVisible;
    if (wasVisible !== isVisible) {
      managed.isVisible = isVisible;
      managed.lastActiveTime = Date.now();

      if (isVisible) {
        if (managed.isAttaching) return;

        const rect = managed.hostElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const widthChanged = Math.abs(managed.lastWidth - rect.width) >= 1;
          const heightChanged = Math.abs(managed.lastHeight - rect.height) >= 1;

          if (widthChanged || heightChanged) {
            managed.lastWidth = rect.width;
            managed.lastHeight = rect.height;
          }
        }

        const tier = managed.getRefreshTier
          ? managed.getRefreshTier()
          : TerminalRefreshTier.VISIBLE;
        this.rendererPolicy.applyRendererPolicy(id, tier);

        requestAnimationFrame(() => {
          const current = this.instances.get(id);
          if (current && current.isVisible) {
            current.terminal.refresh(0, current.terminal.rows - 1);

            if (!current.isAltBuffer && current.latestWasAtBottom) {
              this.scrollToBottom(id);
            }
          }
        });
      }
    }
  }

  lockResize(id: string, locked: boolean): void {
    this.resizeController.lockResize(id, locked);
  }

  suppressResizesDuringProjectSwitch(terminalIds: string[], durationMs: number): void {
    terminalIds.forEach((id) => {
      const instance = this.instances.get(id);
      if (!instance) return;

      if (instance.resizeSuppressionTimer) {
        clearTimeout(instance.resizeSuppressionTimer);
      }

      instance.isResizeSuppressed = true;
      instance.resizeSuppressionEndTime = Date.now() + durationMs;
      this.resizeController.lockResize(id, true);

      instance.resizeSuppressionTimer = window.setTimeout(() => {
        instance.isResizeSuppressed = false;
        instance.resizeSuppressionEndTime = undefined;
        instance.resizeSuppressionTimer = undefined;
        this.resizeController.lockResize(id, false);
      }, durationMs);
    });
  }

  setTargetSize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      cols <= 500 &&
      rows > 0 &&
      rows <= 500
    ) {
      instance.targetCols = cols;
      instance.targetRows = rows;
    }
  }

  clearResizeSuppression(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (instance.resizeSuppressionTimer) {
      clearTimeout(instance.resizeSuppressionTimer);
      instance.resizeSuppressionTimer = undefined;
    }

    instance.isResizeSuppressed = false;
    instance.resizeSuppressionEndTime = undefined;
    this.resizeController.lockResize(id, false);
  }

  wake(id: string): void {
    this.wakeManager.wake(id);
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
      if (options) {
        this.updateOptions(id, options);
      }
      return existing;
    }

    const openLink = (url: string, event?: MouseEvent) => {
      this.linkHandler.openLink(url, id, event);
    };

    const terminalOptions = {
      ...options,
      linkHandler: {
        activate: (event: MouseEvent, text: string) => openLink(text, event),
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
    hostElement.style.overflow = "hidden";
    hostElement.style.position = "relative";

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

    const kind =
      type === "claude" || type === "gemini" || type === "codex" || type === "opencode"
        ? "agent"
        : "terminal";
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
      isAltBuffer: false,
      altBufferListeners: new Set(),
    };

    managed.parserHandler = new TerminalParserHandler(managed, () => {
      this.resizeController.applyDeferredResize(id);
    });

    const initialIsAltBuffer = terminal.buffer.active.type === "alternate";
    managed.isAltBuffer = initialIsAltBuffer;

    const bufferDisposable = terminal.buffer.onBufferChange(() => {
      const newIsAltBuffer = terminal.buffer.active.type === "alternate";
      if (newIsAltBuffer !== managed.isAltBuffer) {
        managed.isAltBuffer = newIsAltBuffer;
        this.handleBufferModeChange(id, newIsAltBuffer);
      }
    });
    listeners.push(() => bufferDisposable.dispose());

    if (initialIsAltBuffer) {
      this.handleBufferModeChange(id, true);
    }

    const oscDisposable = terminal.parser.registerOscHandler(11, () => {
      if (managed.isAltBuffer) {
        for (const callback of managed.altBufferListeners) {
          try {
            callback(true);
          } catch (err) {
            logError("Alt buffer callback error", err);
          }
        }
      }
      return false;
    });
    listeners.push(() => oscDisposable.dispose());

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
    this.rendererPolicy.applyRendererPolicy(id, initialTier);

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
    if (!managed) {
      logDebug(`[TIS.attach] No managed instance for ${id}`);
      return null;
    }

    const wasDetached = managed.isDetached === true;
    const wasReparented = managed.hostElement.parentElement !== container;
    logDebug(`[TIS.attach] ${id}`, {
      wasReparented,
      wasDetached,
      isOpened: managed.isOpened,
      bufferRows: managed.terminal.buffer?.active?.length ?? 0,
      containerRect: container.getBoundingClientRect(),
    });

    if (wasReparented) {
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;
      logDebug(`[TIS.attach] Opened terminal ${id}`);
    }
    managed.lastAttachAt = Date.now();
    managed.isDetached = false;

    if (wasReparented && managed.isOpened) {
      requestAnimationFrame(() => {
        if (this.instances.get(id) !== managed) return;
        managed.isAttaching = false;
        if (!managed.terminal.element) return;

        managed.terminal.refresh(0, managed.terminal.rows - 1);

        requestAnimationFrame(() => {
          if (this.instances.get(id) !== managed) return;

          if (wasDetached) {
            const rect = container.getBoundingClientRect();
            const widthMatch =
              managed.lastWidth > 0 && Math.abs(managed.lastWidth - rect.width) < 2;
            const heightMatch =
              managed.lastHeight > 0 && Math.abs(managed.lastHeight - rect.height) < 2;
            if (widthMatch && heightMatch) {
              logDebug(`[TIS.attach] Skipping resize for ${id} — dimensions match after detach`);
              managed.targetCols = undefined;
              managed.targetRows = undefined;
              return;
            }
          }

          // Temporarily bypass resize lock for the initial attach fit, then re-lock.
          // Don't call clearResizeSuppression() — the suppression window must remain
          // active to block ResizeObserver and batch-fit events while layout settles.
          const needsLockBypass = managed.isResizeSuppressed;
          let remainingSuppressionMs = 0;

          if (needsLockBypass) {
            // Calculate remaining suppression time to use for re-lock
            if (managed.resizeSuppressionEndTime) {
              remainingSuppressionMs = Math.max(0, managed.resizeSuppressionEndTime - Date.now());
            }
            this.resizeController.lockResize(id, false);
          }

          try {
            if (managed.targetCols && managed.targetRows) {
              this.resizeController.applyResize(id, managed.targetCols, managed.targetRows);
              managed.targetCols = undefined;
              managed.targetRows = undefined;
            } else {
              this.resizeController.fit(id);
            }
          } finally {
            if (needsLockBypass) {
              // Re-lock with remaining suppression time to maintain full protection window
              this.resizeController.lockResize(id, true, remainingSuppressionMs);
            }
          }
        });
      });
    } else {
      managed.isAttaching = false;
    }

    return managed;
  }

  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container) {
      logDebug(`[TIS.detach] Skipping ${id} - no managed:${!managed}, no container:${!container}`);
      return;
    }

    const isDirectChild = managed.hostElement.parentElement === container;
    logDebug(`[TIS.detach] ${id}`, {
      isDirectChild,
      bufferRows: managed.terminal.buffer?.active?.length ?? 0,
    });

    if (isDirectChild) {
      const slot = this.offscreenManager.getOffscreenSlot(id);
      if (slot) {
        logDebug(`[TIS.detach] Moving ${id} to offscreen slot`);
        slot.appendChild(managed.hostElement);
      } else {
        const hiddenContainer = this.offscreenManager.ensureHiddenContainer();
        if (hiddenContainer) {
          logDebug(`[TIS.detach] Moving ${id} to hidden container`);
          hiddenContainer.appendChild(managed.hostElement);
        } else {
          logDebug(`[TIS.detach] Removing ${id} from DOM (no fallback container)`);
          container.removeChild(managed.hostElement);
        }
      }
    }
    managed.lastDetachAt = Date.now();
    managed.isDetached = true;
  }

  detachForProjectSwitch(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    logDebug(`[TIS.detachForProjectSwitch] ${id}`);

    managed.isVisible = false;
    managed.isDetached = true;

    this.resizeController.clearResizeJobs(managed);
    this.resizeController.clearSettledTimer(id);

    if (managed.hostElement.parentElement) {
      const hiddenContainer = this.offscreenManager.ensureHiddenContainer();
      if (hiddenContainer && managed.hostElement.parentElement !== hiddenContainer) {
        hiddenContainer.appendChild(managed.hostElement);
      }
    }

    managed.lastDetachAt = Date.now();
  }

  fit(id: string): { cols: number; rows: number } | null {
    return this.resizeController.fit(id);
  }

  flushResize(id: string): void {
    this.resizeController.flushResize(id);
  }

  sendPtyResize(id: string, cols: number, rows: number): void {
    this.resizeController.sendPtyResize(id, cols, rows);
  }

  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    return this.resizeController.resize(id, width, height, options);
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

  setAgentState(id: string, state: AgentState): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const previousState = managed.agentState;
    if (previousState === state) return;

    managed.agentState = state;

    for (const callback of managed.agentStateSubscribers) {
      try {
        callback(state);
      } catch (err) {
        logError("Agent state callback error", err);
      }
    }
  }

  private handlePostWake(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // For settled-strategy agents, send a single PTY resize.
    // For default agents, xterm v6 handles rendering recovery
    // after wake without needing a row bounce hack.
    if (this.getResizeStrategyForTerminal(managed) === "settled") {
      const cols = managed.latestCols;
      const rows = managed.latestRows;
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        this.resizeController.sendPtyResize(id, cols, rows);
      }
      return;
    }

    this.resizeController.forceImmediateResize(id);
  }

  private getResizeStrategyForTerminal(managed: ManagedTerminal): "default" | "settled" {
    if (!managed.agentId) return "default";
    const config = getEffectiveAgentConfig(managed.agentId);
    return config?.capabilities?.resizeStrategy ?? "default";
  }

  private handleBufferModeChange(id: string, isAltBuffer: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    for (const callback of managed.altBufferListeners) {
      try {
        callback(isAltBuffer);
      } catch (err) {
        logError("Alt buffer callback error", err);
      }
    }

    // Don't call fit() here. The alt buffer listeners update React state which
    // changes container padding, and the ResizeObserver on the container handles
    // the resulting layout change. Calling fit() in a rAF would double-trigger
    // the resize path, sending redundant PTY resize events that cause Ink-based
    // TUIs (Gemini CLI) to detect idle re-render loops.
    this.resizeController.clearResizeJobs(managed);
  }

  addAltBufferListener(id: string, callback: (isAltBuffer: boolean) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.altBufferListeners.add(callback);

    if (managed.isAltBuffer !== undefined) {
      try {
        callback(managed.isAltBuffer);
      } catch (err) {
        logError("Alt buffer callback error", err);
      }
    }

    return () => {
      managed.altBufferListeners.delete(callback);
    };
  }

  getAltBufferState(id: string): boolean {
    const managed = this.instances.get(id);
    return managed?.isAltBuffer ?? false;
  }

  getAgentState(id: string): AgentState | undefined {
    const managed = this.instances.get(id);
    return managed?.agentState;
  }

  addAgentStateListener(id: string, callback: AgentStateCallback): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.agentStateSubscribers.add(callback);

    if (managed.agentState !== undefined) {
      try {
        callback(managed.agentState);
      } catch (err) {
        logError("Agent state callback error", err);
      }
    }

    return () => {
      managed.agentStateSubscribers.delete(callback);
    };
  }

  setFocused(id: string, isFocused: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isFocused = isFocused;
    managed.lastActiveTime = Date.now();
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    managed?.terminal.focus();
  }

  resetRenderer(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    try {
      if (!managed.hostElement.isConnected) {
        logDebug(`resetRenderer skipped for ${id}: not connected`);
        return;
      }
      if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) {
        logDebug(
          `resetRenderer skipped for ${id}: too small (${managed.hostElement.clientWidth}x${managed.hostElement.clientHeight})`
        );
        return;
      }

      logDebug(`resetRenderer running for ${id}`);

      managed.terminal.clearTextureAtlas();
      managed.terminal.refresh(0, managed.terminal.rows - 1);

      this.resizeController.fit(id);
    } catch (error) {
      logError(`resetRenderer failed for ${id}`, error);
    }
  }

  handleBackendRecovery(): void {
    this.instances.forEach((managed, id) => {
      try {
        managed.terminal.write("\x1b[!p");

        this.resetRenderer(id);

        managed.fitAddon?.fit();

        const timestamp = new Date().toLocaleTimeString();
        managed.terminal.write(
          `\r\n\x1b[33m[${timestamp}] Terminal backend reconnected\x1b[0m\r\n`
        );
      } catch (error) {
        logError(`Failed to recover terminal ${id}`, error);
      }
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
    this.rendererPolicy.applyRendererPolicy(id, tier);
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.getRefreshTier = provider;
  }

  boostRefreshRate(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);
  }

  /**
   * Initialize the backend tier state for a reconnected terminal.
   * This ensures proper wake behavior after project switch by setting
   * the frontend's lastBackendTier to match the actual backend state.
   */
  initializeBackendTier(id: string, tier: "active" | "background"): void {
    this.rendererPolicy.initializeBackendTier(id, tier);
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

    this.instances.delete(id);

    for (const unsub of managed.listeners) {
      try {
        unsub();
      } catch (error) {
        logWarn("Error unsubscribing listener", { error });
      }
    }
    managed.listeners.length = 0;

    this.resizeController.clearResizeJobs(managed);
    this.resizeController.clearResizeLock(id);
    this.resizeController.clearSettledTimer(id);
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
    if (managed.resizeSuppressionTimer !== undefined) {
      clearTimeout(managed.resizeSuppressionTimer);
      managed.resizeSuppressionTimer = undefined;
    }

    managed.restoreGeneration++;
    managed.isSerializedRestoreInProgress = false;
    managed.deferredOutput = [];

    managed.exitSubscribers.clear();
    managed.agentStateSubscribers.clear();
    managed.altBufferListeners.clear();

    managed.parserHandler?.dispose();

    try {
      managed.fileLinksDisposable?.dispose();
    } catch (error) {
      logWarn("Error disposing file links", { error });
    }

    managed.terminal.dispose();

    if (managed.hostElement.parentElement) {
      managed.hostElement.parentElement.removeChild(managed.hostElement);
    }

    this.offscreenManager.removeOffscreenSlot(id);
    this.suppressedExitUntil.delete(id);
    this.cwdProviders.delete(id);
    this.wakeManager.clearWakeState(id);
    this.rendererPolicy.clearTierState(id);
  }

  dispose(): void {
    this.stopPolling();
    this.instances.forEach((_, id) => this.destroy(id));
    this.offscreenManager.dispose();
    this.wakeManager.dispose();
    this.rendererPolicy.dispose();
  }

  async restoreFetchedState(id: string, serializedState: string | null): Promise<boolean> {
    if (!serializedState) {
      logWarn(`No serialized state for terminal ${id}`);
      return false;
    }

    if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
      return await this.restoreFromSerializedIncremental(id, serializedState);
    }

    return this.restoreFromSerialized(id, serializedState);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    try {
      const serializedState = await terminalClient.getSerializedState(id);
      return await this.restoreFetchedState(id, serializedState);
    } catch (error) {
      logError(`Failed to fetch state for terminal ${id}`, error);
      return false;
    }
  }

  restoreFromSerialized(id: string, serializedState: string): boolean {
    const managed = this.instances.get(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    try {
      if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        void this.restoreFromSerializedIncremental(id, serializedState);
        return true;
      }

      const shouldAutoScroll = managed.latestWasAtBottom;
      managed.isSerializedRestoreInProgress = true;

      managed.terminal.reset();
      managed.terminal.write(serializedState, () => {
        const current = this.instances.get(id);
        if (current !== managed) return;

        current.isSerializedRestoreInProgress = false;

        const deferred = current.deferredOutput;
        current.deferredOutput = [];
        for (const data of deferred) {
          this.writeToTerminal(id, data);
        }

        if (shouldAutoScroll && !current.isAltBuffer) {
          this.scrollToBottom(id);

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const latest = this.instances.get(id);
              if (latest && latest.isVisible && !latest.isAltBuffer && shouldAutoScroll) {
                this.scrollToBottom(id);
              }
            });
          });
        }
      });
      return true;
    } catch (error) {
      managed.isSerializedRestoreInProgress = false;
      logError(`Failed to restore terminal ${id}`, error);
      return false;
    }
  }

  private async restoreFromSerializedIncremental(
    id: string,
    serializedState: string
  ): Promise<boolean> {
    const managed = this.instances.get(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = ++managed.restoreGeneration;
    const shouldAutoScroll = managed.latestWasAtBottom;
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
        logError(`Incremental restore failed for ${id}`, error);
        return false;
      } finally {
        if (this.instances.get(id) === managed && managed.restoreGeneration === restoreGeneration) {
          managed.isSerializedRestoreInProgress = false;

          const deferredData = managed.deferredOutput;
          managed.deferredOutput = [];

          for (const data of deferredData) {
            this.writeToTerminal(id, data);
          }

          if (shouldAutoScroll && !managed.isAltBuffer) {
            this.scrollToBottom(id);

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const latest = this.instances.get(id);
                if (latest && latest.isVisible && !latest.isAltBuffer && shouldAutoScroll) {
                  this.scrollToBottom(id);
                }
              });
            });
          }
        }
      }
    };

    const writePromise = managed.writeChain.then(task).catch((err) => {
      logError(`Write chain error for ${id}`, err);
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

  setInputLocked(id: string, locked: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isInputLocked = locked;
    managed.terminal.options.disableStdin = locked;
  }
}

export const terminalInstanceService = new TerminalInstanceService();
