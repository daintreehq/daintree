import { BrowserWindow, Menu, WebContentsView, app, clipboard } from "electron";
import type { PortalBounds, PortalNavEvent } from "../../shared/types/portal.js";
import { CHANNELS } from "../ipc/channels.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";

export const PORTAL_MAX_LIVE_TABS = 3;

export class PortalManager {
  private window: BrowserWindow;
  private viewMap = new Map<string, WebContentsView>();
  private activeView: WebContentsView | null = null;
  private activeTabId: string | null = null;
  private lruOrder = new Map<string, true>();

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  private touchLru(tabId: string): void {
    this.lruOrder.delete(tabId);
    this.lruOrder.set(tabId, true);
  }

  private destroyView(tabId: string): void {
    const view = this.viewMap.get(tabId);
    if (!view) return;

    if (this.activeView === view) {
      try {
        this.window.contentView.removeChildView(view);
      } catch {
        // ignore if already removed
      }
      this.activeView = null;
      this.activeTabId = null;
    }

    try {
      view.webContents.close();
    } catch (error) {
      console.error(`[PortalManager] Error closing view for tab ${tabId}:`, error);
    }

    this.viewMap.delete(tabId);
    this.lruOrder.delete(tabId);
  }

  private evictIfNeeded(): void {
    if (this.lruOrder.size <= PORTAL_MAX_LIVE_TABS) return;

    for (const tabId of this.lruOrder.keys()) {
      if (tabId === this.activeTabId) continue;
      if (!this.viewMap.has(tabId)) {
        this.lruOrder.delete(tabId);
        continue;
      }

      this.destroyView(tabId);

      if (!this.window?.isDestroyed()) {
        this.window.webContents.send(CHANNELS.PORTAL_TAB_EVICTED, { tabId });
      }
      break;
    }
  }

  createTab(tabId: string, url: string): void {
    console.log(`[PortalManager] Creating tab ${tabId} for ${url}`);
    if (this.viewMap.has(tabId)) return;

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}`);
      }
    } catch (error) {
      console.error(`[PortalManager] Invalid URL for tab ${tabId}:`, error);
      return;
    }

    try {
      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: "persist:portal",
          navigateOnDragDrop: false,
          disableBlinkFeatures: "Auxclick",
        },
      });

      view.webContents.setWindowOpenHandler(({ url }) => {
        if (typeof url === "string" && url.trim()) {
          void openExternalUrl(url).catch((error) => {
            console.error("[PortalManager] Failed to open window URL:", error);
          });
        }
        return { action: "deny" };
      });

      const sendNavEvent = (navEvent: PortalNavEvent) => {
        if (!this.window?.isDestroyed()) {
          this.window.webContents.send(CHANNELS.PORTAL_NAV_EVENT, navEvent);
        }
      };

      view.webContents.on("page-title-updated", (_, title) => {
        sendNavEvent({
          tabId,
          title,
          url: view.webContents.getURL(),
        });
      });

      view.webContents.on("did-navigate", (_, url) => {
        sendNavEvent({
          tabId,
          title: view.webContents.getTitle(),
          url,
        });
      });

      view.webContents.on("did-navigate-in-page", (_, url) => {
        sendNavEvent({
          tabId,
          title: view.webContents.getTitle(),
          url,
        });
      });

      view.webContents.once("destroyed", () => {
        this.viewMap.delete(tabId);
        this.lruOrder.delete(tabId);
        if (this.activeTabId === tabId) {
          try {
            this.window.contentView.removeChildView(view);
          } catch {
            // ignore if already removed
          }
          this.activeView = null;
          this.activeTabId = null;
        }
      });

      view.webContents.on("focus", () => {
        if (!this.window?.isDestroyed()) {
          this.window.webContents.send(CHANNELS.PORTAL_FOCUS);
        }
      });

      view.webContents.on("blur", () => {
        if (!this.window?.isDestroyed()) {
          this.window.webContents.send(CHANNELS.PORTAL_BLUR);
        }
      });

      view.webContents.on("context-menu", (_event, params) => {
        const win = this.window;
        if (!win || win.isDestroyed()) return;

        const template: Electron.MenuItemConstructorOptions[] = [];

        const isEditable = params.isEditable;
        const canCopy = params.editFlags.canCopy || (params.selectionText ?? "").trim().length > 0;
        const canCut = params.editFlags.canCut;
        const canPaste = params.editFlags.canPaste;

        if (isEditable || canCopy) {
          if (isEditable) {
            template.push(
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut", enabled: canCut },
              { role: "copy", enabled: canCopy },
              {
                label: "Paste",
                enabled: canPaste,
                click: () => view.webContents.paste(),
              },
              { role: "selectAll" }
            );
          } else {
            template.push({ role: "copy", enabled: canCopy });
          }
          template.push({ type: "separator" });
        }

        const linkUrl = params.linkURL?.trim();
        if (linkUrl) {
          template.push(
            {
              label: "Open Link in Browser",
              enabled: canOpenExternalUrl(linkUrl),
              click: () => {
                void openExternalUrl(linkUrl).catch((error) => {
                  console.error("[PortalManager] Failed to open link URL:", error);
                });
              },
            },
            {
              label: "Copy Link Address",
              click: () => clipboard.writeText(linkUrl),
            },
            { type: "separator" }
          );
        }

        template.push(
          {
            label: "Back",
            enabled: view.webContents.canGoBack(),
            click: () => view.webContents.goBack(),
          },
          {
            label: "Forward",
            enabled: view.webContents.canGoForward(),
            click: () => view.webContents.goForward(),
          },
          { label: "Reload", click: () => view.webContents.reload() },
          { type: "separator" }
        );

        const pageUrl = (params.pageURL ?? view.webContents.getURL()).trim();
        if (pageUrl) {
          template.push(
            { label: "Copy Page URL", click: () => clipboard.writeText(pageUrl) },
            {
              label: "Open Page in Browser",
              enabled: canOpenExternalUrl(pageUrl),
              click: () => {
                void openExternalUrl(pageUrl).catch((error) => {
                  console.error("[PortalManager] Failed to open page URL:", error);
                });
              },
            }
          );
        }

        if (!app.isPackaged) {
          template.push(
            { type: "separator" },
            {
              label: "Inspect Element",
              click: () => view.webContents.inspectElement(params.x, params.y),
            }
          );
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: win });
      });

      view.webContents.loadURL(url).catch((err) => {
        console.error(`[PortalManager] Failed to load URL ${url} in tab ${tabId}:`, err);
      });
      this.viewMap.set(tabId, view);
      this.touchLru(tabId);
      this.evictIfNeeded();
    } catch (error) {
      console.error(`[PortalManager] Failed to create tab ${tabId}:`, error);
      throw error;
    }
  }

  showTab(tabId: string, bounds: PortalBounds): void {
    console.log(`[PortalManager] Showing tab ${tabId}`, bounds);
    const view = this.viewMap.get(tabId);
    if (!view) return;

    if (this.activeView && this.activeView !== view) {
      this.window.contentView.removeChildView(this.activeView);
    }

    if (this.activeView !== view) {
      this.window.contentView.addChildView(view);
    }

    const validatedBounds = this.validateBounds(bounds);
    view.setBounds(validatedBounds);
    this.activeView = view;
    this.activeTabId = tabId;
    this.touchLru(tabId);
    this.evictIfNeeded();
  }

  private validateBounds(bounds: PortalBounds): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const x = Number.isFinite(bounds.x) ? Math.max(0, Math.round(bounds.x)) : 0;
    const y = Number.isFinite(bounds.y) ? Math.max(0, Math.round(bounds.y)) : 0;
    const width = Number.isFinite(bounds.width) ? Math.max(100, Math.round(bounds.width)) : 800;
    const height = Number.isFinite(bounds.height) ? Math.max(100, Math.round(bounds.height)) : 600;

    return { x, y, width, height };
  }

  hideAll(): void {
    if (this.activeView) {
      this.window.contentView.removeChildView(this.activeView);
      this.activeView = null;
      this.activeTabId = null;
    }
  }

  updateBounds(bounds: PortalBounds): void {
    if (this.activeView) {
      const validatedBounds = this.validateBounds(bounds);
      this.activeView.setBounds(validatedBounds);
    }
  }

  closeTab(tabId: string): void {
    this.destroyView(tabId);
  }

  navigate(tabId: string, url: string): void {
    const view = this.viewMap.get(tabId);
    if (!view) return;

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}`);
      }
      view.webContents.loadURL(url).catch((err) => {
        console.error(`[PortalManager] Failed to navigate tab ${tabId} to ${url}:`, err);
      });
    } catch (error) {
      console.error(`[PortalManager] Invalid navigation URL for tab ${tabId}:`, error);
    }
  }

  goBack(tabId: string): boolean {
    const view = this.viewMap.get(tabId);
    if (!view || !view.webContents.canGoBack()) return false;
    view.webContents.goBack();
    return true;
  }

  goForward(tabId: string): boolean {
    const view = this.viewMap.get(tabId);
    if (!view || !view.webContents.canGoForward()) return false;
    view.webContents.goForward();
    return true;
  }

  reload(tabId: string): void {
    const view = this.viewMap.get(tabId);
    if (!view) return;
    view.webContents.reload();
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  hasTab(tabId: string): boolean {
    return this.viewMap.has(tabId);
  }

  destroy(): void {
    const tabIds = [...this.viewMap.keys()];
    for (const tabId of tabIds) {
      this.destroyView(tabId);
    }
    this.activeView = null;
    this.activeTabId = null;
  }
}
