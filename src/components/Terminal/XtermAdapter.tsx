import React, { useCallback, useLayoutEffect, useMemo, useRef, useEffect, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { TerminalType, AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useScrollbackStore, usePerformanceModeStore, useTerminalFontStore } from "@/store";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { CANOPY_TERMINAL_THEME, getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { getSoftNewlineSequence } from "../../../shared/utils/terminalInputProtocol.js";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";

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
}

export { getTerminalThemeFromCSS, CANOPY_TERMINAL_THEME };

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
}: XtermAdapterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const exitUnsubRef = useRef<(() => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);

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

  // Agent state for state-aware rendering decisions (height ratchet, resize guard, scroll latch)
  // Used via ref to avoid triggering re-renders that would cause XtermAdapter to detach/reattach
  const agentStateRef = useRef<AgentState | undefined>(undefined);

  const scrollbackLines = useScrollbackStore((state) => state.scrollbackLines);
  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);

  // Calculate effective scrollback: performance mode overrides, otherwise use type-based policy
  const effectiveScrollback = useMemo(() => {
    if (performanceMode) {
      return PERFORMANCE_MODE_SCROLLBACK;
    }
    // Use scrollbackLines directly (0 means unlimited, handled by getScrollbackForType)
    return getScrollbackForType(terminalType, scrollbackLines);
  }, [performanceMode, scrollbackLines, terminalType]);

  // Alt buffer state for TUI applications (OpenCode, vim, htop, etc.)
  // When in alt buffer, we remove padding and let the TUI fill the entire space
  // Initialize from service to avoid flash of wrong padding on mount
  const [isAltBuffer, setIsAltBuffer] = useState(() =>
    terminalInstanceService.getAltBufferState(terminalId)
  );

  const terminalTheme = useMemo(() => getTerminalThemeFromCSS(), []);

  const hasVisibleBufferContent = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return false;

    const buffer = managed.terminal.buffer.active;
    if (buffer.baseY > 0) return true;
    const firstLine = buffer.getLine(0)?.translateToString(true) ?? "";
    return firstLine.trim().length > 0;
  }, [terminalId]);

  const terminalOptions = useMemo(
    () => ({
      cursorBlink: true,
      cursorStyle: "block" as const,
      cursorInactiveStyle: "block" as const,
      fontSize,
      lineHeight: 1.1,
      letterSpacing: 0,
      fontFamily: fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      fontLigatures: false,
      fontWeight: "normal" as const,
      fontWeightBold: "700" as const,
      theme: terminalTheme,
      allowProposedApi: true,
      smoothScrollDuration: performanceMode ? 0 : 0, // Already 0, but keep explicit
      scrollback: effectiveScrollback,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollOnUserInput: false,
      fastScrollModifier: "alt" as const,
      fastScrollSensitivity: 5,
      scrollSensitivity: 1.5,
    }),
    [effectiveScrollback, performanceMode, fontSize, fontFamily, terminalTheme]
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

      // Filter collapsed/zero states
      if (width === 0 || height === 0) return;
      if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

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

    // Retry logic: if container has no size (e.g. during drag/mount transition),
    // schedule a retry on next animation frame. This fixes blank terminals when
    // xterm initializes with 0x0 dimensions during drag preview.
    if (container.clientWidth === 0 || container.clientHeight === 0) {
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
    }
  }, [terminalId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    console.log(`[XtermAdapter] useLayoutEffect running for ${terminalId}`, {
      containerRect: container.getBoundingClientRect(),
      containerClientSize: { width: container.clientWidth, height: container.clientHeight },
    });

    const managed = terminalInstanceService.getOrCreate(
      terminalId,
      terminalType,
      terminalOptions,
      stableRefreshTierProvider,
      onInput,
      cwd ? () => cwd : undefined
    );

    console.log(`[XtermAdapter] Got managed instance for ${terminalId}, attaching...`);

    const wasDetachedForSwitch = managed.isDetached === true;
    managed.isAttaching = true;
    terminalInstanceService.setInputLocked(terminalId, !!isInputLocked);

    terminalInstanceService.attach(terminalId, container);
    console.log(
      `[XtermAdapter] Attached ${terminalId} to container, wasDetached=${wasDetachedForSwitch}`
    );

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

    if (!wasDetachedForSwitch) {
      performFit();
    }

    if (restoreOnAttach && !wasDetachedForSwitch && !hasVisibleBufferContent()) {
      void terminalInstanceService.fetchAndRestore(terminalId).then((restored) => {
        if (restored) {
          requestAnimationFrame(() => performFit());
        }
      });
    }

    onReady?.();

    return () => {
      console.log(`[XtermAdapter] Cleanup/unmount for ${terminalId}`);
      terminalInstanceService.setVisible(terminalId, false);

      // Flush pending resizes before unmount
      terminalInstanceService.flushResize(terminalId);

      terminalInstanceService.detach(terminalId, container);

      if (exitUnsubRef.current) {
        exitUnsubRef.current();
        exitUnsubRef.current = null;
      }

      prevDimensionsRef.current = null;
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

  // Subscribe to agent state changes for state-aware rendering decisions
  // This enables future defensive layers (height ratchet, resize guard, scroll latch)
  useEffect(() => {
    const unsubscribe = terminalInstanceService.addAgentStateListener(terminalId, (state) => {
      agentStateRef.current = state;
    });
    return unsubscribe;
  }, [terminalId]);

  // Render health check: periodically validate and recover stuck terminal rendering.
  // This addresses intermittent freeze issues where the terminal stops displaying output
  // despite receiving data. The freeze typically resolves when focus changes (click away/back).
  // This defensive mechanism forces a refresh when the agent is actively working to ensure
  // output is always displayed without requiring manual user intervention.
  useEffect(() => {
    // Only run health checks for agent terminals where freezing has been observed
    const isAgentTerminal =
      terminalType === "claude" ||
      terminalType === "gemini" ||
      terminalType === "codex" ||
      terminalType === "opencode";
    if (!isAgentTerminal) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const runHealthCheck = () => {
      const managed = terminalInstanceService.get(terminalId);
      if (!managed) return;

      // Only force refresh when agent is working and terminal should be receiving output
      if (agentStateRef.current !== "working") return;

      // Force a refresh to ensure terminal is rendering properly
      managed.terminal.refresh(0, managed.terminal.rows - 1);
    };

    // Run health check every 2 seconds while the component is mounted
    intervalId = setInterval(runHealthCheck, 2000);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [terminalId, terminalType]);

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
      // Cancel any pending RAF before scheduling a new one
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      // Wrap in requestAnimationFrame to align with render cycle
      // and prevent "ResizeObserver loop limit exceeded" errors
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        for (const entry of entries) {
          handleResizeEntry(entry);
        }
      });
    });
    resizeObserver.observe(container);

    // No need for window.addEventListener("resize") - ResizeObserver handles this

    return () => {
      // Cancel pending RAF to prevent post-unmount execution
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserver.disconnect();
    };
  }, [handleResizeEntry]);

  return (
    <div
      className={cn(
        // Base container styling
        "w-full h-full text-white overflow-hidden bg-canopy-bg",
        // In normal buffer mode: apply padding and rounded corners
        // In alt buffer mode (TUI apps like OpenCode, vim, htop): remove padding for tight full-screen fit
        !isAltBuffer && "pl-3 pt-3 pb-3 pr-4 rounded-b-[var(--radius-lg)]",
        className
      )}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

export const XtermAdapter = React.memo(XtermAdapterComponent);
