import React, { useCallback, useLayoutEffect, useMemo, useRef, useEffect, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { TerminalType, AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { measureCellHeight } from "@/services/terminal/TerminalConfig";
import { useScrollbackStore, usePerformanceModeStore, useTerminalFontStore } from "@/store";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { isRegisteredAgent } from "@/config/agents";

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

export const CANOPY_TERMINAL_THEME = {
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

const MIN_CONTAINER_SIZE = 50;

// Threshold in pixels for "at bottom" detection
const FOLLOW_THRESHOLD_ROWS = 2;

// Layout constants
// pl-3 = 12px. Matches the padding class applied to inner/container elements.
const PADDING_LEFT_PX = 12;

// Vertical padding for Tall Canvas Mode calculations
// pt-3 (12px) + pb-3 (12px) = 24px vertical padding total
const TALL_PADDING_TOP = 12;
const TALL_PADDING_BOTTOM = 12;

// Dead-band for cell height stabilization - ignore changes smaller than this
// Prevents sub-pixel jitter from xterm's internal renderer dimension updates
const CELL_HEIGHT_DEAD_BAND_PX = 0.25;

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
  const [agentState, setAgentState] = useState<AgentState | undefined>(undefined);

  // Tall canvas mode refs (agent terminals only)
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerHostRef = useRef<HTMLDivElement>(null);
  // Note: followLog is persisted in TerminalInstanceService to survive component remounts
  const isSelectingRef = useRef(false);
  // RAF ref for coalescing output-driven updates
  const tallCanvasSyncRafRef = useRef<number | null>(null);
  // Stable bottom row - monotonic while following to prevent jitter from cursor moves
  // Claude Code moves cursor up/down while redrawing UI; this prevents scroll oscillation
  const stableBottomRowRef = useRef(0);
  // Stabilized cell height with dead-band to prevent sub-pixel jitter
  const stableCellHeightRef = useRef(0);
  // Cache last inner host height to avoid redundant style writes
  const lastHeightPxRef = useRef(0);

  // Determine if this terminal should use tall canvas mode
  const isTallCanvas = useMemo(() => {
    // Check if it's an agent terminal by agentId or legacy terminalType
    if (agentId && isRegisteredAgent(agentId)) return true;
    if (terminalType && terminalType !== "terminal" && isRegisteredAgent(terminalType)) return true;
    return false;
  }, [agentId, terminalType]);

  const scrollbackLines = useScrollbackStore((state) => state.scrollbackLines);
  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);

  // Calculate effective scrollback: performance mode overrides, otherwise use type-based policy
  // For tall canvas mode (agent terminals), scrollback is always 0 - the tall screen IS the buffer
  const effectiveScrollback = useMemo(() => {
    if (isTallCanvas) {
      return 0; // No scrollback in tall canvas mode - browser handles scrolling
    }
    if (performanceMode) {
      return PERFORMANCE_MODE_SCROLLBACK;
    }
    // Use scrollbackLines directly (0 means unlimited, handled by getScrollbackForType)
    return getScrollbackForType(terminalType, scrollbackLines);
  }, [performanceMode, scrollbackLines, terminalType, isTallCanvas]);

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
      theme: CANOPY_TERMINAL_THEME,
      allowProposedApi: true,
      smoothScrollDuration: performanceMode ? 0 : 0, // Already 0, but keep explicit
      scrollback: effectiveScrollback,
      macOptionIsMeta: true,
      scrollOnUserInput: false,
      fastScrollModifier: "alt" as const,
      fastScrollSensitivity: 5,
      scrollSensitivity: 1.5,
    }),
    [effectiveScrollback, performanceMode, fontSize, fontFamily]
  );

  // Get cell height using centralized measurement from TerminalConfig
  // Applies dead-band stabilization to prevent sub-pixel jitter
  const getCellHeight = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return stableCellHeightRef.current || 21; // Fallback

    const rawHeight = measureCellHeight(managed.terminal);

    // Apply dead-band: only update stable value if change exceeds threshold
    if (
      stableCellHeightRef.current === 0 ||
      Math.abs(rawHeight - stableCellHeightRef.current) >= CELL_HEIGHT_DEAD_BAND_PX
    ) {
      stableCellHeightRef.current = rawHeight;
    }

    return stableCellHeightRef.current;
  }, [terminalId]);

  // Calculate target scroll position to keep content bottom visible (tall canvas mode)
  // Uses stable bottom row anchor to prevent jitter from cursor moves during TUI redraws
  // Returns integer pixel value for crisp scrolling
  const calculateScrollTarget = useCallback(() => {
    if (!isTallCanvas || !viewportRef.current) return 0;

    const cellHeight = getCellHeight();
    const viewportHeight = viewportRef.current.clientHeight;
    const followLog = terminalInstanceService.getTallCanvasFollowLog(terminalId);

    // Get current content bottom (last non-blank row or cursor, whichever is greater)
    const currentBottom = terminalInstanceService.getContentBottom(terminalId);

    // Compute stable bottom: while following, never let anchor decrease
    // This prevents jitter when Claude Code moves cursor up to redraw status lines
    let stableBottom: number;
    if (followLog) {
      stableBottom = Math.max(stableBottomRowRef.current, currentBottom);
      stableBottomRowRef.current = stableBottom;
    } else {
      // Not following - use actual content bottom (allow scrolling up freely)
      stableBottom = currentBottom;
    }

    // Position stable bottom at bottom of viewport (terminal-like behavior)
    // Include TALL_PADDING_BOTTOM so follow target equals maxScroll when at content bottom
    const contentPixelY = (stableBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
    const target = Math.max(0, contentPixelY - viewportHeight);

    // Round to integer to prevent sub-pixel jitter
    return Math.round(target);
  }, [isTallCanvas, terminalId, getCellHeight]);

  // Sync scroll position for tall canvas mode (follow cursor)
  const syncTallCanvasScroll = useCallback(() => {
    const followLog = terminalInstanceService.getTallCanvasFollowLog(terminalId);
    if (!isTallCanvas || !followLog || !viewportRef.current || isSelectingRef.current) return;

    const target = calculateScrollTarget();
    viewportRef.current.scrollTop = target;
    terminalInstanceService.setTallCanvasLastScrollTop(terminalId, target);
  }, [isTallCanvas, terminalId, calculateScrollTarget]);

  // Handle user scroll events in tall canvas mode
  const handleTallCanvasScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!isTallCanvas) return;

      const target = e.currentTarget;
      const cellHeight = getCellHeight();
      const lastScrollTop = terminalInstanceService.getTallCanvasLastScrollTop(terminalId);

      // Calculate maximum allowed scroll using stable bottom
      // (same logic as updateInnerHostHeight for consistency)
      const currentBottom = terminalInstanceService.getContentBottom(terminalId);
      const stableBottom = Math.max(stableBottomRowRef.current, currentBottom);
      const viewportHeight = target.clientHeight;
      const contentHeight =
        (stableBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
      const maxScroll = Math.round(Math.max(0, contentHeight - viewportHeight));

      // Clamp scroll position to prevent scrolling past content
      if (target.scrollTop > maxScroll) {
        target.scrollTop = maxScroll;
        terminalInstanceService.setTallCanvasLastScrollTop(terminalId, maxScroll);
        return; // Skip further processing for clamped scroll
      }

      const diff = Math.abs(target.scrollTop - lastScrollTop);

      // Ignore tiny/programmatic scroll changes
      if (diff < 2) return;

      const idealScrollTop = calculateScrollTarget();
      const threshold = cellHeight * FOLLOW_THRESHOLD_ROWS;

      // If user scrolls away from target, disable follow; if near target, enable follow
      if (Math.abs(target.scrollTop - idealScrollTop) > threshold) {
        terminalInstanceService.setTallCanvasFollowLog(terminalId, false);
      } else {
        terminalInstanceService.setTallCanvasFollowLog(terminalId, true);
      }

      terminalInstanceService.setTallCanvasLastScrollTop(terminalId, Math.round(target.scrollTop));
    },
    [isTallCanvas, terminalId, getCellHeight, calculateScrollTarget]
  );

  // Jump to bottom on input (tall canvas mode)
  // Also resets stable bottom to current content (user interaction = catch up)
  const handleTallCanvasInput = useCallback(() => {
    if (!isTallCanvas || !viewportRef.current) return;

    // Reset stable bottom to current content when user types
    // This allows scroll to "catch up" after user interaction
    const currentBottom = terminalInstanceService.getContentBottom(terminalId);
    stableBottomRowRef.current = currentBottom;

    terminalInstanceService.setTallCanvasFollowLog(terminalId, true);
    const target = calculateScrollTarget();
    viewportRef.current.scrollTop = target;
    terminalInstanceService.setTallCanvasLastScrollTop(terminalId, target);
  }, [isTallCanvas, terminalId, calculateScrollTarget]);

  // Update inner host height based on stable content bottom (tall canvas mode)
  // Uses stable bottom row while following to match scroll target calculation
  const updateInnerHostHeight = useCallback(() => {
    if (!isTallCanvas || !innerHostRef.current || !viewportRef.current) return;

    const cellHeight = getCellHeight();
    const viewportHeight = viewportRef.current.clientHeight;
    const followLog = terminalInstanceService.getTallCanvasFollowLog(terminalId);

    // Get current content bottom
    const currentBottom = terminalInstanceService.getContentBottom(terminalId);

    // Height ratchet: determine if agent is actively working
    // When working/running/waiting, viewport height can only grow (never shrink)
    // This prevents jitter during TUI redraws where ESC[2J briefly empties the buffer
    const isWorking =
      agentState === "working" || agentState === "running" || agentState === "waiting";

    // If content shrinks significantly (>10 rows), reset stable bottom
    // This handles terminal.clear() and major TUI collapses
    // BUT: only allow shrink reset when agent is NOT working (height ratchet)
    const SHRINK_RESET_THRESHOLD = 10;
    if (!isWorking && stableBottomRowRef.current - currentBottom > SHRINK_RESET_THRESHOLD) {
      stableBottomRowRef.current = currentBottom;
    }

    // Use same stable bottom logic as calculateScrollTarget for consistency
    let stableBottom: number;
    if (followLog) {
      stableBottom = Math.max(stableBottomRowRef.current, currentBottom);
      stableBottomRowRef.current = stableBottom;
    } else {
      stableBottom = currentBottom;
    }

    // Height should be the greater of:
    // 1. Viewport height (so content fills the view when little output)
    // 2. Stable bottom in pixels (so we can scroll up to see history, but not past content)
    // Account for padding (top + bottom) to ensure container wraps full content
    const contentHeight = (stableBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
    const totalHeight = Math.max(viewportHeight, Math.round(contentHeight));

    // Only update style if height changed by at least 1px to reduce layout churn
    if (Math.abs(totalHeight - lastHeightPxRef.current) >= 1) {
      lastHeightPxRef.current = totalHeight;
      innerHostRef.current.style.height = `${totalHeight}px`;
    }
  }, [isTallCanvas, terminalId, getCellHeight, agentState]);

  // Track text selection to avoid fighting with scroll sync
  // Only freeze if selection is inside THIS terminal (not global page selection)
  useEffect(() => {
    if (!isTallCanvas) return;

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.toString().length === 0) {
        isSelectingRef.current = false;
        return;
      }
      // Check if selection is inside our container
      const container = containerRef.current;
      if (container && selection.anchorNode) {
        isSelectingRef.current = container.contains(selection.anchorNode);
      } else {
        isSelectingRef.current = false;
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [isTallCanvas]);

  // Push-based resize handler using ResizeObserver dimensions directly
  const handleResizeEntry = useCallback(
    (entry: ResizeObserverEntry) => {
      // Early exit if not visible (use ref for latest value)
      if (!isVisibleRef.current) return;

      // Get dimensions from observer (zero DOM reads)
      const rect = entry.contentRect;
      let width = rect.width;
      const height = rect.height;

      // Filter collapsed/zero states
      if (width === 0 || height === 0) return;
      if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

      // For tall canvas: innerHostRef has padding that terminal lives inside
      // Subtract this from width so cols calculation accounts for it
      if (isTallCanvas) {
        width -= PADDING_LEFT_PX;
      }

      const dims = terminalInstanceService.resize(terminalId, width, height, {
        isTallCanvas,
      });

      if (dims) {
        prevDimensionsRef.current = dims;
      }

      // For tall canvas: always update height and re-snap on ANY resize (including height-only)
      // This handles viewport height changes (maximize/restore) that don't change cols
      if (isTallCanvas) {
        updateInnerHostHeight();
        if (terminalInstanceService.getTallCanvasFollowLog(terminalId)) {
          requestAnimationFrame(syncTallCanvasScroll);
        }
      }
    },
    [terminalId, isTallCanvas, updateInnerHostHeight, syncTallCanvasScroll]
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

    let width = container.clientWidth - paddingLeft - paddingRight;
    const height = container.clientHeight - paddingTop - paddingBottom;

    // For tall canvas: innerHostRef has padding that terminal lives inside
    // Subtract this from width so cols calculation accounts for it
    if (isTallCanvas) {
      width -= PADDING_LEFT_PX;
    }

    if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

    const dims = terminalInstanceService.resize(terminalId, width, height, {
      immediate: true,
      isTallCanvas,
    });
    if (dims) {
      prevDimensionsRef.current = dims;
      // Update inner host height after fit in tall canvas mode
      if (isTallCanvas) {
        updateInnerHostHeight();
      }
    }
  }, [terminalId, isTallCanvas, updateInnerHostHeight]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // For tall canvas mode, we need the inner host to be ready first
    // In standard mode, we attach directly to container
    const attachTarget = isTallCanvas ? innerHostRef.current : container;
    if (isTallCanvas && !attachTarget) return;

    const managed = terminalInstanceService.getOrCreate(
      terminalId,
      terminalType,
      terminalOptions,
      getRefreshTier || (() => TerminalRefreshTier.FOCUSED),
      onInput,
      { isTallCanvas, agentId }
    );

    // Attach to appropriate target
    if (attachTarget) {
      terminalInstanceService.attach(terminalId, attachTarget);
    }

    if (!managed.keyHandlerInstalled) {
      managed.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // TUI reliability: keep common readline-style Ctrl+key bindings in the terminal
        const TUI_KEYBINDS = ["p", "n", "r", "f", "b", "a", "e", "k", "u", "w", "h", "d"];

        // Let the OS handle meta combinations (e.g., Cmd+C/V).
        // Keep Alt/Option available for word navigation/editing inside the TUI.
        if (event.metaKey) {
          return false;
        }

        // Tall canvas mode: handle PageUp/PageDown/Home/End for browser scrolling
        // Since xterm's scrollback is disabled, these keys won't scroll without intervention
        if (isTallCanvas && viewportRef.current && event.type === "keydown") {
          const viewport = viewportRef.current;
          const pageSize = viewport.clientHeight * 0.9; // 90% of viewport for page scroll

          if (event.key === "PageUp" || (event.shiftKey && event.key === "PageUp")) {
            event.preventDefault();
            viewport.scrollTop = Math.max(0, viewport.scrollTop - pageSize);
            terminalInstanceService.setTallCanvasFollowLog(terminalId, false);
            terminalInstanceService.setTallCanvasLastScrollTop(terminalId, viewport.scrollTop);
            return false;
          }
          if (event.key === "PageDown" || (event.shiftKey && event.key === "PageDown")) {
            event.preventDefault();
            viewport.scrollTop += pageSize;
            // Check if near bottom to re-enable follow
            const cellHeight = getCellHeight();
            const threshold = cellHeight * FOLLOW_THRESHOLD_ROWS;
            const idealScrollTop = calculateScrollTarget();
            if (Math.abs(viewport.scrollTop - idealScrollTop) <= threshold) {
              terminalInstanceService.setTallCanvasFollowLog(terminalId, true);
            }
            terminalInstanceService.setTallCanvasLastScrollTop(terminalId, viewport.scrollTop);
            return false;
          }
          if (event.key === "Home" && event.ctrlKey) {
            event.preventDefault();
            viewport.scrollTop = 0;
            terminalInstanceService.setTallCanvasFollowLog(terminalId, false);
            terminalInstanceService.setTallCanvasLastScrollTop(terminalId, 0);
            return false;
          }
          if (event.key === "End" && event.ctrlKey) {
            event.preventDefault();
            const target = calculateScrollTarget();
            viewport.scrollTop = target;
            terminalInstanceService.setTallCanvasFollowLog(terminalId, true);
            terminalInstanceService.setTallCanvasLastScrollTop(terminalId, target);
            return false;
          }
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
            terminalClient.write(terminalId, "\x1b\r");
          }
          return false;
        }
        return true;
      });
      managed.keyHandlerInstalled = true;
    }

    // For tall canvas mode: snap to bottom on actual PTY input
    // Using onData instead of onKey because onData fires only when bytes are sent to PTY
    // This correctly handles Ctrl/Alt keybinds (like Ctrl+F, Alt+←) which ARE real input
    let tallCanvasDataDisposable: { dispose: () => void } | null = null;
    if (isTallCanvas) {
      tallCanvasDataDisposable = managed.terminal.onData(() => {
        handleTallCanvasInput();
      });
    }

    // For tall canvas mode: prevent xterm from handling wheel events
    // We want native browser scrolling on the outer container, not xterm's internal scroll
    // which can trigger history navigation in some terminal applications
    let wheelHandler: ((e: WheelEvent) => void) | null = null;
    if (isTallCanvas && managed.terminal.element) {
      wheelHandler = (e: WheelEvent) => {
        // Stop xterm from processing the wheel event
        e.stopPropagation();
        // Don't preventDefault - let browser handle scroll natively on outer container
      };
      // Use capture phase to intercept before xterm processes it
      // passive: true since we don't call preventDefault, reduces scroll jank
      managed.terminal.element.addEventListener("wheel", wheelHandler, {
        capture: true,
        passive: true,
      });
    }

    exitUnsubRef.current = terminalInstanceService.addExitListener(terminalId, (code) => {
      onExit?.(code);
    });

    // Initial setup for tall canvas mode
    if (isTallCanvas) {
      // Initialize stable bottom ref to current content
      const contentBottom = terminalInstanceService.getContentBottom(terminalId);
      stableBottomRowRef.current = contentBottom;

      updateInnerHostHeight();

      // Restore scroll position from persisted state (survives remounts)
      // If following, calculate current target; otherwise use saved position
      if (viewportRef.current) {
        const followLog = terminalInstanceService.getTallCanvasFollowLog(terminalId);
        if (followLog) {
          // Calculate scroll position to show content bottom at viewport bottom
          const cellHeight = getCellHeight();
          const viewportHeight = viewportRef.current.clientHeight;
          const contentHeight =
            (contentBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
          const initialScroll = Math.round(Math.max(0, contentHeight - viewportHeight));
          viewportRef.current.scrollTop = initialScroll;
          terminalInstanceService.setTallCanvasLastScrollTop(terminalId, initialScroll);
        } else {
          // Restore previous scroll position (user was browsing history)
          const savedScrollTop = terminalInstanceService.getTallCanvasLastScrollTop(terminalId);
          viewportRef.current.scrollTop = savedScrollTop;
        }
      }

      // Register scroll callback for search to scroll to matches
      terminalInstanceService.setTallCanvasScrollCallback(terminalId, (row: number) => {
        if (!viewportRef.current) return;
        const cellHeight = getCellHeight();
        const viewportHeight = viewportRef.current.clientHeight;
        // Center the target row in the viewport
        // Account for top padding, round to prevent sub-pixel jitter
        const targetScroll = Math.round(
          Math.max(0, row * cellHeight + TALL_PADDING_TOP - viewportHeight / 2)
        );
        viewportRef.current.scrollTop = targetScroll;
        terminalInstanceService.setTallCanvasLastScrollTop(terminalId, targetScroll);
      });
    }

    performFit();
    onReady?.();

    return () => {
      // Mark terminal as invisible before unmount
      terminalInstanceService.setVisible(terminalId, false);

      // Flush pending resizes before unmount
      terminalInstanceService.flushResize(terminalId);

      // Clean up tall canvas data listener
      if (tallCanvasDataDisposable) {
        tallCanvasDataDisposable.dispose();
      }

      // Clean up tall canvas wheel handler (must match addEventListener options)
      if (wheelHandler && managed.terminal.element) {
        managed.terminal.element.removeEventListener("wheel", wheelHandler, {
          capture: true,
        });
      }

      // Clean up tall canvas scroll callback
      if (isTallCanvas) {
        terminalInstanceService.setTallCanvasScrollCallback(terminalId, null);
      }

      const detachTarget = isTallCanvas ? innerHostRef.current : containerRef.current;
      terminalInstanceService.detach(terminalId, detachTarget);

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
    isTallCanvas,
    handleTallCanvasInput,
    updateInnerHostHeight,
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

        // Notify the service about visibility change (handles WebGL and forced resize)
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
      setAgentState(state);
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

  // Subscribe to output events for tall canvas height updates and scroll sync
  // Using outputListener (triggered after PTY data is written) is more efficient than onRender
  // which fires for cursor blink, selections, decorations etc. causing unnecessary work.
  // For frontend-only operations (like terminal.clear()), use requestTallCanvasSync explicitly.
  useEffect(() => {
    if (!isTallCanvas) return;

    // Register callback for when output is written to terminal
    const unsubscribe = terminalInstanceService.addOutputListener(terminalId, () => {
      // Coalesce rapid bursts with a single RAF
      if (tallCanvasSyncRafRef.current !== null) {
        cancelAnimationFrame(tallCanvasSyncRafRef.current);
      }
      tallCanvasSyncRafRef.current = requestAnimationFrame(() => {
        tallCanvasSyncRafRef.current = null;
        updateInnerHostHeight();
        syncTallCanvasScroll();
      });
    });

    return () => {
      unsubscribe();
      if (tallCanvasSyncRafRef.current !== null) {
        cancelAnimationFrame(tallCanvasSyncRafRef.current);
        tallCanvasSyncRafRef.current = null;
      }
    };
  }, [terminalId, isTallCanvas, updateInnerHostHeight, syncTallCanvasScroll]);

  // Render tall canvas mode
  if (isTallCanvas) {
    return (
      <div
        ref={containerRef}
        className={cn(
          "w-full h-full bg-canopy-bg text-white overflow-hidden rounded-b-[var(--radius-lg)]",
          className
        )}
        style={{
          willChange: "transform",
          transform: "translateZ(0)",
        }}
      >
        {/* Outer scroll viewport - browser owns scrolling */}
        {/* No padding here - padding goes on inner host so scroll math is clean */}
        {/* scrollbar-gutter: stable prevents column reflow when scrollbar appears/disappears */}
        <div
          ref={viewportRef}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          style={{ overscrollBehavior: "contain", scrollbarGutter: "stable" }}
          onScroll={handleTallCanvasScroll}
        >
          {/* Inner tall host - padding here so browser includes it in scrollable area */}
          {/* overflow:hidden clips the oversized xterm canvas (600 rows) to match content height */}
          {/* This creates a hard scroll lock - users physically cannot scroll past content */}
          <div
            ref={innerHostRef}
            className="w-full relative pl-3 pt-3 pb-3 pr-2 overflow-hidden"
            style={{
              // Height will be set dynamically by updateInnerHostHeight
              // The scroll range = innerHostRef.height - viewportRef.height
              // overflow:hidden ensures xterm's tall canvas doesn't expand the scroll range
              minHeight: "100%",
            }}
          />
        </div>
      </div>
    );
  }

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
        // Force GPU layer promotion to prevent WebGL canvas snapshot DPI issues during drag
        willChange: "transform",
        transform: "translateZ(0)",
      }}
    />
  );
}

export const XtermAdapter = React.memo(XtermAdapterComponent);
