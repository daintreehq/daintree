import React, { useCallback, useLayoutEffect, useMemo, useRef, useEffect, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { TerminalType } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
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

// Padding constants matching Tailwind classes: pt-2 (8px), pb-4 (16px)
const TALL_PADDING_TOP = 8;
const TALL_PADDING_BOTTOM = 16;

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

  // Tall canvas mode refs (agent terminals only)
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerHostRef = useRef<HTMLDivElement>(null);
  const [followLog, setFollowLog] = useState(true);
  const lastScrollTopRef = useRef(0);
  const isSelectingRef = useRef(false);
  const cellHeightRef = useRef(0);

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

  // Measure cell height from xterm's internal renderer
  const measureCellHeight = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return cellHeightRef.current || 21; // Fallback

    // Access xterm internal dimensions
    const terminal = managed.terminal;
    // @ts-expect-error - accessing internal API
    const renderDims = terminal._core?._renderService?.dimensions;
    if (renderDims?.css?.cell?.height) {
      cellHeightRef.current = renderDims.css.cell.height;
      return renderDims.css.cell.height;
    }
    // Fallback based on font size
    const fallback = fontSize * 1.1 + 2; // lineHeight + buffer
    cellHeightRef.current = fallback;
    return fallback;
  }, [terminalId, fontSize]);

  // Calculate target scroll position to keep cursor visible (tall canvas mode)
  const calculateScrollTarget = useCallback(() => {
    if (!isTallCanvas || !viewportRef.current) return 0;

    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return 0;

    const cellHeight = measureCellHeight();
    const cursorRow = managed.terminal.buffer.active.cursorY;
    const viewportHeight = viewportRef.current.clientHeight;

    // Position cursor at bottom of viewport (terminal-like behavior)
    // Account for top padding which pushes content down
    const cursorPixelY = (cursorRow + 1) * cellHeight + TALL_PADDING_TOP;
    const target = Math.max(0, cursorPixelY - viewportHeight);

    return target;
  }, [isTallCanvas, terminalId, measureCellHeight]);

  // Sync scroll position for tall canvas mode (follow cursor)
  const syncTallCanvasScroll = useCallback(() => {
    if (!isTallCanvas || !followLog || !viewportRef.current || isSelectingRef.current) return;

    const target = calculateScrollTarget();
    viewportRef.current.scrollTop = target;
    lastScrollTopRef.current = target;
  }, [isTallCanvas, followLog, calculateScrollTarget]);

  // Handle user scroll events in tall canvas mode
  const handleTallCanvasScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!isTallCanvas) return;

      const target = e.currentTarget;
      const cellHeight = measureCellHeight();

      // Calculate maximum allowed scroll (content bottom + padding - viewport)
      const contentBottom = terminalInstanceService.getContentBottom(terminalId);
      const viewportHeight = target.clientHeight;
      const contentHeight = (contentBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
      const maxScroll = Math.max(0, contentHeight - viewportHeight);

      // Clamp scroll position to prevent scrolling past content
      if (target.scrollTop > maxScroll) {
        target.scrollTop = maxScroll;
        lastScrollTopRef.current = maxScroll;
        return; // Skip further processing for clamped scroll
      }

      const diff = Math.abs(target.scrollTop - lastScrollTopRef.current);

      // Ignore tiny/programmatic scroll changes
      if (diff < 2) return;

      const idealScrollTop = calculateScrollTarget();
      const threshold = cellHeight * FOLLOW_THRESHOLD_ROWS;

      // If user scrolls away from target, disable follow
      if (Math.abs(target.scrollTop - idealScrollTop) > threshold) {
        setFollowLog(false);
      } else {
        setFollowLog(true);
      }

      lastScrollTopRef.current = target.scrollTop;
    },
    [isTallCanvas, terminalId, measureCellHeight, calculateScrollTarget]
  );

  // Jump to bottom on input (tall canvas mode)
  const handleTallCanvasInput = useCallback(() => {
    if (!isTallCanvas || !viewportRef.current) return;

    setFollowLog(true);
    const target = calculateScrollTarget();
    viewportRef.current.scrollTop = target;
    lastScrollTopRef.current = target;
  }, [isTallCanvas, calculateScrollTarget]);

  // Update inner host height based on actual content bottom (tall canvas mode)
  // Uses getContentBottom() to find real content extent - handles shrinking (autocomplete, clear, etc.)
  const updateInnerHostHeight = useCallback(() => {
    if (!isTallCanvas || !innerHostRef.current || !viewportRef.current) return;

    const cellHeight = measureCellHeight();
    const viewportHeight = viewportRef.current.clientHeight;

    // Get the actual content bottom (last non-blank row or cursor, whichever is greater)
    const contentBottom = terminalInstanceService.getContentBottom(terminalId);

    // Height should be the greater of:
    // 1. Viewport height (so content fills the view when little output)
    // 2. Content bottom in pixels (so we can scroll up to see history, but not past content)
    // Account for padding (top + bottom) to ensure container wraps full content
    const contentHeight = (contentBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
    const totalHeight = Math.max(viewportHeight, contentHeight);

    innerHostRef.current.style.height = `${totalHeight}px`;
  }, [isTallCanvas, terminalId, measureCellHeight]);

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
      let { width, height } = entry.contentRect;

      // Filter collapsed/zero states
      if (width === 0 || height === 0) return;
      if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

      // For tall canvas: innerHostRef has pl-2 (8px) padding that terminal lives inside
      // Subtract this from width so cols calculation accounts for it
      if (isTallCanvas) {
        width -= 8; // pl-2 = 8px left padding on innerHostRef
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
        if (followLog) {
          requestAnimationFrame(syncTallCanvasScroll);
        }
      }
    },
    [terminalId, isTallCanvas, updateInnerHostHeight, followLog, syncTallCanvasScroll]
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

    // For tall canvas: innerHostRef has pl-2 (8px) padding that terminal lives inside
    // Subtract this from width so cols calculation accounts for it
    if (isTallCanvas) {
      width -= 8; // pl-2 = 8px left padding on innerHostRef
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

    // For tall canvas mode: set up key listener to snap to bottom on actual input
    // Filter to keys that send data to PTY, not navigation/scroll keys
    let tallCanvasKeyDisposable: { dispose: () => void } | null = null;
    if (isTallCanvas) {
      tallCanvasKeyDisposable = managed.terminal.onKey(({ domEvent }) => {
        // Skip navigation keys that shouldn't snap to bottom
        const navigationKeys = ["PageUp", "PageDown", "Home", "End"];
        if (navigationKeys.includes(domEvent.key)) {
          return;
        }
        // Skip if modifier keys are held (likely shortcuts, not input)
        if (domEvent.ctrlKey || domEvent.metaKey || domEvent.altKey) {
          return;
        }
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
        // Don't preventDefault - let it bubble to outer scroll container
      };
      // Use capture phase to intercept before xterm processes it
      managed.terminal.element.addEventListener("wheel", wheelHandler, { capture: true });
    }

    exitUnsubRef.current = terminalInstanceService.addExitListener(terminalId, (code) => {
      onExit?.(code);
    });

    // Initial setup for tall canvas mode
    if (isTallCanvas) {
      updateInnerHostHeight();

      // Ensure initial scroll position is at the bottom (follow mode)
      if (viewportRef.current) {
        const cellHeight = measureCellHeight();
        const contentBottom = terminalInstanceService.getContentBottom(terminalId);
        const viewportHeight = viewportRef.current.clientHeight;
        const contentHeight = (contentBottom + 1) * cellHeight + TALL_PADDING_TOP + TALL_PADDING_BOTTOM;
        // Start at bottom of content, or 0 if content fits in viewport
        const initialScroll = Math.max(0, contentHeight - viewportHeight);
        viewportRef.current.scrollTop = initialScroll;
        lastScrollTopRef.current = initialScroll;
      }

      // Register scroll callback for search to scroll to matches
      terminalInstanceService.setTallCanvasScrollCallback(terminalId, (row: number) => {
        if (!viewportRef.current) return;
        const cellHeight = measureCellHeight();
        const viewportHeight = viewportRef.current.clientHeight;
        // Center the target row in the viewport
        // Account for top padding
        const targetScroll = Math.max(0, row * cellHeight + TALL_PADDING_TOP - viewportHeight / 2);
        viewportRef.current.scrollTop = targetScroll;
        lastScrollTopRef.current = targetScroll;
      });
    }

    performFit();
    onReady?.();

    return () => {
      // Mark terminal as invisible before unmount
      terminalInstanceService.setVisible(terminalId, false);

      // Flush pending resizes before unmount
      terminalInstanceService.flushResize(terminalId);

      // Clean up tall canvas key listener
      if (tallCanvasKeyDisposable) {
        tallCanvasKeyDisposable.dispose();
      }

      // Clean up tall canvas wheel handler
      if (wheelHandler && managed.terminal.element) {
        managed.terminal.element.removeEventListener("wheel", wheelHandler, { capture: true });
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

  // Subscribe to output for tall canvas height updates and scroll sync
  useEffect(() => {
    if (!isTallCanvas) return;

    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return;

    // Register callback for when output is written
    const unsubscribe = terminalInstanceService.addOutputListener(terminalId, () => {
      // Update height first (expands scroll area as content grows)
      // Then sync scroll position
      requestAnimationFrame(() => {
        updateInnerHostHeight();
        syncTallCanvasScroll();
      });
    });

    return unsubscribe;
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
        <div
          ref={viewportRef}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          style={{ overscrollBehavior: "contain" }}
          onScroll={handleTallCanvasScroll}
        >
          {/* Inner tall host - padding here so browser includes it in scrollable area */}
          <div
            ref={innerHostRef}
            className="w-full relative pl-2 pt-2 pb-4"
            style={{
              // Height will be set dynamically by updateInnerHostHeight
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
        // pl-2 pt-2 pb-4: left/top padding for FitAddon measurement; pb-4 prevents text from touching bottom edge
        "w-full h-full bg-canopy-bg text-white overflow-hidden rounded-b-[var(--radius-lg)] pl-2 pt-2 pb-4",
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
