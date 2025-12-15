import { BrowserWindow, Menu, ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { MenuItemOption, ShowContextMenuPayload } from "../../../shared/types/menu.js";

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

export function registerMenuHandlers(_deps: HandlerDependencies): () => void {
  const handleShowContext = async (
    event: Electron.IpcMainInvokeEvent,
    payload: ShowContextMenuPayload
  ): Promise<string | null> => {
    const sanitized = sanitizeShowContextMenuPayload(payload);
    if (!sanitized || sanitized.template.length === 0) return null;

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return null;

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const buildTemplate = (items: MenuItemOption[]): Electron.MenuItemConstructorOptions[] => {
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
  };

  ipcMain.handle(CHANNELS.MENU_SHOW_CONTEXT, handleShowContext);
  return () => ipcMain.removeHandler(CHANNELS.MENU_SHOW_CONTEXT);
}
