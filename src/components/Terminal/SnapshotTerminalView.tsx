import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import type { TerminalScreenSnapshot } from "@/types";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getTerminalThemeFromCSS } from "./XtermAdapter";

export interface SnapshotTerminalViewProps {
  terminalId: string;
  isFocused: boolean;
  isVisible: boolean;
  refreshMs: number;
  isInputLocked?: boolean;
  className?: string;
}

export function SnapshotTerminalView({
  terminalId,
  isFocused,
  isVisible,
  refreshMs,
  isInputLocked,
  className,
}: SnapshotTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<TerminalScreenSnapshot | null>(null);

  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const disposedRef = useRef(false);
  const writeInFlightRef = useRef(0);
  const disposeTimerRef = useRef<number | null>(null);
  const inFlightPollRef = useRef(false);
  const pushActiveRef = useRef(false);
  const renderInFlightRef = useRef(false);
  const pendingSnapshotRef = useRef<TerminalScreenSnapshot | null>(null);

  const fontSize = useTerminalFontStore((s) => s.fontSize);
  const fontFamily = useTerminalFontStore((s) => s.fontFamily);

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

  useLayoutEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

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
    term.open(container);
    try {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fit.fit();
      }
    } catch {
      // ignore
    }

    xtermRef.current = term;
    fitAddonRef.current = fit;

    const onDataDisposable = term.onData((data) => {
      if (isInputLocked) return;
      terminalClient.write(terminalId, data);
      terminalInstanceService.notifyUserInput(terminalId);
    });

    return () => {
      disposedRef.current = true;
      onDataDisposable.dispose();
      pendingSnapshotRef.current = null;
      xtermRef.current = null;
      fitAddonRef.current = null;
      if (disposeTimerRef.current !== null) {
        window.clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = null;
      }
      scheduleDispose(term);
    };
  }, [fontFamily, fontSize, isInputLocked, scheduleDispose, terminalId]);

  const pushTier = refreshMs <= 60 ? "focused" : "visible";

  useEffect(() => {
    if (!isVisible || refreshMs <= 0) return;
    const unsubscribe = terminalClient.subscribeScreenSnapshot(terminalId, pushTier, (next) => {
      if (!next) return;
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
  }, [isVisible, refreshMs, pushTier, terminalId]);

  const poll = useCallback(async () => {
    if (!isVisible || refreshMs <= 0) return;
    if (pushActiveRef.current) return;
    if (inFlightPollRef.current) return;

    inFlightPollRef.current = true;
    try {
      const next = await terminalClient.getSnapshot(terminalId, { buffer: "auto" });
      if (next) {
        setSnapshot((prev) => (prev?.sequence === next.sequence ? prev : next));
      }
    } finally {
      inFlightPollRef.current = false;
    }
  }, [isVisible, refreshMs, terminalId]);

  useEffect(() => {
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
    const container = containerRef.current;
    if (!container) return;
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
          const rect = container.getBoundingClientRect();
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

    observer.observe(container);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [isFocused, isVisible, terminalId, fontFamily, fontSize]);

  const renderSnapshot = useCallback(async () => {
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
    if (!isFocused) return;
    // Focus after mount/tier updates so typing works immediately.
    requestAnimationFrame(() => xtermRef.current?.focus());
  }, [isFocused]);

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 overflow-hidden bg-canopy-bg", className)}
      style={style}
      onPointerDownCapture={() => {
        if (isFocused) {
          xtermRef.current?.focus();
        }
      }}
      aria-label="Terminal snapshot view"
    >
      {snapshot && snapshot.buffer === "alt" && (
        <div className="absolute top-2 right-2 text-[10px] font-sans text-canopy-text/50 bg-black/20 px-2 py-1 rounded">
          ALT
        </div>
      )}
    </div>
  );
}
