import { BrowserWindow, Menu, ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  SidecarCreatePayload,
  SidecarShowPayload,
  SidecarCloseTabPayload,
  SidecarNavigatePayload,
  SidecarBounds,
  SidecarShowNewTabMenuPayload,
  SidecarNewTabMenuAction,
} from "../../../shared/types/sidecar.js";

export function registerSidecarHandlers(deps: HandlerDependencies): () => void {
  const { sidecarManager } = deps;
  const handlers: Array<() => void> = [];

  const handleSidecarCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SidecarCreatePayload
  ) => {
    try {
      if (!sidecarManager) return;
      if (!payload?.tabId || typeof payload.tabId !== "string") {
        throw new Error("Invalid tabId");
      }
      if (!payload?.url || typeof payload.url !== "string") {
        throw new Error("Invalid url");
      }
      sidecarManager.createTab(payload.tabId, payload.url);
    } catch (error) {
      console.error("[SidecarHandler] Error in create:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SIDECAR_CREATE, handleSidecarCreate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_CREATE));

  const handleSidecarShow = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SidecarShowPayload
  ) => {
    try {
      if (!sidecarManager) return;
      if (!payload?.tabId || typeof payload.tabId !== "string") {
        throw new Error("Invalid tabId");
      }
      if (!payload?.bounds || typeof payload.bounds !== "object") {
        throw new Error("Invalid bounds");
      }
      sidecarManager.showTab(payload.tabId, payload.bounds);
    } catch (error) {
      console.error("[SidecarHandler] Error in show:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SIDECAR_SHOW, handleSidecarShow);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_SHOW));

  const handleSidecarHide = async () => {
    if (!sidecarManager) return;
    sidecarManager.hideAll();
  };
  ipcMain.handle(CHANNELS.SIDECAR_HIDE, handleSidecarHide);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_HIDE));

  const handleSidecarResize = async (
    _event: Electron.IpcMainInvokeEvent,
    bounds: SidecarBounds
  ) => {
    try {
      if (!sidecarManager) return;
      if (!bounds || typeof bounds !== "object") {
        throw new Error("Invalid bounds");
      }
      sidecarManager.updateBounds(bounds);
    } catch (error) {
      console.error("[SidecarHandler] Error in resize:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SIDECAR_RESIZE, handleSidecarResize);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_RESIZE));

  const handleSidecarCloseTab = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SidecarCloseTabPayload
  ) => {
    if (!sidecarManager) return;
    if (!payload || typeof payload !== "object" || typeof payload.tabId !== "string") {
      return;
    }
    sidecarManager.closeTab(payload.tabId);
  };
  ipcMain.handle(CHANNELS.SIDECAR_CLOSE_TAB, handleSidecarCloseTab);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_CLOSE_TAB));

  const handleSidecarNavigate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SidecarNavigatePayload
  ) => {
    if (!sidecarManager) return;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.tabId !== "string" ||
      typeof payload.url !== "string"
    ) {
      return;
    }
    sidecarManager.navigate(payload.tabId, payload.url);
  };
  ipcMain.handle(CHANNELS.SIDECAR_NAVIGATE, handleSidecarNavigate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_NAVIGATE));

  const handleSidecarGoBack = async (
    _event: Electron.IpcMainInvokeEvent,
    tabId: string
  ): Promise<boolean> => {
    if (!sidecarManager) return false;
    if (typeof tabId !== "string") return false;
    return sidecarManager.goBack(tabId);
  };
  ipcMain.handle(CHANNELS.SIDECAR_GO_BACK, handleSidecarGoBack);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_GO_BACK));

  const handleSidecarGoForward = async (
    _event: Electron.IpcMainInvokeEvent,
    tabId: string
  ): Promise<boolean> => {
    if (!sidecarManager) return false;
    if (typeof tabId !== "string") return false;
    return sidecarManager.goForward(tabId);
  };
  ipcMain.handle(CHANNELS.SIDECAR_GO_FORWARD, handleSidecarGoForward);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_GO_FORWARD));

  const handleSidecarReload = async (_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    if (!sidecarManager) return;
    if (typeof tabId !== "string") return;
    sidecarManager.reload(tabId);
  };
  ipcMain.handle(CHANNELS.SIDECAR_RELOAD, handleSidecarReload);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_RELOAD));

  const handleShowNewTabMenu = async (
    event: Electron.IpcMainInvokeEvent,
    payload: SidecarShowNewTabMenuPayload
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") return;
    if (!Array.isArray(payload.links)) return;

    const x = Number.isFinite(payload.x) ? Math.round(payload.x) : 0;
    const y = Number.isFinite(payload.y) ? Math.round(payload.y) : 0;
    const defaultNewTabUrl =
      payload.defaultNewTabUrl === null ||
      (typeof payload.defaultNewTabUrl === "string" && payload.defaultNewTabUrl.trim())
        ? payload.defaultNewTabUrl
        : null;

    const links = payload.links
      .filter(
        (l): l is { title: string; url: string } =>
          !!l &&
          typeof l === "object" &&
          typeof (l as { title?: unknown }).title === "string" &&
          typeof (l as { url?: unknown }).url === "string" &&
          (l as { title: string }).title.trim() !== "" &&
          (l as { url: string }).url.trim() !== ""
      )
      .map((l) => ({ title: l.title.trim(), url: l.url.trim() }));

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    const sendAction = (action: SidecarNewTabMenuAction) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(CHANNELS.SIDECAR_NEW_TAB_MENU_ACTION, action);
    };

    const menu = Menu.buildFromTemplate([
      ...links.map((link) => ({
        label: link.title,
        click: () => sendAction({ type: "open-url", url: link.url, title: link.title }),
      })),
      ...(links.length > 0 ? [{ type: "separator" as const }] : []),
      {
        label: "Launchpad (Pick provider...)",
        click: () => sendAction({ type: "open-launchpad" }),
      },
      { type: "separator" as const },
      {
        label: "Default New Tab",
        submenu: [
          {
            label: "Launchpad",
            type: "radio" as const,
            checked: defaultNewTabUrl === null,
            click: () => sendAction({ type: "set-default-new-tab-url", url: null }),
          },
          ...(links.length > 0 ? [{ type: "separator" as const }] : []),
          ...links.map((link) => ({
            label: link.title,
            type: "radio" as const,
            checked: defaultNewTabUrl === link.url,
            click: () => sendAction({ type: "set-default-new-tab-url", url: link.url }),
          })),
          ...(links.length > 0 ? [{ type: "separator" as const }] : []),
          {
            label: "Manage Sidecar Settings...",
            click: () => win.webContents.send(CHANNELS.MENU_ACTION, "open-settings:sidecar"),
          },
        ],
      },
      {
        label: "Manage Sidecar Settings...",
        click: () => win.webContents.send(CHANNELS.MENU_ACTION, "open-settings:sidecar"),
      },
    ]);

    menu.popup({ window: win, x, y });
  };
  ipcMain.handle(CHANNELS.SIDECAR_SHOW_NEW_TAB_MENU, handleShowNewTabMenu);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SIDECAR_SHOW_NEW_TAB_MENU));

  return () => handlers.forEach((cleanup) => cleanup());
}
