import React, { useCallback, useLayoutEffect, useMemo, useRef, useEffect } from "react";
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
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { getSoftNewlineSequence } from "../../../shared/utils/terminalInputProtocol.js";

export interface XtermAdapterProps {
  terminalId: string;
  terminalType?: TerminalType;
  agentId?: string;
  isInputLocked?: boolean;
  onReady?: () => void;
  onExit?: (exitCode: number) => void;
  onInput?: (data: string) => void;
  className?: string;
  getRefreshTier?: () => TerminalRefreshTier;
  cwd?: string;
}

export { getTerminalThemeFromCSS, CANOPY_TERMINAL_THEME };

const MIN_CONTAINER_SIZE = 50;

function XtermAdapterComponent({
  terminalId,
  terminalType = "terminal",
  agentId,
  isInputLocked,
  onReady,
  onExit,
  onInput,
  className,
  getRefreshTier,
  cwd,
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

  // Get agent-specific background color if available
  const agentConfig = agentId ? getEffectiveAgentConfig(agentId) : undefined;
  const agentBackgroundColor = agentConfig?.backgroundColor;

  const terminalTheme = getTerminalThemeFromCSS({ backgroundColor: agentBackgroundColor });

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

    const managed = terminalInstanceService.getOrCreate(
      terminalId,
      terminalType,
      terminalOptions,
      stableRefreshTierProvider,
      onInput,
      cwd ? () => cwd : undefined
    );

    terminalInstanceService.setInputLocked(terminalId, !!isInputLocked);

    terminalInstanceService.attach(terminalId, container);

    // Force visibility immediately on mount - don't wait for IntersectionObserver.
    // This prevents data from being dropped during the brief window before the observer fires.
    terminalInstanceService.setVisible(terminalId, true);

    if (!managed.keyHandlerInstalled) {
      managed.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // TUI reliability: keep common readline-style Ctrl+key bindings in the terminal
        const TUI_KEYBINDS = ["p", "n", "r", "f", "b", "a", "e", "k", "u", "w", "h", "d"];

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

    performFit();
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
    };
  }, [
    terminalId,
    terminalType,
    agentId,
    isInputLocked,
    terminalOptions,
    onExit,
    onReady,
    performFit,
    stableRefreshTierProvider,
    onInput,
    cwd,
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
        // Outer wrapper provides padding - xterm container must have no padding for correct column calculation
        "w-full h-full text-white overflow-hidden rounded-b-[var(--radius-lg)] pl-3 pt-3 pb-3 pr-4",
        !agentBackgroundColor && "bg-canopy-bg",
        className
      )}
      style={agentBackgroundColor ? { backgroundColor: agentBackgroundColor } : undefined}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

export const XtermAdapter = React.memo(XtermAdapterComponent);
