import { Terminal } from "@xterm/xterm";
import { isMac } from "@/lib/platform";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier, TerminalType } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
  HIBERNATION_DELAY_MS,
} from "./types";
import {
  setupTerminalAddons,
  createImageAddon,
  createFileLinksAddon,
  createWebLinksAddon,
} from "./TerminalAddonManager";
import { TerminalOutputIngestService } from "./TerminalOutputIngestService";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { TerminalUnseenOutputTracker, UnseenOutputSnapshot } from "./TerminalUnseenOutputTracker";
import { TerminalOffscreenManager } from "./TerminalOffscreenManager";
import { TerminalLinkHandler } from "./TerminalLinkHandler";
import { TerminalResizeController } from "./TerminalResizeController";
import { TerminalRendererPolicy } from "./TerminalRendererPolicy";
import { TerminalWebGLManager } from "./TerminalWebGLManager";
import { TerminalWakeManager } from "./TerminalWakeManager";
import { TerminalAgentStateController } from "./TerminalAgentStateController";
import { TerminalRestoreController } from "./TerminalRestoreController";
import { TerminalHibernationManager } from "./TerminalHibernationManager";
import { reduceScrollback, restoreScrollback } from "./TerminalScrollbackController";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { stripAnsiAndOscCodes } from "@shared/utils/urlUtils";
import { isNonKeyboardInput } from "./inputUtils";

export { isNonKeyboardInput } from "./inputUtils";

function canAutoInitializeTerminalIngest(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.electron?.terminal?.getSharedBuffers === "function"
  );
}

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private dataBuffer = new TerminalOutputIngestService((id, data) =>
    this.writeToTerminal(id, data)
  );
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
  private cachedSelections = new Map<string, string>();
  private resizeController: TerminalResizeController;
  private rendererPolicy: TerminalRendererPolicy;
  private webGLManager = new TerminalWebGLManager();
  private wakeManager: TerminalWakeManager;
  private agentStateController: TerminalAgentStateController;
  private restoreController: TerminalRestoreController;
  private hibernationManager: TerminalHibernationManager;

  constructor() {
    if (canAutoInitializeTerminalIngest()) {
      void this.dataBuffer.initialize();
    }

    this.resizeController = new TerminalResizeController({
      getInstance: (id) => this.instances.get(id),
      dataBuffer: this.dataBuffer,
    });

    this.agentStateController = new TerminalAgentStateController({
      getInstance: (id) => this.instances.get(id),
    });

    this.restoreController = new TerminalRestoreController({
      getInstance: (id) => this.instances.get(id),
      writeData: (id, data) => this.writeToTerminal(id, data),
    });

    this.hibernationManager = new TerminalHibernationManager({
      getInstance: (id) => this.instances.get(id),
      destroyRestoreState: (id) => this.restoreController.destroy(id),
      resetBufferedOutput: (id) => this.dataBuffer.resetForTerminal(id),
      releaseWebGL: (id) => this.webGLManager.onTerminalDestroyed(id),
      clearResizeJob: (managed) => this.resizeController.clearResizeJob(managed),
      clearSettledTimer: (id) => this.resizeController.clearSettledTimer(id),
      applyDeferredResize: (id) => this.resizeController.applyDeferredResize(id),
      openLink: (url, id, event) => this.linkHandler.openLink(url, id, event),
      getCwdProvider: (id) => this.cwdProviders.get(id),
      onBufferModeChange: (id, isAltBuffer) => this.handleBufferModeChange(id, isAltBuffer),
      notifyParsed: (id) => this.dataBuffer.notifyParsed(id),
      scrollToBottomSafe: (managed) => this.scrollToBottomSafe(managed),
      clearUnseen: (id, fromUser) => this.unseenTracker.clearUnseen(id, fromUser),
      updateScrollState: (id, isScrolledBack) =>
        this.unseenTracker.updateScrollState(id, isScrolledBack),
      setCachedSelection: (id, selection) => this.cachedSelections.set(id, selection),
      clearDirectingState: (id) => this.agentStateController.clearDirectingState(id),
      onUserInput: (id, data) => this.onUserInput(id, data),
    });

    this.wakeManager = new TerminalWakeManager({
      getInstance: (id) => this.instances.get(id),
      hasInstance: (id) => this.instances.has(id),
      restoreFromSerialized: (id, state) => this.restoreController.restoreFromSerialized(id, state),
      restoreFromSerializedIncremental: (id, state) =>
        this.restoreController.restoreFromSerializedIncremental(id, state),
    });

    this.rendererPolicy = new TerminalRendererPolicy({
      getInstance: (id) => this.instances.get(id),
      wakeAndRestore: (id) => {
        const m = this.instances.get(id);
        if (m?.isHibernated) this.unhibernate(id);
        return this.wakeManager.wakeAndRestore(id);
      },
      onPostWake: (id) => this.handlePostWake(id),
      onTierApplied: (id, tier, managed) => {
        // Hibernation timer management
        if (
          tier === TerminalRefreshTier.BACKGROUND &&
          (managed.kind !== "agent" || managed.canonicalAgentState === "completed")
        ) {
          if (!managed.hibernationTimer && !managed.isHibernated) {
            managed.hibernationTimer = setTimeout(() => {
              managed.hibernationTimer = undefined;
              this.hibernate(id);
            }, HIBERNATION_DELAY_MS);
          }
        } else {
          if (managed.hibernationTimer) {
            clearTimeout(managed.hibernationTimer);
            managed.hibernationTimer = undefined;
          }
        }

        if (tier === TerminalRefreshTier.BACKGROUND) {
          reduceScrollback(managed, SCROLLBACK_BACKGROUND);

          if (managed.imageAddon) {
            try {
              managed.imageAddon.dispose();
            } catch {
              /* ignore */
            }
            managed.imageAddon = null;
          }
          if (managed.fileLinksDisposable) {
            try {
              managed.fileLinksDisposable.dispose();
            } catch {
              /* ignore */
            }
            managed.fileLinksDisposable = null;
          }
          if (managed.webLinksAddon) {
            try {
              managed.webLinksAddon.dispose();
            } catch {
              /* ignore */
            }
            managed.webLinksAddon = null;
          }
        } else {
          restoreScrollback(managed);

          if (!managed.imageAddon) {
            try {
              managed.imageAddon = createImageAddon(managed.terminal);
            } catch (err) {
              logWarn("Failed to recreate ImageAddon", { id, error: err });
            }
          }
          if (!managed.fileLinksDisposable) {
            try {
              managed.fileLinksDisposable = createFileLinksAddon(managed.terminal, () =>
                (this.cwdProviders.get(id) ?? (() => ""))()
              );
            } catch (err) {
              logWarn("Failed to recreate FileLinksAddon", { id, error: err });
            }
          }
          if (!managed.webLinksAddon) {
            try {
              managed.webLinksAddon = createWebLinksAddon(managed.terminal, (event, uri) =>
                this.linkHandler.openLink(uri, id, event)
              );
            } catch (err) {
              logWarn("Failed to recreate WebLinksAddon", { id, error: err });
            }
          }
        }

        if (
          tier === TerminalRefreshTier.FOCUSED ||
          tier === TerminalRefreshTier.BURST ||
          tier === TerminalRefreshTier.VISIBLE
        ) {
          this.webGLManager.ensureContext(id, managed);
        } else {
          this.webGLManager.releaseContext(id);
        }
      },
    });
  }

  setGPUHardwareAvailable(available: boolean): void {
    this.webGLManager.setHardwareAvailable(available);
  }

  notifyUserInput(id: string, data = ""): void {
    this.onUserInput(id, data);
  }

  private onUserInput(id: string, data: string): void {
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

    this.agentStateController.onUserInput(id, data);
  }

  private onEnterPressed(id: string): void {
    this.agentStateController.onEnterPressed(id);
  }

  clearDirectingState(id: string): void {
    this.agentStateController.clearDirectingState(id);
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

    if (managed.isHibernated) {
      const bytes = typeof data === "string" ? data.length : data.byteLength;
      this.dataBuffer.notifyWriteComplete(id, bytes);
      return;
    }

    if (managed.isSerializedRestoreInProgress) {
      managed.deferredOutput.push(data);
      const deferredBytes = typeof data === "string" ? data.length : data.byteLength;
      this.dataBuffer.notifyWriteComplete(id, deferredBytes);
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
    const acknowledgedBytes = typeof data === "string" ? data.length : data.byteLength;

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
      this.dataBuffer.notifyWriteComplete(id, acknowledgedBytes);

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

      if (!managed.isAltBuffer) {
        managed.lastActivityMarker?.dispose();
        managed.lastActivityMarker = terminal.registerMarker(0);
      }
    });
  }

  setVisible(id: string, isVisible: boolean): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

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
          }
        });
      }
    }
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    this.resizeController.lockResize(id, locked, customTtlMs);
  }

  private layoutTransitionTimer: number | undefined;

  suppressResizesDuringLayoutTransition(terminalIds: string[], durationMs: number): void {
    if (terminalIds.length === 0) return;

    if (this.layoutTransitionTimer !== undefined) {
      clearTimeout(this.layoutTransitionTimer);
    }

    const safetyTtl = durationMs + 100;
    for (const id of terminalIds) {
      this.resizeController.lockResize(id, true, safetyTtl);
    }

    this.layoutTransitionTimer = window.setTimeout(() => {
      this.layoutTransitionTimer = undefined;
      for (const id of terminalIds) {
        if (!this.instances.has(id)) continue;
        this.resizeController.lockResize(id, false);
        this.resizeController.fit(id);
      }
    }, durationMs);
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
    const managed = this.instances.get(id);
    if (managed?.isHibernated) {
      this.unhibernate(id);
    }
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
    const addons = setupTerminalAddons(
      terminal,
      () => (this.cwdProviders.get(id) ?? (() => ""))(),
      (event, uri) => openLink(uri, event)
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
      const current = this.instances.get(id);
      if (current && !current.isHibernated) {
        current.terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
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
      latestCols: 0,
      latestRows: 0,
      latestWasAtBottom: true,
      isUserScrolledBack: false,
      isFocused: false,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      scrollbackRestoreState: "none",
      attachRevealToken: 0,
      isAltBuffer: false,
      altBufferListeners: new Set(),
      ipcListenerCount: listeners.length,
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

    const writeParsedDisposable = terminal.onWriteParsed(() => {
      this.dataBuffer.notifyParsed(id);
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        this.scrollToBottomSafe(managed);
      }
    });
    listeners.push(() => writeParsedDisposable.dispose());

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      managed.latestWasAtBottom = isAtBottom;

      managed._userScrollIntent = false;
      if (managed._suppressScrollTracking) return;

      if (isAtBottom) {
        managed.isUserScrolledBack = false;
        this.unseenTracker.clearUnseen(id, false);
        if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
          reduceScrollback(managed, SCROLLBACK_BACKGROUND);
        }
      } else {
        managed.isUserScrolledBack = true;
        this.unseenTracker.updateScrollState(id, true);
      }
    });
    listeners.push(() => scrollDisposable.dispose());

    const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);
    const onWheel = () => {
      managed._userScrollIntent = true;
    };
    const onKeydownScroll = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) managed._userScrollIntent = true;
    };
    hostElement.addEventListener("wheel", onWheel, { passive: true });
    hostElement.addEventListener("keydown", onKeydownScroll);
    listeners.push(() => {
      hostElement.removeEventListener("wheel", onWheel);
      hostElement.removeEventListener("keydown", onKeydownScroll);
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      const sel = terminal.getSelection();
      if (sel) {
        this.cachedSelections.set(id, sel);
      } else if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
        reduceScrollback(managed, SCROLLBACK_BACKGROUND);
      }
    });
    listeners.push(() => selectionDisposable.dispose());

    if (agentId) {
      const agentConfig = getEffectiveAgentConfig(agentId);
      const titlePatterns = agentConfig?.detection?.titleStatePatterns;
      if (titlePatterns) {
        let lastReportedTitleState: "working" | "waiting" | undefined;

        const titleDisposable = terminal.onTitleChange((title: string) => {
          let matched: "working" | "waiting" | undefined;
          for (const pattern of titlePatterns.working) {
            if (title.includes(pattern)) {
              matched = "working";
              break;
            }
          }
          if (!matched) {
            for (const pattern of titlePatterns.waiting) {
              if (title.includes(pattern)) {
                matched = "waiting";
                break;
              }
            }
          }
          if (!matched) {
            if (managed.titleReportTimer !== undefined) {
              clearTimeout(managed.titleReportTimer);
              managed.titleReportTimer = undefined;
              managed.pendingTitleState = undefined;
            }
            return;
          }

          if (matched === "working") {
            if (managed.titleReportTimer !== undefined) {
              clearTimeout(managed.titleReportTimer);
              managed.titleReportTimer = undefined;
              managed.pendingTitleState = undefined;
            }
            if (lastReportedTitleState !== "working") {
              lastReportedTitleState = "working";
              window.electron.terminal.reportTitleState(id, "working");
            }
          } else {
            managed.pendingTitleState = "waiting";
            if (managed.titleReportTimer !== undefined) {
              clearTimeout(managed.titleReportTimer);
            }
            managed.titleReportTimer = window.setTimeout(() => {
              managed.titleReportTimer = undefined;
              if (managed.pendingTitleState === "waiting") {
                managed.pendingTitleState = undefined;
                if (lastReportedTitleState !== "waiting") {
                  lastReportedTitleState = "waiting";
                  window.electron.terminal.reportTitleState(id, "waiting");
                }
              }
            }, 250);
          }
        });
        listeners.push(() => {
          titleDisposable.dispose();
          if (managed.titleReportTimer !== undefined) {
            clearTimeout(managed.titleReportTimer);
            managed.titleReportTimer = undefined;
            managed.pendingTitleState = undefined;
          }
        });
      }
    }

    const inputDisposable = terminal.onData((data) => {
      if (!managed.isInputLocked) {
        if (isNonKeyboardInput(data)) {
          if (data === "\x1b") {
            this.agentStateController.clearDirectingState(id);
          }
        } else {
          this.onUserInput(id, data);
        }
        terminalClient.write(id, data);
        if (onInput) {
          onInput(data);
        }
      }
    });
    listeners.push(() => inputDisposable.dispose());

    if (kind === "agent") {
      const keyDisposable = terminal.onKey(({ domEvent }) => {
        if (
          !managed.isInputLocked &&
          domEvent.key === "Enter" &&
          !domEvent.isComposing &&
          !domEvent.shiftKey &&
          !domEvent.ctrlKey &&
          !domEvent.altKey &&
          !domEvent.metaKey
        ) {
          this.onEnterPressed(id);
        }
      });
      listeners.push(() => keyDisposable.dispose());
    }

    this.instances.set(id, managed);

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.rendererPolicy.applyRendererPolicy(id, initialTier);

    // For terminals starting at BACKGROUND tier, dispose tier-managed addons
    // immediately. The first applyRendererPolicy call is a no-op when initial
    // tier matches, so onTierApplied won't fire to dispose them. We also set
    // lastAppliedTier so that a later promotion is seen as an upgrade.
    if (initialTier === TerminalRefreshTier.BACKGROUND) {
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      try {
        managed.imageAddon?.dispose();
      } catch {
        /* ignore */
      }
      managed.imageAddon = null;
      try {
        managed.fileLinksDisposable?.dispose();
      } catch {
        /* ignore */
      }
      managed.fileLinksDisposable = null;
      try {
        managed.webLinksAddon?.dispose();
      } catch {
        /* ignore */
      }
      managed.webLinksAddon = null;
    }

    this.notifyReadinessWaiters(id);

    return managed;
  }

  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  getCachedSelection(id: string): string {
    return this.cachedSelections.get(id) ?? "";
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

  private cancelAttachReveal(managed: ManagedTerminal): void {
    managed.attachRevealToken++;
    if (managed.attachRevealTimer !== undefined) {
      clearTimeout(managed.attachRevealTimer);
      managed.attachRevealTimer = undefined;
    }
    if (managed.attachRevealDisposable) {
      managed.attachRevealDisposable.dispose();
      managed.attachRevealDisposable = undefined;
    }
    managed.hostElement.style.opacity = "";
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) {
      logDebug(`[TIS.attach] No managed instance for ${id}`);
      return null;
    }

    if (managed.isHibernated) {
      this.unhibernate(id);
    }

    const wasDetached = managed.isDetached === true;
    const wasAlreadyOpened = managed.isOpened;
    const wasReparented = managed.hostElement.parentElement !== container;
    logDebug(`[TIS.attach] ${id}`, {
      wasReparented,
      wasDetached,
      isOpened: managed.isOpened,
      bufferRows: managed.terminal.buffer?.active?.length ?? 0,
      containerRect: container.getBoundingClientRect(),
    });

    if (wasReparented) {
      if (managed.isOpened) {
        this.cancelAttachReveal(managed);
        managed.hostElement.style.opacity = "0";
      }
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;
      logDebug(`[TIS.attach] Opened terminal ${id}`);
      if (
        managed.lastAppliedTier === TerminalRefreshTier.FOCUSED ||
        managed.lastAppliedTier === TerminalRefreshTier.BURST ||
        managed.lastAppliedTier === TerminalRefreshTier.VISIBLE
      ) {
        this.webGLManager.ensureContext(id, managed);
      }
    }
    managed.lastAttachAt = Date.now();
    managed.isDetached = false;

    // For warm terminals (previously opened, detached during project switch) with
    // saved target dimensions, apply the resize synchronously before the rAF reveal.
    // This runs inside useLayoutEffect (before browser paint), eliminating the visible
    // layout snap that occurs when resize is deferred to the double-nested rAF.
    let earlyResizeApplied = false;
    if (wasDetached && wasAlreadyOpened && managed.targetCols && managed.targetRows) {
      const needsLockBypass = managed.isResizeSuppressed;
      let remainingMs = 0;
      if (needsLockBypass && managed.resizeSuppressionEndTime) {
        remainingMs = Math.max(0, managed.resizeSuppressionEndTime - Date.now());
        this.resizeController.lockResize(id, false);
      }
      try {
        this.resizeController.applyResize(id, managed.targetCols, managed.targetRows);
        managed.targetCols = undefined;
        managed.targetRows = undefined;
        earlyResizeApplied = true;
      } finally {
        if (needsLockBypass) {
          this.resizeController.lockResize(id, true, remainingMs);
        }
      }
    }

    if (wasReparented && managed.isOpened) {
      const revealToken = managed.attachRevealToken;
      requestAnimationFrame(() => {
        if (this.instances.get(id) !== managed) return;
        if (managed.attachRevealToken !== revealToken) return;
        managed.isAttaching = false;
        if (!managed.terminal.element) {
          managed.hostElement.style.opacity = "";
          return;
        }

        const reveal = () => {
          if (managed.attachRevealToken !== revealToken) return;
          managed.hostElement.style.opacity = "";
          if (managed.attachRevealTimer !== undefined) {
            clearTimeout(managed.attachRevealTimer);
            managed.attachRevealTimer = undefined;
          }
          if (managed.attachRevealDisposable) {
            managed.attachRevealDisposable.dispose();
            managed.attachRevealDisposable = undefined;
          }
        };

        managed.attachRevealDisposable = managed.terminal.onRender(() => {
          reveal();
        });

        managed.attachRevealTimer = setTimeout(reveal, 150);

        managed.terminal.refresh(0, managed.terminal.rows - 1);

        requestAnimationFrame(() => {
          if (this.instances.get(id) !== managed) return;

          if (earlyResizeApplied) return;

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
    if (!managed || !container || managed.isHibernated) {
      logDebug(`[TIS.detach] Skipping ${id} - no managed:${!managed}, no container:${!container}`);
      return;
    }
    this.cancelAttachReveal(managed);

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
    managed.terminal.blur();
    managed.lastDetachAt = Date.now();
    managed.isDetached = true;
  }

  detachForProjectSwitch(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    this.cancelAttachReveal(managed);

    logDebug(`[TIS.detachForProjectSwitch] ${id}`);

    managed.isVisible = false;
    managed.isDetached = true;

    this.resizeController.clearResizeJob(managed);
    this.resizeController.clearSettledTimer(id);

    if (managed.hostElement.parentElement) {
      const hiddenContainer = this.offscreenManager.ensureHiddenContainer();
      if (hiddenContainer && managed.hostElement.parentElement !== hiddenContainer) {
        hiddenContainer.appendChild(managed.hostElement);
      }
    }

    managed.terminal.blur();
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
    if (managed && !managed.isHibernated) {
      this.scrollToBottomSafe(managed);
    }
  }

  private scrollToBottomSafe(managed: ManagedTerminal): void {
    managed._suppressScrollTracking = true;
    try {
      managed.terminal.scrollToBottom();
    } finally {
      managed._suppressScrollTracking = false;
    }
    managed.isUserScrolledBack = false;
    managed.latestWasAtBottom = true;
  }

  scrollToLastActivity(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

    if (managed.isAltBuffer) {
      managed.terminal.scrollToBottom();
      return;
    }

    const marker = managed.lastActivityMarker;
    if (!marker || marker.isDisposed || marker.line < 0) {
      managed.terminal.scrollToBottom();
      return;
    }

    const viewportY = managed.terminal.buffer.active.viewportY;
    if (Math.abs(viewportY - marker.line) < 2) {
      managed.terminal.scrollToBottom();
      return;
    }

    managed.terminal.scrollToLine(marker.line);
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

    managed.isUserScrolledBack = false;
    this.unseenTracker.clearUnseen(id, false);
    this.scrollToBottomSafe(managed);
  }

  setAgentState(id: string, state: AgentState): void {
    this.agentStateController.setAgentState(id, state);
  }

  private handlePostWake(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Settled-strategy agents require atomic xterm+PTY resize (deferred 500ms).
    // fit() would immediately resize xterm.js while PTY lags, breaking atomicity.
    // Skip fit() for settled agents and use sendPtyResize which preserves the contract.
    if (this.getResizeStrategyForTerminal(managed) === "settled") {
      const cols = managed.latestCols;
      const rows = managed.latestRows;
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        this.resizeController.sendPtyResize(id, cols, rows);
      }
      return;
    }

    // Re-measure container dimensions after wake so latestCols/latestRows
    // reflect the current window size rather than pre-hibernation cache.
    // fit() already guards against offscreen/small terminals (returns null).
    const fitResult = this.resizeController.fit(id);
    if (fitResult) return;

    // Fallback: fit() returned null (terminal offscreen or container too small).
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
    this.resizeController.clearResizeJob(managed);

    if (!isAltBuffer && managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
      reduceScrollback(managed, SCROLLBACK_BACKGROUND);
    }
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

  captureBufferText(id: string, maxChars: number = 20000): string {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return "";

    const buf = managed.terminal.buffer.active;
    if (buf.length === 0) return "";

    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }

    let text = stripAnsiAndOscCodes(lines.join("\n"));

    if (text.length > maxChars) {
      text = text.slice(-maxChars);
    }

    return text;
  }

  registerPostCompleteHook(id: string, callback: PostCompleteHook): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.postCompleteMarker?.dispose();
    managed.postCompleteHook = callback;

    if (!managed.isAltBuffer) {
      managed.postCompleteMarker = managed.terminal.registerMarker(0);
    } else {
      managed.postCompleteMarker = undefined;
    }

    return () => {
      this.unregisterPostCompleteHook(id);
    };
  }

  unregisterPostCompleteHook(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.postCompleteMarker?.dispose();
    managed.postCompleteMarker = undefined;
    managed.postCompleteHook = undefined;
  }

  setFocused(id: string, isFocused: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isFocused = isFocused;
    managed.lastActiveTime = Date.now();
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;
    managed.terminal.focus();
  }

  resetRenderer(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

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
      if (managed.isHibernated) return;
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

    if (!managed.isHibernated) {
      Object.entries(options).forEach(([key, value]) => {
        // @ts-expect-error xterm options are indexable
        managed.terminal.options[key] = value;
      });
    }

    if (textMetricsChanged) {
      managed.lastWidth = 0;
      managed.lastHeight = 0;
    }
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    this.instances.forEach((managed) => {
      if (!managed.isHibernated) {
        Object.entries(options).forEach(([key, value]) => {
          // @ts-expect-error xterm options are indexable
          managed.terminal.options[key] = value;
        });
      }

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

  reduceScrollback(id: string, targetLines: number): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    reduceScrollback(managed, targetLines);
  }

  restoreScrollback(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    restoreScrollback(managed);
  }

  reduceScrollbackAllBackground(targetLines: number): void {
    for (const managed of this.instances.values()) {
      if (managed.isHibernated) continue;
      if (managed.isFocused) continue;
      if (managed.kind === "agent" && managed.canonicalAgentState !== "completed") continue;
      reduceScrollback(managed, targetLines);
    }
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  isHibernated(id: string): boolean {
    return this.instances.get(id)?.isHibernated === true;
  }

  hibernate(id: string): void {
    this.hibernationManager.hibernate(id);
  }

  unhibernate(id: string): void {
    this.hibernationManager.unhibernate(id);
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

    this.cancelAttachReveal(managed);
    this.agentStateController.destroy(id);
    this.restoreController.destroy(id);

    if (managed.scrollbackRestoreDisposable) {
      managed.scrollbackRestoreDisposable.dispose();
      managed.scrollbackRestoreDisposable = undefined;
    }
    managed.scrollbackRestoreState = "none";

    this.instances.delete(id);

    for (const unsub of managed.listeners) {
      try {
        unsub();
      } catch (error) {
        logWarn("Error unsubscribing listener", { error });
      }
    }
    managed.listeners.length = 0;

    this.resizeController.clearResizeJob(managed);
    this.resizeController.clearResizeLock(id);
    this.resizeController.clearSettledTimer(id);
    this.dataBuffer.resetForTerminal(id);
    this.unseenTracker.destroy(id);

    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
      managed.inputBurstTimer = undefined;
    }
    if (managed.titleReportTimer !== undefined) {
      clearTimeout(managed.titleReportTimer);
      managed.titleReportTimer = undefined;
      managed.pendingTitleState = undefined;
    }
    if (managed.resizeSuppressionTimer !== undefined) {
      clearTimeout(managed.resizeSuppressionTimer);
      managed.resizeSuppressionTimer = undefined;
    }

    managed.lastActivityMarker?.dispose();
    managed.postCompleteMarker?.dispose();
    managed.postCompleteMarker = undefined;
    managed.postCompleteHook = undefined;
    managed.exitSubscribers.clear();
    managed.agentStateSubscribers.clear();
    managed.altBufferListeners.clear();

    if (!managed.isHibernated) {
      managed.parserHandler?.dispose();

      try {
        managed.fileLinksDisposable?.dispose();
      } catch (error) {
        logWarn("Error disposing file links", { error });
      }
      try {
        managed.webLinksAddon?.dispose();
      } catch (error) {
        logWarn("Error disposing web links addon", { error });
      }
      try {
        managed.imageAddon?.dispose();
      } catch (error) {
        logWarn("Error disposing image addon", { error });
      }

      this.webGLManager.onTerminalDestroyed(id);
      managed.terminal.dispose();

      if (managed.hostElement.parentElement) {
        managed.hostElement.parentElement.removeChild(managed.hostElement);
      }
    }

    this.offscreenManager.removeOffscreenSlot(id);
    this.suppressedExitUntil.delete(id);
    this.cwdProviders.delete(id);
    this.cachedSelections.delete(id);
    this.wakeManager.clearWakeState(id);
    this.rendererPolicy.clearTierState(id);
  }

  dispose(): void {
    this.stopPolling();
    this.instances.forEach((_, id) => this.destroy(id));
    this.offscreenManager.dispose();
    this.wakeManager.dispose();
    this.webGLManager.dispose();
    this.rendererPolicy.dispose();
    this.agentStateController.dispose();
    this.restoreController.dispose();
  }

  async restoreFetchedState(id: string, serializedState: string | null): Promise<boolean> {
    return this.restoreController.restoreFetchedState(id, serializedState);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    return this.restoreController.fetchAndRestore(id);
  }

  restoreFromSerialized(id: string, serializedState: string): boolean {
    return this.restoreController.restoreFromSerialized(id, serializedState);
  }

  restoreFromSerializedIncremental(id: string, serializedState: string): Promise<boolean> {
    return this.restoreController.restoreFromSerializedIncremental(id, serializedState);
  }

  setInputLocked(id: string, locked: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isInputLocked = locked;
    if (!managed.isHibernated) {
      managed.terminal.options.disableStdin = locked;
    }
  }
}

export const terminalInstanceService = new TerminalInstanceService();

// Expose terminal buffer reader for E2E tests (WebGL renderer has no DOM text).
// Registered unconditionally but gated at call time — the function is harmless
// in production and avoids import-time env var timing issues.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__canopyReadTerminalBuffer = (
    panelId: string
  ): string => {
    const managed = terminalInstanceService["instances"].get(panelId);
    if (!managed) return "";
    const buf = managed.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  };

  (window as unknown as Record<string, unknown>).__canopySelectTerminalAll = (
    panelId: string
  ): boolean => {
    const managed = terminalInstanceService["instances"].get(panelId);
    if (!managed) return false;
    managed.terminal.selectAll();
    return true;
  };

  (window as unknown as Record<string, unknown>).__canopyGetTerminalBufferLength = (
    panelId: string
  ): number => {
    const managed = terminalInstanceService["instances"].get(panelId);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  };

  (window as unknown as Record<string, unknown>).__canopyTriggerTerminalLink = (
    panelId: string,
    url: string
  ): string => {
    const managed = terminalInstanceService["instances"].get(panelId);
    if (!managed) return "missing-panel";
    const mac = isMac();
    const syntheticEvent = new MouseEvent("click", {
      metaKey: mac,
      ctrlKey: !mac,
    });
    terminalInstanceService["linkHandler"].openLink(url, panelId, syntheticEvent);
    return "ok";
  };
}
