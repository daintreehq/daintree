import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { TriageTerminalData, TriageTerminalView } from "@shared/types/ipc/triage";
import { isSecretPrompt } from "@shared/utils/secretPrompt";
import { getXtermOptions } from "@/config/xtermConfig";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import {
  selectEffectiveTheme,
  selectWrapperBackground,
  useTerminalColorSchemeStore,
} from "@/store/terminalColorSchemeStore";
import { streamRangeOf, stripCoveredOutput } from "@/services/terminal/streamFence";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/** The smallest the viewer shrinks its font to make a wide PTY fit. */
const MIN_FONT_SIZE = 8;
const SCROLLBACK = 2_000;
/** The frame's padding — a grid pane's xterm inset — which the grid cannot use. */
const FRAME_PADDING_PX = 24;
/** DOM events in which xterm turns what the user did into terminal input. */
const GESTURE_EVENTS = [
  "keydown",
  "keypress",
  "beforeinput",
  "input",
  "compositionend",
  "paste",
  "mousedown",
  "mouseup",
  "wheel",
] as const;

/** Where the live view's stream stands, for the controls around it. */
export interface TriageStreamState {
  /** The open stream input goes through; null until it opens, or once it ends. */
  watchId: number | null;
  ended: boolean;
  /** The live screen's cursor sits on a secret prompt (`Password:`). */
  secretPrompt: boolean;
}

interface TriageTerminalProps {
  runId: string;
  spawnedAt: number;
  onStreamChange?: (state: TriageStreamState) => void;
}

/**
 * A live view of one agent's terminal, from any project: its own xterm on the
 * WebGL renderer, fed by the stream main brokers for the triage panel.
 *
 * Never resizes the PTY — the terminal belongs to its pane, and a second size
 * would reflow it there. The grid follows the PTY's own geometry and the font
 * shrinks until it fits; the bottom rows, where an agent asks, stay in view.
 *
 * Only what the user does here reaches the terminal. xterm also answers the
 * program's own queries (cursor position, device attributes) through the same
 * event, and the terminal's own pane already answers those; a second answer
 * would corrupt the program's input. So input is taken only inside a user
 * gesture, and only through the open stream, which main refuses once the
 * terminal it was opened for has gone.
 */
export function TriageTerminal({ runId, spawnedAt, onStreamChange }: TriageTerminalProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onStreamChangeRef = useRef(onStreamChange);
  useEffect(() => {
    onStreamChangeRef.current = onStreamChange;
  });
  const [status, setStatus] = useState<"opening" | "live" | "failed" | "ended">("opening");
  // A full-screen TUI runs on the alternate buffer: like a grid pane, the view
  // then drops its inset and hides the scrollbar that buffer has no use for.
  const [altBuffer, setAltBuffer] = useState(false);
  // The terminal's own canvas colour, so the frame reads as the terminal itself.
  const background = useTerminalColorSchemeStore(selectWrapperBackground);

  useEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    setStatus("opening");
    let disposed = false;
    const stream: TriageStreamState = { watchId: null, ended: false, secretPrompt: false };
    const publish = (next: Partial<TriageStreamState>) => {
      Object.assign(stream, next);
      onStreamChangeRef.current?.({ ...stream });
    };

    const { fontSize, fontFamily } = useTerminalFontStore.getState();
    const theme = selectEffectiveTheme(useTerminalColorSchemeStore.getState());
    const terminal = new Terminal({
      ...getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: SCROLLBACK,
        theme,
        performanceMode: false,
      }),
      cols: 80,
      rows: 24,
      cursorBlink: false,
    });
    terminal.open(host);

    let webgl: WebglAddon | undefined;
    void import("@xterm/addon-webgl").then(
      ({ WebglAddon: Addon }) => {
        if (disposed) return;
        try {
          const addon = new Addon();
          // A lost context falls back to xterm's DOM renderer rather than a blank pane.
          addon.onContextLoss(() => {
            addon.dispose();
            if (webgl === addon) webgl = undefined;
          });
          terminal.loadAddon(addon);
          webgl = addon;
        } catch (error) {
          logWarn("[Triage] WebGL renderer unavailable; using the DOM renderer", { error });
        }
      },
      (error: unknown) => logWarn("[Triage] couldn't load the WebGL renderer", { error })
    );

    let inset = FRAME_PADDING_PX;
    const bufferChange = terminal.buffer.onBufferChange((buffer) => {
      const alternate = buffer.type === "alternate";
      inset = alternate ? 0 : FRAME_PADDING_PX;
      setAltBuffer(alternate);
    });

    // Shrink the font, never the grid, until the PTY's width fits the frame.
    const fit = () => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const available = frame.clientWidth - inset;
      if (!screen || available <= 0) return;
      const current = terminal.options.fontSize ?? fontSize;
      const width = screen.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = Math.max(
        MIN_FONT_SIZE,
        Math.min(fontSize, Math.floor(((current * available) / width) * 2) / 2)
      );
      if (next !== current) terminal.options.fontSize = next;
    };
    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(frame);

    // Whether the cursor line asks for a secret, so the composer — which keeps
    // history — is never offered for one.
    const checkSecret = () => {
      if (disposed) return;
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
      const secret = isSecretPrompt(line);
      if (secret !== stream.secretPrompt) publish({ secretPrompt: secret });
    };

    let view: TriageTerminalView | null = null;
    let fence: number | undefined;
    const early: TriageTerminalData[] = [];
    const apply = (chunk: TriageTerminalData) => {
      if (view === null || chunk.watchId !== view.watchId) return;
      if (chunk.kind === "resize") {
        terminal.resize(chunk.cols, chunk.rows);
        requestAnimationFrame(() => {
          if (!disposed) fit();
        });
        return;
      }
      if (chunk.kind === "ended") {
        publish({ watchId: null, ended: true });
        setStatus("ended");
        return;
      }
      const paint = stripCoveredOutput(
        fence,
        chunk.data,
        streamRangeOf(chunk.data, chunk.streamEnd)
      );
      // All of it already in the snapshot.
      if (paint.length === 0) return;
      terminal.write(paint, checkSecret);
    };
    const offData = window.electron.triage.onTerminalData((chunk) => {
      if (chunk.runId !== runId) return;
      // The stream can start before the call that opened it returns.
      if (view === null) early.push(chunk);
      else apply(chunk);
    });

    let gesture = false;
    let gestureTimer: ReturnType<typeof setTimeout> | null = null;
    const markGesture = () => {
      gesture = true;
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      // xterm turns the event into input synchronously, within its own handler.
      gestureTimer = setTimeout(() => {
        gesture = false;
        gestureTimer = null;
      }, 0);
    };
    for (const type of GESTURE_EVENTS) frame.addEventListener(type, markGesture, true);
    const input = terminal.onData((data) => {
      const watchId = stream.watchId;
      if (!gesture || watchId === null) return;
      window.electron.triage.terminalInput(watchId, data).catch((error: unknown) => {
        logWarn("[Triage] input refused", { error });
      });
    });

    window.electron.triage.watchTerminal(runId, { spawnedAt }).then(
      (opened) => {
        if (disposed) return;
        if (opened.watchId === null || opened.snapshot === null) {
          setStatus("failed");
          return;
        }
        view = opened;
        const snapshot = opened.snapshot;
        terminal.resize(snapshot.cols, snapshot.rows);
        const continuation = snapshot.continuation;
        fence = continuation?.streamOffset;
        // The escape sequence the host's parser was inside, so the chunks
        // after the fence land in the same parser state they were written in.
        const tail = fence !== undefined ? (continuation?.pendingEscapeTail ?? "") : "";
        terminal.write(snapshot.data + tail, checkSecret);
        requestAnimationFrame(() => {
          if (!disposed) fit();
        });
        // Without a fence nothing says which early chunks the snapshot already
        // holds; painting them could draw output twice, so they are dropped and
        // the next redraw brings the screen up to date.
        const queued = early.splice(0);
        if (fence !== undefined) {
          for (const chunk of queued) apply(chunk);
        } else {
          for (const chunk of queued) if (chunk.kind !== "data") apply(chunk);
        }
        if (stream.ended) return;
        publish({ watchId: opened.watchId });
        setStatus("live");
      },
      (error: unknown) => {
        if (disposed) return;
        logWarn("[Triage] couldn't open the terminal stream", { error });
        setStatus("failed");
      }
    );

    return () => {
      disposed = true;
      offData();
      input.dispose();
      bufferChange.dispose();
      for (const type of GESTURE_EVENTS) frame.removeEventListener(type, markGesture, true);
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      resizeObserver.disconnect();
      webgl?.dispose();
      terminal.dispose();
      onStreamChangeRef.current?.({ watchId: null, ended: false, secretPrompt: false });
      safeFireAndForget(window.electron.triage.unwatchTerminal(), {
        context: "Ending the triage terminal stream",
      });
    };
  }, [runId, spawnedAt]);

  return (
    <div
      ref={frameRef}
      data-triage-terminal=""
      data-keybindings-isolated=""
      style={{ background }}
      // A grid pane's terminal body: the terminal's own background, inset p-3
      // on the normal buffer and flush on the alternate one.
      className={cn(
        "relative flex min-h-0 flex-1 flex-col justify-end overflow-hidden",
        altBuffer ? "terminal-alt-buffer" : "p-3"
      )}
    >
      <div ref={hostRef} className="min-w-0 shrink-0" />
      {(status === "failed" || status === "ended") && (
        <p className="absolute inset-x-0 top-3 text-center text-xs text-text-secondary">
          {status === "ended"
            ? "This terminal has exited."
            : "Couldn't show this terminal. Go to it to see its screen."}
        </p>
      )}
    </div>
  );
}
