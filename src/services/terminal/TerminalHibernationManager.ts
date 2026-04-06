import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { isNonKeyboardInput } from "./inputUtils";
import { reduceScrollback } from "./TerminalScrollbackController";
import { logDebug, logError } from "@/utils/logger";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

export interface HibernationManagerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  destroyRestoreState: (id: string) => void;
  resetBufferedOutput: (id: string) => void;
  releaseWebGL: (id: string) => void;
  clearResizeJob: (managed: ManagedTerminal) => void;
  clearSettledTimer: (id: string) => void;
  applyDeferredResize: (id: string) => void;
  openLink: (url: string, id: string, event?: MouseEvent) => void;
  getCwdProvider: (id: string) => (() => string) | undefined;
  onBufferModeChange: (id: string, isAltBuffer: boolean) => void;
  notifyParsed: (id: string) => void;
  scrollToBottomSafe: (managed: ManagedTerminal) => void;
  clearUnseen: (id: string, fromUser: boolean) => void;
  updateScrollState: (id: string, isScrolledBack: boolean) => void;
  setCachedSelection: (id: string, selection: string) => void;
  clearDirectingState: (id: string) => void;
  onUserInput: (id: string, data: string) => void;
  onEnterPressed: (id: string) => void;
}

export class TerminalHibernationManager {
  private deps: HibernationManagerDeps;

  constructor(deps: HibernationManagerDeps) {
    this.deps = deps;
  }

  hibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (
      !managed ||
      managed.isHibernated ||
      (managed.kind === "agent" &&
        managed.canonicalAgentState !== "completed" &&
        managed.canonicalAgentState !== "exited")
    )
      return;

    logDebug(`[TIS.hibernate] Hibernating terminal ${id}`);

    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }

    this.deps.destroyRestoreState(id);
    this.deps.resetBufferedOutput(id);

    // Release WebGL context first to avoid context leaks
    this.deps.releaseWebGL(id);

    // Dispose tier-managed addons
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

    // Dispose terminal-bound listeners (keep IPC listeners at the beginning)
    const terminalBoundListeners = managed.listeners.splice(managed.ipcListenerCount);
    for (const unsub of terminalBoundListeners) {
      try {
        unsub();
      } catch {
        /* ignore — terminal already disposing */
      }
    }

    // Dispose parser handler
    managed.parserHandler?.dispose();
    managed.parserHandler = undefined;

    // Dispose last activity marker
    managed.lastActivityMarker?.dispose();
    managed.lastActivityMarker = undefined;

    // Dispose terminal instance — this removes xterm's injected DOM elements
    // from the hostElement but leaves the hostElement itself in the DOM
    // so XtermAdapter's container ref stays valid for reattachment
    managed.terminal.dispose();

    managed.isHibernated = true;
    managed.isOpened = false;
    managed.keyHandlerInstalled = false;

    // Clear resize state
    this.deps.clearResizeJob(managed);
    this.deps.clearSettledTimer(id);
  }

  unhibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || !managed.isHibernated) return;

    logDebug(`[TIS.unhibernate] Restoring terminal ${id}`);

    // Create fresh Terminal with same options
    const terminal = new Terminal(managed.terminal.options);
    managed.terminal = terminal;

    // Create fresh addons
    const openLink = (url: string, event?: MouseEvent) => {
      this.deps.openLink(url, id, event);
    };
    const addons = setupTerminalAddons(
      terminal,
      () => (this.deps.getCwdProvider(id) ?? (() => ""))(),
      (event, uri) => openLink(uri, event)
    );
    managed.fitAddon = addons.fitAddon;
    managed.serializeAddon = addons.serializeAddon;
    managed.searchAddon = addons.searchAddon;
    managed.imageAddon = addons.imageAddon;
    managed.fileLinksDisposable = addons.fileLinksDisposable;
    managed.webLinksAddon = addons.webLinksAddon;

    // Reuse existing hostElement — clear old xterm DOM nodes to prevent ghosting
    const hostElement = managed.hostElement;
    hostElement.replaceChildren();

    // Re-create parser handler
    managed.parserHandler = new TerminalParserHandler(managed, () => {
      this.deps.applyDeferredResize(id);
    });

    // Re-register terminal-bound listeners (IPC listeners in managed.listeners survive)
    const initialIsAltBuffer = terminal.buffer.active.type === "alternate";
    managed.isAltBuffer = initialIsAltBuffer;

    const bufferDisposable = terminal.buffer.onBufferChange(() => {
      const newIsAltBuffer = terminal.buffer.active.type === "alternate";
      if (newIsAltBuffer !== managed.isAltBuffer) {
        managed.isAltBuffer = newIsAltBuffer;
        this.deps.onBufferModeChange(id, newIsAltBuffer);
      }
    });
    managed.listeners.push(() => bufferDisposable.dispose());

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
    managed.listeners.push(() => oscDisposable.dispose());

    const writeParsedDisposable = terminal.onWriteParsed(() => {
      this.deps.notifyParsed(id);
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        this.deps.scrollToBottomSafe(managed);
      }
    });
    managed.listeners.push(() => writeParsedDisposable.dispose());

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      managed.latestWasAtBottom = isAtBottom;

      managed._userScrollIntent = false;
      if (managed._suppressScrollTracking) return;

      if (isAtBottom) {
        managed.isUserScrolledBack = false;
        this.deps.clearUnseen(id, false);
        if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
          reduceScrollback(managed, SCROLLBACK_BACKGROUND);
        }
      } else {
        managed.isUserScrolledBack = true;
        this.deps.updateScrollState(id, true);
      }
    });
    managed.listeners.push(() => scrollDisposable.dispose());

    const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);
    const onWheel = () => {
      managed._userScrollIntent = true;
    };
    const onKeydownScroll = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) managed._userScrollIntent = true;
    };
    hostElement.addEventListener("wheel", onWheel, { passive: true });
    hostElement.addEventListener("keydown", onKeydownScroll);
    managed.listeners.push(() => {
      hostElement.removeEventListener("wheel", onWheel);
      hostElement.removeEventListener("keydown", onKeydownScroll);
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      const sel = terminal.getSelection();
      if (sel) {
        this.deps.setCachedSelection(id, sel);
      } else if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
        reduceScrollback(managed, SCROLLBACK_BACKGROUND);
      }
    });
    managed.listeners.push(() => selectionDisposable.dispose());

    const inputDisposable = terminal.onData((data) => {
      if (!managed.isInputLocked) {
        if (isNonKeyboardInput(data)) {
          if (data === "\x1b") {
            this.deps.clearDirectingState(id);
          }
        } else {
          this.deps.onUserInput(id, data);
        }
        terminalClient.write(id, data);
        if (managed.onInput) {
          managed.onInput(data);
        }
      }
    });
    managed.listeners.push(() => inputDisposable.dispose());

    // Reinstall title-state listener for agent terminals
    if (managed.agentId) {
      const agentConfig = getEffectiveAgentConfig(managed.agentId);
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
        managed.listeners.push(() => {
          titleDisposable.dispose();
          if (managed.titleReportTimer !== undefined) {
            clearTimeout(managed.titleReportTimer);
            managed.titleReportTimer = undefined;
            managed.pendingTitleState = undefined;
          }
        });
      }
    }

    // Reinstall agent Enter key listener
    if (managed.kind === "agent") {
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
          this.deps.onEnterPressed(id);
        }
      });
      managed.listeners.push(() => keyDisposable.dispose());
    }

    // Reset restore state
    managed.writeChain = Promise.resolve();
    managed.restoreGeneration += 1;
    managed.isSerializedRestoreInProgress = false;
    managed.deferredOutput = [];

    managed.isHibernated = false;
    managed.isDetached = false;
  }
}
