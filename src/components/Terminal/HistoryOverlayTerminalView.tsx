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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import Anser from "anser";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getTerminalThemeFromCSS } from "./XtermAdapter";

// ============================================================================
// Configuration
// ============================================================================

const MAX_HISTORY_LINES = 5000;
const RESYNC_INTERVAL_MS = 3000;
const SETTLE_MS = 60; // Quiet period before accepting snapshot
const MIN_LINES_FOR_HISTORY = 3;
const BOTTOM_EPSILON_PX = 5;
const BOTTOM_BUFFER_LINES = 6; // Buffer zone for exit detection

// ============================================================================
// Types
// ============================================================================

export interface HistoryOverlayTerminalViewProps {
  terminalId: string;
  isFocused: boolean;
  isVisible: boolean;
  isInputLocked?: boolean;
  className?: string;
}

type ViewMode = "live" | "history";

interface HistoryState {
  lines: string[]; // Plain text lines (for comparison)
  htmlLines: string[]; // HTML-rendered lines with colors (for display)
  windowStart: number; // Buffer line index where lines[0] came from
  windowEnd: number; // Buffer line index after last line
  takenAt: number;
}

interface ScrollAnchor {
  topIndex: number;
  offsetPx: number;
  wasAtBottom: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Escape HTML entities in a string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * URL regex pattern for detecting links in terminal output.
 * Matches http://, https://, and file:// URLs.
 */
const URL_REGEX = /\b(https?:\/\/|file:\/\/)[^\s<>"'`)\]},;]+/gi;

/**
 * Convert URLs in HTML to clickable anchor tags.
 * Handles URLs that may span across HTML tags from ANSI coloring.
 */
function linkifyHtml(html: string): string {
  // Split by HTML tags to process text content separately
  const parts = html.split(/(<[^>]+>)/);

  return parts.map((part) => {
    // Skip HTML tags
    if (part.startsWith("<")) return part;

    // Replace URLs in text content
    return part.replace(URL_REGEX, (url) => {
      // Clean up any trailing punctuation that's likely not part of the URL
      let cleanUrl = url;
      const trailingPunct = /[.,;:!?)>\]]+$/;
      const match = cleanUrl.match(trailingPunct);
      let suffix = "";
      if (match) {
        suffix = match[0];
        cleanUrl = cleanUrl.slice(0, -suffix.length);
      }

      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;text-decoration:underline;text-underline-offset:2px">${cleanUrl}</a>${suffix}`;
    });
  }).join("");
}

/**
 * Convert ANSI lines to HTML using Anser library.
 * Maintains color state across lines for proper continuation.
 * Also converts URLs to clickable links.
 */
function convertAnsiLinesToHtml(ansiLines: string[]): string[] {
  return ansiLines.map((line) => {
    if (!line) return " ";
    // Use Anser to convert ANSI to HTML with inline styles
    let html = Anser.ansiToHtml(line, { use_classes: false });
    // Convert URLs to clickable links
    html = linkifyHtml(html);
    return html || " ";
  });
}

/**
 * Extract snapshot from xterm buffer.
 * Returns the last maxLines lines from the buffer with both plain text and HTML.
 * @param skipBottomLines - Number of lines to skip from the bottom (for seamless transition)
 */
function extractSnapshot(
  term: Terminal,
  serializeAddon: SerializeAddon | null,
  maxLines: number,
  skipBottomLines: number = 0
): HistoryState {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const cols = term.cols;

  // Calculate effective end (skip bottom lines for seamless history entry)
  const effectiveEnd = Math.max(0, total - skipBottomLines);
  const count = Math.min(maxLines, effectiveEnd);
  const start = Math.max(0, effectiveEnd - count);

  // Get plain text lines for comparison
  const lines: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const line = buffer.getLine(start + i);
    lines[i] = line ? line.translateToString(true, 0, cols) : "";
  }

  // Get ANSI-encoded content and convert to HTML
  let htmlLines: string[];
  if (serializeAddon) {
    try {
      const serialized = serializeAddon.serialize();
      // Split by newlines and convert to HTML
      const allAnsiLines = serialized.split("\n");
      // Take the relevant window (skip bottom lines, take last 'count' of remaining)
      const relevantAnsiLines = allAnsiLines.slice(
        Math.max(0, allAnsiLines.length - skipBottomLines - count),
        allAnsiLines.length - skipBottomLines
      );
      htmlLines = convertAnsiLinesToHtml(relevantAnsiLines);
    } catch {
      // Fallback to plain text if serialization fails
      htmlLines = lines.map((l) => escapeHtml(l) || " ");
    }
  } else {
    htmlLines = lines.map((l) => escapeHtml(l) || " ");
  }

  return {
    lines,
    htmlLines,
    windowStart: start,
    windowEnd: effectiveEnd,
    takenAt: performance.now(),
  };
}

/**
 * Compute how many lines were trimmed from the top.
 * Primary method: compare windowStart indices.
 * Fallback: overlap-based detection when windowStart is unreliable.
 */
function computeTrimmedTopCount(
  oldState: HistoryState | null,
  newState: HistoryState
): number {
  if (!oldState) return 0;

  // Primary: use window start difference
  const primaryTrimmed = Math.max(0, newState.windowStart - oldState.windowStart);
  if (primaryTrimmed > 0) return primaryTrimmed;

  // Fallback: overlap-based detection for when xterm buffer is saturated
  // (buffer.length stays constant but content shifts)
  const oldLines = oldState.lines;
  const newLines = newState.lines;

  if (oldLines.length === 0 || newLines.length === 0) return 0;

  // Try to find where old content appears in new content
  const probeLen = Math.min(20, oldLines.length, newLines.length);
  const maxShift = Math.min(500, oldLines.length - probeLen);

  // Take probe from near the end of old lines (more likely to still exist)
  const probeStart = Math.max(0, oldLines.length - probeLen - 50);
  const probe = oldLines.slice(probeStart, probeStart + probeLen);

  // Search for this probe in newLines
  for (let shift = 0; shift <= maxShift; shift++) {
    const searchIdx = probeStart - shift;
    if (searchIdx < 0) break;

    let match = true;
    for (let i = 0; i < probeLen && searchIdx + i < newLines.length; i++) {
      if (newLines[searchIdx + i] !== probe[i]) {
        match = false;
        break;
      }
    }
    if (match) return shift;
  }

  return 0;
}

/**
 * Check if we should accept a new snapshot based on settle logic.
 * Avoids capturing mid-redraw "broken frames".
 */
function shouldAcceptSnapshot(
  now: number,
  lastOutputAt: number,
  oldLines: string[],
  newLines: string[],
  settleMs: number
): boolean {
  // If enough time has passed since last output, always accept
  if (now - lastOutputAt >= settleMs) return true;

  // During active output, check if the diff is "small enough"
  // Large diffs during settle window likely indicate transient redraw
  const checkCount = Math.min(40, oldLines.length, newLines.length);
  let changedLines = 0;

  for (let i = 1; i <= checkCount; i++) {
    const oldIdx = oldLines.length - i;
    const newIdx = newLines.length - i;
    if (oldIdx < 0 || newIdx < 0) break;

    if (oldLines[oldIdx] !== newLines[newIdx]) {
      changedLines++;
      if (changedLines > 5) return false; // Too many changes, skip this tick
    }
  }

  return true;
}

/**
 * Check if overlay is at bottom (within epsilon).
 */
function isAtBottom(el: HTMLElement, epsilon = BOTTOM_EPSILON_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= epsilon;
}

/**
 * Check if overlay is near bottom (within buffer zone).
 */
function isNearBottom(el: HTMLElement, lineHeight: number, bufferLines: number): boolean {
  const bufferPx = lineHeight * bufferLines;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= bufferPx;
}

// ============================================================================
// Component
// ============================================================================

export function HistoryOverlayTerminalView({
  terminalId,
  isFocused,
  isVisible,
  isInputLocked,
  className,
}: HistoryOverlayTerminalViewProps) {
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

  // Scroll anchor for resync
  const anchorRef = useRef<ScrollAnchor | null>(null);

  // Line height for scroll calculations (measured dynamically)
  const lineHeightRef = useRef(18); // Default, will be measured

  // Flag to scroll to bottom after entering history mode
  const shouldScrollToBottomRef = useRef(false);

  // Refs for values used in callbacks that shouldn't trigger re-initialization
  const isFocusedRef = useRef(isFocused);
  const isInputLockedRef = useRef(isInputLocked);

  // Sync refs
  useEffect(() => {
    isFocusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    isInputLockedRef.current = isInputLocked;
  }, [isInputLocked]);

  // Store subscriptions
  const fontSize = useTerminalFontStore((s) => s.fontSize);
  const fontFamily = useTerminalFontStore((s) => s.fontFamily);
  const scrollbackLines = useScrollbackStore((s) => s.scrollbackLines);

  const effectiveFontFamily =
    fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  // Sync viewMode ref
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // ============================================================================
  // Style
  // ============================================================================

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: effectiveFontFamily,
      fontSize,
      lineHeight: 1.2,
    }),
    [effectiveFontFamily, fontSize]
  );

  const overlayStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: effectiveFontFamily,
      fontSize,
      lineHeight: "1.2",
    }),
    [effectiveFontFamily, fontSize]
  );

  // ============================================================================
  // Measure Line Height
  // ============================================================================

  const measureLineHeight = useCallback(() => {
    const content = overlayContentRef.current;
    if (!content || !content.firstElementChild) return;

    const firstLine = content.firstElementChild as HTMLElement;
    const height = firstLine.offsetHeight;
    if (height > 0) {
      lineHeightRef.current = height;
    }
  }, []);

  // ============================================================================
  // Enter History Mode
  // ============================================================================

  const enterHistoryMode = useCallback(() => {
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

    // Take snapshot with ANSI colors, skipping bottom lines for seamless transition
    // This ensures history starts where the live view ends - no visual jump
    const snapshot = extractSnapshot(
      term,
      serializeAddonRef.current,
      MAX_HISTORY_LINES,
      BOTTOM_BUFFER_LINES
    );
    if (snapshot.lines.length === 0) return;

    // Update state
    historyStateRef.current = snapshot;
    setHistoryHtmlLines(snapshot.htmlLines);
    setShowTruncationBanner(snapshot.windowStart > 0);

    // Flag to scroll to bottom after React renders the content
    shouldScrollToBottomRef.current = true;

    // Set mode
    viewModeRef.current = "history";
    setViewMode("history");
  }, []);

  // ============================================================================
  // Exit History Mode
  // ============================================================================

  const exitHistoryMode = useCallback(() => {
    if (viewModeRef.current === "live") return;

    viewModeRef.current = "live";
    setViewMode("live");

    // Ensure xterm is scrolled to bottom
    xtermRef.current?.scrollToBottom();

    // Restore focus (use ref to avoid dependency on isFocused prop)
    if (isFocusedRef.current) {
      requestAnimationFrame(() => xtermRef.current?.focus());
    }
  }, []);

  // ============================================================================
  // Scroll to Bottom on History Entry
  // ============================================================================

  // This useLayoutEffect runs AFTER React has rendered the overlay content,
  // ensuring scrollHeight is accurate when we scroll to bottom
  useLayoutEffect(() => {
    if (viewMode !== "history") return;
    if (!shouldScrollToBottomRef.current) return;

    const overlay = overlayScrollRef.current;
    if (!overlay) return;

    // Measure line height for future calculations
    measureLineHeight();

    // Scroll to the very bottom so a single scroll-down exits to live mode
    overlay.scrollTop = overlay.scrollHeight;

    // Clear the flag
    shouldScrollToBottomRef.current = false;
  }, [viewMode, historyHtmlLines, measureLineHeight]);

  // ============================================================================
  // Resync History
  // ============================================================================

  const resyncHistory = useCallback(() => {
    if (viewModeRef.current !== "history") return;
    if (resyncInFlightRef.current) return;

    const term = xtermRef.current;
    const overlay = overlayScrollRef.current;
    if (!term || !overlay) return;

    resyncInFlightRef.current = true;

    try {
      const now = performance.now();

      // 1) Capture anchor BEFORE any changes
      const wasAtBottom = isAtBottom(overlay);
      let topIndex = 0;
      let offsetPx = 0;

      if (!wasAtBottom) {
        const lineHeight = lineHeightRef.current;
        topIndex = Math.max(0, Math.floor(overlay.scrollTop / lineHeight));
        offsetPx = overlay.scrollTop - topIndex * lineHeight;
      }

      anchorRef.current = { topIndex, offsetPx, wasAtBottom };

      // 2) Extract new snapshot with ANSI colors (skip bottom lines like on entry)
      const newSnapshot = extractSnapshot(
        term,
        serializeAddonRef.current,
        MAX_HISTORY_LINES,
        BOTTOM_BUFFER_LINES
      );
      const oldSnapshot = historyStateRef.current;

      // 3) Check settle logic
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

      // 4) Compute trim count
      const trimmedTopCount = computeTrimmedTopCount(oldSnapshot, newSnapshot);

      // 5) Update state
      historyStateRef.current = newSnapshot;
      setHistoryHtmlLines(newSnapshot.htmlLines);
      setShowTruncationBanner(newSnapshot.windowStart > 0);

      // 6) Restore scroll position after DOM update
      requestAnimationFrame(() => {
        if (!overlay) return;

        const anchor = anchorRef.current;
        if (!anchor) return;

        if (anchor.wasAtBottom) {
          overlay.scrollTop = overlay.scrollHeight;
        } else {
          const newTopIndex = Math.max(0, anchor.topIndex - trimmedTopCount);
          const lineHeight = lineHeightRef.current;
          overlay.scrollTop = newTopIndex * lineHeight + anchor.offsetPx;
        }
      });
    } finally {
      resyncInFlightRef.current = false;
    }
  }, []);

  // ============================================================================
  // Initialize xterm
  // ============================================================================

  useLayoutEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    const xtermContainer = xtermContainerRef.current;
    if (!container || !xtermContainer) return;

    const terminalTheme = getTerminalThemeFromCSS();
    const effectiveScrollback = Math.max(1000, Math.min(50000, Math.floor(scrollbackLines)));

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      fontSize,
      lineHeight: 1.1,
      letterSpacing: 0,
      fontFamily: effectiveFontFamily,
      fontWeight: "normal",
      fontWeightBold: "700",
      theme: terminalTheme,
      scrollback: effectiveScrollback,
      macOptionIsMeta: true,
      scrollOnUserInput: true,
    });

    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(xtermContainer);

    try {
      const rect = xtermContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fit.fit();
        terminalClient.resize(terminalId, term.cols, term.rows);
      }
    } catch {
      // ignore
    }

    xtermRef.current = term;
    fitAddonRef.current = fit;
    serializeAddonRef.current = serialize;

    // Handle user input (use refs to avoid re-initialization on prop changes)
    const inputDisposable = term.onData((data) => {
      if (isInputLockedRef.current) return;

      // Ignore focus report escape sequences
      if (data === "\x1b[I" || data === "\x1b[O") return;

      // If user types while in history mode, return to live
      if (viewModeRef.current === "history") {
        viewModeRef.current = "live";
        setViewMode("live");
        term.scrollToBottom();
        if (isFocusedRef.current) {
          requestAnimationFrame(() => term.focus());
        }
      }

      terminalClient.write(terminalId, data);
      terminalInstanceService.notifyUserInput(terminalId);
    });

    // Subscribe to PTY data
    const dataUnsub = terminalClient.onData(terminalId, (data) => {
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);

      // Track output time for settle logic
      lastOutputAtRef.current = performance.now();

      term.write(str);
    });

    return () => {
      disposedRef.current = true;
      inputDisposable.dispose();
      dataUnsub();
      xtermRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      term.dispose();
    };
  }, [
    terminalId,
    effectiveFontFamily,
    fontSize,
    scrollbackLines,
  ]);

  // ============================================================================
  // Wheel Event Handler
  // ============================================================================

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Ignore horizontal scrolling
      if (e.deltaY === 0) return;

      if (viewModeRef.current === "live") {
        // LIVE MODE: scroll up enters history
        if (e.deltaY < 0) {
          e.preventDefault();
          e.stopPropagation();
          enterHistoryMode();
        }
        // Down scrolls in live mode are ignored (we're at bottom)
        return;
      }

      // HISTORY MODE: let overlay scroll, but detect exit condition
      const overlay = overlayScrollRef.current;
      if (!overlay) return;

      // Check if scrolling down while near bottom
      if (e.deltaY > 0) {
        const lineHeight = lineHeightRef.current;
        const nearBottom = isNearBottom(overlay, lineHeight, BOTTOM_BUFFER_LINES);

        if (nearBottom) {
          // Check if we're actually at the very bottom (can't scroll further)
          const atVeryBottom = isAtBottom(overlay, 2);

          if (atVeryBottom) {
            // Exit to live mode
            e.preventDefault();
            e.stopPropagation();
            exitHistoryMode();
            return;
          }

          // Let scroll happen, but check if it would go past bottom
          const wouldBe = overlay.scrollTop + e.deltaY;
          const maxScroll = overlay.scrollHeight - overlay.clientHeight;

          if (wouldBe >= maxScroll) {
            // Would hit bottom, exit
            e.preventDefault();
            e.stopPropagation();
            exitHistoryMode();
            return;
          }
        }
      }

      // Let normal overlay scroll happen
      // Stop propagation to prevent xterm from also handling
      e.stopPropagation();
    };

    container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [enterHistoryMode, exitHistoryMode]);

  // ============================================================================
  // Periodic Resync Timer
  // ============================================================================

  useEffect(() => {
    if (viewMode !== "history") return;
    if (!isVisible) return;

    const timer = setInterval(() => {
      resyncHistory();
    }, RESYNC_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [viewMode, isVisible, resyncHistory]);

  // ============================================================================
  // Resize Handler
  // ============================================================================

  useLayoutEffect(() => {
    const xtermContainer = xtermContainerRef.current;
    if (!xtermContainer) return;
    if (!isVisible && !isFocused) return;

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
  }, [isFocused, isVisible, terminalId, resyncHistory]);

  // ============================================================================
  // Focus Handler
  // ============================================================================

  useEffect(() => {
    if (!isFocused) return;
    if (viewMode === "live") {
      requestAnimationFrame(() => xtermRef.current?.focus());
    }
  }, [isFocused, viewMode]);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 overflow-hidden bg-canopy-bg", className)}
      style={containerStyle}
      aria-label="Terminal view"
    >
      {/* Live xterm layer - always mounted */}
      <div
        ref={xtermContainerRef}
        className={cn(
          "absolute inset-0 py-2 px-3",
          viewMode === "history" && "pointer-events-none"
        )}
        style={{ opacity: viewMode === "history" ? 0.3 : 1 }}
        onPointerDownCapture={() => {
          if (isFocused && viewMode === "live") {
            xtermRef.current?.focus();
          }
        }}
      />

      {/* History overlay layer - DOM-based, scrollable */}
      {viewMode === "history" && (
        <div
          ref={overlayScrollRef}
          className="history-overlay absolute inset-0 py-2 px-3 overflow-y-auto overflow-x-hidden z-10 bg-canopy-bg/95"
          style={{
            ...overlayStyle,
            overscrollBehavior: "contain",
            scrollBehavior: "auto",
          }}
        >
          {/* Link hover styles */}
          <style>{`
            .history-overlay a:hover {
              color: #79c0ff !important;
              text-decoration-color: #79c0ff;
            }
          `}</style>

          {/* Truncation banner */}
          {showTruncationBanner && (
            <div className="sticky top-0 z-20 mb-2 px-3 py-2 bg-canopy-sidebar/90 backdrop-blur-sm border border-canopy-border/50 rounded text-xs text-canopy-text/70">
              History limited to last {MAX_HISTORY_LINES.toLocaleString()} lines.
              Older output was truncated.
            </div>
          )}

          {/* History content with colors */}
          <div ref={overlayContentRef} className="flex flex-col">
            {historyHtmlLines.map((htmlLine, idx) => (
              <div
                key={idx}
                data-idx={idx}
                className="whitespace-pre break-all min-h-[1.2em] select-text"
                style={{ lineHeight: "1.2" }}
                dangerouslySetInnerHTML={{ __html: htmlLine }}
              />
            ))}
            {/* Bottom padding to allow scrolling past end */}
            <div className="h-4" />
          </div>
        </div>
      )}

      {/* Back to live button */}
      {viewMode === "history" && (
        <button
          type="button"
          onClick={exitHistoryMode}
          className="absolute bottom-4 right-4 z-30 flex items-center gap-1.5 px-2.5 py-1.5 bg-canopy-sidebar border border-canopy-border rounded-md text-xs font-medium text-canopy-text/80 hover:bg-canopy-bg hover:text-canopy-text hover:border-canopy-border/80 transition-colors shadow-md"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
          Back to live
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
}
