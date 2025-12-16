import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import type { TerminalScreenSnapshot } from "@/types";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getTerminalThemeFromCSS } from "./XtermAdapter";

export interface SnapshotTerminalViewProps {
  terminalId: string;
  isFocused: boolean;
  isVisible: boolean;
  refreshMs: number;
  isInputLocked?: boolean;
  forceLiveKey?: number;
  className?: string;
}

type SnapshotViewMode = "live" | "scrolled";

export function SnapshotTerminalView({
  terminalId,
  isFocused,
  isVisible,
  refreshMs,
  isInputLocked,
  forceLiveKey = 0,
  className,
}: SnapshotTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermContainerRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<TerminalScreenSnapshot | null>(null);
  const [viewMode, setViewMode] = useState<SnapshotViewMode>("live");
  const viewModeRef = useRef<SnapshotViewMode>("live");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasNewOutputWhileScrolled, setHasNewOutputWhileScrolled] = useState(false);
  const [scrollbackUnavailable, setScrollbackUnavailable] = useState(false);
  const snapshotRef = useRef<TerminalScreenSnapshot | null>(null);

  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const disposedRef = useRef(false);
  const writeInFlightRef = useRef(0);
  const disposeTimerRef = useRef<number | null>(null);
  const inFlightPollRef = useRef(false);
  const pushActiveRef = useRef(false);
  const renderInFlightRef = useRef(false);
  const pendingSnapshotRef = useRef<TerminalScreenSnapshot | null>(null);
  const lastLiveSequenceRef = useRef(0);
  const scrolledCheckTimerRef = useRef<number | null>(null);
  const suppressResumeRef = useRef(false); // Suppress resumeLive during enterScrolledMode

  const fontSize = useTerminalFontStore((s) => s.fontSize);
  const fontFamily = useTerminalFontStore((s) => s.fontFamily);
  const scrollbackLines = useScrollbackStore((s) => s.scrollbackLines);

  const style = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize,
      lineHeight: 1.1,
    }),
    [fontFamily, fontSize]
  );

  const scheduleDispose = useCallback((term: Terminal) => {
    if (disposeTimerRef.current !== null) {
      window.clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }

    const tick = () => {
      if (writeInFlightRef.current > 0 || renderInFlightRef.current) {
        disposeTimerRef.current = window.setTimeout(tick, 25);
        return;
      }
      disposeTimerRef.current = null;
      try {
        term.dispose();
      } catch {
        // ignore
      }
    };

    disposeTimerRef.current = window.setTimeout(tick, 0);
  }, []);

  const resumeLive = useCallback(() => {
    console.log("[SnapshotView:resumeLive] Called!", new Error().stack);
    setScrollbackUnavailable(false);
    setHasNewOutputWhileScrolled(false);
    setHistoryLoading(false);
    viewModeRef.current = "live";
    setViewMode("live");
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === "live") {
      if (scrolledCheckTimerRef.current !== null) {
        window.clearInterval(scrolledCheckTimerRef.current);
        scrolledCheckTimerRef.current = null;
      }
    }
  }, [viewMode]);

  const enterScrolledMode = useCallback(async () => {
    console.log("[SnapshotView:enterScrolledMode] Starting...", {
      currentViewMode: viewModeRef.current,
      buffer: snapshotRef.current?.buffer,
    });

    if (viewModeRef.current === "scrolled") {
      console.log("[SnapshotView:enterScrolledMode] Already in scrolled mode, returning");
      return;
    }
    const term = xtermRef.current;
    if (!term) {
      console.log("[SnapshotView:enterScrolledMode] No xterm instance, returning");
      return;
    }

    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot?.buffer === "alt") {
      console.log("[SnapshotView:enterScrolledMode] ALT buffer, showing unavailable");
      setScrollbackUnavailable(true);
      return;
    }

    setScrollbackUnavailable(false);
    setHasNewOutputWhileScrolled(false);
    setHistoryLoading(true);
    viewModeRef.current = "scrolled";
    setViewMode("scrolled");

    const desiredScrollback = Math.max(1000, Math.min(20000, Math.floor(scrollbackLines)));
    console.log("[SnapshotView:enterScrolledMode] Setting scrollback to", desiredScrollback);

    try {
      term.options.scrollback = desiredScrollback;
    } catch {
      // ignore
    }

    let state: string | null = null;
    const fetchStart = performance.now();
    try {
      state = await terminalClient.getSerializedState(terminalId);
    } catch (err) {
      console.error("[SnapshotView:enterScrolledMode] getSerializedState error:", err);
      state = null;
    }
    const fetchMs = performance.now() - fetchStart;

    console.log("[SnapshotView:enterScrolledMode] getSerializedState result:", {
      hasState: !!state,
      stateLength: state?.length ?? 0,
      fetchMs: Math.round(fetchMs),
    });

    if (disposedRef.current) return;
    if (viewModeRef.current !== "scrolled") return;

    if (!state) {
      console.log("[SnapshotView:enterScrolledMode] No state returned, showing unavailable");
      setHistoryLoading(false);
      // FIX: Set scrollbackUnavailable AFTER resumeLive so it doesn't get cleared
      resumeLive();
      // Use setTimeout to ensure this runs after resumeLive's state updates
      setTimeout(() => setScrollbackUnavailable(true), 0);
      return;
    }

    console.log("[SnapshotView:enterScrolledMode] Resetting terminal and writing state...");

    // Suppress resumeLive during terminal operations - xterm fires onData events
    // for internal escape sequences (focus reports, mode changes) which would
    // otherwise trigger resumeLive and reset us back to live mode.
    suppressResumeRef.current = true;

    try {
      term.reset();
    } catch (err) {
      console.error("[SnapshotView:enterScrolledMode] term.reset() failed:", err);
    }

    await new Promise<void>((resolve) => {
      try {
        writeInFlightRef.current += 1;
        term.write(state, () => {
          writeInFlightRef.current = Math.max(0, writeInFlightRef.current - 1);
          console.log("[SnapshotView:enterScrolledMode] term.write() callback fired");
          resolve();
        });
      } catch (err) {
        console.error("[SnapshotView:enterScrolledMode] term.write() failed:", err);
        writeInFlightRef.current = Math.max(0, writeInFlightRef.current - 1);
        resolve();
      }
    });

    // Re-enable resumeLive now that terminal operations are complete
    suppressResumeRef.current = false;

    console.log("[SnapshotView:enterScrolledMode] Write complete, setting up scroll position");

    // Scroll up significantly from bottom to make it visually obvious that
    // history is now available for scrolling. This provides immediate feedback
    // that scrolled mode is active.
    try {
      term.scrollToBottom();
      // Scroll up by ~half the viewport so user sees some history immediately
      const scrollUpLines = Math.max(5, Math.floor(term.rows / 2));
      term.scrollLines(-scrollUpLines);
    } catch (err) {
      console.error("[SnapshotView:enterScrolledMode] scroll positioning failed:", err);
    }

    console.log("[SnapshotView:enterScrolledMode] COMPLETE - viewMode should now be 'scrolled'");
    setHistoryLoading(false);

    if (scrolledCheckTimerRef.current !== null) {
      window.clearInterval(scrolledCheckTimerRef.current);
    }
    scrolledCheckTimerRef.current = window.setInterval(async () => {
      if (disposedRef.current) return;
      if (viewModeRef.current !== "scrolled") return;
      try {
        const latest = await terminalClient.getSnapshot(terminalId, { buffer: "auto" });
        if (!latest) return;
        if (latest.sequence > lastLiveSequenceRef.current) {
          lastLiveSequenceRef.current = latest.sequence;
          setHasNewOutputWhileScrolled(true);
        }
      } catch {
        // ignore
      }
    }, 1000);
  }, [resumeLive, scrollbackLines, terminalId]);

  useLayoutEffect(() => {
    console.log("[SnapshotView:useLayoutEffect] Terminal setup running - this resets the terminal!");
    disposedRef.current = false;
    const container = containerRef.current;
    const xtermContainer = xtermContainerRef.current;
    if (!container || !xtermContainer) return;

    const terminalTheme = getTerminalThemeFromCSS();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      fontSize,
      lineHeight: 1.1,
      letterSpacing: 0,
      fontFamily: fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontWeight: "normal",
      fontWeightBold: "700",
      theme: terminalTheme,
      scrollback: 0,
      macOptionIsMeta: true,
      scrollOnUserInput: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(xtermContainer);
    try {
      const rect = xtermContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fit.fit();
      }
    } catch {
      // ignore
    }

    xtermRef.current = term;
    fitAddonRef.current = fit;

    // Robust wheel event interception: attach to container with capture phase.
    // This intercepts the event BEFORE xterm.js can swallow it.
    const handleWheel = (event: WheelEvent) => {
      // Ignore horizontal scrolling
      if (event.deltaY === 0) return;

      const term = xtermRef.current;
      if (!term) return;

      // DIAGNOSTIC: Log wheel events to debug scroll issues
      console.log("[SnapshotView:wheel]", {
        viewMode: viewModeRef.current,
        buffer: snapshotRef.current?.buffer ?? "no-snapshot",
        deltaY: event.deltaY,
        target: (event.target as HTMLElement)?.className?.slice(0, 50),
      });

      // In scrolled mode: manually scroll xterm based on wheel delta
      if (viewModeRef.current === "scrolled") {
        event.preventDefault();
        event.stopPropagation();
        // Convert deltaY to lines (approximate - deltaY varies by browser/OS)
        // Typical wheel event deltaY is ~100 per notch, trackpad is smaller
        const deltaLines = event.deltaY > 0 ? Math.max(1, Math.ceil(event.deltaY / 40))
                                            : Math.min(-1, Math.floor(event.deltaY / 40));
        term.scrollLines(deltaLines);
        return;
      }

      // In full-screen (alt buffer), show feedback instead of silently doing nothing
      const currentSnapshot = snapshotRef.current;
      if (currentSnapshot?.buffer === "alt") {
        console.log("[SnapshotView:wheel] ALT buffer - showing unavailable notice");
        setScrollbackUnavailable(true);
        // Auto-clear after 3s so it doesn't persist forever
        setTimeout(() => setScrollbackUnavailable(false), 3000);
        return;
      }

      // In live mode: intercept and enter scrolled mode
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      void enterScrolledMode();
    };

    // Attach ONLY to the container div with capture: true, passive: false.
    // This ensures we intercept before xterm processes the event.
    container.addEventListener("wheel", handleWheel, { passive: false, capture: true });

    const onDataDisposable = term.onData((data) => {
      if (isInputLocked) return;
      // If user types while in scrolled mode, immediately return to live.
      // But suppress this during enterScrolledMode operations - xterm fires
      // onData for internal escape sequences (focus reports) which aren't user input.
      if (viewModeRef.current === "scrolled" && !suppressResumeRef.current) {
        console.log("[SnapshotView:onData] User input detected in scrolled mode, resuming live");
        resumeLive();
      }
      terminalClient.write(terminalId, data);
      terminalInstanceService.notifyUserInput(terminalId);
    });

    return () => {
      disposedRef.current = true;
      container.removeEventListener("wheel", handleWheel, true);
      onDataDisposable.dispose();
      pendingSnapshotRef.current = null;
      xtermRef.current = null;
      fitAddonRef.current = null;
      if (scrolledCheckTimerRef.current !== null) {
        window.clearInterval(scrolledCheckTimerRef.current);
        scrolledCheckTimerRef.current = null;
      }
      if (disposeTimerRef.current !== null) {
        window.clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = null;
      }
      scheduleDispose(term);
    };
  }, [
    enterScrolledMode,
    fontFamily,
    fontSize,
    isInputLocked,
    resumeLive,
    scheduleDispose,
    terminalId,
  ]);

  const pushTier = refreshMs <= 60 ? "focused" : "visible";

  useEffect(() => {
    if (viewMode !== "live") return;
    if (!isVisible || refreshMs <= 0) return;
    const unsubscribe = terminalClient.subscribeScreenSnapshot(terminalId, pushTier, (next) => {
      if (!next) return;
      lastLiveSequenceRef.current = Math.max(lastLiveSequenceRef.current, next.sequence);
      setSnapshot((prev) => (prev?.sequence === next.sequence ? prev : next));
    });
    if (!unsubscribe) {
      pushActiveRef.current = false;
      return;
    }

    pushActiveRef.current = true;
    terminalClient.updateScreenSnapshotTier(terminalId, pushTier);

    return () => {
      pushActiveRef.current = false;
      unsubscribe();
    };
  }, [isVisible, refreshMs, pushTier, terminalId, viewMode]);

  const poll = useCallback(async () => {
    if (viewMode !== "live") return;
    if (!isVisible || refreshMs <= 0) return;
    if (pushActiveRef.current) return;
    if (inFlightPollRef.current) return;

    inFlightPollRef.current = true;
    try {
      const next = await terminalClient.getSnapshot(terminalId, { buffer: "auto" });
      if (next) {
        lastLiveSequenceRef.current = Math.max(lastLiveSequenceRef.current, next.sequence);
        setSnapshot((prev) => (prev?.sequence === next.sequence ? prev : next));
      }
    } finally {
      inFlightPollRef.current = false;
    }
  }, [isVisible, refreshMs, terminalId, viewMode]);

  useEffect(() => {
    if (viewMode !== "live") return;
    if (!isVisible || refreshMs <= 0) return;
    if (pushActiveRef.current) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await poll();
      if (cancelled) return;
      window.setTimeout(tick, refreshMs);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [isVisible, refreshMs, poll]);

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
          const cols = term.cols;
          const rows = term.rows;
          terminalClient.resize(terminalId, cols, rows);
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
  }, [isFocused, isVisible, terminalId, fontFamily, fontSize]);

  const renderSnapshot = useCallback(async () => {
    if (viewMode !== "live") return;
    if (!snapshot) return;

    pendingSnapshotRef.current = snapshot;
    if (renderInFlightRef.current) return;

    renderInFlightRef.current = true;
    try {
      while (pendingSnapshotRef.current) {
        if (disposedRef.current) return;
        const term = xtermRef.current;
        if (!term) return;

        const next = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;

        if (term.cols !== next.cols || term.rows !== next.rows) {
          try {
            term.resize(next.cols, next.rows);
          } catch {
            // ignore
          }
        }

        const payload =
          next.ansi ??
          // Ensure a full-frame snapshot even if ANSI serialization is unavailable.
          `\x1b[0m\x1b[2J\x1b[H${next.lines.join("\n")}`;
        await new Promise<void>((resolve) => {
          try {
            writeInFlightRef.current += 1;
            term.write(payload, () => {
              writeInFlightRef.current = Math.max(0, writeInFlightRef.current - 1);
              resolve();
            });
          } catch {
            writeInFlightRef.current = Math.max(0, writeInFlightRef.current - 1);
            resolve();
          }
        });
      }
    } finally {
      renderInFlightRef.current = false;
    }
  }, [snapshot]);

  useEffect(() => {
    void renderSnapshot();
  }, [renderSnapshot]);

  useEffect(() => {
    if (forceLiveKey <= 0) return;
    if (viewModeRef.current !== "scrolled") return;
    resumeLive();
  }, [forceLiveKey, resumeLive]);

  useEffect(() => {
    if (!isFocused) return;
    // Focus after mount/tier updates so typing works immediately.
    requestAnimationFrame(() => xtermRef.current?.focus());
  }, [isFocused]);

  useEffect(() => {
    if (viewMode !== "live") return;
    const term = xtermRef.current;
    if (!term) return;
    try {
      term.options.scrollback = 0;
    } catch {
      // ignore
    }
    try {
      term.reset();
    } catch {
      // ignore
    }
    void (async () => {
      try {
        const next = await terminalClient.getSnapshot(terminalId, { buffer: "auto" });
        if (next) setSnapshot(next);
      } catch {
        // ignore
      }
    })();
  }, [terminalId, viewMode]);

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 overflow-hidden bg-canopy-bg py-2 px-3", className)}
      style={style}
      onPointerDownCapture={() => {
        if (isFocused) {
          xtermRef.current?.focus();
        }
      }}
      aria-label="Terminal snapshot view"
    >
      {/* Inner container for xterm - sized after padding so FitAddon calculates correctly */}
      <div ref={xtermContainerRef} className="h-full w-full" />

      {/* Loading overlay while fetching history - pointer-events-none so scrolling can pass through */}
      {historyLoading && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm pointer-events-none">
          <Loader2 className="w-6 h-6 text-white/60 animate-spin mb-2" />
          <div className="text-xs font-medium text-white/70">Loading history…</div>
        </div>
      )}

      {/* Scrolled mode control bar */}
      {viewMode === "scrolled" && (
        <div className="absolute bottom-0 left-0 right-0 z-30 px-4 py-3 bg-black/80 backdrop-blur-md border-t border-white/10 flex items-center justify-between">
          <div className="text-xs font-sans text-white/70 flex items-center gap-2">
            {historyLoading ? (
              "Loading scrollback…"
            ) : hasNewOutputWhileScrolled ? (
              <span className="text-amber-400">Paused (new output available)</span>
            ) : (
              "Paused for scrolling"
            )}
          </div>
          <button
            type="button"
            onClick={() => resumeLive()}
            className="bg-canopy-primary text-canopy-primary-fg px-3 py-1.5 rounded-md text-xs font-medium hover:bg-canopy-primary/90 transition-colors"
          >
            Resume live
          </button>
        </div>
      )}

      {/* Alt buffer scrollback unavailable notice */}
      {scrollbackUnavailable && viewMode === "live" && (
        <div className="absolute bottom-4 left-4 right-4 z-30 px-4 py-3 bg-black/80 backdrop-blur-sm border border-white/10 rounded-md text-xs font-sans text-white/70">
          Scrollback isn't available while the terminal is in full-screen mode.
        </div>
      )}

      {/* Alt buffer indicator */}
      {snapshot && snapshot.buffer === "alt" && (
        <div className="absolute top-2 right-2 text-[10px] font-sans text-canopy-text/50 bg-black/30 px-2 py-1 rounded pointer-events-none">
          ALT
        </div>
      )}
    </div>
  );
}
