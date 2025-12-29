/**
 * History Overlay Terminal View
 *
 * Provides a two-mode terminal UI:
 * - Live Mode: Interactive xterm.js canvas for real-time TUI interaction
 * - History Mode: DOM overlay that appears on scroll-up, scrollable like a webpage,
 *   stays stable while output continues, with periodic resync from xterm buffer
 *
 * Key features:
 * - Scroll up to enter history mode, scroll past bottom to exit
 * - Periodic resync (every few seconds) without jumping scroll position
 * - 5000 line cap with robust trim handling
 * - Broken-frame mitigation via settle-based gating
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { getTerminalRefreshTier, usePerformanceModeStore, useTerminalStore } from "@/store";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useIsDragging } from "@/components/DragDrop";
import type { TerminalType } from "@/types";
import { getSoftNewlineSequence } from "../../../shared/utils/terminalInputProtocol.js";
import {
  readXtermVisualMetrics,
  wheelDeltaToPx,
  type XtermVisualMetrics,
} from "./utils/xtermUtils";
import {
  extractSnapshot,
  computeTrimmedTopCount,
  shouldAcceptSnapshot,
  checkJumpBackPersistence,
  type HistoryState,
} from "./utils/historyUtils";

// Configuration
const MAX_HISTORY_LINES = 5000;
const RESYNC_INTERVAL_MS = 3000;
const SETTLE_MS = 60; // Quiet period before accepting snapshot
const BOTTOM_EPSILON_PX = 5;
const MIN_LINES_FOR_HISTORY = 8; // Minimum lines before allowing history mode
const HISTORY_ENTRY_THRESHOLD_PX = 1; // Immediate entry on any upward scroll
const INITIAL_HISTORY_SKIP_LINES = 4; // Number of lines to skip from bottom when entering history mode

// Types
export interface HistoryOverlayTerminalViewProps {
  terminalId: string;
  type: TerminalType;
  isFocused: boolean;
  isVisible: boolean;
  isInputLocked?: boolean;
  className?: string;
  /** Called when a submit occurs (Enter pressed via HybridInputBar) */
  onSubmit?: () => void;
}

export interface HistoryOverlayTerminalViewHandle {
  /** Notify the view that a submit occurred (exits history mode) */
  notifySubmit: () => void;
}

type ViewMode = "live" | "history";

interface ScrollAnchor {
  topIndex: number;
  offsetPx: number;
  wasAtBottom: boolean;
}

/**
 * Check if overlay is at bottom (within epsilon).
 */
function isAtBottom(el: HTMLElement, epsilon = BOTTOM_EPSILON_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= epsilon;
}

// Component
export const HistoryOverlayTerminalView = forwardRef<
  HistoryOverlayTerminalViewHandle,
  HistoryOverlayTerminalViewProps
>(function HistoryOverlayTerminalView(
  { terminalId, type, isFocused, isVisible, isInputLocked, className },
  ref
) {
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermContainerRef = useRef<HTMLDivElement>(null);
  const overlayScrollRef = useRef<HTMLDivElement>(null);
  const overlayContentRef = useRef<HTMLDivElement>(null);

  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const disposedRef = useRef(false);

  // State
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const viewModeRef = useRef<ViewMode>("live");

  // HTML-rendered lines for display (with colors)
  const [historyHtmlLines, setHistoryHtmlLines] = useState<string[]>([]);
  const historyStateRef = useRef<HistoryState | null>(null);

  const [scrollbackUnavailable, setScrollbackUnavailable] = useState(false);
  const [showTruncationBanner, setShowTruncationBanner] = useState(false);

  // Output tracking for settle logic
  const lastOutputAtRef = useRef(0);
  const resyncInFlightRef = useRef(false);

  // Jump-back persistence state (defense-in-depth, mirrors backend)
  const lastAcceptedWindowStartRef = useRef<number | null>(null);
  const pendingJumpBackRef = useRef<{
    windowStart: number;
    firstSeenAt: number;
    stableFrames: number;
  } | null>(null);

  // Scroll anchor for resync
  const anchorRef = useRef<ScrollAnchor | null>(null);

  // Xterm visual metrics for pixel-perfect alignment
  const [metrics, setMetrics] = useState<XtermVisualMetrics | null>(null);
  const metricsRef = useRef<XtermVisualMetrics | null>(null);

  // Flag to scroll to bottom after entering history mode
  const shouldScrollToBottomRef = useRef(false);

  // Pending wheel delta to apply when entering history mode (for seamless scroll)
  const pendingEntryDeltaPxRef = useRef<number>(0);

  // Exit-armed state: only allow exit after user has scrolled up at least once
  const exitArmedRef = useRef(false);

  // Accumulated wheel delta for history entry threshold (prevents accidental entry)
  const accumulatedWheelDeltaRef = useRef(0);

  // Check if a drag is in progress (prevents history entry during drag operations)
  const isDragging = useIsDragging();

  // Refs for values used in callbacks that shouldn't trigger re-initialization
  const isFocusedRef = useRef(isFocused);
  const isInputLockedRef = useRef(isInputLocked);

  // Sync refs
  useEffect(() => {
    isFocusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    isInputLockedRef.current = isInputLocked;
    terminalInstanceService.setInputLocked(terminalId, !!isInputLocked);
  }, [isInputLocked, terminalId]);

  // Store subscriptions
  const fontSize = useTerminalFontStore((s) => s.fontSize);
  const fontFamily = useTerminalFontStore((s) => s.fontFamily);
  const scrollbackLines = useScrollbackStore((s) => s.scrollbackLines);
  const performanceMode = usePerformanceModeStore((s) => s.performanceMode);
  const getTerminal = useTerminalStore((s) => s.getTerminal);

  // Use the same font family as XtermAdapter for pixel-perfect alignment
  const effectiveFontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;

  const effectiveScrollback = useMemo(() => {
    if (performanceMode) {
      return PERFORMANCE_MODE_SCROLLBACK;
    }
    return getScrollbackForType(type, scrollbackLines);
  }, [performanceMode, scrollbackLines, type]);

  const getRefreshTierCallback = useCallback(() => {
    const terminal = getTerminal(terminalId);
    return getTerminalRefreshTier(terminal, isFocusedRef.current);
  }, [getTerminal, terminalId]);

  // Sync viewMode ref
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // Style - matches XtermAdapter settings exactly
  // Do NOT set lineHeight here - it's controlled per-row using xterm's cellH
  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: effectiveFontFamily,
      fontSize,
    }),
    [effectiveFontFamily, fontSize]
  );

  // Overlay style with ligature disabling to match xterm's fontLigatures: false
  const overlayStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: effectiveFontFamily,
      fontSize,
      letterSpacing: "0px",
      fontVariantLigatures: "none",
      fontFeatureSettings: '"liga" 0, "calt" 0',
      fontKerning: "none",
      fontWeight: "normal",
      fontStyle: "normal",
      tabSize: 8,
    }),
    [effectiveFontFamily, fontSize]
  );

  // Get the row style for each history line based on xterm metrics
  // The CSS properties here are carefully chosen to eliminate gaps:
  // - height/lineHeight match xterm's cell height exactly
  // - boxSizing ensures padding/border don't add to height
  // - margin/padding reset prevents browser defaults from adding space
  // - cellH is rounded to avoid fractional pixel issues on non-integer zoom levels
  const rowStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!metrics) return undefined;
    const cellH = Math.round(metrics.cellH);
    return {
      height: `${cellH}px`,
      lineHeight: `${cellH}px`,
      boxSizing: "border-box",
      margin: 0,
      padding: 0,
    };
  }, [metrics]);

  // Update metrics from xterm
  const updateMetrics = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    const m = readXtermVisualMetrics(term);
    if (m) {
      metricsRef.current = m;
      setMetrics(m);
    }
  }, []);

  // Enter History Mode
  // @param initialDeltaPx - Optional wheel delta to apply after render (for seamless scroll entry)
  const enterHistoryMode = useCallback(
    (initialDeltaPx: number = 0) => {
      if (viewModeRef.current === "history") return;

      const term = xtermRef.current;
      if (!term) return;

      // Check if alt buffer is active (alternate not in @types/xterm but exists at runtime)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isAltBuffer = term.buffer.active === (term.buffer as any).alternate;
      if (isAltBuffer) {
        setScrollbackUnavailable(true);
        setTimeout(() => setScrollbackUnavailable(false), 3000);
        return;
      }

      // Check if there's enough content
      const buffer = term.buffer.active;
      if (buffer.baseY < MIN_LINES_FOR_HISTORY) return;

      // Update metrics before taking snapshot
      updateMetrics();

      // Take snapshot with ANSI colors - NO skip for pixel-perfect sync
      // The exit-armed mechanism handles preventing immediate exit instead
      const snapshot = extractSnapshot(
        term,
        serializeAddonRef.current,
        MAX_HISTORY_LINES,
        INITIAL_HISTORY_SKIP_LINES // Skip lines from bottom when entering history mode
      );
      if (snapshot.lines.length === 0) return;

      // Update state
      historyStateRef.current = snapshot;
      setHistoryHtmlLines(snapshot.htmlLines);
      setShowTruncationBanner(snapshot.windowStart > 0);

      // Initialize jump-back persistence state
      lastAcceptedWindowStartRef.current = snapshot.windowStart;
      pendingJumpBackRef.current = null;

      // Store the initial wheel delta to apply after render
      pendingEntryDeltaPxRef.current = initialDeltaPx;

      // Flag to scroll to bottom after React renders the content
      shouldScrollToBottomRef.current = true;

      // Reset exit-armed - user must scroll up before exit is allowed
      exitArmedRef.current = false;

      // Set mode
      viewModeRef.current = "history";
      setViewMode("history");
    },
    [updateMetrics]
  );

  // Exit History Mode
  const exitHistoryMode = useCallback(() => {
    if (viewModeRef.current === "live") return;

    viewModeRef.current = "live";
    setViewMode("live");

    // Reset jump-back persistence state
    lastAcceptedWindowStartRef.current = null;
    pendingJumpBackRef.current = null;

    // Ensure xterm is scrolled to bottom
    xtermRef.current?.scrollToBottom();

    // Restore focus (use ref to avoid dependency on isFocused prop)
    if (isFocusedRef.current) {
      requestAnimationFrame(() => xtermRef.current?.focus());
    }
  }, []);

  // Expose notifySubmit to parent for HybridInputBar submits
  useImperativeHandle(
    ref,
    () => ({
      notifySubmit: () => {
        exitHistoryMode();
      },
    }),
    [exitHistoryMode]
  );

  // Scroll to bottom on History Entry with initial wheel delta applied
  // This useLayoutEffect runs AFTER React has rendered the overlay content,
  // ensuring scrollHeight is accurate when we scroll
  useLayoutEffect(() => {
    if (viewMode !== "history") return;
    if (!shouldScrollToBottomRef.current) return;

    const overlay = overlayScrollRef.current;
    if (!overlay) return;

    // Scroll to bottom, then apply the initial wheel delta for seamless scroll entry
    const bottom = Math.max(0, overlay.scrollHeight - overlay.clientHeight);
    const deltaPx = pendingEntryDeltaPxRef.current;

    // Apply delta (negative = scroll up from bottom)
    overlay.scrollTop = Math.max(0, Math.min(bottom, bottom + deltaPx));

    // Clear flags
    shouldScrollToBottomRef.current = false;
    pendingEntryDeltaPxRef.current = 0;
  }, [viewMode, historyHtmlLines]);

  // Resync History
  const resyncHistory = useCallback(() => {
    if (viewModeRef.current !== "history") return;
    if (resyncInFlightRef.current) return;

    const term = xtermRef.current;
    const overlay = overlayScrollRef.current;
    const content = overlayContentRef.current;
    if (!term || !overlay || !content) return;

    resyncInFlightRef.current = true;

    try {
      const now = performance.now();

      // Get cell height from metrics (fallback to estimate)
      const cellH = metricsRef.current?.cellH ?? 18;

      // 1) Capture anchor BEFORE any changes
      // Use content container's offsetTop to account for banner/padding
      const wasAtBottom = isAtBottom(overlay);
      let topIndex = 0;
      let offsetPx = 0;

      if (!wasAtBottom) {
        const contentTop = content.offsetTop;
        const y = overlay.scrollTop - contentTop;
        topIndex = Math.max(0, Math.floor(y / cellH));
        offsetPx = y - topIndex * cellH;
      }

      anchorRef.current = { topIndex, offsetPx, wasAtBottom };

      // 2) Extract new snapshot - NO skip for pixel-perfect sync
      const newSnapshot = extractSnapshot(
        term,
        serializeAddonRef.current,
        MAX_HISTORY_LINES,
        0 // No skip for pixel-perfect sync
      );
      const oldSnapshot = historyStateRef.current;

      // 3) Check settle logic (diff-based)
      if (
        oldSnapshot &&
        !shouldAcceptSnapshot(
          now,
          lastOutputAtRef.current,
          oldSnapshot.lines,
          newSnapshot.lines,
          SETTLE_MS
        )
      ) {
        // Skip this resync tick
        return;
      }

      // 3b) Check jump-back persistence (scroll monotonicity)
      const jumpBackResult = checkJumpBackPersistence(
        newSnapshot.windowStart,
        lastAcceptedWindowStartRef.current,
        pendingJumpBackRef.current,
        now
      );

      pendingJumpBackRef.current = jumpBackResult.newPendingState;

      if (!jumpBackResult.accept) {
        // Skip this resync tick - backward window move not yet persistent
        return;
      }

      // 4) Compute trim count
      const trimmedTopCount = computeTrimmedTopCount(oldSnapshot, newSnapshot);

      // 5) Update state and track accepted windowStart
      historyStateRef.current = newSnapshot;
      lastAcceptedWindowStartRef.current = newSnapshot.windowStart;
      setHistoryHtmlLines(newSnapshot.htmlLines);
      setShowTruncationBanner(newSnapshot.windowStart > 0);

      // 6) Restore scroll position after DOM update
      requestAnimationFrame(() => {
        if (!overlay || !content) return;

        const anchor = anchorRef.current;
        if (!anchor) return;

        if (anchor.wasAtBottom) {
          overlay.scrollTop = overlay.scrollHeight;
        } else {
          const contentTop = content.offsetTop;
          const newTopIndex = Math.max(0, anchor.topIndex - trimmedTopCount);
          overlay.scrollTop = contentTop + newTopIndex * cellH + anchor.offsetPx;
        }
      });
    } finally {
      resyncInFlightRef.current = false;
    }
  }, []);

  // Initialize xterm via TerminalInstanceService
  useLayoutEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    const xtermContainer = xtermContainerRef.current;
    if (!container || !xtermContainer) return;

    const terminalTheme = getTerminalThemeFromCSS();

    const terminalOptions = {
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block" as const,
      cursorInactiveStyle: "block" as const,
      fontSize,
      lineHeight: 1.1,
      letterSpacing: 0,
      fontFamily: effectiveFontFamily,
      fontLigatures: false,
      fontWeight: "normal" as const,
      fontWeightBold: "700" as const,
      theme: terminalTheme,
      scrollback: effectiveScrollback,
      macOptionIsMeta: true,
      scrollOnUserInput: false,
      scrollOnOutput: true,
      fastScrollModifier: "alt" as const,
      fastScrollSensitivity: 5,
      scrollSensitivity: 1.5,
    };

    // Use persistent instance from service
    const managed = terminalInstanceService.getOrCreate(
      terminalId,
      type,
      terminalOptions,
      getRefreshTierCallback
    );

    // Attach to DOM
    terminalInstanceService.attach(terminalId, xtermContainer);

    const term = managed.terminal;
    const fit = managed.fitAddon;
    const serialize = managed.serializeAddon;

    // Initial fit
    try {
      const rect = xtermContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Force fit to container
        terminalInstanceService.fit(terminalId);

        // Capture initial metrics
        const m = readXtermVisualMetrics(term);
        if (m) {
          metricsRef.current = m;
          setMetrics(m);
        }
      }
    } catch {
      // ignore
    }

    xtermRef.current = term;
    fitAddonRef.current = fit;
    serializeAddonRef.current = serialize;

    // Custom key handler for Enter key behavior.
    // We attach this to the persistent terminal instance.
    // Note: This replaces any handler from XtermAdapter if we switched views.
    term.attachCustomKeyEventHandler((event) => {
      // Handle Shift+Enter to send soft newline (line break without submit)
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "keydown" && !isInputLockedRef.current) {
          const softNewline = getSoftNewlineSequence(type);
          terminalClient.write(terminalId, softNewline);
          terminalInstanceService.notifyUserInput(terminalId);
        }
        return false;
      }

      // Only handle keydown for other logic, not keyup
      if (event.type !== "keydown") return true;

      // Detect Enter without Shift (a submit)
      const isSubmitEnter =
        (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter") &&
        !event.shiftKey;

      if (isSubmitEnter && viewModeRef.current === "history") {
        viewModeRef.current = "live";
        setViewMode("live");
        term.scrollToBottom();
        if (isFocusedRef.current) {
          requestAnimationFrame(() => term.focus());
        }
      }

      // Let xterm process the key normally
      return true;
    });

    // Handle user input (use refs to avoid re-initialization on prop changes)
    // Note: We don't write to terminalClient here; TerminalInstanceService handles that.
    // But we might need to intercept for focus report filtering?
    // Service handles focus report filtering if it's generic?
    // XtermAdapter ignored \x1b[I. Service doesn't seem to.
    // But input lock check is done by service.

    // Enforce lock-to-bottom: if xterm scrolls away from bottom, snap back immediately.
    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active;
      const isAtBottom = buffer.baseY - buffer.viewportY < 1;

      if (!isAtBottom) {
        term.scrollToBottom();
      }
    });

    // Track output time for settle logic (BUT DO NOT WRITE DATA - Service does it)
    const dataUnsub = terminalClient.onData(terminalId, (_data) => {
      lastOutputAtRef.current = performance.now();

      // Ensure viewport is at bottom after write (service writes async, so this might be early?)
      // Service has a callback for write that scrolls to bottom if sticky.
      // We rely on service's stick-to-bottom logic for agents.
    });

    return () => {
      disposedRef.current = true;
      scrollDisposable.dispose();
      dataUnsub();

      xtermRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;

      // Detach from DOM (preserves instance in service)
      terminalInstanceService.detach(terminalId, xtermContainer);
    };
  }, [
    terminalId,
    type,
    effectiveFontFamily,
    fontSize,
    effectiveScrollback,
    getRefreshTierCallback,
  ]);

  // Wheel Event Handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Ignore horizontal scrolling
      if (e.deltaY === 0) return;

      if (viewModeRef.current === "live") {
        // LIVE MODE: xterm is hard-locked to bottom. All scrolling control comes from history mode.
        // Intercept ALL wheel events so xterm never scrolls via wheel.
        e.preventDefault();
        e.stopPropagation();

        // Block history entry during drag operations to prevent accidental mode switches
        if (isDragging) return;

        // Scroll up accumulates delta toward history entry threshold
        if (e.deltaY < 0) {
          // Convert wheel delta to pixels for seamless scroll entry
          const cellH = metricsRef.current?.cellH ?? 18;
          const pageH = containerRef.current?.clientHeight ?? 400;
          const deltaPx = wheelDeltaToPx(e, cellH, pageH);

          // Accumulate upward scroll delta
          accumulatedWheelDeltaRef.current += Math.abs(deltaPx);

          // Only enter history mode after threshold reached (prevents accidental entry)
          if (accumulatedWheelDeltaRef.current >= HISTORY_ENTRY_THRESHOLD_PX) {
            accumulatedWheelDeltaRef.current = 0;
            enterHistoryMode(deltaPx);
          }
        } else {
          // Downward scroll resets accumulator
          accumulatedWheelDeltaRef.current = 0;
        }
        // Down scrolls in live mode are ignored (we're locked to bottom)
        return;
      }

      // HISTORY MODE: manually scroll the overlay
      // We must do this ourselves because stopPropagation in capture phase
      // prevents the overlay from receiving the wheel event
      const overlay = overlayScrollRef.current;
      if (!overlay) return;

      e.preventDefault();
      e.stopPropagation();

      // Convert wheel delta to pixels
      const cellH = metricsRef.current?.cellH ?? 18;
      const pageH = overlay.clientHeight;
      const deltaPx = wheelDeltaToPx(e, cellH, pageH);

      // Scrolling up arms the exit (user has scrolled away from bottom)
      if (deltaPx < 0) {
        exitArmedRef.current = true;
      }

      // Exit to live mode when scrolling down and at bottom
      // Simplified: exit immediately when at bottom, regardless of exitArmed
      // This makes accidental history entry less sticky
      if (deltaPx > 0) {
        const atBottom = isAtBottom(overlay, 2);
        if (atBottom) {
          exitHistoryMode();
          return;
        }
      }

      // Manually scroll the overlay
      overlay.scrollTop += deltaPx;
    };

    container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [enterHistoryMode, exitHistoryMode, isDragging]);

  // Periodic Resync Timer
  useEffect(() => {
    if (viewMode !== "history") return;
    if (!isVisible) return;

    const timer = setInterval(() => {
      resyncHistory();
    }, RESYNC_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [viewMode, isVisible, resyncHistory]);

  // Resize Handler
  useLayoutEffect(() => {
    const xtermContainer = xtermContainerRef.current;
    if (!xtermContainer) return;
    // Keep observer active during drag to prevent layout thrashing
    if (!isVisible && !isFocused && !isDragging) return;

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (disposedRef.current) return;
        const term = xtermRef.current;
        const fit = fitAddonRef.current;
        if (!term || !fit) return;

        try {
          const rect = xtermContainer.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          fit.fit();
          terminalClient.resize(terminalId, term.cols, term.rows);

          // Update metrics after resize for accurate cell dimensions
          const m = readXtermVisualMetrics(term);
          if (m) {
            metricsRef.current = m;
            setMetrics(m);
          }

          // If in history mode, rebuild snapshot on resize
          if (viewModeRef.current === "history") {
            resyncHistory();
          }
        } catch {
          // ignore
        }
      });
    });

    observer.observe(xtermContainer);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [isFocused, isVisible, terminalId, resyncHistory, isDragging]);

  // Post-drag stabilization: force fit when drag ends
  useEffect(() => {
    if (!isDragging) {
      const timer = setTimeout(() => {
        const term = xtermRef.current;
        const fit = fitAddonRef.current;
        if (term && fit) {
          try {
            fit.fit();
            terminalClient.resize(terminalId, term.cols, term.rows);
            // Update metrics after fit
            const m = readXtermVisualMetrics(term);
            if (m) {
              metricsRef.current = m;
              setMetrics(m);
            }
          } catch (e) {
            console.warn("Failed to fit terminal after drag:", e);
          }
        }
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isDragging, terminalId]);

  // Focus Handler
  useEffect(() => {
    if (!isFocused) return;
    if (viewMode === "live") {
      requestAnimationFrame(() => xtermRef.current?.focus());
    }
  }, [isFocused, viewMode]);

  // Render
  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 overflow-hidden bg-canopy-bg", className)}
      style={containerStyle}
      aria-label="Terminal view"
    >
      {/* Live xterm layer - always mounted */}
      {/* Outer wrapper provides padding - xterm container must have no padding for correct column calculation */}
      <div
        className={cn(
          "absolute inset-0 pl-3 pt-3 pb-3 pr-4",
          viewMode === "history" && "pointer-events-none"
        )}
        style={{ opacity: viewMode === "history" ? 0 : 1 }}
        onPointerDownCapture={() => {
          if (isFocused && viewMode === "live") {
            xtermRef.current?.focus();
          }
        }}
      >
        <div ref={xtermContainerRef} className="w-full h-full" />
      </div>

      {/* History overlay layer - DOM-based, scrollable */}
      {/* Outer wrapper matches xterm container positioning so scrollbar aligns */}
      {viewMode === "history" && (
        <div className="absolute inset-0 pl-3 pt-3 pb-3 pr-4 z-10">
          <div
            ref={overlayScrollRef}
            tabIndex={-1}
            className="history-overlay h-full overflow-y-auto overflow-x-hidden bg-canopy-bg outline-none"
            style={{
              ...overlayStyle,
              overscrollBehavior: "contain",
              scrollBehavior: "auto",
            }}
          >
            {/* History overlay styles for pixel-perfect alignment with xterm
                - Uses xterm's serializeAsHTML which outputs inline styles matching xterm's theme
                - Row styling ensures exact cell height matching
                - Span styling preserves inline flow for proper text rendering */}
            <style>{`
              .history-overlay a:hover {
                color: #79c0ff !important;
                text-decoration-color: #79c0ff;
              }
              .history-overlay .history-row {
                display: block;
                box-sizing: border-box;
                margin: 0;
                padding: 0;
              }
              .history-overlay .history-row span {
                display: inline;
                line-height: inherit;
              }
              .history-overlay .history-row a {
                display: inline;
                line-height: inherit;
              }
            `}</style>

            {/* Truncation banner */}
            {showTruncationBanner && (
              <div className="sticky top-0 z-20 mb-2 px-3 py-2 bg-canopy-sidebar/90 backdrop-blur-sm border border-canopy-border/50 rounded text-xs text-canopy-text/70">
                History limited to last {MAX_HISTORY_LINES.toLocaleString()} lines. Older output was
                truncated.
              </div>
            )}

            {/* History content with colors - uses xterm cell metrics for pixel-perfect alignment */}
            <div
              ref={overlayContentRef}
              className="flex flex-col"
              style={metrics ? { width: `${metrics.screenW}px`, gap: 0 } : { gap: 0 }}
            >
              {historyHtmlLines.map((htmlLine, idx) => (
                <div
                  key={idx}
                  data-idx={idx}
                  className="history-row whitespace-pre overflow-hidden select-text"
                  style={rowStyle}
                  dangerouslySetInnerHTML={{ __html: htmlLine }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Back to live bar */}
      {viewMode === "history" && (
        <button
          type="button"
          onClick={exitHistoryMode}
          className="absolute bottom-0 left-0 right-0 z-30 flex items-center justify-center gap-2 py-2 bg-canopy-sidebar/90 backdrop-blur-sm border-t border-canopy-border/50 text-xs font-medium text-canopy-text/70 hover:text-canopy-text hover:bg-canopy-sidebar transition-all cursor-pointer group"
        >
          <svg
            className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100 group-hover:translate-y-0.5 transition-all"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
          <span>Back to live</span>
        </button>
      )}

      {/* Scrollback unavailable notice (alt buffer) */}
      {scrollbackUnavailable && viewMode === "live" && (
        <div className="absolute bottom-4 left-4 right-4 z-30 px-4 py-3 bg-black/80 backdrop-blur-sm border border-white/10 rounded-md text-xs font-sans text-white/70">
          Scrollback isn't available while the terminal is in full-screen mode.
        </div>
      )}
    </div>
  );
});
