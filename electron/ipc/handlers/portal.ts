import { Menu, ipcMain } from "electron";
import { getWindowForWebContents, getAppWebContents } from "../../window/webContentsRegistry.js";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  PortalCreatePayload,
  PortalShowPayload,
  PortalCloseTabPayload,
  PortalNavigatePayload,
  PortalBounds,
  PortalShowNewTabMenuPayload,
  PortalNewTabMenuAction,
} from "../../../shared/types/portal.js";

export function registerPortalHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const isValidBounds = (bounds: unknown): bounds is PortalBounds => {
    if (!bounds || typeof bounds !== "object") return false;
    const candidate = bounds as Partial<PortalBounds>;
    return (
      typeof candidate.x === "number" &&
      Number.isFinite(candidate.x) &&
      typeof candidate.y === "number" &&
      Number.isFinite(candidate.y) &&
      typeof candidate.width === "number" &&
      Number.isFinite(candidate.width) &&
      typeof candidate.height === "number" &&
      Number.isFinite(candidate.height)
    );
  };

  const sendMenuAction = (win: Electron.BrowserWindow, action: string) => {
    try {
      const appWebContents = getAppWebContents(win);
      if (appWebContents.isDestroyed()) return;
      appWebContents.send(CHANNELS.MENU_ACTION, action);
    } catch (error) {
      console.warn("[PortalHandler] Failed to send portal menu action:", error);
    }
  };

  const handlePortalCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: PortalCreatePayload
  ) => {
    try {
      if (!deps.portalManager) return;
      if (!payload?.tabId || typeof payload.tabId !== "string") {
        throw new Error("Invalid tabId");
      }
      if (!payload?.url || typeof payload.url !== "string") {
        throw new Error("Invalid url");
      }
      deps.portalManager.createTab(payload.tabId, payload.url);
    } catch (error) {
      console.error("[PortalHandler] Error in create:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.PORTAL_CREATE, handlePortalCreate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_CREATE));

  const handlePortalShow = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: PortalShowPayload
  ) => {
    try {
      if (!deps.portalManager) return;
      if (!payload?.tabId || typeof payload.tabId !== "string") {
        throw new Error("Invalid tabId");
      }
      if (!isValidBounds(payload?.bounds)) {
        throw new Error("Invalid bounds");
      }
      deps.portalManager.showTab(payload.tabId, payload.bounds);
    } catch (error) {
      console.error("[PortalHandler] Error in show:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.PORTAL_SHOW, handlePortalShow);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_SHOW));

  const handlePortalHide = async () => {
    if (!deps.portalManager) return;
    deps.portalManager.hideAll();
  };
  ipcMain.handle(CHANNELS.PORTAL_HIDE, handlePortalHide);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_HIDE));

  const handlePortalResize = async (_event: Electron.IpcMainInvokeEvent, bounds: PortalBounds) => {
    try {
      if (!deps.portalManager) return;
      if (!isValidBounds(bounds)) {
        throw new Error("Invalid bounds");
      }
      deps.portalManager.updateBounds(bounds);
    } catch (error) {
      console.error("[PortalHandler] Error in resize:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.PORTAL_RESIZE, handlePortalResize);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_RESIZE));

  const handlePortalCloseTab = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: PortalCloseTabPayload
  ) => {
    if (!deps.portalManager) return;
    if (!payload || typeof payload !== "object" || typeof payload.tabId !== "string") {
      return;
    }
    await deps.portalManager.closeTab(payload.tabId);
  };
  ipcMain.handle(CHANNELS.PORTAL_CLOSE_TAB, handlePortalCloseTab);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_CLOSE_TAB));

  const handlePortalNavigate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: PortalNavigatePayload
  ) => {
    if (!deps.portalManager) return;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.tabId !== "string" ||
      typeof payload.url !== "string"
    ) {
      return;
    }
    deps.portalManager.navigate(payload.tabId, payload.url);
  };
  ipcMain.handle(CHANNELS.PORTAL_NAVIGATE, handlePortalNavigate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_NAVIGATE));

  const handlePortalGoBack = async (
    _event: Electron.IpcMainInvokeEvent,
    tabId: string
  ): Promise<boolean> => {
    if (!deps.portalManager) return false;
    if (typeof tabId !== "string") return false;
    return deps.portalManager.goBack(tabId);
  };
  ipcMain.handle(CHANNELS.PORTAL_GO_BACK, handlePortalGoBack);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_GO_BACK));

  const handlePortalGoForward = async (
    _event: Electron.IpcMainInvokeEvent,
    tabId: string
  ): Promise<boolean> => {
    if (!deps.portalManager) return false;
    if (typeof tabId !== "string") return false;
    return deps.portalManager.goForward(tabId);
  };
  ipcMain.handle(CHANNELS.PORTAL_GO_FORWARD, handlePortalGoForward);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_GO_FORWARD));

  const handlePortalReload = async (_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    if (!deps.portalManager) return;
    if (typeof tabId !== "string") return;
    deps.portalManager.reload(tabId);
  };
  ipcMain.handle(CHANNELS.PORTAL_RELOAD, handlePortalReload);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_RELOAD));

  const handleShowNewTabMenu = async (
    event: Electron.IpcMainInvokeEvent,
    payload: PortalShowNewTabMenuPayload
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

    const win = getWindowForWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    const sendAction = (action: PortalNewTabMenuAction) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(CHANNELS.PORTAL_NEW_TAB_MENU_ACTION, action);
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
            label: "Manage Portal Settings...",
            click: () => sendMenuAction(win, "open-settings:portal"),
          },
        ],
      },
      {
        label: "Manage Portal Settings...",
        click: () => sendMenuAction(win, "open-settings:portal"),
      },
    ]);

    menu.popup({ window: win, x, y });
  };
  ipcMain.handle(CHANNELS.PORTAL_SHOW_NEW_TAB_MENU, handleShowNewTabMenu);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PORTAL_SHOW_NEW_TAB_MENU));

  return () => handlers.forEach((cleanup) => cleanup());
}
