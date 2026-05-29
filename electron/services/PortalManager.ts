import { BrowserWindow, Menu, WebContentsView, app, clipboard } from "electron";
import type { PortalBounds, PortalNavEvent } from "../../shared/types/portal.js";
import { isSafeNavigationUrl } from "../../shared/utils/urlUtils.js";
import { CHANNELS } from "../ipc/channels.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getAppWebContents } from "../window/webContentsRegistry.js";

export const PORTAL_MAX_LIVE_TABS = 3;

// Negative coordinates park a hidden view far enough off-screen that no part of
// it is composited on any monitor configuration, but keeps the WebContentsView
// in the contentView child list so its renderer state (scroll, in-flight
// requests, WebSocket/SSE connections) is preserved across overlay open/close.
// Bypasses validateBounds() which clamps x/y to 0.
const OFFSCREEN_BOUNDS = { x: -99999, y: -99999, width: 1, height: 1 } as const;

export class PortalManager {
  private window: BrowserWindow;
  private viewMap = new Map<string, WebContentsView>();
  private activeView: WebContentsView | null = null;
  private activeTabId: string | null = null;
  private lruOrder = new Map<string, true>();
  private lastShownTabId: string | null = null;
  // True while the active view is parked offscreen by hideAll(). Guards
  // updateBounds() so a window resize during an open overlay does not pull
  // the hidden view back on top of the overlay.
  private hidden = false;
  private readonly backgroundColor: string;
  private readonly attachedViews = new Set<WebContentsView>();
  private readonly lastShownBounds = new Map<string, { width: number; height: number }>();

  constructor(window: BrowserWindow, backgroundColor: string = "#000000") {
    this.window = window;
    this.backgroundColor = backgroundColor;
  }

  private sendToApp(channel: string, ...args: unknown[]): void {
    if (this.window?.isDestroyed()) return;
    const wc = getAppWebContents(this.window);
    if (!wc.isDestroyed()) {
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  }

  private touchLru(tabId: string): void {
    this.lruOrder.delete(tabId);
    this.lruOrder.set(tabId, true);
  }

  private async destroyView(tabId: string): Promise<void> {
    const view = this.viewMap.get(tabId);
    if (!view) return;

    // Detach state synchronously first so hasTab() returns false immediately
    this.viewMap.delete(tabId);
    this.lruOrder.delete(tabId);
    this.lastShownBounds.delete(tabId);

    // Any attached view (active or parked offscreen) must be detached from the
    // contentView child list before its webContents is closed — otherwise the
    // compositor holds a dangling reference.
    if (this.attachedViews.has(view)) {
      try {
        this.window.contentView.removeChildView(view);
      } catch {
        // ignore if already removed
      }
      this.attachedViews.delete(view);
    }

    if (this.activeView === view) {
      this.activeView = null;
      this.activeTabId = null;
      this.hidden = false;
    }

    // Flush storage before closing to prevent localStorage data loss
    if (!view.webContents.isDestroyed()) {
      try {
        await view.webContents.session.flushStorageData();
      } catch {
        // Best-effort flush — proceed to close even if flush fails
      }
    }

    try {
      view.webContents.close();
    } catch (error) {
      console.error(`[PortalManager] Error closing view for tab ${tabId}:`, error);
    }
  }

  private evictIfNeeded(): void {
    if (this.lruOrder.size <= PORTAL_MAX_LIVE_TABS) return;

    for (const tabId of this.lruOrder.keys()) {
      if (tabId === this.activeTabId) continue;
      if (!this.viewMap.has(tabId)) {
        this.lruOrder.delete(tabId);
        continue;
      }

      // Fire-and-forget: eviction is synchronous caller path, flush is best-effort
      void this.destroyView(tabId);

      this.sendToApp(CHANNELS.PORTAL_TAB_EVICTED, { tabId });
      break;
    }
  }

  createTab(tabId: string, url: string, partition: string = "persist:portal"): void {
    console.log(`[PortalManager] Creating tab ${tabId} for ${url} on ${partition}`);
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
          partition,
          navigateOnDragDrop: false,
          disableBlinkFeatures: "Auxclick",
        },
      });

      // Set before loadURL so the first paint matches the app's window
      // background instead of the default opaque white — fixes #9207 flash.
      view.setBackgroundColor(this.backgroundColor);

      view.webContents.setWindowOpenHandler(({ url }) => {
        if (typeof url === "string" && url.trim()) {
          void openExternalUrl(url).catch((error) => {
            console.error("[PortalManager] Failed to open window URL:", error);
          });
        }
        return { action: "deny" };
      });

      const sendNavEvent = (navEvent: PortalNavEvent) => {
        this.sendToApp(CHANNELS.PORTAL_NAV_EVENT, navEvent);
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
        this.lastShownBounds.delete(tabId);
        // Detach if attached — covers both the active view and any view parked
        // offscreen via hideAll().
        if (this.attachedViews.has(view)) {
          try {
            this.window.contentView.removeChildView(view);
          } catch {
            // ignore if already removed
          }
          this.attachedViews.delete(view);
        }
        if (this.activeTabId === tabId) {
          this.activeView = null;
          this.activeTabId = null;
          this.hidden = false;
        }
      });

      view.webContents.on("focus", () => {
        this.sendToApp(CHANNELS.PORTAL_FOCUS);
      });

      view.webContents.on("blur", () => {
        this.sendToApp(CHANNELS.PORTAL_BLUR);
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

      view.webContents.on("will-navigate", (event, navigationUrl) => {
        if (!isSafeNavigationUrl(navigationUrl)) {
          console.warn(`[PortalManager] Blocked portal navigation to unsafe URL: ${navigationUrl}`);
          event.preventDefault();
        }
      });

      view.webContents.on("will-redirect", (event, redirectUrl) => {
        if (!isSafeNavigationUrl(redirectUrl)) {
          console.warn(`[PortalManager] Blocked portal redirect to unsafe URL: ${redirectUrl}`);
          event.preventDefault();
        }
      });

      // Subframe coverage: will-navigate is main-frame only, so iframes inside
      // a portal page can otherwise navigate to file:/data:/etc. unblocked.
      view.webContents.on("will-frame-navigate", (details) => {
        if (!isSafeNavigationUrl(details.url)) {
          console.warn(
            `[PortalManager] Blocked portal frame navigation to unsafe URL: ${details.url}`
          );
          details.preventDefault();
        }
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

    // Park the previously-active view offscreen instead of detaching it —
    // keeps its renderer state (scroll, in-flight requests, sockets) alive.
    if (this.activeView && this.activeView !== view) {
      this.activeView.setBounds(OFFSCREEN_BOUNDS);
    }

    // Attach on first show only; subsequent shows just move bounds.
    // addChildView throws if the view is already a child.
    if (!this.attachedViews.has(view)) {
      this.window.contentView.addChildView(view);
      this.attachedViews.add(view);
    }

    const validatedBounds = this.validateBounds(bounds);
    view.setBounds(validatedBounds);
    this.lastShownBounds.set(tabId, {
      width: validatedBounds.width,
      height: validatedBounds.height,
    });
    this.activeView = view;
    this.activeTabId = tabId;
    this.hidden = false;
    this.touchLru(tabId);
    this.evictIfNeeded();
    this.lastShownTabId = tabId;
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
    // Park the active view offscreen instead of removing it from the
    // contentView child list — the detach/reattach cycle that overlay
    // open/close used to perform resets embedded page state (chat scroll,
    // in-flight responses). Keep activeView/activeTabId set so the same tab
    // re-appears when the overlay closes and so destroyHiddenTabs() still
    // protects the right tab from memory-pressure eviction.
    if (this.activeView) {
      this.activeView.setBounds(OFFSCREEN_BOUNDS);
      this.hidden = true;
      // Return focus to the main app webContents. The old removeChildView
      // path implicitly blurred the portal view; keep that behavior so
      // keyboard input goes to the overlay's focus-trap (in the renderer's
      // V8 context), not the now-hidden portal page.
      if (!this.window.isDestroyed()) {
        try {
          const appWc = getAppWebContents(this.window);
          if (!appWc.isDestroyed()) {
            appWc.focus();
          }
        } catch {
          // Best-effort focus return; never block overlay open on this.
        }
      }
    }
  }

  updateBounds(bounds: PortalBounds): void {
    // Renderer-side syncBounds (PortalDock ResizeObserver + window resize
    // listener) only gates on activeTabId, which is preserved across
    // hideAll(). Without this guard a window resize while an overlay is open
    // would re-show the parked view on top of the overlay.
    if (this.hidden) return;
    if (this.activeView) {
      const validatedBounds = this.validateBounds(bounds);
      this.activeView.setBounds(validatedBounds);
    }
  }

  async closeTab(tabId: string): Promise<void> {
    await this.destroyView(tabId);
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

  async destroyHiddenTabs(): Promise<string[]> {
    // Use lastShownTabId as fallback when activeTabId is null (e.g., hideAll was called for overlays)
    const skipId = this.activeTabId ?? this.lastShownTabId;
    const destroyed: string[] = [];
    for (const tabId of [...this.viewMap.keys()]) {
      if (tabId === skipId) continue;
      destroyed.push(tabId);
    }
    if (destroyed.length > 0) {
      await Promise.allSettled(destroyed.map((tabId) => this.destroyView(tabId)));
      console.log(
        `[PortalManager] Destroyed ${destroyed.length} hidden tab(s) for memory pressure`
      );
    }
    return destroyed;
  }

  destroy(): void {
    const tabIds = [...this.viewMap.keys()];
    for (const tabId of tabIds) {
      // Fire-and-forget: window teardown is best-effort; Electron flushes sessions on shutdown
      void this.destroyView(tabId);
    }
    this.activeView = null;
    this.activeTabId = null;
    this.lastShownTabId = null;
    this.hidden = false;
    this.attachedViews.clear();
    this.lastShownBounds.clear();
  }
}
