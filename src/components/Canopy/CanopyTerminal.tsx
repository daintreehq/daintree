import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/copyWithToast";
import { Button } from "@/components/ui/button";
import { Terminal, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { SearchAddon } from "@xterm/addon-search";
import type { CanopyTerminalData, CanopyTerminalView } from "@shared/types/ipc/canopy";
import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "@shared/types/remoteHosts";
import { isPtyPanel } from "@shared/types/panel";
import { isSecretPrompt } from "@shared/utils/secretPrompt";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";
import { isTerminalSubmission } from "@shared/utils/terminalSubmission";
import { getEffectiveScrollbarWidth, getXtermOptions } from "@/config/xtermConfig";
import { keybindingService } from "@/services/KeybindingService";
import { getXtermCellDimensions } from "@/services/terminal/TerminalResizeController";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import {
  activateUnicode11,
  createImageAddon,
  createSearchAddon,
} from "@/services/terminal/TerminalAddonManager";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";
import { cleanTerminalSelection } from "@/services/terminal/cleanTerminalCopy";
import { copyCleanSelection } from "@/services/terminal/copyCleanSelection";
import { TerminalLinkHandler } from "@/services/terminal/TerminalLinkHandler";
import { remoteHostOfView } from "@/services/terminal/remoteLoopbackLinks";
import {
  disposeTerminalLinkProviders,
  hoveredUrlPluginName,
  installTerminalLinkProviders,
  sharedTerminalOptions,
  type TerminalLinkSlots,
  type TerminalLinkTarget,
} from "@/services/terminal/terminalLinkSurface";
import { hideTerminalLinkTooltip } from "@/services/terminal/terminalLinkTooltip";
import type { TerminalLink } from "@/services/terminal/types";
import { loadXtermCore } from "@/services/terminal/xtermCore";
import { hasUsableRenderer } from "@/services/terminal/xtermRendererProbe";
import { usePanelStore } from "@/store/panelStore";
import { isCanopyEdgeDragging, useCanopyStore } from "@/store/canopyStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import {
  selectEffectiveTheme,
  selectWrapperBackground,
  useTerminalColorSchemeStore,
} from "@/store/terminalColorSchemeStore";
import { streamRangeOf, stripCoveredOutput } from "@/services/terminal/streamFence";
import {
  createSurrogatePairJoiner,
  isMouseReport,
  isTerminalReply,
  isWindowCloseChord,
} from "@/services/terminal/inputUtils";
import { logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  TerminalSearchBar,
  type TerminalSearchTarget,
} from "@/components/Terminal/TerminalSearchBar";
import {
  ownCanopyTerminalApi,
  unlessHostDisconnected,
  type CanopyTerminalApi,
} from "./canopyHostSource";
import { CanopyTerminalMenu, type CanopyTerminalMenuHandle } from "./CanopyTerminalMenu";
import { gridRise, lastKeptRow } from "./canopyGridRise";

const SCROLLBACK = 2_000;
/** The smallest grid worth handing an agent; a smaller measure is a pane mid-layout. */
const MIN_COLS = 20;
const MIN_ROWS = 5;
const SIZE_SETTLE_MS = 120;
/**
 * A stream asked for this soon after the last waits this long first, so arrowing
 * down the list opens a stream for the row the user stops on rather than one
 * per row passed: each one has the host serialize the whole terminal.
 */
const WATCH_BURST_MS = 150;
/** When this view last asked main for a stream, in `performance.now()` time. */
let lastWatchAt = Number.NEGATIVE_INFINITY;

export function _resetCanopyWatchBurstForTests(): void {
  lastWatchAt = Number.NEGATIVE_INFINITY;
}
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
  // A release belongs to the press before it, so the drag follow takes it.
  "mousedown",
  "wheel",
] as const;

const linkHandler = new TerminalLinkHandler();
/** Why another host's paths don't open: here they would name this machine's files. */
const OTHER_HOST_PATH = "This path is on another host. Open it from a window on that host.";

function sameHost(a: HostId, b: HostId): boolean {
  return isLocalHostId(a) ? isLocalHostId(b) : a === b;
}

/** The cwd the run's own pane in this view resolves its paths against. */
function panelCwdOf(id: string): string {
  const panel = usePanelStore.getState().panelsById[id];
  return (panel && isPtyPanel(panel) ? panel.cwd : undefined) ?? "";
}

/** Find in the focused panel, which a keybinding-isolated surface answers itself. */
function isFindKey(event: KeyboardEvent): boolean {
  return keybindingService
    .getTriggerCombos("find.inFocusedPanel")
    .some((combo) => !combo.includes(" ") && keybindingService.matchesEvent(event, combo));
}

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
  /** The host the run is on; the window's own by default. */
  api?: CanopyTerminalApi;
  /** The run's working directory: relative paths in its output resolve against it. */
  cwd?: string;
  /** The run's project, whose editor preference its files open in; the window's when absent. */
  projectId?: string;
  /**
   * The link to the run's host is down: the stream is gone with it, so input
   * stops and the pane says so until the link's return opens it again.
   */
  reconnecting?: boolean;
  onStreamChange?: (state: CanopyStreamState) => void;
  /** Return was typed straight into the terminal and the run took it. */
  onSubmitted?: () => void;
  /** Go to the run's own pane: the way to see a screen this view couldn't show. */
  onGoTo?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Showing the run takes no size: only the user working in it does, in a
   * window left open all day (#16339). Main holds the window's own host's runs
   * to this; a run on another host is held to it here.
   */
  sizesOnUse?: boolean;
  /**
   * Counts what the user sent the run from beside the terminal — a reply, a
   * key, an answer — each a use of it, as a keystroke into it is.
   */
  uses?: number;
}

/**
 * A live view of one agent's terminal, from any project: its own xterm on the
 * WebGL renderer, fed by the stream main brokers for the canopy panel.
 *
 * Built like the run's grid pane — the same options, widths, link providers,
 * images, search and output menu — so it behaves like that pane. What it
 * opens is resolved against the run: its cwd, and its host, so a `localhost`
 * link means the run's host and another host's files aren't opened as local
 * ones. A file opens in the viewer dialog, over the panel rather than behind it.
 *
 * Sized to the panel, at the user's own font size: once the stream is open the
 * PTY is held at the grid this pane fits, so the agent draws for the space it
 * is read in, and main hands it back to its own pane's size when the stream
 * ends. Until then — and if that pane resizes it meanwhile — the grid follows
 * the PTY's geometry: one taller than the pane keeps the last rows the agent
 * has drawn in view, and one wider than the pane scrolls sideways. While the
 * stream is open the terminal's own pane in this view is frozen, so it doesn't
 * take the PTY back.
 * With `sizesOnUse` the pane draws the PTY's grid from the start, and takes the
 * size only once the user clicks, types or replies in it.
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
  api = ownCanopyTerminalApi,
  cwd,
  projectId,
  reconnecting = false,
  onStreamChange,
  onSubmitted,
  onGoTo,
  sizesOnUse = false,
  uses = 0,
}: CanopyTerminalProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onStreamChangeRef = useRef(onStreamChange);
  const onSubmittedRef = useRef(onSubmitted);
  const cwdRef = useRef(cwd);
  const projectIdRef = useRef(projectId);
  const sizesOnUseRef = useRef(sizesOnUse);
  useEffect(() => {
    onStreamChangeRef.current = onStreamChange;
    onSubmittedRef.current = onSubmitted;
    cwdRef.current = cwd;
    projectIdRef.current = projectId;
    sizesOnUseRef.current = sizesOnUse;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  // The current xterm's menu, for handlers that outlive one generation.
  const menuRef = useRef<CanopyTerminalMenuHandle | null>(null);
  // The current xterm's search: a search bar open across a reopen searches,
  // and counts the results of, the terminal that replaced it.
  const [search, setSearch] = useState<TerminalSearchTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The grid's own resolved setting, so a screen reader meets this terminal
  // exactly as it meets the same terminal in its pane.
  const screenReaderEnabled = useScreenReaderStore((s) => s.resolvedScreenReaderEnabled());
  const [status, setStatus] = useState<"opening" | "live" | "failed" | "ended" | "reconnecting">(
    "opening"
  );
  // The open stream's handles, for the link going down and coming back, and the user's Retry.
  const suspendRef = useRef<(() => void) | null>(null);
  const resumeRef = useRef<(() => void) | null>(null);
  const reopenRef = useRef<((next: "reconnecting" | "opening") => void) | null>(null);
  // The current stream's way to hear of a use made from beside the terminal.
  const usedRef = useRef<(() => void) | null>(null);
  /**
   * Each reopening starts the stream over on a new xterm: a reset one keeps
   * its parser mid-sequence and its queued writes, which would land the fresh
   * snapshot in the old screen's state.
   */
  const [generation, setGeneration] = useState(0);
  const reopenStatusRef = useRef<"opening" | "reconnecting">("opening");
  const refocusRef = useRef(false);
  const reconnectingRef = useRef(reconnecting);
  // A full-screen TUI runs on the alternate buffer: like a grid pane, the view
  // then drops its inset and hides the scrollbar that buffer has no use for.
  const [altBuffer, setAltBuffer] = useState(false);
  // The terminal's own canvas colour, so the frame reads as the terminal itself.
  const background = useTerminalColorSchemeStore(selectWrapperBackground);

  useEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    setStatus(reopenStatusRef.current);
    reopenStatusRef.current = "opening";
    let disposed = false;
    const stream: CanopyStreamState = { watchId: null, ended: false, secretPrompt: false };
    const publish = (next: Partial<CanopyStreamState>) => {
      Object.assign(stream, next);
      onStreamChangeRef.current?.({ ...stream });
    };

    // The local terminal's own id: a routed run is keyed by host, the terminal service is not.
    const localId = api.holdsSize ? runId : (api.ownSizedId?.(runId) ?? null);
    const hostId = api.hostOf(runId);
    // Only this view's host serves its files here; another host's paths would
    // open whatever this machine has at the same place.
    const filesHere = sameHost(hostId, remoteHostOfView() ?? LOCAL_HOST_ID);
    let hoveredLink: TerminalLink | null = null;
    const links: TerminalLinkTarget = {
      // As this view's panels know it: a run this view doesn't hold has no
      // panel, plugin subject or help lane here, so its links open on their own.
      terminalId: localId,
      getTerminal: () => (disposed ? null : terminal),
      getCwd: () => cwdRef.current ?? (localId === null ? "" : panelCwdOf(localId)),
      getRuntimeAgentId: () =>
        localId === null ? undefined : peekTerminalService()?.get(localId)?.runtimeAgentId,
      setHoveredLink: (link) => {
        hoveredLink = link;
      },
      openLink: (url, event, options) =>
        linkHandler.openLink(url, localId, event, { ...options, hostId }),
      fileRoute: {
        dialogOnly: true,
        refusal: () => (filesHere ? null : OTHER_HOST_PATH),
        get projectId() {
          return projectIdRef.current;
        },
      },
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
      ...sharedTerminalOptions(links),
      cols: 80,
      rows: 24,
      cursorBlink: false,
    });
    terminal.attachCustomKeyEventHandler((event) => !isWindowCloseChord(event));
    // Awaited before the snapshot's first write, so widths are recorded as the grid records them.
    const unicodeReady = activateUnicode11(terminal);
    terminal.open(host);
    if (refocusRef.current) {
      refocusRef.current = false;
      // Unless the user has put the keyboard somewhere else meanwhile.
      if (document.activeElement === null || document.activeElement === document.body) {
        terminal.focus();
      }
    }
    terminalRef.current = terminal;

    const linkSlots: TerminalLinkSlots = {
      commandLinksDisposable: null,
      fileLinksDisposable: null,
      imageLinksDisposable: null,
      webLinksAddon: null,
      pluginLinksDisposable: null,
    };
    // The web links addon comes with the core the grid loads on its first terminal.
    void loadXtermCore().then(
      () => {
        if (!disposed) installTerminalLinkProviders(terminal, linkSlots, links);
      },
      (error: unknown) => logWarn("[Canopy] couldn't load the terminal's links", { error })
    );
    // Only on a terminal that paints: built before its renderer, the image
    // addon wedges every later open (#11776).
    let image: IDisposable | null = null;
    let imageTried = false;
    const ensureImageAddon = () => {
      if (imageTried || disposed || !hasUsableRenderer(terminal)) return;
      imageTried = true;
      createImageAddon(terminal).then(
        (addon) => {
          if (disposed) addon.dispose();
          else image = addon;
        },
        (error: unknown) => logWarn("[Canopy] couldn't load the image addon", { error })
      );
    };
    ensureImageAddon();

    let searchAddon: SearchAddon | null = null;
    let searchLoad: Promise<SearchAddon | null> | null = null;
    const searchTarget: TerminalSearchTarget = {
      // Nothing once this xterm has gone: a search queued before a reopen
      // finds no addon rather than a disposed one.
      ensureSearchAddon: () => {
        if (disposed) return Promise.resolve(null);
        if (searchAddon) return Promise.resolve(searchAddon);
        searchLoad ??= createSearchAddon(terminal).then(
          (addon) => {
            if (disposed) {
              addon.dispose();
              return null;
            }
            searchAddon = addon;
            return addon;
          },
          (error: unknown) => {
            searchLoad = null;
            logWarn("[Canopy] couldn't load terminal search", { error });
            return null;
          }
        );
        return searchLoad;
      },
      getSearchAddon: () => (disposed ? null : searchAddon),
    };
    setSearch(searchTarget);

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

    // Another host's terminal is sized only once its watch answer says the host takes it.
    let holdsSize = localId !== null;
    // Another surface has the size: this pane draws the PTY's grid, clipped,
    // until the user's own click, keystroke or reply takes the size back, or the
    // host says so once the agent's own pane stops showing it (#16737).
    let following = false;
    // The size is this pane's to take: main is asked even for a grid the PTY
    // already has, as holding is what stops the terminal's other views fitting.
    let mustHold = true;
    // Another host's run, shown where only use takes the size: that host tells
    // this pane to follow only while its own pane shows the run, so the pane
    // holds itself back until used.
    let awaitingUse = false;

    let inset = FRAME_PADDING_PX;
    // A new xterm starts on the normal buffer, whatever the last one was on.
    setAltBuffer(false);
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
        // A host that doesn't take the size keeps the one its own window gave it.
        if (
          disposed ||
          watchId === null ||
          cell === null ||
          !holdsSize ||
          following ||
          awaitingUse
        ) {
          return;
        }
        // The list's or the dock's edge is still moving: the drag's end asks again.
        if (isCanopyEdgeDragging(useCanopyStore.getState())) return;
        // Fractional bounds, truncated, as the grid pane measures them: a
        // rounded-up clientWidth can promise a column the pane hasn't got.
        const box = frame.getBoundingClientRect();
        const scrollbar = inset === 0 ? 0 : getEffectiveScrollbarWidth(terminal.options);
        const cols = Math.floor(Math.floor(box.width - inset - scrollbar) / cell.width);
        const rows = Math.floor(Math.floor(box.height - inset) / cell.height);
        if (cols < MIN_COLS || rows < MIN_ROWS) return;
        // Against what the PTY holds, not what xterm was last told: a hold the
        // terminal's own pane has since overridden is asked for again.
        if (!mustHold && ptySize !== null && cols === ptySize.cols && rows === ptySize.rows) return;
        mustHold = false;
        // Ahead of the PTY's echo, so output drawn for the new size lands on it.
        // Another host's echo is awaited instead: it may let the hold go
        // unanswered (the view lost the drive), and the pane stays on the PTY's grid.
        if (localId !== null) terminal.resize(cols, rows);
        api.terminalResize(watchId, cols, rows).catch((error: unknown) => {
          logWarn("[Canopy] couldn't size the terminal", { error });
          // Refused, so no echo is coming: back to the grid the PTY really has.
          if (!disposed && ptySize !== null) terminal.resize(ptySize.cols, ptySize.rows);
        });
      }, SIZE_SETTLE_MS);
    };

    // A grid that fits sits at the top of the pane, the way it does in the
    // terminal's own pane. One taller than the pane rises out of its top just
    // far enough to keep the last rows the agent has drawn in view: a full
    // screen's bottom rows, where an agent asks, or a fresh agent's top ones.
    // The pane's height the grid can use, its content box; null until laid out.
    let available: number | null = null;
    // The last row to keep, as of xterm's last paint.
    let keptRow = -1;
    let rise = 0;
    const place = () => {
      const css = terminal.dimensions?.css;
      const next =
        css === undefined || available === null
          ? 0
          : gridRise(
              { gridHeight: css.canvas.height, rowHeight: css.cell.height },
              available,
              keptRow
            );
      if (next === rise) return;
      rise = next;
      host.style.marginTop = next === 0 ? "" : `${-next}px`;
    };
    // Read as xterm paints, not as output is parsed: so it moves in the same
    // frame as the rows it keeps, never ahead of a screen held back by
    // synchronized output, and with every scroll through the history.
    const render = terminal.onRender(() => {
      keptRow = lastKeptRow(terminal.buffer.active, terminal.rows, terminal.modes.showCursor);
      place();
    });
    // The cell size moves with the renderer (WebGL arriving or lost, a display
    // change) and with the user's font; either changes the grid the pane fits.
    const dimensionsChange = terminal.onDimensionsChange(() => {
      ensureImageAddon();
      place();
      requestPanelSize();
    });
    // The pane took its new width while the list's or the dock's edge moved;
    // the agent redraws for it once, as the last edge lands.
    const unsubscribeListDrag = useCanopyStore.subscribe((state, previous) => {
      if (isCanopyEdgeDragging(previous) && !isCanopyEdgeDragging(state)) requestPanelSize();
    });
    const unsubscribeFont = useTerminalFontStore.subscribe((font, previous) => {
      if (font.fontSize === previous.fontSize && font.fontFamily === previous.fontFamily) return;
      terminal.options.fontSize = font.fontSize;
      terminal.options.fontFamily = font.fontFamily;
      requestPanelSize();
    });
    // The panel's terminal can outlive a change of palette made in another
    // window. The selector is cached, so a set with nothing new costs xterm nothing.
    const applyTheme = () => {
      terminal.options.theme = selectEffectiveTheme(useTerminalColorSchemeStore.getState());
    };
    const unsubscribeColors = useTerminalColorSchemeStore.subscribe(applyTheme);
    const unsubscribeAppTheme = useAppThemeStore.subscribe(applyTheme);

    // The content box is what's left inside the padding the buffer has, and
    // it is measured after layout: a rise set here still lands before the paint.
    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box) available = box.height;
      place();
      requestPanelSize();
    });
    resizeObserver.observe(frame);
    // The grid only rises, never scrolls: a focus or caret revealing a row
    // below the pane would leave it scrolled out from under its rise.
    const holdTop = () => {
      if (frame.scrollTop !== 0) frame.scrollTop = 0;
    };
    frame.addEventListener("scroll", holdTop);

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
    // A stream that opened while the link still read as down: shown, not typed into.
    let heldWatchId: number | null = null;
    let fence: number | undefined;
    const early: CanopyTerminalData[] = [];
    const apply = (chunk: CanopyTerminalData) => {
      if (view === null || chunk.watchId !== view.watchId) return;
      if (chunk.kind === "resize") {
        const nowFollowing = chunk.following === true;
        if (following && !nowFollowing) mustHold = true;
        following = nowFollowing;
        ptySize = { cols: chunk.cols, rows: chunk.rows };
        terminal.resize(chunk.cols, chunk.rows);
        requestPanelSize();
        return;
      }
      if (chunk.kind === "ended") {
        heldWatchId = null;
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
    const offData = api.onTerminalData((chunk) => {
      if (chunk.runId !== runId) return;
      // The stream can start before the call that opened it returns.
      if (view === null) early.push(chunk);
      else apply(chunk);
    });

    let gesture = false;
    let gestureTimer: ReturnType<typeof setTimeout> | null = null;
    const markGesture = (event: Event) => {
      gesture = true;
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      const end = () => {
        gesture = false;
        gestureTimer = null;
      };
      // xterm turns most events into input synchronously, within its own
      // handler. Composed text is the exception — an IME or a dead-key accent
      // ending its composition, or a key the input method holds (keyCode 229)
      // — which xterm sends from a timer of its own, queued after this one, so
      // the gesture lasts one task longer.
      const deferred =
        event.type === "compositionend" ||
        (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229));
      gestureTimer = deferred
        ? setTimeout(() => {
            gestureTimer = setTimeout(end, 0);
          }, 0)
        : setTimeout(end, 0);
    };
    for (const type of GESTURE_EVENTS) frame.addEventListener(type, markGesture, true);
    // A press the program reports has xterm follow its motion and release at the
    // document, so they arrive wherever the pointer goes. Without them a
    // fullscreen Claude Code reads a drag as a click, and a release outside the
    // view leaves its button held. Captured, to run before xterm's own listeners.
    let dragDocument: Document | null = null;
    const endDrag = () => {
      dragDocument?.removeEventListener("mousemove", followDrag, true);
      dragDocument?.removeEventListener("mouseup", followDrag, true);
      dragDocument = null;
    };
    const followDrag = (event: globalThis.MouseEvent) => {
      // A release the document never saw, as off the window's edge.
      if (event.type === "mousemove" && event.buttons === 0) return endDrag();
      markGesture(event);
      if (event.type === "mouseup" && event.buttons === 0) endDrag();
    };
    const startDrag = () => {
      if (dragDocument === frame.ownerDocument) return;
      endDrag();
      dragDocument = frame.ownerDocument;
      dragDocument.addEventListener("mousemove", followDrag, true);
      dragDocument.addEventListener("mouseup", followDrag, true);
    };
    frame.addEventListener("mousedown", startDrag, true);
    // Hover, for a program that asks for every motion (mode 1003). Motion with a
    // button held is a drag, which counts only when it began here: one begun
    // elsewhere can cross the view while xterm still follows a drag whose
    // release never arrived.
    const markHover = (event: globalThis.MouseEvent) => {
      if (event.buttons === 0) markGesture(event);
    };
    frame.addEventListener("mousemove", markHover, true);
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
    // A use made while the stream was still opening, such as an answer sent
    // by the run: it counts once the stream opens.
    let usedWhileOpening = false;
    // The user's first use asks another host for the size this pane fits.
    const markUsed = () => {
      if (view === null) {
        usedWhileOpening = true;
        return;
      }
      if (!awaitingUse || stream.watchId === null) return;
      awaitingUse = false;
      mustHold = true;
      requestPanelSize();
    };
    usedRef.current = markUsed;
    const claimSize = () => {
      markUsed();
      const watchId = stream.watchId;
      if (!following || watchId === null) return;
      api
        .terminalClaimSize(watchId)
        .catch((error: unknown) => logWarn("[Canopy] couldn't take the size", { error }));
    };
    const claimOnPress = (event: globalThis.MouseEvent) => {
      if (event.button === 0) claimSize();
    };
    frame.addEventListener("mousedown", claimOnPress, true);
    const joinSurrogatePairs = createSurrogatePairJoiner();
    const forwardInput = (data: string) => {
      const watchId = stream.watchId;
      // A reply to the program's own query, or a focus change, can fall
      // inside a gesture: the terminal's own pane answers those, and focus
      // here must never tell the agent it is being looked at.
      if (!gesture || watchId === null || isTerminalReply(data) || reconnectingRef.current) {
        return;
      }
      if (!isMouseReport(data)) claimSize();
      api.terminalInput(watchId, data).then(
        () => {
          if (isTerminalSubmission(data)) onSubmittedRef.current?.();
        },
        (error: unknown) => logWarn("[Canopy] input refused", { error })
      );
    };
    const input = terminal.onData((data) => {
      if (!gesture || stream.watchId === null || reconnectingRef.current) {
        joinSurrogatePairs.reset();
        return;
      }
      for (const chunk of joinSurrogatePairs.join(data)) forwardInput(chunk);
    });

    // The link under the pointer when the menu opened: the hover ends as the pointer reaches it.
    let menuLink: TerminalLink | null = null;
    const menu: CanopyTerminalMenuHandle = {
      read: () => {
        menuLink = hoveredLink;
        return {
          selection: terminal.getSelection(),
          hoveredUrl: menuLink?.text ?? null,
          hoveredUrlPluginName: hoveredUrlPluginName(links, menuLink),
        };
      },
      openHoveredLink: () => {
        const link = menuLink;
        if (!link) return;
        void Promise.resolve()
          .then(() => link.activate(new MouseEvent("click"), link.text))
          .catch((error: unknown) =>
            reportFileLinkFailure("Failed to activate hovered link", error, link.text)
          );
      },
      openLink: (url, options) => links.openLink(url, undefined, options),
      copy: (text) => copyWithToast("Selection", text),
      // A run on this machine may be Claude Code's, whose reply the host can
      // find as written; the host decides, since this view needn't hold its panel.
      copyClean: (captured) =>
        copyCleanSelection(
          captured,
          cleanTerminalSelection(terminal, linkSlots.commandLinksDisposable, captured),
          localId !== null && isLocalHostId(hostId) ? localId : null
        ),
      // Chosen from the menu, so the user's own input: sent through the stream
      // like a typed paste, formatted as the grid's paste is.
      paste: () => {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            const watchId = stream.watchId;
            if (!text || disposed || watchId === null || reconnectingRef.current) return;
            const data = formatForTerminalPaste(text, {
              bracketedPasteMode: terminal.modes.bracketedPasteMode,
            });
            claimSize();
            return api.terminalInput(watchId, data);
          })
          .catch((error: unknown) => logWarn("[Canopy] paste refused", { error }));
      },
      refocus: () => {
        if (disposed) return;
        const active = document.activeElement;
        if (active !== null && frame.contains(active)) return;
        // A dialog the menu opened (the file viewer) keeps the keyboard.
        const around = frame.closest('[role="dialog"], [data-canopy-standalone]');
        if (active === null || active === document.body || around?.contains(active)) {
          terminal.focus();
        }
      },
    };
    menuRef.current = menu;

    // Each opening of the stream; an answer to an earlier one is old news.
    let attempt = 0;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    const openStream = () => {
      lastWatchAt = performance.now();
      const mine = ++attempt;
      api.watchTerminal(runId, { spawnedAt }).then(
        (opened) => {
          if (mine !== attempt) return;
          // A pane already gone lets its stream go now; a live one paints
          // once the widths are set.
          if (disposed) {
            onOpened(opened);
            return;
          }
          void unicodeReady.then(() => {
            if (mine === attempt) onOpened(opened);
          });
        },
        (error: unknown) => {
          if (mine === attempt) onOpenFailed(error);
        }
      );
    };
    // The link dropped and the stream with it, and nothing has opened it since.
    let suspended = false;
    /**
     * The stream is gone — the link to the run's host dropped — so nothing
     * typed can reach it. Input stops at once, and nothing typed meanwhile is
     * kept to be sent later: the screen it was typed at is not the one the
     * agent will be showing.
     */
    const suspend = () => {
      if (disposed || stream.ended) return;
      suspended = true;
      heldWatchId = null;
      attempt++;
      if (openTimer !== null) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      view = null;
      if (stream.watchId !== null) publish({ watchId: null });
      setStatus("reconnecting");
    };
    /** Start again from a fresh snapshot of the screen, not from what was shown. */
    const reopen = (next: "reconnecting" | "opening") => {
      if (disposed || stream.ended) return;
      disposed = true;
      reopenStatusRef.current = next;
      // Typing straight into the terminal carries on in the one that replaces it.
      refocusRef.current = frame.contains(document.activeElement);
      setGeneration((n) => n + 1);
    };
    suspendRef.current = suspend;
    reopenRef.current = reopen;
    // The link reads as up again: open again unless its `resync` already did,
    // and let the user type into a stream that opened meanwhile.
    resumeRef.current = () => {
      if (stream.ended) return;
      if (suspended) {
        reopen("reconnecting");
      } else if (heldWatchId !== null) {
        const watchId = heldWatchId;
        heldWatchId = null;
        publish({ watchId });
        setStatus("live");
        // A measure that ran while the stream was held had no stream to size.
        requestPanelSize();
      }
    };
    const offResync = api.onResync(() => reopen("reconnecting"));
    const onOpened = (opened: CanopyTerminalView) => {
      if (disposed) {
        // Opened for a pane already gone: let that one stream go, and only it.
        if (opened.watchId !== null) {
          safeFireAndForget(unlessHostDisconnected(api.unwatchTerminal(opened.watchId)), {
            context: "Ending a canopy terminal stream that opened too late",
          });
        }
        return;
      }
      if (opened.watchId === null || opened.snapshot === null) {
        // A stream opened with no screen to start from is let go, not left
        // running behind a pane that never shows it.
        if (opened.watchId !== null) {
          safeFireAndForget(unlessHostDisconnected(api.unwatchTerminal(opened.watchId)), {
            context: "Ending a canopy terminal stream that opened with no screen",
          });
        }
        setStatus("failed");
        return;
      }
      view = opened;
      holdsSize = localId !== null || opened.holdsSize === true;
      // A new stream is a new selection, which takes the size as a first one
      // does, unless it is shown where only use does: main says so for its own runs.
      following = opened.following === true;
      awaitingUse = localId === null && sizesOnUseRef.current && !usedWhileOpening;
      mustHold = true;
      const snapshot = opened.snapshot;
      ptySize = { cols: snapshot.cols, rows: snapshot.rows };
      terminal.resize(snapshot.cols, snapshot.rows);
      const continuation = snapshot.continuation;
      fence = continuation?.streamOffset;
      // The escape sequence the host's parser was inside, so the chunks
      // after the fence land in the same parser state they were written in.
      const tail = fence !== undefined ? (continuation?.pendingEscapeTail ?? "") : "";
      terminal.write(snapshot.data + tail, () => {
        // A snapshot keeps no record of the widths its rows were laid out at.
        linkSlots.commandLinksDisposable?.markRowsStale();
        checkSecret();
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
      if (reconnectingRef.current) {
        heldWatchId = opened.watchId;
        return;
      }
      publish({ watchId: opened.watchId });
      setStatus("live");
      // Main may have opened the stream after that use reached it, and found nothing to claim.
      if (usedWhileOpening) claimSize();
      requestPanelSize();
    };
    const onOpenFailed = (error: unknown) => {
      if (disposed) return;
      logWarn("[Canopy] couldn't open the terminal stream", { error });
      setStatus("failed");
    };
    if (performance.now() - lastWatchAt < WATCH_BURST_MS) {
      openTimer = setTimeout(() => {
        openTimer = null;
        openStream();
      }, WATCH_BURST_MS);
    } else {
      openStream();
    }

    return () => {
      disposed = true;
      if (suspendRef.current === suspend) suspendRef.current = null;
      if (reopenRef.current === reopen) reopenRef.current = null;
      if (usedRef.current === markUsed) usedRef.current = null;
      resumeRef.current = null;
      if (openTimer !== null) clearTimeout(openTimer);
      offResync();
      offData();
      input.dispose();
      if (menuRef.current === menu) menuRef.current = null;
      disposeTerminalLinkProviders(linkSlots);
      hideTerminalLinkTooltip(terminal);
      image?.dispose();
      searchAddon?.dispose();
      bufferChange.dispose();
      render.dispose();
      dimensionsChange.dispose();
      unsubscribeFont();
      unsubscribeColors();
      unsubscribeAppTheme();
      unsubscribeListDrag();
      for (const type of GESTURE_EVENTS) frame.removeEventListener(type, markGesture, true);
      frame.removeEventListener("mousedown", startDrag, true);
      frame.removeEventListener("mousedown", claimOnPress, true);
      frame.removeEventListener("mousemove", markHover, true);
      endDrag();
      frame.removeEventListener("wheel", sideways, true);
      frame.removeEventListener("scroll", holdTop);
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      resizeObserver.disconnect();
      // The host outlives this xterm: the next one starts at the pane's top.
      host.style.marginTop = "";
      if (sizeTimer !== null) clearTimeout(sizeTimer);
      webgl?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      onStreamChangeRef.current?.({ watchId: null, ended: false, secretPrompt: false });
      // Only its own stream, by id: another pane in this view may have opened
      // one since, which this cleanup must leave alone. A stream still opening
      // is let go when its answer arrives, below.
      const ownWatchId = view?.watchId ?? null;
      if (ownWatchId !== null) {
        safeFireAndForget(unlessHostDisconnected(api.unwatchTerminal(ownWatchId)), {
          context: "Ending the canopy terminal stream",
        });
      }
    };
  }, [runId, spawnedAt, api, generation]);

  // The link's return also says `resync`, which opens the stream again; this
  // covers a link that came back without a fresh session to say it.
  const wasReconnectingRef = useRef(reconnecting);
  useEffect(() => {
    const was = wasReconnectingRef.current;
    wasReconnectingRef.current = reconnecting;
    reconnectingRef.current = reconnecting;
    if (reconnecting) suspendRef.current?.();
    else if (was) resumeRef.current?.();
  }, [reconnecting]);

  // Counted from the value the pane mounted with, so a count from before it is no use of it.
  const usesSeenRef = useRef(uses);
  useEffect(() => {
    if (usesSeenRef.current === uses) return;
    usesSeenRef.current = uses;
    usedRef.current?.();
  }, [uses]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.screenReaderMode = screenReaderEnabled;
  }, [screenReaderEnabled]);

  // The frame keeps app shortcuts away from the run, so Find is answered here,
  // before the key reaches the terminal as input.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !isFindKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      requestAnimationFrame(() => {
        root.querySelector<HTMLInputElement>("[data-terminal-search-input]")?.focus();
      });
    };
    root.addEventListener("keydown", onKeyDown, true);
    return () => root.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const closeSearch = () => {
    setSearchOpen(false);
    terminalRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <CanopyTerminalMenu handle={menuRef}>
        <div
          ref={frameRef}
          data-canopy-terminal=""
          data-keybindings-isolated=""
          style={{ background }}
          // A grid pane's terminal body: the terminal's own background, inset p-3
          // on the normal buffer and flush on the alternate one.
          className={cn(
            // Clipped when too tall, the grid risen to keep what the agent drew
            // in view, and scrollable sideways when too wide (a cut-off line
            // would lose words).
            "relative flex min-h-0 flex-1 flex-col items-start overflow-x-auto overflow-y-hidden",
            altBuffer ? "terminal-alt-buffer" : "p-3"
          )}
        >
          {/* The pane's full width at least, so xterm's scrollbar sits at the pane's
          edge, in the gutter the grid was measured to leave, not over the last
          column; wider when the PTY is, and the frame scrolls. */}
          <div ref={hostRef} className="min-w-full shrink-0" />
          {(status === "reconnecting" || reconnecting) && status !== "ended" && (
            <div
              role="status"
              data-canopy-reconnecting=""
              className="absolute inset-x-0 top-3 flex justify-center text-xs text-text-secondary"
            >
              <p className="rounded-full bg-surface-panel px-2.5 py-1 shadow-[var(--theme-shadow-ambient)]">
                Reconnecting…
              </p>
            </div>
          )}
          {(status === "failed" || status === "ended") && !reconnecting && (
            <div
              role="status"
              className="absolute inset-x-0 top-3 flex flex-col items-center gap-2 text-center text-xs text-text-secondary"
            >
              {status === "ended" ? (
                <p>This terminal has exited. Archive it, or trash it to clear it away.</p>
              ) : (
                <>
                  <p>Couldn't show this terminal here</p>
                  {onGoTo ? (
                    <Button variant="outline" size="xs" onClick={onGoTo}>
                      Go to terminal
                    </Button>
                  ) : (
                    // No pane to go to: the stream is opened again here.
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => reopenRef.current?.("opening")}
                    >
                      Retry
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </CanopyTerminalMenu>
      {searchOpen && search && (
        // Typed into here, not the terminal: still none of the grid's shortcuts.
        <div data-keybindings-isolated="" className="contents">
          <TerminalSearchBar search={search} onClose={closeSearch} />
        </div>
      )}
    </div>
  );
}
