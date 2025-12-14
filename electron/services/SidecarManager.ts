import { BrowserWindow, WebContentsView } from "electron";
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

          if (!hasFileData) {
            // No file data - let native paste handle it (text, images, rich content)
            return;
          }

          // File data detected - intercept and handle
          event.preventDefault();

          ClipboardFileInjector.getFilePathsFromClipboard()
            .then(async (filePaths) => {
              if (filePaths.length > 0) {
                if (filePaths.length > 1) {
                  console.warn(
                    `[SidecarManager] Multiple files in clipboard (${filePaths.length}), pasting first only`
                  );
                }

                try {
                  await ClipboardFileInjector.injectFileIntoPaste(view.webContents, filePaths[0]);
                } catch (error) {
                  console.error("[SidecarManager] Failed to inject file paste:", error);
                  // Fallback to native paste on injection failure
                  view.webContents.paste();
                }
              } else {
                // File format detected but validation failed (too large, outside home, etc.)
                // Fall back to native paste
                view.webContents.paste();
              }
            })
            .catch((error) => {
              console.error("[SidecarManager] Error checking clipboard for files:", error);
              // Always fallback to native paste on error
              view.webContents.paste();
            });
        }
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
