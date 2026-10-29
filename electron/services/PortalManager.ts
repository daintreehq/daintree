import { BrowserWindow, Menu, WebContentsView, app, clipboard } from "electron";
import type { PortalBounds, PortalNavEvent } from "../../shared/types/portal.js";
import { isSafeNavigationUrl } from "../../shared/utils/urlUtils.js";
import { CHANNELS } from "../ipc/channels.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getAppWebContents, getWindowAppWebContents } from "../window/webContentsRegistry.js";
import { unthrottleCpuWebContents } from "../utils/webContentsLifecycle.js";
import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { getProcessMemoryKb } from "../utils/processMemory.js";
import { getFocusedPanelTracker } from "./FocusedPanelTracker.js";
import { findPortalPageAction } from "./menuAccelerators.js";
import { claimPageDictationKey } from "./voice/pageDictationKey.js";

// Tab keys a focused portal page hands to the portal rather than to the page
// or the native menu: with the page focused the app renderer never sees the
// key, so the menu's Cmd+W (close window) and Cmd+T (duplicate panel) would
// otherwise act on something the user is not looking at.
const PORTAL_PAGE_KEY_ACTIONS = [
  "portal.closeTab",
  "portal.newTab",
  "portal.nextTab",
  "portal.prevTab",
] as const;

export const PORTAL_MAX_LIVE_TABS = 3;

/**
 * How long a tab may go unseen before it's released and rebuilt at its URL on
 * its next show, like a cached project view (#14217). Measured from when it was
 * last on screen, and wall-clock so a night asleep counts.
 */
export const PORTAL_IDLE_RELEASE_MS = 60 * 60 * 1000;

/**
 * How often hidden tabs are checked against the release age. Only runs while a
 * tab is hidden. Date.now() decides the age: Node's timers stop while the
 * machine sleeps, so an hour-long timeout would not count the night.
 */
export const PORTAL_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A restore mark older than this no longer protects its tab. The renderer's
 * create→show takes about a second; one it abandoned (bounds never appeared,
 * an overlay opened) would otherwise leave the tab exempt for good.
 */
export const PORTAL_RESTORE_LEASE_MS = 60_000;

// A storage flush that hasn't finished by then calls the release off.
const RELEASE_FLUSH_TIMEOUT_MS = 10_000;
// Chromium proceeds past a hung beforeunload after about a second. A sweep
// stops waiting for a verdict after the first of these and warns; the release
// itself stays open, holding back any show, until the second.
const RELEASE_VERDICT_WATCHDOG_MS = 10_000;
const RELEASE_VERDICT_DEADLINE_MS = 60_000;

type ReleaseVerdict = "released" | "refused" | "unknown";

interface ReleaseOperation {
  view: WebContentsView;
  phase: "preparing" | "closing";
  cancelled: boolean;
  // Set when destroyView() takes the tab, which reports it itself.
  superseded: boolean;
  verdict: Promise<ReleaseVerdict>;
}

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
  // Tabs in the create→show restore window, with when each was marked. The
  // renderer restores a tab by calling create, polling DOM bounds (up to ~1s),
  // then show — activeTabId is only set at the end of showTab(), so without
  // this guard a concurrent createTab() could LRU-evict the tab mid-restore
  // (#9971). Entries are cleared by showTab() or destroyView(), and stop
  // protecting after PORTAL_RESTORE_LEASE_MS.
  private restoringTabIds = new Map<string, number>();
  // When each tab not on screen was last on it, or created if never shown.
  private hiddenSince = new Map<string, number>();
  // A tab whose page refused a release isn't asked again before this.
  private releaseRetryAfter = new Map<string, number>();
  private releaseOps = new Map<string, ReleaseOperation>();
  // A release whose close went unanswered past its deadline, logged if the
  // view does go later.
  private lateReleases = new WeakMap<WebContentsView, Record<string, unknown>>();
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private idleCheckRunning = false;
  // Bumped by every show and hide, so a show that waited out a release only
  // lands if nothing has changed what should be on screen since.
  private visibilityGeneration = 0;
  private disposed = false;
  // True while the active view is parked offscreen by hideAll(). Guards
  // updateBounds() so a window resize during an open overlay does not pull
  // the hidden view back on top of the overlay.
  private hidden = false;
  private readonly backgroundColor: string;
  private readonly attachedViews = new Set<WebContentsView>();
  private readonly lastShownBounds = new Map<string, { width: number; height: number }>();
  // The tab whose webContents holds focus, so a background tab's teardown
  // can't clear the Portal's focus in the plugin focus tracker (#13221).
  private focusedTabId: string | null = null;

  constructor(window: BrowserWindow, backgroundColor: string = "#000000") {
    this.window = window;
    this.backgroundColor = backgroundColor;
  }

  private setTabFocused(tabId: string, focused: boolean): void {
    if (focused) this.focusedTabId = tabId;
    else if (this.focusedTabId === tabId) this.focusedTabId = null;
    else return;
    if (!this.window || this.window.isDestroyed()) return;
    getFocusedPanelTracker().setPortalFocused(this.window.id, this.focusedTabId !== null);
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

  // Every project view in the window keeps its own record of which tabs main
  // holds and at which URL, so tab lifecycle notices go to all of them, not
  // just the one in front (#14537).
  private sendToWindowViews(channel: string, ...args: unknown[]): void {
    if (this.window?.isDestroyed()) return;
    for (const wc of getWindowAppWebContents(this.window)) {
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  }

  // History is only readable here, so every report carries it: the toolbar's
  // Back and Forward follow these, as the page's context menu follows main.
  private sendNavEvent(
    tabId: string,
    view: WebContentsView,
    page: { url?: string; title?: string } = {}
  ): void {
    // A released view still loading through its storage flush must not
    // overwrite the URL of the tab recreated under its id.
    if (this.viewMap.get(tabId) !== view) return;
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    const url = page.url ?? wc.getURL();
    // A view shown before its first commit has no page yet, and reporting one
    // would replace the URL the tab is restored from.
    if (!isSafeNavigationUrl(url)) return;
    const navEvent: PortalNavEvent = {
      tabId,
      title: page.title ?? wc.getTitle(),
      url,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
    };
    this.sendToWindowViews(CHANNELS.PORTAL_NAV_EVENT, navEvent);
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
    this.restoringTabIds.delete(tabId);
    this.releaseRetryAfter.delete(tabId);
    const releaseOp = this.releaseOps.get(tabId);
    if (releaseOp) releaseOp.superseded = true;
    this.lateReleases.delete(view);
    this.releaseOps.delete(tabId);
    this.clearHidden(tabId);

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

  private isRestoring(tabId: string, now: number = Date.now()): boolean {
    const markedAt = this.restoringTabIds.get(tabId);
    return markedAt !== undefined && now - markedAt < PORTAL_RESTORE_LEASE_MS;
  }

  private isOnScreen(tabId: string): boolean {
    const view = this.viewMap.get(tabId);
    return view !== undefined && view === this.activeView && !this.hidden;
  }

  private markHidden(tabId: string, now: number = Date.now()): void {
    if (this.hiddenSince.has(tabId)) return;
    this.hiddenSince.set(tabId, now);
    this.armIdleCheck();
  }

  private clearHidden(tabId: string): void {
    this.hiddenSince.delete(tabId);
    if (this.hiddenSince.size === 0) this.stopIdleCheck();
  }

  private armIdleCheck(): void {
    if (this.idleCheckTimer || this.disposed) return;
    this.idleCheckTimer = setInterval(() => {
      void this.releaseIdleTabs();
    }, PORTAL_IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref?.();
  }

  private stopIdleCheck(): void {
    if (!this.idleCheckTimer) return;
    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = null;
  }

  private isReleaseCandidate(tabId: string, view: WebContentsView, now: number): boolean {
    if (this.disposed || this.viewMap.get(tabId) !== view) return false;
    if (this.isOnScreen(tabId) || this.isRestoring(tabId, now)) return false;
    const since = this.hiddenSince.get(tabId);
    if (since === undefined || now - since < PORTAL_IDLE_RELEASE_MS) return false;
    if (now < (this.releaseRetryAfter.get(tabId) ?? 0)) return false;
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    return !wc.isCurrentlyAudible() && !wc.isDevToolsOpened() && !wc.isLoading();
  }

  /**
   * Release tabs nobody has seen for PORTAL_IDLE_RELEASE_MS (#14538). The
   * renderer rebuilds one at its latest URL and partition the next time it's
   * shown, so a persisted login survives. Parked tabs are otherwise left
   * running untouched (#9207, #12456); this only ages them out.
   */
  async releaseIdleTabs(): Promise<string[]> {
    if (this.idleCheckRunning || this.disposed) return [];
    this.idleCheckRunning = true;
    try {
      const now = Date.now();
      const candidates: Array<[string, WebContentsView]> = [];
      for (const [tabId, view] of this.viewMap) {
        if (this.releaseOps.has(tabId)) continue;
        try {
          if (this.isReleaseCandidate(tabId, view, now)) candidates.push([tabId, view]);
        } catch {
          // A webContents torn down mid-check simply isn't a candidate.
        }
      }
      const results = await Promise.allSettled(
        candidates.map(([tabId, view]) => this.releaseView(tabId, view))
      );
      return candidates
        .filter((_, i) => {
          const result = results[i]!;
          return result.status === "fulfilled" && result.value === "released";
        })
        .map(([tabId]) => tabId);
    } finally {
      this.idleCheckRunning = false;
    }
  }

  /**
   * Close a hidden tab in a way its page can refuse. Unlike destroyView(),
   * nothing is dropped up front: the tab stays tracked, attached and parked
   * until its webContents is actually destroyed, so a refusal leaves it
   * exactly as it was. A show before the close is sent calls the release off;
   * one after it waits for the verdict (see showTab()).
   */
  private releaseView(tabId: string, view: WebContentsView): Promise<ReleaseVerdict> {
    let settle!: (verdict: ReleaseVerdict) => void;
    const op: ReleaseOperation = {
      view,
      phase: "preparing",
      cancelled: false,
      superseded: false,
      verdict: new Promise<ReleaseVerdict>((resolve) => (settle = resolve)),
    };
    this.releaseOps.set(tabId, op);
    const finish = (verdict: ReleaseVerdict): ReleaseVerdict => {
      const wasClosing = op.phase === "closing" && this.releaseOps.get(tabId) === op;
      if (this.releaseOps.get(tabId) === op) this.releaseOps.delete(tabId);
      settle(verdict);
      if (wasClosing && verdict !== "released" && !this.disposed) {
        // The page was asked; don't ask again for another hour.
        if (this.viewMap.get(tabId) === view) {
          this.releaseRetryAfter.set(tabId, Date.now() + PORTAL_IDLE_RELEASE_MS);
        }
        // LRU skipped this tab while it was closing; it still counts.
        this.evictIfNeeded();
      }
      return verdict;
    };

    const run = async (): Promise<ReleaseVerdict> => {
      const wc = view.webContents;
      let flushTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          wc.session.flushStorageData(),
          new Promise((_, reject) => {
            flushTimer = setTimeout(
              () => reject(new Error("flush timed out")),
              RELEASE_FLUSH_TIMEOUT_MS
            );
          }),
        ]);
      } catch {
        return finish("refused");
      } finally {
        clearTimeout(flushTimer);
      }

      const now = Date.now();
      if (op.cancelled || this.releaseOps.get(tabId) !== op) return finish("refused");
      if (!this.isReleaseCandidate(tabId, view, now)) return finish("refused");

      const hiddenMs = now - (this.hiddenSince.get(tabId) ?? now);
      const footprint = readTabFootprint(wc);

      op.phase = "closing";
      const deadline = setTimeout(() => {
        // Not a refusal: the page may still close, and "destroyed" still
        // reports it. A show waiting on this goes ahead.
        wc.removeListener("will-prevent-unload", onRefused);
        wc.removeListener("destroyed", onDestroyed);
        logWarn("portal.idle-release-no-verdict", { tabId, hiddenMs });
        this.lateReleases.set(view, { tabId, hiddenMs, ...footprint });
        finish("unknown");
      }, RELEASE_VERDICT_DEADLINE_MS);
      const cleanup = () => {
        clearTimeout(deadline);
        wc.removeListener("will-prevent-unload", onRefused);
        wc.removeListener("destroyed", onDestroyed);
      };
      // No preventDefault(): that would override the page and close it.
      const onRefused = () => {
        cleanup();
        logInfo("portal.idle-release-refused", { tabId, hiddenMs });
        finish("refused");
      };
      const onDestroyed = () => {
        cleanup();
        if (!op.superseded) logInfo("portal.idle-release", { tabId, hiddenMs, ...footprint });
        finish("released");
      };
      wc.once("will-prevent-unload", onRefused);
      wc.once("destroyed", onDestroyed);
      try {
        wc.close({ waitForBeforeUnload: true });
      } catch (error) {
        cleanup();
        console.error(`[PortalManager] Error releasing tab ${tabId}:`, error);
        return finish("refused");
      }

      let watchdog: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        op.verdict,
        new Promise<ReleaseVerdict>((resolve) => {
          watchdog = setTimeout(() => resolve("unknown"), RELEASE_VERDICT_WATCHDOG_MS);
        }),
      ]);
      clearTimeout(watchdog);
      return result;
    };

    return run();
  }

  private evictIfNeeded(): void {
    if (this.lruOrder.size <= PORTAL_MAX_LIVE_TABS) return;

    // The newest entry is the tab being created or shown, never the one to go,
    // even when every older tab is protected or already closing.
    const newest = [...this.lruOrder.keys()].pop();
    for (const tabId of this.lruOrder.keys()) {
      if (tabId === newest) break;
      if (tabId === this.activeTabId) continue;
      if (this.isRestoring(tabId)) continue;
      // Already closing; it leaves the budget when its release lands.
      if (this.releaseOps.get(tabId)?.phase === "closing") continue;
      if (!this.viewMap.has(tabId)) {
        this.lruOrder.delete(tabId);
        continue;
      }

      // Fire-and-forget: eviction is synchronous caller path, flush is best-effort
      void this.destroyView(tabId);

      this.sendToWindowViews(CHANNELS.PORTAL_TAB_EVICTED, { tabId });
      break;
    }
  }

  /**
   * Shield a tab from LRU eviction during the create→show restore window.
   * Cleared by showTab() or destroyView(); createTab() clears it on failure so
   * a tab that never materializes can't leak a permanent guard entry.
   */
  markRestoring(tabId: string): void {
    this.restoringTabIds.set(tabId, Date.now());
  }

  createTab(
    tabId: string,
    url: string,
    partition: string = "persist:portal",
    options: { isPopupAllowed?: (url: string) => boolean } = {}
  ): void {
    console.log(`[PortalManager] Creating tab ${tabId} for ${url} on ${partition}`);
    if (this.viewMap.has(tabId)) return;

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}`);
      }
    } catch (error) {
      console.error(`[PortalManager] Invalid URL for tab ${tabId}:`, error);
      this.restoringTabIds.delete(tabId);
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
        if (typeof url === "string" && url.trim() && (options.isPopupAllowed?.(url) ?? true)) {
          void openExternalUrl(url).catch((error) => {
            console.error("[PortalManager] Failed to open window URL:", error);
          });
        }
        return { action: "deny" };
      });

      view.webContents.on("page-title-updated", (_, title) => {
        this.sendNavEvent(tabId, view, { title });
      });

      view.webContents.on("did-navigate", (_, url) => {
        this.sendNavEvent(tabId, view, { url });
      });

      // A subframe's commit adds to the tab's history without moving the page,
      // so it reports the top-level URL. Main-frame commits arrive as did-navigate.
      view.webContents.on("did-frame-navigate", (_, _url, _code, _status, isMainFrame) => {
        if (!isMainFrame) this.sendNavEvent(tabId, view);
      });

      view.webContents.on("did-navigate-in-page", (_, url, isMainFrame) => {
        this.sendNavEvent(tabId, view, isMainFrame ? { url } : {});
      });

      // An error page commits a history entry without any of the events above.
      view.webContents.on("did-stop-loading", () => {
        this.sendNavEvent(tabId, view);
      });

      view.webContents.once("destroyed", () => {
        // A view closed by destroyView() only fires this after its storage
        // flush, by which time the tab may have been created again under the
        // same id. That state belongs to the new view.
        const current = this.viewMap.get(tabId);
        if (current === undefined || current === view) {
          this.setTabFocused(tabId, false);
          this.viewMap.delete(tabId);
          this.lruOrder.delete(tabId);
          this.lastShownBounds.delete(tabId);
          this.restoringTabIds.delete(tabId);
          this.releaseRetryAfter.delete(tabId);
          this.clearHidden(tabId);
        }
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
        if (this.activeView === view) {
          this.activeView = null;
          this.activeTabId = null;
          this.hidden = false;
        }
        // Still tracked means nothing on our side closed it through
        // destroyView(), which reports its own: an idle release, or a close
        // whose verdict came too late. Every project view drops the tab.
        if (current === view && !this.disposed) {
          const late = this.lateReleases.get(view);
          if (late) logInfo("portal.idle-release", late);
          this.sendToWindowViews(CHANNELS.PORTAL_TAB_EVICTED, { tabId });
        }
        this.lateReleases.delete(view);
      });

      view.webContents.on("before-input-event", (event, input) => {
        if (claimPageDictationKey(input)) {
          event.preventDefault();
          return;
        }
        const actionId = findPortalPageAction(input, PORTAL_PAGE_KEY_ACTIONS);
        if (!actionId) return;
        // Also keeps the key from the native menu's accelerator for it.
        event.preventDefault();
        this.sendToApp(CHANNELS.MENU_ACTION, { actionId });
      });

      view.webContents.on("focus", () => {
        this.setTabFocused(tabId, true);
        this.sendToApp(CHANNELS.PORTAL_FOCUS);
      });

      view.webContents.on("blur", () => {
        this.setTabFocused(tabId, false);
        this.sendToApp(CHANNELS.PORTAL_BLUR);
        // A click or key in the page can make entries it pushed on its own
        // reachable again without navigating, and leaving the page is when the
        // toolbar comes back into play.
        this.sendNavEvent(tabId, view);
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
      this.markHidden(tabId);
      this.touchLru(tabId);
      this.evictIfNeeded();
    } catch (error) {
      console.error(`[PortalManager] Failed to create tab ${tabId}:`, error);
      this.restoringTabIds.delete(tabId);
      throw error;
    }
  }

  /**
   * Returns false when main holds no view for the tab, so the renderer can
   * recreate it instead of leaving the pane blank. A show calls off an idle
   * release still preparing; once the release's close is sent it can't be
   * taken back, so the show waits for the page's verdict and shows the tab
   * only if it survived and nothing has been shown or hidden since.
   */
  async showTab(tabId: string, bounds: PortalBounds): Promise<boolean> {
    const generation = ++this.visibilityGeneration;
    const op = this.releaseOps.get(tabId);
    if (op?.phase === "preparing") op.cancelled = true;
    else if (op?.phase === "closing") {
      // Kept from another idle pass while it waits.
      this.restoringTabIds.set(tabId, Date.now());
      await op.verdict;
      if (generation !== this.visibilityGeneration || this.disposed) {
        return this.viewMap.has(tabId);
      }
    }
    return this.showTabNow(tabId, bounds);
  }

  private showTabNow(tabId: string, bounds: PortalBounds): boolean {
    console.log(`[PortalManager] Showing tab ${tabId}`, bounds);
    const view = this.viewMap.get(tabId);
    if (!view) return false;

    // Park the previously-active view offscreen instead of detaching it —
    // keeps its renderer state (scroll, in-flight requests, sockets) alive.
    // Neither frozen nor CPU-throttled, so its event loop and live SSE/WS
    // streams keep running: CDP CPU throttling busy-spins the renderer it
    // "slows" (#12456).
    if (this.activeView && this.activeView !== view) {
      if (!this.hidden && this.activeTabId !== null) this.markHidden(this.activeTabId);
      this.activeView.setBounds(OFFSCREEN_BOUNDS);
    }

    // Defensive: clear CPU emulation on a view that already has a debugger
    // session. Parking no longer throttles, so this only undoes a rate some
    // other session left behind.
    if (view.webContents && !view.webContents.isDestroyed()) {
      void unthrottleCpuWebContents(view.webContents);
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
    // Restore complete — the activeTabId guard takes over eviction protection.
    this.restoringTabIds.delete(tabId);
    this.hidden = false;
    this.clearHidden(tabId);
    this.touchLru(tabId);
    this.evictIfNeeded();
    this.lastShownTabId = tabId;
    // A project view that mounted after the page navigated has no history for
    // it until now.
    this.sendNavEvent(tabId, view);
    return true;
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
    this.visibilityGeneration++;
    if (this.activeView) {
      if (!this.hidden && this.activeTabId !== null) this.markHidden(this.activeTabId);
      this.activeView.setBounds(OFFSCREEN_BOUNDS);
      this.hidden = true;
      // A parked page isn't where the user is working, whether or not the
      // focus return below produces a blur.
      if (this.focusedTabId !== null) this.setTabFocused(this.focusedTabId, false);
      // Parked like showTab() parks: not frozen, not CPU-throttled (#12456).

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
    // The project view closing the tab knows; any other one still listing it
    // would keep it marked live, history and all.
    if (this.viewMap.has(tabId)) {
      this.sendToWindowViews(CHANNELS.PORTAL_TAB_EVICTED, { tabId });
    }
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
      // A tab between its create and its show is about to be the visible one.
      if (this.isRestoring(tabId)) continue;
      if (this.releaseOps.get(tabId)?.phase === "closing") continue;
      destroyed.push(tabId);
    }
    if (destroyed.length > 0) {
      const closed = Promise.allSettled(destroyed.map((tabId) => this.destroyView(tabId)));
      // destroyView() drops the tabs synchronously; say so before the flushes.
      this.sendToWindowViews(CHANNELS.PORTAL_TABS_EVICTED, { tabIds: destroyed });
      await closed;
      console.log(
        `[PortalManager] Destroyed ${destroyed.length} hidden tab(s) for memory pressure`
      );
    }
    return destroyed;
  }

  destroy(): void {
    this.disposed = true;
    this.visibilityGeneration++;
    this.stopIdleCheck();
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
    this.restoringTabIds.clear();
    this.hiddenSince.clear();
    this.releaseRetryAfter.clear();
    this.releaseOps.clear();
  }
}

/**
 * The tab's footprint across its own renderer and any out-of-process iframes,
 * for the release log. Fields are left out when no process could be measured.
 */
function readTabFootprint(wc: Electron.WebContents): {
  memoryKb?: number;
  processCount?: number;
} {
  try {
    const pids = new Set<number>();
    const mainPid = wc.getOSProcessId();
    if (mainPid > 0) pids.add(mainPid);
    for (const frame of wc.mainFrame?.framesInSubtree ?? []) {
      if (frame.osProcessId > 0) pids.add(frame.osProcessId);
    }
    let memoryKb = 0;
    let measured = 0;
    for (const metric of getAppMetricsSnapshot()) {
      if (!pids.has(metric.pid)) continue;
      memoryKb += getProcessMemoryKb(metric);
      measured++;
    }
    return measured > 0 ? { memoryKb, processCount: pids.size } : {};
  } catch {
    return {};
  }
}
