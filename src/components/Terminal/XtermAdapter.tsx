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

export interface XtermAdapterProps {
  terminalId: string;
  terminalType?: TerminalType;
  agentId?: string;
  onReady?: () => void;
  onExit?: (exitCode: number) => void;
  onInput?: (data: string) => void;
  className?: string;
  getRefreshTier?: () => TerminalRefreshTier;
}

const CANOPY_TERMINAL_THEME_FALLBACK = {
  background: "#18181b",
  foreground: "#e4e4e7",
  cursor: "#10b981",
  cursorAccent: "#18181b",
  selectionBackground: "#064e3b",
  selectionForeground: "#e4e4e7",
  black: "#18181b",
  red: "#f87171",
  green: "#10b981",
  yellow: "#fbbf24",
  blue: "#38bdf8",
  magenta: "#a855f7",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#34d399",
  brightYellow: "#fcd34d",
  brightBlue: "#7dd3fc",
  brightMagenta: "#c084fc",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

let cachedTerminalTheme: typeof CANOPY_TERMINAL_THEME_FALLBACK | null = null;

function getTerminalThemeFromCSS(): typeof CANOPY_TERMINAL_THEME_FALLBACK {
  if (cachedTerminalTheme) return cachedTerminalTheme;

  const styles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };

  cachedTerminalTheme = {
    background: getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.background),
    foreground: getVar("--color-canopy-text", CANOPY_TERMINAL_THEME_FALLBACK.foreground),
    cursor: getVar("--color-canopy-accent", CANOPY_TERMINAL_THEME_FALLBACK.cursor),
    cursorAccent: getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.cursorAccent),
    selectionBackground: "#064e3b", // Keep hardcoded - specific to terminal selection
    selectionForeground: getVar(
      "--color-canopy-text",
      CANOPY_TERMINAL_THEME_FALLBACK.selectionForeground
    ),
    black: getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.black),
    red: getVar("--color-status-error", CANOPY_TERMINAL_THEME_FALLBACK.red),
    green: getVar("--color-canopy-accent", CANOPY_TERMINAL_THEME_FALLBACK.green),
    yellow: getVar("--color-status-warning", CANOPY_TERMINAL_THEME_FALLBACK.yellow),
    blue: getVar("--color-status-info", CANOPY_TERMINAL_THEME_FALLBACK.blue),
    magenta: "#a855f7", // No token, keep as-is
    cyan: "#22d3ee", // No token, keep as-is
    white: getVar("--color-canopy-text", CANOPY_TERMINAL_THEME_FALLBACK.white),
    brightBlack: getVar("--color-state-idle", CANOPY_TERMINAL_THEME_FALLBACK.brightBlack),
    brightRed: "#fca5a5", // Bright variant, no token
    brightGreen: getVar("--color-canopy-success", CANOPY_TERMINAL_THEME_FALLBACK.brightGreen),
    brightYellow: "#fcd34d", // Bright variant, no token
    brightBlue: "#7dd3fc", // Bright variant, no token
    brightMagenta: "#c084fc", // Bright variant, no token
    brightCyan: "#67e8f9", // Bright variant, no token
    brightWhite: "#fafafa", // Near-white, no token needed
  };

  return cachedTerminalTheme;
}

export { getTerminalThemeFromCSS };
export const CANOPY_TERMINAL_THEME = CANOPY_TERMINAL_THEME_FALLBACK;

const MIN_CONTAINER_SIZE = 50;

function XtermAdapterComponent({
  terminalId,
  terminalType = "terminal",
  agentId,
  onReady,
  onExit,
  onInput,
  className,
  getRefreshTier,
}: XtermAdapterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const exitUnsubRef = useRef<(() => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Track visibility for resize optimization (start pessimistic for offscreen mounts)
  const isVisibleRef = useRef(false);

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

  const terminalTheme = useMemo(() => getTerminalThemeFromCSS(), []);

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
      // Early exit if not visible (use ref for latest value)
      if (!isVisibleRef.current) return;

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

    // Subtract padding to match ResizeObserver's contentRect behavior.
    // clientWidth/Height INCLUDE padding, but contentRect EXCLUDES it.
    // This ensures consistent dimensions between performFit and handleResizeEntry.
    const style = window.getComputedStyle(container);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;

    const width = container.clientWidth - paddingLeft - paddingRight;
    const height = container.clientHeight - paddingTop - paddingBottom;

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
      getRefreshTier || (() => TerminalRefreshTier.FOCUSED),
      onInput
    );

    // Attach to appropriate target
    terminalInstanceService.attach(terminalId, container);

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
          if (event.type === "keydown") {
            // "Soft" newline for agent CLIs.
            // Codex CLI commonly expects LF (\n / Ctrl+J) for a newline without submit.
            // Other agent CLIs use the legacy ESC+CR sequence.
            const softNewline = terminalType === "codex" ? "\n" : "\x1b\r";
            terminalClient.write(terminalId, softNewline);
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
      // Mark terminal as invisible before unmount
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
    terminalOptions,
    onExit,
    onReady,
    performFit,
    getRefreshTier,
    onInput,
  ]);

  // Resolve current tier for dependency tracking
  const currentTier = useMemo(
    () => (getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED),
    [getRefreshTier]
  );

  useLayoutEffect(() => {
    terminalInstanceService.updateRefreshTierProvider(
      terminalId,
      getRefreshTier || (() => TerminalRefreshTier.FOCUSED)
    );
    terminalInstanceService.applyRendererPolicy(terminalId, currentTier);

    // If moving to a high-priority state (Focused or Burst), boost the writer
    // to flush any background buffer immediately.
    if (currentTier === TerminalRefreshTier.FOCUSED || currentTier === TerminalRefreshTier.BURST) {
      terminalInstanceService.boostRefreshRate(terminalId);
    }
  }, [terminalId, getRefreshTier, currentTier]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;
        isVisibleRef.current = nowVisible;

        // Notify the service about visibility change (handles tiering and forced resize)
        terminalInstanceService.setVisible(terminalId, nowVisible);

        if (nowVisible) {
          // Force immediate fit with fresh dimensions
          performFit();
        }
      },
      { threshold: 0.1 }
    );
    visibilityObserver.observe(container);

    return () => visibilityObserver.disconnect();
  }, [terminalId, performFit]);

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

  // Standard terminal mode (original behavior)
  return (
    <div
      ref={containerRef}
      className={cn(
        // pl-3 pt-3 pb-3 pr-2: Clean padding on all sides, with space for scrollbar on right
        "w-full h-full bg-canopy-bg text-white overflow-hidden rounded-b-[var(--radius-lg)] pl-3 pt-3 pb-3 pr-2",
        className
      )}
      style={{
        // Promote its own compositor layer to reduce drag/resize jank.
        willChange: "transform",
        transform: "translateZ(0)",
      }}
    />
  );
}

export const XtermAdapter = React.memo(XtermAdapterComponent);
