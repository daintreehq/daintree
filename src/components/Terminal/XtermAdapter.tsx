import React, { useCallback, useLayoutEffect, useMemo, useRef, useEffect, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { TerminalType } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  useScrollbackStore,
  usePerformanceModeStore,
  useTerminalFontStore,
  useProjectSettingsStore,
  useScreenReaderStore,
} from "@/store";
import {
  useTerminalColorSchemeStore,
  selectWrapperBackground,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions } from "@/config/xtermConfig";
import { getSoftNewlineSequence } from "../../../shared/utils/terminalInputProtocol.js";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { useTerminalFileTransfer } from "./useTerminalFileTransfer";

export interface XtermAdapterProps {
  terminalId: string;
  terminalType?: TerminalType;
  isInputLocked?: boolean;
  onReady?: () => void;
  onExit?: (exitCode: number) => void;
  onInput?: (data: string) => void;
  className?: string;
  getRefreshTier?: () => TerminalRefreshTier;
  cwd?: string;
  restoreOnAttach?: boolean;
  hasBottomBar?: boolean;
}

const MIN_CONTAINER_SIZE = 50;

function XtermAdapterComponent({
  terminalId,
  terminalType = "terminal",
  isInputLocked,
  onReady,
  onExit,
  onInput,
  className,
  getRefreshTier,
  cwd,
  restoreOnAttach = false,
  hasBottomBar = false,
}: XtermAdapterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const exitUnsubRef = useRef<(() => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFitRef = useRef(false);
  const initialFitDoneRef = useRef(false);

  // Store the latest getRefreshTier in a ref to prevent stale closures.
  // This ensures the service always calls the current version of the callback.
  const getRefreshTierRef = useRef(getRefreshTier);
  useEffect(() => {
    getRefreshTierRef.current = getRefreshTier;
  }, [getRefreshTier]);

  // Create a STABLE proxy function that always calls the latest getRefreshTier.
  // This function's identity never changes, preventing stale closure issues.
  const stableRefreshTierProvider = useCallback(() => {
    return getRefreshTierRef.current ? getRefreshTierRef.current() : TerminalRefreshTier.FOCUSED;
  }, []);

  const scrollbackLines = useScrollbackStore((state) => state.scrollbackLines);
  const projectScrollback = useProjectSettingsStore(
    (state) => state.settings?.terminalSettings?.scrollbackLines
  );
  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);
  // Subscribe to app theme so wrapper background + effective theme re-compute on theme change
  useAppThemeStore((s) => s.selectedSchemeId);
  const wrapperBackground = useTerminalColorSchemeStore(selectWrapperBackground);
  const effectiveTheme = useTerminalColorSchemeStore(selectEffectiveTheme);

  const screenReaderEnabled = useScreenReaderStore((s) => s.resolvedScreenReaderEnabled());

  // Calculate effective scrollback: performance mode overrides, then project override, then app default
  const effectiveScrollback = useMemo(() => {
    if (performanceMode) {
      return PERFORMANCE_MODE_SCROLLBACK;
    }
    const isAgent = terminalType !== "terminal";
    const baseScrollback = !isAgent && projectScrollback ? projectScrollback : scrollbackLines;
    return getScrollbackForType(terminalType, baseScrollback);
  }, [performanceMode, scrollbackLines, projectScrollback, terminalType]);

  // Alt buffer state for TUI applications (OpenCode, vim, htop, etc.)
  // When in alt buffer, we remove padding and let the TUI fill the entire space
  // Initialize from service to avoid flash of wrong padding on mount
  const [isAltBuffer, setIsAltBuffer] = useState(() =>
    terminalInstanceService.getAltBufferState(terminalId)
  );

  // Attach image paste and file drag-and-drop handlers to the xterm container
  useTerminalFileTransfer(containerRef, { terminalId, isInputLocked, onInput });

  const hasVisibleBufferContent = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return false;

    const buffer = managed.terminal.buffer.active;
    if (buffer.baseY > 0) return true;
    const firstLine = buffer.getLine(0)?.translateToString(true) ?? "";
    return firstLine.trim().length > 0;
  }, [terminalId]);

  const terminalOptions = useMemo(
    () =>
      getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: effectiveTheme,
        screenReaderMode: screenReaderEnabled,
      }),
    [
      effectiveScrollback,
      performanceMode,
      fontSize,
      fontFamily,
      effectiveTheme,
      screenReaderEnabled,
    ]
  );

  // Push-based resize handler using ResizeObserver dimensions directly
  const handleResizeEntry = useCallback(
    (entry: ResizeObserverEntry) => {
      const instance = terminalInstanceService.get(terminalId);
      if (instance?.isAttaching) {
        return;
      }

      // Get dimensions from observer (zero DOM reads)
      const rect = entry.contentRect;
      const width = rect.width;
      const height = rect.height;

      // Filter collapsed/zero states and hidden windows (clientWidth/Height return 0 when hidden)
      if (width === 0 || height === 0) return;
      if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;
      if (document.visibilityState !== "visible") {
        pendingFitRef.current = true;
        return;
      }

      const dims = terminalInstanceService.resize(terminalId, width, height);

      if (dims) {
        prevDimensionsRef.current = dims;
      }
    },
    [terminalId]
  );

  // Fallback fit for initial mount and visibility changes
  const performFit = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (container.clientWidth === 0 || container.clientHeight === 0) {
      if (document.visibilityState !== "visible") {
        pendingFitRef.current = true;
        return;
      }
      // Retry on next frame for drag/mount transitions where container isn't sized yet
      requestAnimationFrame(() => {
        if (containerRef.current) performFit();
      });
      return;
    }

    // Container has no padding (padding is on wrapper), so use clientWidth/Height directly
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

    const dims = terminalInstanceService.resize(terminalId, width, height, {
      immediate: true,
    });
    if (dims) {
      prevDimensionsRef.current = dims;
      initialFitDoneRef.current = true;
    }
  }, [terminalId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const managed = terminalInstanceService.getOrCreate(
      terminalId,
      terminalType,
      terminalOptions,
      stableRefreshTierProvider,
      onInput,
      cwd ? () => cwd : undefined
    );

    const wasDetachedForSwitch = managed.isDetached === true;
    const hasSavedTargetDims = !!(managed.targetCols && managed.targetRows);
    managed.isAttaching = true;
    terminalInstanceService.setInputLocked(terminalId, !!isInputLocked);

    terminalInstanceService.attach(terminalId, container);
    // Force visibility immediately on mount - don't wait for IntersectionObserver.
    // This prevents data from being dropped during the brief window before the observer fires.
    terminalInstanceService.setVisible(terminalId, true);

    if (!managed.keyHandlerInstalled) {
      managed.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Only process keydown events to avoid double-firing
        if (event.type !== "keydown") {
          return true;
        }

        // Skip repeat events
        if (event.repeat) {
          return true;
        }

        // Get normalized key for modifier-only detection
        const normalizedKey = keybindingService.normalizeKeyForBinding(event);
        const isModifierOnly = ["Meta", "Control", "Alt", "Shift"].includes(normalizedKey);

        // Don't process modifier-only keypresses
        if (isModifierOnly) {
          return true;
        }

        // During IME/voice composition, let xterm's CompositionHelper handle the
        // full lifecycle (composed text + \r). keyCode 229 is Chromium's "Process"
        // key signal during active composition where isComposing may not yet be set.
        if (event.isComposing || event.keyCode === 229) {
          return true;
        }

        // Let Shift+F10 and ContextMenu key bubble to DOM for panel context menu
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" &&
            event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey)
        ) {
          return false;
        }

        // Intercept F6 for macro-region focus cycling before terminal processing
        if (event.key === "F6") {
          return false;
        }

        // TUI reliability: keep common readline-style Ctrl+key bindings in the terminal
        const TUI_KEYBINDS = ["p", "n", "r", "f", "b", "a", "e", "k", "u", "w", "h", "d"];

        // Allow critical Ctrl+<key> bindings to reach the TUI before checking global shortcuts
        if (event.ctrlKey && !event.shiftKey && TUI_KEYBINDS.includes(event.key)) {
          return true;
        }

        // Intercept global keybindings before terminal processing
        // Check when: (1) modifier is pressed, OR (2) chord is pending
        const hasModifier = event.metaKey || event.ctrlKey;
        const pendingChord = keybindingService.getPendingChord();
        if (hasModifier || pendingChord) {
          const result = keybindingService.resolveKeybinding(event);
          if (result.shouldConsume) {
            event.preventDefault();
            event.stopPropagation();

            if (result.match) {
              // Dispatch the matched action
              void actionService
                .dispatch(
                  result.match.actionId as Parameters<typeof actionService.dispatch>[0],
                  undefined,
                  {
                    source: "keybinding",
                  }
                )
                .then((dispatchResult) => {
                  if (!dispatchResult.ok) {
                    console.error(
                      `[XtermKeybinding] Action "${result.match!.actionId}" failed:`,
                      dispatchResult.error
                    );
                  }
                })
                .catch((error) => {
                  console.error(`[XtermKeybinding] Unexpected error:`, error);
                });
            }
            // Chord prefix consumed to prevent terminal leakage
            return false;
          }
        }

        // Let the OS handle meta combinations (e.g., Cmd+C/V).
        // Paste (Cmd+V) is handled by Electron's native Edit > Paste menu role,
        // which dispatches a paste event that xterm.js processes natively
        // (including bracketed paste mode wrapping).
        // Keep Alt/Option available for word navigation/editing inside the TUI.
        if (event.metaKey) {
          return false;
        }

        // Allow critical Ctrl+<key> bindings to reach the TUI
        if (event.ctrlKey && !event.shiftKey && TUI_KEYBINDS.includes(event.key)) {
          return true;
        }

        if (
          event.key === "Enter" &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.type === "keydown" && !managed.isInputLocked) {
            // "Soft" newline for agent CLIs.
            // Codex CLI commonly expects LF (\n / Ctrl+J) for a newline without submit.
            // Other agent CLIs use the legacy ESC+CR sequence.
            const softNewline = getSoftNewlineSequence(terminalType);
            terminalClient.write(terminalId, softNewline);
            terminalInstanceService.notifyUserInput(terminalId);
            onInput?.(softNewline);
          }
          return false;
        }

        if (
          (event.key === "Enter" || event.key === "Return" || event.code === "NumpadEnter") &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.type === "keydown" && !managed.isInputLocked) {
            const submit = "\r";
            terminalClient.write(terminalId, submit);
            terminalInstanceService.notifyUserInput(terminalId);
            onInput?.(submit);
          }
          return false;
        }
        return true;
      });
      managed.keyHandlerInstalled = true;
    }

    exitUnsubRef.current = terminalInstanceService.addExitListener(terminalId, (code) => {
      onExit?.(code);
    });

    if (!wasDetachedForSwitch || !hasSavedTargetDims) {
      performFit();
    }

    if (
      restoreOnAttach &&
      !(wasDetachedForSwitch && hasSavedTargetDims) &&
      !hasVisibleBufferContent()
    ) {
      void terminalInstanceService.fetchAndRestore(terminalId).then((restored) => {
        if (restored) {
          requestAnimationFrame(() => performFit());
        }
      });
    }

    onReady?.();

    return () => {
      terminalInstanceService.setVisible(terminalId, false);

      // Flush pending resizes before unmount
      terminalInstanceService.flushResize(terminalId);

      terminalInstanceService.detach(terminalId, container);

      if (exitUnsubRef.current) {
        exitUnsubRef.current();
        exitUnsubRef.current = null;
      }

      prevDimensionsRef.current = null;
      initialFitDoneRef.current = false;
    };
  }, [
    terminalId,
    terminalType,
    isInputLocked,
    terminalOptions,
    onExit,
    onReady,
    performFit,
    stableRefreshTierProvider,
    onInput,
    cwd,
    restoreOnAttach,
    hasVisibleBufferContent,
  ]);

  // Resolve current tier for dependency tracking
  const currentTier = useMemo(
    () => (getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED),
    [getRefreshTier]
  );

  useLayoutEffect(() => {
    // Use the stable proxy to avoid stale closures in the service
    terminalInstanceService.updateRefreshTierProvider(terminalId, stableRefreshTierProvider);
    terminalInstanceService.applyRendererPolicy(terminalId, currentTier);

    // If moving to a high-priority state (Focused or Burst), boost the writer
    // to flush any background buffer immediately.
    if (currentTier === TerminalRefreshTier.FOCUSED || currentTier === TerminalRefreshTier.BURST) {
      terminalInstanceService.boostRefreshRate(terminalId);
    }
  }, [terminalId, stableRefreshTierProvider, currentTier]);

  // Refit terminal when window becomes visible again after being hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && pendingFitRef.current) {
        pendingFitRef.current = false;
        performFit();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [performFit]);

  // Subscribe to alt buffer state changes for TUI applications (OpenCode, vim, htop, etc.)
  // When in alt buffer, we need to sync the container styling
  // Use useLayoutEffect to avoid flash before first paint
  useLayoutEffect(() => {
    const unsubscribe = terminalInstanceService.addAltBufferListener(terminalId, (altBuffer) => {
      setIsAltBuffer(altBuffer);
    });
    return unsubscribe;
  }, [terminalId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      // On the first non-zero observation, bypass the debounce and fit
      // synchronously. This prevents blank panels on Linux where the
      // compositor commits layout after the initial rAF-based retry in
      // performFit — the 50ms debounce would delay the fit past first paint.
      if (!initialFitDoneRef.current) {
        for (const entry of entries) {
          const instance = terminalInstanceService.get(terminalId);
          if (instance?.isAttaching) continue;

          const rect = entry.contentRect;
          if (
            rect.width >= MIN_CONTAINER_SIZE &&
            rect.height >= MIN_CONTAINER_SIZE &&
            document.visibilityState === "visible"
          ) {
            const dims = terminalInstanceService.resize(terminalId, rect.width, rect.height, {
              immediate: true,
            });
            if (dims) {
              prevDimensionsRef.current = dims;
              initialFitDoneRef.current = true;
              // Cancel any pending debounce/rAF from earlier zero-dim observations
              if (resizeDebounceRef.current !== null) {
                clearTimeout(resizeDebounceRef.current);
                resizeDebounceRef.current = null;
              }
              if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
              }
              return;
            }
          }
        }
      }

      // xterm.js v6's DomScrollableElement triggers layout mutations that can
      // re-enter the ResizeObserver synchronously. Debounce with a short delay
      // to let the DOM settle, then sync with the paint cycle via rAF.
      if (resizeDebounceRef.current !== null) {
        clearTimeout(resizeDebounceRef.current);
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      // Capture entries for the closure
      const latestEntries = entries;
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null;
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          for (const entry of latestEntries) {
            handleResizeEntry(entry);
          }
        });
      }, 50);
    });
    resizeObserver.observe(container);

    return () => {
      if (resizeDebounceRef.current !== null) {
        clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserver.disconnect();
    };
  }, [handleResizeEntry, terminalId]);

  return (
    <div
      className={cn(
        "w-full h-full text-text-primary overflow-hidden",
        !isAltBuffer && ["pl-3 pt-3 pb-3 pr-3", !hasBottomBar && "rounded-b-[var(--radius-lg)]"],
        className
      )}
      style={{ backgroundColor: wrapperBackground, contain: "strict" }}
    >
      <div
        ref={containerRef}
        className="w-full h-full min-h-0 min-w-0"
        aria-label="Terminal output"
      />
    </div>
  );
}

export const XtermAdapter = React.memo(XtermAdapterComponent);
