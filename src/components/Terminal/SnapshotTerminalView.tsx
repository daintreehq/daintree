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

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminalTheme = getTerminalThemeFromCSS();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
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
    fit.fit();

    xtermRef.current = term;
    fitAddonRef.current = fit;

    const onDataDisposable = term.onData((data) => {
      if (isInputLocked) return;
      terminalClient.write(terminalId, data);
      terminalInstanceService.notifyUserInput(terminalId);
    });

    return () => {
      onDataDisposable.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      try {
        term.dispose();
      } catch {
        // ignore
      }
    };
  }, [fontFamily, fontSize, isInputLocked, terminalId]);

  const pushTier = refreshMs <= 60 ? "focused" : "visible";

  useEffect(() => {
    if (!isVisible || refreshMs <= 0) return;
    const unsubscribe = terminalClient.subscribeScreenSnapshot(terminalId, pushTier, (next) => {
      setSnapshot(next);
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
      if (next) setSnapshot(next);
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
        const term = xtermRef.current;
        const fit = fitAddonRef.current;
        if (!term || !fit) return;

        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        terminalClient.resize(terminalId, cols, rows);
      });
    });

    observer.observe(container);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [isFocused, isVisible, terminalId, fontFamily, fontSize]);

  const renderSnapshot = useCallback(async () => {
    const term = xtermRef.current;
    if (!term) return;
    if (!snapshot) return;

    pendingSnapshotRef.current = snapshot;
    if (renderInFlightRef.current) return;

    renderInFlightRef.current = true;
    try {
      while (pendingSnapshotRef.current) {
        const next = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;

        if (term.cols !== next.cols || term.rows !== next.rows) {
          try {
            term.resize(next.cols, next.rows);
          } catch {
            // ignore
          }
        }

        term.reset();
        const payload = next.ansi ?? next.lines.join("\n");
        await new Promise<void>((resolve) => {
          term.write(payload, () => resolve());
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
