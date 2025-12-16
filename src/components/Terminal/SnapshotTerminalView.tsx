import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { terminalClient } from "@/clients";
import type { TerminalScreenSnapshot } from "@/types";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

export interface SnapshotTerminalViewProps {
  terminalId: string;
  isFocused: boolean;
  isVisible: boolean;
  refreshMs: number;
  isInputLocked?: boolean;
  className?: string;
}

function toControlChar(key: string): string | null {
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code < 65 || code > 90) return null;
  return String.fromCharCode(code - 64);
}

function mapKeyEventToSequence(event: React.KeyboardEvent): string | null {
  if (event.metaKey) {
    return null;
  }

  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    const control = toControlChar(event.key);
    if (control) return control;
  }

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    default:
      break;
  }

  if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
    return event.key;
  }

  return null;
}

function measureCell(container: HTMLElement): { cellWidth: number; cellHeight: number } | null {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.textContent = "MMMMMMMMMM";
  container.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  container.removeChild(probe);
  const cellWidth = rect.width / 10;
  const cellHeight = rect.height;
  if (
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) {
    return null;
  }
  return { cellWidth, cellHeight };
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
  const inFlightRef = useRef(false);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pushActiveRef = useRef(false);

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

  const poll = useCallback(async () => {
    if (!isVisible || refreshMs <= 0) return;
    if (pushActiveRef.current) return;
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    try {
      const next = await terminalClient.getSnapshot(terminalId, { buffer: "auto" });
      if (next) setSnapshot(next);
    } finally {
      inFlightRef.current = false;
    }
  }, [isVisible, refreshMs, terminalId]);

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
        const current = containerRef.current;
        if (!current) return;
        const metrics = measureCell(current);
        if (!metrics) return;

        const cols = Math.max(1, Math.floor(current.clientWidth / metrics.cellWidth));
        const rows = Math.max(1, Math.floor(current.clientHeight / metrics.cellHeight));

        const prev = lastResizeRef.current;
        if (prev && prev.cols === cols && prev.rows === rows) {
          return;
        }
        lastResizeRef.current = { cols, rows };
        terminalClient.resize(terminalId, cols, rows);
      });
    });

    observer.observe(container);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [isFocused, isVisible, terminalId, fontFamily, fontSize]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isInputLocked) {
        return;
      }

      const seq = mapKeyEventToSequence(event);
      if (!seq) return;

      event.preventDefault();
      event.stopPropagation();

      terminalClient.write(terminalId, seq);
      terminalInstanceService.notifyUserInput(terminalId);
    },
    [isInputLocked, terminalId]
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 overflow-hidden bg-canopy-bg text-canopy-text",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        className
      )}
      style={style}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDownCapture={() => {
        // Make the snapshot pane keyboard-active on click.
        containerRef.current?.focus();
      }}
      aria-label="Terminal snapshot view"
    >
      <pre className="m-0 p-3 whitespace-pre select-text">{(snapshot?.lines ?? []).join("\n")}</pre>
      {snapshot && snapshot.buffer === "alt" && (
        <div className="absolute top-2 right-2 text-[10px] font-sans text-canopy-text/50 bg-black/20 px-2 py-1 rounded">
          ALT
        </div>
      )}
    </div>
  );
}
