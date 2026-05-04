import { Terminal } from "@xterm/xterm";
import { isLinux } from "@/lib/platform";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { logError, logWarn } from "@/utils/logger";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isUselessTitle, normalizeObservedTitle } from "@shared/utils/isUselessTitle";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ManagedTerminal } from "./types";
import { reduceScrollback } from "./TerminalScrollbackController";
import { isNonKeyboardInput } from "./inputUtils";
import { installLinuxPrimarySelectionListeners } from "./primarySelection";
import { writeTerminalInputOrFleet } from "./fleetInputRouter";

// Debounce: coalesce a burst of OSC 0/2 title changes from agent shells
// (which can emit many per second) into a single panel-store / main-process
// update.
const OBSERVED_TITLE_DEBOUNCE_MS = 150;

// Hysteresis: a "waiting" title must persist this long before we report it.
// Working titles fire immediately; the asymmetric debounce prevents flicker
// when an agent briefly idles mid-task.
const WAITING_TITLE_HYSTERESIS_MS = 250;

/**
 * Callback surface needed by `installTerminalBoundListeners`. Both
 * `TerminalInstanceService.getOrCreate()` (create path) and
 * `TerminalHibernationManager.unhibernate()` (wake path) satisfy this
 * interface so they install the exact same listener set — adding a new
 * terminal-bound listener is a one-edit operation.
 */
export interface TerminalListenerInstallDeps {
  // Buffer / scroll / selection scrollback
  onBufferModeChange: (id: string, isAltBuffer: boolean) => void;
  notifyParsed: (id: string) => void;
  scrollToBottomSafe: (managed: ManagedTerminal) => void;
  updateScrollState: (id: string, isScrolledBack: boolean) => void;
  clearUnseen: (id: string, fromUser: boolean) => void;
  onWriteParsedReflow?: (managed: ManagedTerminal) => void;

  // Selection cache
  setCachedSelection: (id: string, selection: string) => void;
  deleteCachedSelection: (id: string) => void;

  // Linux primary selection (middle-click paste / copy-on-select)
  getCachedSelection: (id: string) => string | undefined;
  getBracketedPasteMode: (id: string) => boolean;
  isDisposed: (id: string) => boolean;
  isInputLocked: (id: string) => boolean;
  notifyUserInput: (id: string) => void;

  // Input
  clearDirectingState: (id: string, trigger?: string) => void;
  onUserInput: (id: string, data: string) => void;
  onEnterPressed: (id: string) => void;

  // Panel store side effects (routed through deps to keep this module
  // import-cycle-free relative to the renderer store).
  updateLastObservedTitle: (id: string, title: string) => void;
}

/**
 * Installs every terminal-bound listener on a fresh `Terminal` and pushes its
 * cleanup lambda into `managed.listeners`. The listener order, `setTimeout`
 * cleanup, and behaviour must remain identical across the create and wake
 * paths — drift between them previously meant Linux primary selection,
 * observed-title forwarding, and fleet input broadcast all silently broke
 * after the first hibernate/wake cycle (#6660).
 *
 * `lastReportedTitleState` is a function-local closure so each call starts
 * with a fresh zero state. Storing it on `managed` would make a post-wake
 * report inherit the previous session's state and silently drop the first
 * title transition.
 */
export function installTerminalBoundListeners(
  terminal: Terminal,
  managed: ManagedTerminal,
  id: string,
  deps: TerminalListenerInstallDeps
): void {
  const hostElement = managed.hostElement;
  const initialIsAltBuffer = terminal.buffer.active.type === "alternate";
  managed.isAltBuffer = initialIsAltBuffer;

  const bufferDisposable = terminal.buffer.onBufferChange(() => {
    const newIsAltBuffer = terminal.buffer.active.type === "alternate";
    if (newIsAltBuffer !== managed.isAltBuffer) {
      managed.isAltBuffer = newIsAltBuffer;
      deps.onBufferModeChange(id, newIsAltBuffer);
    }
  });
  managed.listeners.push(() => bufferDisposable.dispose());

  if (initialIsAltBuffer) {
    deps.onBufferModeChange(id, true);
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
  managed.listeners.push(() => oscDisposable.dispose());

  const writeParsedDisposable = terminal.onWriteParsed(() => {
    deps.notifyParsed(id);
    if (!managed.isUserScrolledBack && !managed.isAltBuffer) {
      if (!managed.terminal.hasSelection()) {
        deps.scrollToBottomSafe(managed);
      } else {
        managed.isUserScrolledBack = true;
        deps.updateScrollState(id, true);
      }
    }
    deps.onWriteParsedReflow?.(managed);
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
      deps.clearUnseen(id, false);
      if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
        reduceScrollback(managed, SCROLLBACK_BACKGROUND);
      }
    } else {
      managed.isUserScrolledBack = true;
      deps.updateScrollState(id, true);
    }
  });
  managed.listeners.push(() => scrollDisposable.dispose());

  const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);
  const onWheel = () => {
    managed._userScrollIntent = true;
    managed.lastWheelAt = Date.now();
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
      deps.setCachedSelection(id, sel);
    } else {
      deps.deleteCachedSelection(id);
      if (managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
        reduceScrollback(managed, SCROLLBACK_BACKGROUND);
      }
    }
  });
  managed.listeners.push(() => selectionDisposable.dispose());

  if (isLinux()) {
    const removePrimaryListeners = installLinuxPrimarySelectionListeners({
      hostElement,
      terminalId: id,
      getCachedSelection: () => deps.getCachedSelection(id),
      getBracketedPasteMode: () => deps.getBracketedPasteMode(id),
      isDisposed: () => deps.isDisposed(id),
      isInputLocked: () => deps.isInputLocked(id),
      writeToPty: (termId, data) => terminalClient.write(termId, data),
      notifyUserInput: (termId) => deps.notifyUserInput(termId),
      writeSelection: (text) => window.electron.clipboard.writeSelection(text),
      readSelection: () => window.electron.clipboard.readSelection(),
    });
    managed.listeners.push(removePrimaryListeners);
  }

  if (typeof terminal.onTitleChange === "function") {
    const observedTitleDisposable = terminal.onTitleChange((title: string) => {
      if (!managed.runtimeAgentId) return;
      const normalized = normalizeObservedTitle(title);
      if (!normalized || isUselessTitle(normalized)) return;
      if (normalized === managed.lastObservedTitleSent) return;
      managed.pendingObservedTitle = normalized;
      if (managed.observedTitleTimer !== undefined) {
        clearTimeout(managed.observedTitleTimer);
      }
      managed.observedTitleTimer = window.setTimeout(() => {
        managed.observedTitleTimer = undefined;
        const pending = managed.pendingObservedTitle;
        managed.pendingObservedTitle = undefined;
        if (!managed.runtimeAgentId) return;
        if (!pending || pending === managed.lastObservedTitleSent) return;
        managed.lastObservedTitleSent = pending;
        try {
          window.electron.terminal.updateObservedTitle(id, pending);
        } catch (err) {
          logWarn("[TerminalInstanceService] updateObservedTitle failed", {
            error: formatErrorMessage(err, "Failed to update observed title"),
          });
        }
        try {
          deps.updateLastObservedTitle(id, pending);
        } catch (err) {
          logWarn("[TerminalInstanceService] panel store title update failed", {
            error: formatErrorMessage(err, "Failed to update panel store observed title"),
          });
        }
      }, OBSERVED_TITLE_DEBOUNCE_MS);
    });
    managed.listeners.push(() => {
      observedTitleDisposable.dispose();
      if (managed.observedTitleTimer !== undefined) {
        clearTimeout(managed.observedTitleTimer);
        managed.observedTitleTimer = undefined;
        managed.pendingObservedTitle = undefined;
      }
    });

    let lastReportedTitleState: "working" | "waiting" | undefined;
    const titleDisposable = terminal.onTitleChange((title: string) => {
      const agentId = managed.runtimeAgentId;
      const titlePatterns = agentId
        ? getEffectiveAgentConfig(agentId)?.detection?.titleStatePatterns
        : undefined;
      if (!titlePatterns) return;

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
        }, WAITING_TITLE_HYSTERESIS_MS);
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
  } else {
    managed.listeners.push(() => {
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
        managed.titleReportTimer = undefined;
        managed.pendingTitleState = undefined;
      }
    });
  }

  const inputDisposable = terminal.onData((data) => {
    if (managed.isInputLocked) return;
    if (isNonKeyboardInput(data)) {
      if (data === "\x1b") {
        deps.clearDirectingState(id, "escape-key");
      }
    } else {
      deps.onUserInput(id, data);
    }
    writeTerminalInputOrFleet(id, data);
    if (managed.onInput) {
      managed.onInput(data);
    }
  });
  managed.listeners.push(() => inputDisposable.dispose());

  if (typeof terminal.onKey === "function") {
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
        deps.onEnterPressed(id);
      }
    });
    managed.listeners.push(() => keyDisposable.dispose());
  }
}
