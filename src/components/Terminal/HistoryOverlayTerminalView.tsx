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
import Anser from "anser";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getTerminalThemeFromCSS } from "./XtermAdapter";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

// Configuration
const MAX_HISTORY_LINES = 5000;
const RESYNC_INTERVAL_MS = 3000;
const SETTLE_MS = 60; // Quiet period before accepting snapshot
const BOTTOM_EPSILON_PX = 5;
const MIN_LINES_FOR_HISTORY = 8; // Minimum lines before allowing history mode

// Jump-back persistence for history resync (defense-in-depth, mirrors backend)
const HISTORY_JUMP_BACK_PERSIST_MS = 100;
const HISTORY_JUMP_BACK_PERSIST_FRAMES = 2;

// Xterm visual metrics for pixel-perfect alignment
interface XtermVisualMetrics {
  cellW: number;
  cellH: number;
  screenW: number;
  screenH: number;
  cols: number;
  rows: number;
}

/**
 * Read xterm's actual cell dimensions from its internal renderer.
 * Falls back to measuring the screen element if internals unavailable.
 */
function readXtermVisualMetrics(term: Terminal): XtermVisualMetrics | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (term as any)?._core;
  const dims = core?._renderService?.dimensions;

  // Try known internal dimension shapes (varies by xterm version)
  const cssCellW = dims?.css?.cell?.width ?? dims?.actualCellWidth ?? dims?.cell?.width;
  const cssCellH = dims?.css?.cell?.height ?? dims?.actualCellHeight ?? dims?.cell?.height;

  // Fallback: measure screen element and divide by cols/rows
  const screenEl = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screenEl) return null;

  const rect = screenEl.getBoundingClientRect();
  const cols = term.cols || 0;
  const rows = term.rows || 0;
  if (rect.width <= 0 || rect.height <= 0 || cols <= 0 || rows <= 0) return null;

  const screenW = rect.width;
  const screenH = rect.height;

  const cellW = typeof cssCellW === "number" && cssCellW > 0 ? cssCellW : screenW / cols;
  const cellH = typeof cssCellH === "number" && cssCellH > 0 ? cssCellH : screenH / rows;

  return { cellW, cellH, screenW, screenH, cols, rows };
}

/**
 * Convert wheel deltaY to pixels, handling different deltaMode values.
 */
function wheelDeltaToPx(e: WheelEvent, cellH: number, pageH: number): number {
  if (e.deltaMode === 1) return e.deltaY * cellH; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return e.deltaY * pageH; // DOM_DELTA_PAGE
  return e.deltaY; // DOM_DELTA_PIXEL
}

// Types
export interface HistoryOverlayTerminalViewProps {
  terminalId: string;
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

// Utility Functions

/**
 * Escape HTML entities in a string.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  return parts
    .map((part) => {
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
    })
    .join("");
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
 * Uses line-by-line serialization to respect xterm's column-based wrapping.
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
  // IMPORTANT: Serialize each buffer line individually to respect xterm's wrapping.
  // The buffer already wraps long content at `cols` characters, so each buffer line
  // is one visual row. Serializing the whole buffer doesn't preserve this wrapping.
  let htmlLines: string[];
  if (serializeAddon) {
    try {
      const ansiLines: string[] = new Array(count);
      for (let i = 0; i < count; i++) {
        const lineIdx = start + i;
        // Serialize just this one line using range option

        const serialized = serializeAddon.serialize({
          range: { start: lineIdx, end: lineIdx },
          excludeAltBuffer: true,
          excludeModes: true,
        } as any);
        // Remove trailing newline if present (single line shouldn't have one)
        ansiLines[i] = serialized.replace(/\n$/, "");
      }
      htmlLines = convertAnsiLinesToHtml(ansiLines);
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
function computeTrimmedTopCount(oldState: HistoryState | null, newState: HistoryState): number {
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
 * Check if a backward window move should be accepted (persistence check).
 * Returns { accept: boolean, updatePending: boolean } where updatePending
 * indicates whether the pending state was updated.
 */
function checkJumpBackPersistence(
  newWindowStart: number,
  lastAcceptedWindowStart: number | null,
  pendingJumpBack: { windowStart: number; firstSeenAt: number; stableFrames: number } | null,
  now: number
): {
  accept: boolean;
  newPendingState: { windowStart: number; firstSeenAt: number; stableFrames: number } | null;
} {
  // No previous accepted position - accept immediately
  if (lastAcceptedWindowStart === null) {
    return { accept: true, newPendingState: null };
  }

  // Forward or same position - accept immediately, clear pending
  if (newWindowStart >= lastAcceptedWindowStart) {
    return { accept: true, newPendingState: null };
  }

  // Backward position - apply persistence check
  const sameCandidate = pendingJumpBack && pendingJumpBack.windowStart === newWindowStart;

  let newPending: { windowStart: number; firstSeenAt: number; stableFrames: number };
  if (sameCandidate) {
    newPending = {
      ...pendingJumpBack,
      stableFrames: pendingJumpBack.stableFrames + 1,
    };
  } else {
    newPending = {
      windowStart: newWindowStart,
      firstSeenAt: now,
      stableFrames: 1,
    };
  }

  // Check if persistence criteria met
  const elapsed = now - newPending.firstSeenAt;
  const shouldAccept =
    elapsed >= HISTORY_JUMP_BACK_PERSIST_MS ||
    newPending.stableFrames >= HISTORY_JUMP_BACK_PERSIST_FRAMES;

  if (shouldAccept) {
    return { accept: true, newPendingState: null };
  }

  // Not yet persistent - reject but update pending state
  return { accept: false, newPendingState: newPending };
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
  { terminalId, isFocused, isVisible, isInputLocked, className },
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

  // Use the same font family as XtermAdapter for pixel-perfect alignment
  const effectiveFontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;

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
      tabSize: 8,
    }),
    [effectiveFontFamily, fontSize]
  );

  // Get the row style for each history line based on xterm metrics
  const rowStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!metrics) return undefined;
    return {
      height: `${metrics.cellH}px`,
      lineHeight: `${metrics.cellH}px`,
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
        0 // No skip - pixel perfect sync requires showing exactly what xterm shows
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

  // Initialize xterm
  useLayoutEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    const xtermContainer = xtermContainerRef.current;
    if (!container || !xtermContainer) return;

    const terminalTheme = getTerminalThemeFromCSS();
    const effectiveScrollback = Math.max(1000, Math.min(50000, Math.floor(scrollbackLines)));

    // Match XtermAdapter options exactly for pixel-perfect alignment
    // Note: fontLigatures is a valid xterm option but may not be in @types
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
    const term = new Terminal(terminalOptions);

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

        // Capture initial metrics after fit
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

    // Custom key handler to detect Enter (submit) without Shift.
    // This allows us to distinguish between Enter (exit history) and Shift+Enter (newline).
    term.attachCustomKeyEventHandler((event) => {
      // Only handle keydown, not keyup
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

      // Always return true to let xterm process the key normally
      return true;
    });

    // Handle user input (use refs to avoid re-initialization on prop changes)
    const inputDisposable = term.onData((data) => {
      if (isInputLockedRef.current) return;

      // Ignore focus report escape sequences
      if (data === "\x1b[I" || data === "\x1b[O") return;

      // Note: Enter detection for exiting history mode is handled by
      // attachCustomKeyEventHandler above, which can distinguish Enter from Shift+Enter.

      terminalClient.write(terminalId, data);
      terminalInstanceService.notifyUserInput(terminalId);
    });

    // Enforce lock-to-bottom: if xterm scrolls away from bottom, snap back immediately.
    // In this view, xterm must ALWAYS be at bottom - any deviation is a bug.
    // History scrolling is handled entirely by the overlay, not xterm's native scrolling.
    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active;
      const isAtBottom = buffer.baseY - buffer.viewportY < 1;

      if (!isAtBottom) {
        term.scrollToBottom();
      }
    });

    // Subscribe to PTY data
    const dataUnsub = terminalClient.onData(terminalId, (data) => {
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);

      // Track output time for settle logic
      lastOutputAtRef.current = performance.now();

      // Note: We intentionally do NOT exit history mode when PTY data arrives.
      // This allows users to browse history while an agent is working.
      // The resync mechanism will update history content periodically,
      // and users can exit via: scroll to bottom, "Back to live" button, or pressing Enter.

      term.write(str, () => {
        // Ensure viewport is at bottom after every write
        const buffer = term.buffer.active;
        const isAtBottom = buffer.baseY - buffer.viewportY < 1;
        if (!isAtBottom) {
          term.scrollToBottom();
        }
      });
    });

    return () => {
      disposedRef.current = true;
      scrollDisposable.dispose();
      inputDisposable.dispose();
      dataUnsub();
      xtermRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      term.dispose();
    };
  }, [terminalId, effectiveFontFamily, fontSize, scrollbackLines]);

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

        // Scroll up enters history with the wheel delta applied
        if (e.deltaY < 0) {
          // Convert wheel delta to pixels for seamless scroll entry
          const cellH = metricsRef.current?.cellH ?? 18;
          const pageH = containerRef.current?.clientHeight ?? 400;
          const deltaPx = wheelDeltaToPx(e, cellH, pageH);

          enterHistoryMode(deltaPx);
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

      // Check if scrolling down while at/near bottom AND exit is armed - exit to live mode
      if (deltaPx > 0 && exitArmedRef.current) {
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
  }, [enterHistoryMode, exitHistoryMode]);

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
  }, [isFocused, isVisible, terminalId, resyncHistory]);

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
                History limited to last {MAX_HISTORY_LINES.toLocaleString()} lines. Older output was
                truncated.
              </div>
            )}

            {/* History content with colors - uses xterm cell metrics for pixel-perfect alignment */}
            <div
              ref={overlayContentRef}
              className="flex flex-col"
              style={metrics ? { width: `${metrics.screenW}px` } : undefined}
            >
              {historyHtmlLines.map((htmlLine, idx) => (
                <div
                  key={idx}
                  data-idx={idx}
                  className="whitespace-pre overflow-hidden select-text"
                  style={rowStyle}
                  dangerouslySetInnerHTML={{ __html: htmlLine }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Back to live button */}
      {viewMode === "history" && (
        <button
          type="button"
          onClick={exitHistoryMode}
          className="absolute bottom-4 right-4 z-30 flex items-center gap-2 px-4 py-2.5 bg-canopy-sidebar/70 backdrop-blur-md border border-canopy-border/50 rounded-lg text-sm font-medium text-canopy-text/90 hover:bg-canopy-sidebar/80 hover:text-canopy-text hover:border-canopy-border/70 transition-all shadow-lg"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
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
});
