import { BrowserWindow, Menu, WebContentsView, app, clipboard, shell } from "electron";
import type { SidecarBounds, SidecarNavEvent } from "../../shared/types/sidecar.js";
import { CHANNELS } from "../ipc/channels.js";
import { ClipboardFileInjector } from "./ClipboardFileInjector.js";

export class SidecarManager {
  private window: BrowserWindow;
  private viewMap = new Map<string, WebContentsView>();
  private activeView: WebContentsView | null = null;
  private activeTabId: string | null = null;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  private async pasteFromClipboard(webContents: Electron.WebContents): Promise<void> {
    const hasFileData = ClipboardFileInjector.hasFileDataInClipboard();
    if (!hasFileData) {
      webContents.paste();
      return;
    }

    try {
      const filePaths = await ClipboardFileInjector.getFilePathsFromClipboard();
      if (filePaths.length === 0) {
        webContents.paste();
        return;
      }

      if (filePaths.length > 1) {
        console.warn(
          `[SidecarManager] Multiple files in clipboard (${filePaths.length}), pasting first only`
        );
      }

      await ClipboardFileInjector.injectFileIntoPaste(webContents, filePaths[0]);
    } catch (error) {
      console.error("[SidecarManager] Failed to paste from clipboard:", error);
      webContents.paste();
    }
  }

  createTab(tabId: string, url: string): void {
    console.log(`[SidecarManager] Creating tab ${tabId} for ${url}`);
    if (this.viewMap.has(tabId)) return;

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}`);
      }
    } catch (error) {
      console.error(`[SidecarManager] Invalid URL for tab ${tabId}:`, error);
      return;
    }

    try {
      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: "persist:sidecar",
        },
      });

      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      const sendNavEvent = (navEvent: SidecarNavEvent) => {
        if (!this.window?.isDestroyed()) {
          this.window.webContents.send(CHANNELS.SIDECAR_NAV_EVENT, navEvent);
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
          this.window.webContents.send(CHANNELS.SIDECAR_FOCUS);
        }
      });

      view.webContents.on("blur", () => {
        if (!this.window?.isDestroyed()) {
          this.window.webContents.send(CHANNELS.SIDECAR_BLUR);
        }
      });

      view.webContents.on("before-input-event", (event, input) => {
        const isMac = process.platform === "darwin";
        const isPasteShortcut =
          input.key.toLowerCase() === "v" &&
          ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
          !input.alt &&
          !input.shift &&
          input.type === "keyDown";

        if (isPasteShortcut) {
          // Check synchronously if clipboard has file data before intercepting
          const hasFileData = ClipboardFileInjector.hasFileDataInClipboard();
          if (!hasFileData) return;

          event.preventDefault();
          void this.pasteFromClipboard(view.webContents);
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
                click: () => void this.pasteFromClipboard(view.webContents),
              },
              { role: "selectAll" }
            );
          } else {
            template.push({ role: "copy", enabled: canCopy });
          }
          template.push({ type: "separator" });
        }

        if (params.linkURL && params.linkURL.trim()) {
          template.push(
            {
              label: "Open Link in Browser",
              click: () => void shell.openExternal(params.linkURL),
            },
            {
              label: "Copy Link Address",
              click: () => clipboard.writeText(params.linkURL),
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
            { label: "Open Page in Browser", click: () => void shell.openExternal(pageUrl) }
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
        console.error(`[SidecarManager] Failed to load URL ${url} in tab ${tabId}:`, err);
      });
      this.viewMap.set(tabId, view);
    } catch (error) {
      console.error(`[SidecarManager] Failed to create tab ${tabId}:`, error);
      throw error;
    }
  }

  showTab(tabId: string, bounds: SidecarBounds): void {
    console.log(`[SidecarManager] Showing tab ${tabId}`, bounds);
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
  }

  private validateBounds(bounds: SidecarBounds): {
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

  updateBounds(bounds: SidecarBounds): void {
    if (this.activeView) {
      const validatedBounds = this.validateBounds(bounds);
      this.activeView.setBounds(validatedBounds);
    }
  }

  closeTab(tabId: string): void {
    const view = this.viewMap.get(tabId);
    if (!view) return;

    if (this.activeView === view) {
      this.window.contentView.removeChildView(view);
      this.activeView = null;
      this.activeTabId = null;
    }

    try {
      view.webContents.close();
    } catch (error) {
      console.error(`[SidecarManager] Error closing tab ${tabId}:`, error);
    }

    this.viewMap.delete(tabId);
  }

  navigate(tabId: string, url: string): void {
    const view = this.viewMap.get(tabId);
    if (!view) return;

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}`);
      }
      view.webContents.loadURL(url);
    } catch (error) {
      console.error(`[SidecarManager] Invalid navigation URL for tab ${tabId}:`, error);
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
    this.viewMap.forEach((view) => {
      try {
        if (this.activeView === view) {
          this.window.contentView.removeChildView(view);
        }
        view.webContents.close();
      } catch (error) {
        console.error("[SidecarManager] Error destroying view:", error);
      }
    });
    this.viewMap.clear();
    this.activeView = null;
    this.activeTabId = null;
  }
}
