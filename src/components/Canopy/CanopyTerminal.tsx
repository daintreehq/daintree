import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { CanopyTerminalData, CanopyTerminalView } from "@shared/types/ipc/canopy";
import { isSecretPrompt } from "@shared/utils/secretPrompt";
import { isTerminalSubmission } from "@shared/utils/terminalSubmission";
import { getEffectiveScrollbarWidth, getXtermOptions } from "@/config/xtermConfig";
import { getXtermCellDimensions } from "@/services/terminal/TerminalResizeController";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import {
  selectEffectiveTheme,
  selectWrapperBackground,
  useTerminalColorSchemeStore,
} from "@/store/terminalColorSchemeStore";
import { streamRangeOf, stripCoveredOutput } from "@/services/terminal/streamFence";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const SCROLLBACK = 2_000;
/** The smallest grid worth handing an agent; a smaller measure is a pane mid-layout. */
const MIN_COLS = 20;
const MIN_ROWS = 5;
const SIZE_SETTLE_MS = 120;
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
export interface CanopyStreamState {
  /** The open stream input goes through; null until it opens, or once it ends. */
  watchId: number | null;
  ended: boolean;
  /** The live screen's cursor sits on a secret prompt (`Password:`). */
  secretPrompt: boolean;
}

interface CanopyTerminalProps {
  runId: string;
  spawnedAt: number;
  onStreamChange?: (state: CanopyStreamState) => void;
  /** Return was typed straight into the terminal and the run took it. */
  onSubmitted?: () => void;
  /** Go to the run's own pane: the way to see a screen this view couldn't show. */
  onGoTo?: () => void;
}

/**
 * A live view of one agent's terminal, from any project: its own xterm on the
 * WebGL renderer, fed by the stream main brokers for the canopy panel.
 *
 * Sized to the panel, at the user's own font size: once the stream is open the
 * PTY is held at the grid this pane fits, so the agent draws for the space it
 * is read in, and main hands it back to its own pane's size when the stream
 * ends. Until then — and if that pane resizes it meanwhile — the grid follows
 * the PTY's geometry: the bottom rows, where an agent asks, stay in view, and
 * a grid wider than the pane scrolls sideways. While the stream is open the
 * terminal's own pane in this view is frozen, so it doesn't take the PTY back.
 *
 * Only what the user does here reaches the terminal. xterm also answers the
 * program's own queries (cursor position, device attributes) through the same
 * event, and the terminal's own pane already answers those; a second answer
 * would corrupt the program's input. So input is taken only inside a user
 * gesture, and only through the open stream, which main refuses once the
 * terminal it was opened for has gone.
 */
export function CanopyTerminal({
  runId,
  spawnedAt,
  onStreamChange,
  onSubmitted,
  onGoTo,
}: CanopyTerminalProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onStreamChangeRef = useRef(onStreamChange);
  const onSubmittedRef = useRef(onSubmitted);
  useEffect(() => {
    onStreamChangeRef.current = onStreamChange;
    onSubmittedRef.current = onSubmitted;
  });
  // The grid's own resolved setting, so a screen reader meets this terminal
  // exactly as it meets the same terminal in its pane.
  const screenReaderEnabled = useScreenReaderStore((s) => s.resolvedScreenReaderEnabled());
  const [status, setStatus] = useState<"opening" | "live" | "failed" | "ended">("opening");
  // A full-screen TUI runs on the alternate buffer: like a grid pane, the view
  // then drops its inset and hides the scrollbar that buffer has no use for.
  const [altBuffer, setAltBuffer] = useState(false);
  // The grid is taller than the pane.
  const [overflowing, setOverflowing] = useState(false);
  // The terminal's own canvas colour, so the frame reads as the terminal itself.
  const background = useTerminalColorSchemeStore(selectWrapperBackground);

  useEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    setStatus("opening");
    let disposed = false;
    const stream: CanopyStreamState = { watchId: null, ended: false, secretPrompt: false };
    const publish = (next: Partial<CanopyStreamState>) => {
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
        screenReaderMode: useScreenReaderStore.getState().resolvedScreenReaderEnabled(),
      }),
      cols: 80,
      rows: 24,
      cursorBlink: false,
    });
    terminal.open(host);
    terminalRef.current = terminal;

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
          logWarn("[Canopy] WebGL renderer unavailable; using the DOM renderer", { error });
        }
      },
      (error: unknown) => logWarn("[Canopy] couldn't load the WebGL renderer", { error })
    );

    let inset = FRAME_PADDING_PX;
    const bufferChange = terminal.buffer.onBufferChange((buffer) => {
      const alternate = buffer.type === "alternate";
      inset = alternate ? 0 : FRAME_PADDING_PX;
      setAltBuffer(alternate);
      // The inset just changed, so the grid the pane fits did too.
      requestPanelSize();
    });

    // The grid this pane fits at the current font, once the stream is open;
    // main holds the PTY at it. Settled briefly, so a dialog animating open or
    // a window drag sends one size rather than every frame's.
    // The PTY's own geometry, as the snapshot and its resize echoes report it.
    let ptySize: { cols: number; rows: number } | null = null;
    let sizeTimer: ReturnType<typeof setTimeout> | null = null;
    const requestPanelSize = () => {
      if (sizeTimer !== null) clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        sizeTimer = null;
        const watchId = stream.watchId;
        const cell = getXtermCellDimensions(terminal);
        if (disposed || watchId === null || cell === null) return;
        // Fractional bounds, truncated, as the grid pane measures them: a
        // rounded-up clientWidth can promise a column the pane hasn't got.
        const box = frame.getBoundingClientRect();
        const scrollbar = inset === 0 ? 0 : getEffectiveScrollbarWidth(terminal.options);
        const cols = Math.floor(Math.floor(box.width - inset - scrollbar) / cell.width);
        const rows = Math.floor(Math.floor(box.height - inset) / cell.height);
        if (cols < MIN_COLS || rows < MIN_ROWS) return;
        // Against what the PTY holds, not what xterm was last told: a hold the
        // terminal's own pane has since overridden is asked for again.
        if (ptySize !== null && cols === ptySize.cols && rows === ptySize.rows) return;
        // Ahead of the PTY's echo, so output drawn for the new size lands on it.
        terminal.resize(cols, rows);
        window.electron.canopy.terminalResize(watchId, cols, rows).catch((error: unknown) => {
          logWarn("[Canopy] couldn't size the terminal", { error });
          // Refused, so no echo is coming: back to the grid the PTY really has.
          if (!disposed && ptySize !== null) terminal.resize(ptySize.cols, ptySize.rows);
        });
      }, SIZE_SETTLE_MS);
    };
    // The cell size moves with the renderer (WebGL arriving or lost, a display
    // change) and with the user's font; either changes the grid the pane fits.
    const dimensionsChange = terminal.onDimensionsChange(() => requestPanelSize());
    const unsubscribeFont = useTerminalFontStore.subscribe((font, previous) => {
      if (font.fontSize === previous.fontSize && font.fontFamily === previous.fontFamily) return;
      terminal.options.fontSize = font.fontSize;
      terminal.options.fontFamily = font.fontFamily;
      requestPanelSize();
    });

    // A grid that fits sits at the top of the pane, the way it does in the
    // terminal's own pane; one taller than the pane keeps its bottom rows,
    // where an agent asks, in view.
    const fit = () => {
      requestPanelSize();
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || frame.clientHeight <= 0) return;
      const { height } = screen.getBoundingClientRect();
      if (height <= 0) return;
      setOverflowing(height > frame.clientHeight - inset + 1);
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

    let view: CanopyTerminalView | null = null;
    let releasePane: (() => void) | null = null;
    let fence: number | undefined;
    const early: CanopyTerminalData[] = [];
    const apply = (chunk: CanopyTerminalData) => {
      if (view === null || chunk.watchId !== view.watchId) return;
      if (chunk.kind === "resize") {
        ptySize = { cols: chunk.cols, rows: chunk.rows };
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
    const offData = window.electron.canopy.onTerminalData((chunk) => {
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
    // A sideways gesture over a grid wider than the pane scrolls the pane. xterm
    // swallows every wheel event while the program reports the mouse — and would
    // pass a diagonal one on as vertical wheel input — so it is taken first.
    const sideways = (event: WheelEvent) => {
      if (frame.scrollWidth <= frame.clientWidth) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      frame.scrollLeft += event.deltaX;
    };
    frame.addEventListener("wheel", sideways, { capture: true, passive: false });
    const input = terminal.onData((data) => {
      const watchId = stream.watchId;
      if (!gesture || watchId === null) return;
      window.electron.canopy.terminalInput(watchId, data).then(
        () => {
          if (isTerminalSubmission(data)) onSubmittedRef.current?.();
        },
        (error: unknown) => logWarn("[Canopy] input refused", { error })
      );
    });

    window.electron.canopy.watchTerminal(runId, { spawnedAt }).then(
      (opened) => {
        if (disposed) return;
        if (opened.watchId === null || opened.snapshot === null) {
          setStatus("failed");
          return;
        }
        view = opened;
        releasePane = terminalInstanceService.holdGeometry(runId);
        const snapshot = opened.snapshot;
        ptySize = { cols: snapshot.cols, rows: snapshot.rows };
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
        requestPanelSize();
      },
      (error: unknown) => {
        if (disposed) return;
        logWarn("[Canopy] couldn't open the terminal stream", { error });
        setStatus("failed");
      }
    );

    return () => {
      disposed = true;
      offData();
      input.dispose();
      bufferChange.dispose();
      dimensionsChange.dispose();
      unsubscribeFont();
      for (const type of GESTURE_EVENTS) frame.removeEventListener(type, markGesture, true);
      frame.removeEventListener("wheel", sideways, true);
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      resizeObserver.disconnect();
      if (sizeTimer !== null) clearTimeout(sizeTimer);
      webgl?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      onStreamChangeRef.current?.({ watchId: null, ended: false, secretPrompt: false });
      // The pane re-measures only once main has handed the PTY back, so a size
      // it took meanwhile lands after the one main restores, not before it.
      const release = releasePane;
      safeFireAndForget(
        window.electron.canopy.unwatchTerminal().finally(() => release?.()),
        { context: "Ending the canopy terminal stream" }
      );
    };
  }, [runId, spawnedAt]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.screenReaderMode = screenReaderEnabled;
  }, [screenReaderEnabled]);

  return (
    <div
      ref={frameRef}
      data-canopy-terminal=""
      data-keybindings-isolated=""
      style={{ background }}
      // A grid pane's terminal body: the terminal's own background, inset p-3
      // on the normal buffer and flush on the alternate one.
      className={cn(
        // Clipped at the top when too tall (the bottom is what matters), and
        // scrollable sideways when too wide (a cut-off line would lose words).
        "relative flex min-h-0 flex-1 flex-col items-start overflow-x-auto overflow-y-hidden",
        overflowing ? "justify-end" : "justify-start",
        altBuffer ? "terminal-alt-buffer" : "p-3"
      )}
    >
      {/* The pane's full width at least, so xterm's scrollbar sits at the pane's
          edge, in the gutter the grid was measured to leave, not over the last
          column; wider when the PTY is, and the frame scrolls. */}
      <div ref={hostRef} className="min-w-full shrink-0" />
      {(status === "failed" || status === "ended") && (
        <div
          role="status"
          className="absolute inset-x-0 top-3 flex flex-col items-center gap-2 text-center text-xs text-text-secondary"
        >
          {status === "ended" ? (
            <p>This terminal has exited. Archive it, or trash it to clear it away.</p>
          ) : (
            <>
              <p>Couldn't show this terminal here</p>
              {onGoTo && (
                <Button variant="outline" size="xs" onClick={onGoTo}>
                  Go to terminal
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
