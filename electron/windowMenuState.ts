import { Menu, type BrowserWindow } from "electron";
import { getWindowRegistry } from "./window/windowRef.js";
import { revealWindow } from "./window/projectOwnership.js";
import type { WindowContext } from "./window/WindowRegistry.js";

// On macOS the Window menu's role has AppKit list the open windows. Off macOS
// nothing does unless the menu carries one item per window itself (#15536).
const OPEN_WINDOW_ITEM_ID_PREFIX = "window-list-";

const closingWindows = new WeakSet<BrowserWindow>();

/** The windows the installed menu has an item for, in menu order. */
let builtWindowIds: number[] = [];

function listsOpenWindows(): boolean {
  return process.platform !== "darwin";
}

function isListed(ctx: WindowContext): boolean {
  return !ctx.browserWindow.isDestroyed() && !closingWindows.has(ctx.browserWindow);
}

function listedWindowIds(): number[] {
  const registry = getWindowRegistry();
  if (!registry) return [];
  return registry
    .all()
    .filter(isListed)
    .map((ctx) => ctx.windowId);
}

// Windows and Linux menus read `&` as a mnemonic marker, so a project named
// "R&D" would otherwise lose its ampersand and underline the D.
function menuLabelFor(win: BrowserWindow): string {
  return win.getTitle().replace(/&/g, "&&");
}

function itemIdFor(windowId: number): string {
  return `${OPEN_WINDOW_ITEM_ID_PREFIX}${windowId}`;
}

/**
 * The Window menu's list of open windows, in the order they opened, each named
 * by its window title. Records what it built, so {@link isOpenWindowMenuStale}
 * and {@link refreshOpenWindowMenu} answer for the menu that gets installed.
 */
export function buildOpenWindowMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (!listsOpenWindows()) return [];
  const registry = getWindowRegistry();
  const windows = registry ? registry.all().filter(isListed) : [];
  builtWindowIds = windows.map((ctx) => ctx.windowId);
  if (windows.length === 0) return [];

  const primaryId = registry?.getPrimary()?.windowId;
  return [
    { type: "separator" },
    ...windows.map(
      (ctx): Electron.MenuItemConstructorOptions => ({
        id: itemIdFor(ctx.windowId),
        label: menuLabelFor(ctx.browserWindow),
        type: "checkbox",
        checked: ctx.windowId === primaryId,
        click: () => focusListedWindow(ctx.windowId),
      })
    ),
  ];
}

/**
 * Whether the installed menu lists a different set of windows than are open.
 * Titles and the current-window mark don't count: those update in place, and a
 * rebuild would dismiss a menu the user has open.
 */
export function isOpenWindowMenuStale(): boolean {
  if (!listsOpenWindows()) return false;
  const ids = listedWindowIds();
  return ids.length !== builtWindowIds.length || ids.some((id, i) => id !== builtWindowIds[i]);
}

/**
 * Bring the installed list in line with the windows without rebuilding: each
 * item takes its window's current title, only the most recently focused window
 * is checked, and a window that has closed or is closing is hidden until the
 * next rebuild drops it.
 *
 * Best-effort by construction, like `refreshProjectMenuState`: callers run it
 * after a title write or a focus change, and a cosmetic menu update must never
 * fail those.
 */
export function refreshOpenWindowMenu(): void {
  if (!listsOpenWindows() || builtWindowIds.length === 0) return;
  try {
    const registry = getWindowRegistry();
    const menu = Menu.getApplicationMenu();
    if (!registry || !menu) return;

    const primaryId = registry.getPrimary()?.windowId;
    for (const windowId of builtWindowIds) {
      const item = menu.getMenuItemById(itemIdFor(windowId));
      if (!item) continue;
      const ctx = registry.getByWindowId(windowId);
      const listed = ctx !== undefined && isListed(ctx);
      item.visible = listed;
      item.checked = listed && windowId === primaryId;
      if (!listed) continue;
      const label = menuLabelFor(ctx.browserWindow);
      if (item.label !== label) item.label = label;
    }
  } catch (err) {
    console.error("[MAIN] Failed to refresh the Window-menu window list:", err);
  }
}

/**
 * A window's `close` event: it leaves the list now rather than when it is gone,
 * so the menu never offers a window that is on its way out.
 */
export function noteWindowClosing(win: BrowserWindow, event: Electron.Event): void {
  closingWindows.add(win);
  refreshOpenWindowMenu();
  // Every `close` listener has run by the microtask. One that vetoed the close
  // left the window open, so it goes back on the list.
  queueMicrotask(() => {
    if (!event.defaultPrevented || win.isDestroyed()) return;
    closingWindows.delete(win);
    refreshOpenWindowMenu();
  });
}

function focusListedWindow(windowId: number): void {
  const ctx = getWindowRegistry()?.getByWindowId(windowId);
  if (ctx && isListed(ctx)) revealWindow(ctx.browserWindow);
  // A checkbox item toggles itself when clicked, so choosing the window that is
  // already current would clear its mark. Put every mark back from the registry.
  refreshOpenWindowMenu();
}
