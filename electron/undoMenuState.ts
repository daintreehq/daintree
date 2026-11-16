import { app, Menu, webContents as electronWebContents, type WebContents } from "electron";
import type { UndoCloseMenuState } from "../shared/types/menu.js";
import { pluralize } from "../shared/utils/pluralize.js";
import { CHANNELS } from "./ipc/channels.js";
import { onWebContentsDestroyed } from "./window/webContentsDestroyed.js";

/**
 * Edit > Undo names the close the next Cmd+Z would reopen in the focused view
 * (#17108), and choosing it reopens that close. Only the view knows where its
 * keyboard is and what its fields would undo, so each project view publishes
 * its own state; this keeps the latest per view and shows the focused one's.
 */

export const UNDO_MENU_ITEM_ID = "edit-undo";

const UNDO_CLOSE_ACTION_ID = "panel.undoClose";

/** Longest panel title the label carries before it's cut short. */
const MAX_TITLE_LENGTH = 40;

type NamedClose = NonNullable<UndoCloseMenuState>;

const states = new Map<number, NamedClose>();
const watched = new Set<number>();
let focusTracking = false;
let refreshQueued = false;

function oneLine(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > MAX_TITLE_LENGTH
    ? `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
    : flat;
}

/**
 * The label for a view's state. Menus on every platform read `&` as a mnemonic
 * marker (macOS strips it too), so a title's own ampersands are doubled.
 */
export function formatUndoMenuLabel(state: UndoCloseMenuState): string {
  if (state === null) return "Undo";
  const title = state.count === 1 && state.title !== null ? oneLine(state.title) : "";
  if (title !== "") return `Undo Close "${title.replace(/&/g, "&&")}"`;
  return state.count === 1 ? "Undo Close Panel" : `Undo Close ${pluralize(state.count, "Panel")}`;
}

function focusedContents(): WebContents | null {
  const focused = electronWebContents.getFocusedWebContents();
  return focused && !focused.isDestroyed() ? focused : null;
}

/** Edit > Undo's label for whatever has the keyboard now. */
export function currentUndoMenuLabel(): string {
  const focused = focusedContents();
  return formatUndoMenuLabel((focused && states.get(focused.id)) ?? null);
}

/**
 * Puts the focused view's label on the installed menu, in place: a rebuild
 * would dismiss a menu the user has open. Cosmetic, so it never throws.
 */
export function refreshUndoMenuItem(): void {
  try {
    const item = Menu.getApplicationMenu()?.getMenuItemById(UNDO_MENU_ITEM_ID);
    if (!item) return;
    const label = currentUndoMenuLabel();
    if (item.label !== label) item.label = label;
  } catch (err) {
    console.error("[MAIN] Failed to refresh Edit > Undo:", err);
  }
}

// Focus moving fires the blur before the focus, with nothing focused between.
function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  setImmediate(() => {
    refreshQueued = false;
    refreshUndoMenuItem();
  });
}

// A crash-loop's recovery page replaces the document without mounting the
// app, so nothing would ever clear the dead document's close.
function onRenderProcessGone(_event: Electron.Event, wc: WebContents): void {
  if (states.delete(wc.id)) scheduleRefresh();
}

// Installed with the first close a view names, so an app where nobody closes
// a panel listens to nothing. App-wide, not per view: a project view already
// carries close to the listener limit on its own events.
function trackFocus(wc: WebContents): void {
  if (!focusTracking) {
    focusTracking = true;
    app.on("browser-window-focus", scheduleRefresh);
    app.on("browser-window-blur", scheduleRefresh);
    app.on("render-process-gone", onRenderProcessGone);
  }
  if (watched.has(wc.id)) return;
  const id = wc.id;
  watched.add(id);
  // A guest page or DevTools taking the keyboard inside the same window
  // blurs the view without the window losing focus.
  wc.on("focus", scheduleRefresh);
  wc.on("blur", scheduleRefresh);
  onWebContentsDestroyed(wc, () => {
    watched.delete(id);
    states.delete(id);
    scheduleRefresh();
  });
}

/**
 * Records what the next Cmd+Z in `wc` would reopen. A view reloaded or
 * recovered publishes its state as it starts, which clears what the document
 * before it left.
 */
export function setUndoCloseState(wc: WebContents, state: UndoCloseMenuState): void {
  if (wc.isDestroyed()) return;
  if (state === null) {
    if (!states.delete(wc.id)) return;
  } else {
    states.set(wc.id, state);
    trackFocus(wc);
  }
  scheduleRefresh();
}

/**
 * Edit > Undo chosen. With a close named for the focused view, the view
 * reopens it; anything else undoes text where the keyboard is, as before. On
 * the Mac, Cmd+Z reaches the menu only once the view has let the key go (it
 * consumes it when it reopens), so the key equivalent always undoes text,
 * whatever the label read a moment earlier.
 */
export function handleUndoMenuClick(
  event: Pick<Electron.KeyboardEvent, "triggeredByAccelerator" | "metaKey">
): void {
  const focused = focusedContents();
  if (!focused) return;
  const keyEquivalent =
    process.platform === "darwin" &&
    event.triggeredByAccelerator === true &&
    event.metaKey === true;
  if (!keyEquivalent && states.has(focused.id)) {
    try {
      focused.send(CHANNELS.MENU_ACTION, { actionId: UNDO_CLOSE_ACTION_ID });
    } catch {
      // The view is going away; there is nothing left to reopen into.
    }
    return;
  }
  focused.undo();
}

/** Test seam. */
export function resetUndoMenuStateForTests(): void {
  states.clear();
  watched.clear();
  if (focusTracking) {
    app.removeListener("browser-window-focus", scheduleRefresh);
    app.removeListener("browser-window-blur", scheduleRefresh);
    app.removeListener("render-process-gone", onRenderProcessGone);
  }
  focusTracking = false;
  refreshQueued = false;
}
