import type { BrowserWindow, WebContents, WebContentsView } from "electron";
import type { CanopyPendingPopOut, CanopyPopOut } from "../../shared/types/ipc/canopy.js";
import { CHANNELS } from "../ipc/channels.js";
import { AppError } from "../utils/errorTypes.js";
import type { CreateWindowResult, SetupBrowserWindowOptions } from "./createWindow.js";
import { setCanopyWindowOpen } from "./openWindowsTracker.js";

const CANOPY_WINDOW_TITLE = "Canopy";

/** How long a pop-out waits for the window to take it up: a new one boots first. */
export const CANOPY_POP_OUT_TIMEOUT_MS = 20_000;

type CanopyRevealMode = NonNullable<SetupBrowserWindowOptions["revealMode"]>;

type CanopyBrowserWindowFactory = (
  revealMode: CanopyRevealMode
) => Pick<CreateWindowResult, "win" | "appView" | "loadRenderer">;

let createBrowserWindow: CanopyBrowserWindowFactory | null = null;
let canopyWindow: BrowserWindow | null = null;
/** The window's one view, which a WebContents id is checked against. */
let canopyViewWebContents: WebContents | null = null;
let stopWatchingMode: (() => void) | null = null;
/** A Canopy window has stood this session, whether or not it still does. */
let openedThisSession = false;

/** Set at boot, which holds the preload's path; handed in so IPC needn't import window setup. */
export function setCanopyBrowserWindowFactory(create: CanopyBrowserWindowFactory): void {
  createBrowserWindow = create;
}

function liveCanopyWindow(): BrowserWindow | null {
  return canopyWindow && !canopyWindow.isDestroyed() ? canopyWindow : null;
}

/** Bring the window forward, if there is one. False means there is none. */
export function focusCanopyWindow(): boolean {
  const win = liveCanopyWindow();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

/**
 * Whether a call came from the Canopy window's own view: what only that window
 * may ask for, like going to a run's pane in the window that has it.
 */
export function isCanopyWindowView(webContentsId: number): boolean {
  return liveCanopyWindow() !== null && canopyViewWebContents?.id === webContentsId;
}

export function closeCanopyWindow(): void {
  liveCanopyWindow()?.close();
}

/** A project window's view manager keeps its view filling the window; this one has none. */
function keepViewFillingWindow(win: BrowserWindow, view: WebContentsView): void {
  const fill = (): void => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  win.on("resize", fill);
  win.on("maximize", fill);
  win.on("unmaximize", fill);
  win.on("enter-full-screen", fill);
  win.on("leave-full-screen", fill);
  win.on("restore", fill);
  // Linux's auto-hidden menu bar gives its height back with no `resize`, as
  // ProjectViewManager's growth handler says. Only growth: while the menu is
  // open the view stays full size, clipped, rather than resize the PTY twice.
  win.contentView.on("bounds-changed", () => {
    if (win.isDestroyed()) return;
    const area = win.getContentBounds();
    const bounds = view.getBounds();
    if (bounds.width < area.width || bounds.height < area.height) fill();
  });
}

/**
 * A docked global assistant stays attached until told otherwise, and a closed,
 * crashed or reloaded view can't say so itself. The registry's unregister and a
 * project view's crash hook do this for the windows they know.
 */
function detachGlobalAssistantWithView(view: WebContentsView): void {
  const webContents = view.webContents;
  const viewId = webContents.id;
  const detach = (): void => {
    void import("../services/globalAssistant.js")
      .then(({ peekGlobalAssistantService }) =>
        peekGlobalAssistantService()?.detachWebContents(viewId)
      )
      .catch((error: unknown) => {
        console.warn("[CanopyWindow] Detaching the global assistant failed:", error);
      });
  };
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) detach();
  });
  webContents.on("render-process-gone", detach);
  webContents.once("destroyed", detach);
}

/**
 * Whether a Canopy window has stood this session. A launch restore that comes
 * after one would reopen a window the user already opened, or already closed.
 */
export function hasCanopyWindowOpenedThisSession(): boolean {
  return openedThisSession;
}

/**
 * Open the one Canopy window, or bring it forward. Never registered with the
 * window registry, which is how it stays out of everything that picks a window
 * for a project: an open, a restore, the project window list of the manifest,
 * a project-scoped action. The manifest records it apart (#16336).
 *
 * `watchMode` is told to close the window when Canopy stops being on, and
 * returns how to stop watching; it runs for as long as the window stands.
 *
 * `revealMode: "showInactive"` is a launch restore's: it opens behind the
 * window the user is in, and leaves one that already stands where it is.
 */
export function openCanopyWindow(
  watchMode: (close: () => void) => () => void,
  { revealMode = "show" }: { revealMode?: CanopyRevealMode } = {}
): void {
  if (revealMode === "showInactive" ? liveCanopyWindow() : focusCanopyWindow()) return;
  if (!createBrowserWindow) throw new Error("The Canopy window opened before the app set it up");

  const { win, appView, loadRenderer } = createBrowserWindow(revealMode);
  canopyWindow = win;
  canopyViewWebContents = appView.webContents;
  openedThisSession = true;
  keepViewFillingWindow(win, appView);
  detachGlobalAssistantWithView(appView);
  // A reload asks again as it boots; a renderer gone can't take anything up.
  appView.webContents.on("render-process-gone", () =>
    failPendingPopOut("Its window stopped before Canopy moved.")
  );
  win.setTitle(CANOPY_WINDOW_TITLE);
  // The page's own <title> would otherwise replace it on load.
  win.on("page-title-updated", (event) => event.preventDefault());
  stopWatchingMode = watchMode(closeCanopyWindow);
  win.once("closed", () => {
    stopWatchingMode?.();
    stopWatchingMode = null;
    if (canopyWindow === win) {
      canopyWindow = null;
      canopyViewWebContents = null;
      setCanopyWindowOpen(false);
    }
    failPendingPopOut("Its window closed before Canopy moved.");
  });
  setCanopyWindowOpen(true);
  loadRenderer("canopy window");
}

interface PendingPopOut extends CanopyPendingPopOut {
  settle: (error: AppError | null) => void;
}

/** The one pop-out under way: a second waits its turn rather than replace the first's place. */
let pendingPopOut: PendingPopOut | null = null;
let popOutSeq = 0;

function failPendingPopOut(userMessage: string): void {
  pendingPopOut?.settle(
    new AppError({ code: "CANCELLED", message: "The Canopy window didn't take the pop-out up", userMessage })
  );
}

/**
 * Open the Canopy window, or bring it forward, with a dialog's place for it to
 * take up (#16338). Settles once the window has the place, so the dialog
 * closes only then; refused while another is under way, and failed when the
 * window closes, stops, or never takes it up in time, leaving the dialog as it
 * was. A window already standing is told; a new one asks as it boots.
 */
export function popOutToCanopyWindow(
  popOut: CanopyPopOut,
  watchMode: (close: () => void) => () => void
): Promise<void> {
  if (pendingPopOut) {
    return Promise.reject(
      new AppError({
        code: "UNSUPPORTED",
        message: "A pop-out is already under way",
        userMessage: "Canopy is already moving to its window.",
      })
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => failPendingPopOut("Its window didn't answer in time."),
      CANOPY_POP_OUT_TIMEOUT_MS
    );
    const entry: PendingPopOut = {
      id: ++popOutSeq,
      popOut,
      settle: (error) => {
        if (pendingPopOut !== entry) return;
        pendingPopOut = null;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      },
    };
    pendingPopOut = entry;
    const standing = liveCanopyWindow() !== null;
    try {
      openCanopyWindow(watchMode);
    } catch (error) {
      entry.settle(
        new AppError({
          code: "CANCELLED",
          message: "The Canopy window didn't open",
          userMessage: "Its window didn't open.",
          cause: error instanceof Error ? error : undefined,
        })
      );
      return;
    }
    const view = canopyViewWebContents;
    if (standing && view && !view.isDestroyed()) {
      try {
        view.send(CHANNELS.CANOPY_WINDOW_POP_OUT_WAITING);
      } catch {
        // A view torn down mid-send closes its window, which fails the pop-out.
      }
    }
  });
}

/** The pop-out waiting for the window, kept until the window says it has it. */
export function peekPendingPopOut(): CanopyPendingPopOut | null {
  return pendingPopOut ? { id: pendingPopOut.id, popOut: pendingPopOut.popOut } : null;
}

/** The window has the pop-out's place. False for one no longer waiting. */
export function acknowledgePopOut(id: number): boolean {
  if (pendingPopOut?.id !== id) return false;
  pendingPopOut.settle(null);
  return true;
}
