import { Menu } from "electron";
import type { HandlerDependencies } from "../types.js";
import type {
  MenuItemOption,
  ShowApplicationMenuPayload,
  ShowContextMenuPayload,
} from "../../../shared/types/menu.js";
import { defineIpcNamespace, op } from "../define.js";
import { MENU_METHOD_CHANNELS } from "./menu.preload.js";
import { getAppWebContents, isCachedViewWebContents } from "../../window/webContentsRegistry.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMenuItemOption(value: unknown, depth: number): MenuItemOption | null {
  if (!isPlainObject(value)) return null;
  if (depth > 10) return null;

  const typeRaw = value.type;
  const type = typeRaw === undefined ? "normal" : typeRaw;
  if (type !== "normal" && type !== "separator" && type !== "checkbox") return null;

  const idRaw = value.id;
  const id = typeof idRaw === "string" ? idRaw : undefined;

  if (type === "separator") {
    return { type: "separator", ...(id ? { id } : {}) };
  }

  if (!id) return null;

  const labelRaw = value.label;
  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  if (!label) return null;

  const enabledRaw = value.enabled;
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : undefined;

  const sublabelRaw = value.sublabel;
  const sublabel = typeof sublabelRaw === "string" ? sublabelRaw.trim() : undefined;

  const submenuRaw = value.submenu;
  const submenu = Array.isArray(submenuRaw)
    ? submenuRaw
        .map((item) => sanitizeMenuItemOption(item, depth + 1))
        .filter((item): item is MenuItemOption => item !== null)
    : undefined;

  if (type === "checkbox") {
    const checkedRaw = value.checked;
    const checked = typeof checkedRaw === "boolean" ? checkedRaw : undefined;
    return {
      type: "checkbox",
      id,
      label,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(sublabel ? { sublabel } : {}),
      ...(submenu && submenu.length > 0 ? { submenu } : {}),
    };
  }

  return {
    type: "normal",
    id,
    label,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(sublabel ? { sublabel } : {}),
    ...(submenu && submenu.length > 0 ? { submenu } : {}),
  };
}

function sanitizeShowContextMenuPayload(value: unknown): ShowContextMenuPayload | null {
  if (!isPlainObject(value)) return null;

  const templateRaw = value.template;
  if (!Array.isArray(templateRaw)) return null;

  const template = templateRaw
    .map((item) => sanitizeMenuItemOption(item, 0))
    .filter((item): item is MenuItemOption => item !== null);

  const xRaw = value.x;
  const yRaw = value.y;
  const x = Number.isFinite(xRaw) ? Math.round(xRaw as number) : undefined;
  const y = Number.isFinite(yRaw) ? Math.round(yRaw as number) : undefined;

  return {
    template,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  };
}

/**
 * Translate a sender-view CSS-pixel anchor into the window coordinates
 * `Menu.popup` expects, clamped inside the window's content area.
 *
 * The project WebContentsView always fills the window's content area
 * (`ProjectViewManager` sets `{x: 0, y: 0, width, height}`), so the only
 * correction between the two spaces is the view's zoom factor — an app zoomed
 * to 150% renders the button 1.5x further from the origin than its CSS rect
 * reports. Non-finite input falls back to Electron's own default (the cursor).
 */
export function resolveApplicationMenuAnchor(
  payload: ShowApplicationMenuPayload | undefined,
  bounds: { width: number; height: number },
  zoomFactor: number
): { x: number; y: number } | null {
  if (!payload) return null;
  const { x, y } = payload;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  // A zero/negative/NaN zoom factor would collapse or invert the anchor.
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const clamp = (value: number, max: number) =>
    Math.round(Math.min(Math.max(value * scale, 0), Math.max(max, 0)));

  return { x: clamp(x as number, bounds.width), y: clamp(y as number, bounds.height) };
}

export const menuNamespace = defineIpcNamespace({
  name: "menu",
  ops: {
    /**
     * Pop up the installed application menu at a renderer-supplied anchor
     * (#11813).
     *
     * Windows hides the native title bar for the Window Controls Overlay, which
     * removes the frame region the menu bar would render into — Alt reveals
     * nothing and every menu-only action becomes unreachable. Linux keeps a real
     * frame (Alt works) but nothing advertises the menu.
     *
     * This pops up the exact object `Menu.getApplicationMenu()` returns rather
     * than rebuilding a template, so the popup inherits every dynamic part of
     * the menu for free: Open Recent, installed-agent items, plugin
     * contributions, the live "Check for Updates…" label mutated by
     * `applyUpdateMenuState`, and the project gates mutated by
     * `refreshProjectMenuState`. Electron runs the items' own click handlers and
     * roles, so there is no second source of truth to drift.
     *
     * macOS keeps its system menu bar and no-ops here even if a renderer calls
     * this, so the native menu is never shadowed by a duplicate popup.
     */
    showApplication: op(
      MENU_METHOD_CHANNELS.showApplication,
      async (ctx, payload?: ShowApplicationMenuPayload): Promise<void> => {
        if (process.platform === "darwin") return;

        const win = ctx.senderWindow;
        if (!win || win.isDestroyed()) return;

        // A backgrounded project view can still hold a queued click; without
        // this it would surface a popup over whichever view is now visible.
        if (isCachedViewWebContents(ctx.webContentsId)) return;

        const menu = Menu.getApplicationMenu();
        if (!menu) return;

        let anchor: { x: number; y: number } | null = null;
        try {
          const wc = getAppWebContents(win);
          if (!wc.isDestroyed()) {
            anchor = resolveApplicationMenuAnchor(
              payload,
              win.getContentBounds(),
              wc.getZoomFactor()
            );
          }
        } catch {
          // Fall through to a cursor-anchored popup rather than dropping the
          // menu entirely — reachability matters more than placement.
        }

        menu.popup({ window: win, ...(anchor ?? {}) });
      },
      { withContext: true }
    ),
    showContext: op(
      MENU_METHOD_CHANNELS.showContext,
      async (ctx, payload: ShowContextMenuPayload): Promise<string | null> => {
        const sanitized = sanitizeShowContextMenuPayload(payload);
        if (!sanitized || sanitized.template.length === 0) return null;

        const win = ctx.senderWindow;
        if (!win || win.isDestroyed()) return null;

        return new Promise((resolve) => {
          let resolved = false;
          const resolveOnce = (value: string | null) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
          };

          const buildTemplate = (
            items: MenuItemOption[]
          ): Electron.MenuItemConstructorOptions[] => {
            return items.map((item) => {
              if (item.type === "separator") {
                return { type: "separator" };
              }

              const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
              const base: Electron.MenuItemConstructorOptions = {
                label: item.label,
                enabled: item.enabled !== false,
                type: item.type === "checkbox" ? "checkbox" : "normal",
                ...(item.type === "checkbox" && item.checked !== undefined
                  ? { checked: item.checked }
                  : {}),
                ...(item.sublabel ? { sublabel: item.sublabel } : {}),
                ...(hasSubmenu ? { submenu: buildTemplate(item.submenu!) } : {}),
                ...(hasSubmenu ? {} : { click: () => resolveOnce(item.id) }),
              };

              return base;
            });
          };

          const menu = Menu.buildFromTemplate(buildTemplate(sanitized.template));

          menu.popup({
            window: win,
            ...(sanitized.x !== undefined ? { x: sanitized.x } : {}),
            ...(sanitized.y !== undefined ? { y: sanitized.y } : {}),
            callback: () => resolveOnce(null),
          });
        });
      },
      { withContext: true }
    ),
  },
});

export function registerMenuHandlers(_deps: HandlerDependencies): () => void {
  return menuNamespace.register();
}
