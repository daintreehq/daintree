/**
 * SurfaceViewManager — per-window lifecycle for paint-fabric surface views
 * (docs/architecture/terminal-paint-fabric.md, Phase 1V substrate).
 *
 * Each aux paint surface is a sibling WebContentsView attached directly to
 * `win.contentView` — never nested inside another WebContentsView (Electron 42
 * has z-order/render glitches for nested views, electron#47990) — positioned
 * over its grid-pane band via the bounds protocol. Every surface gets a
 * unique non-persist session partition: Chromium's same-origin process
 * consolidation can otherwise collapse N views loading the same bundle into
 * ONE renderer process, silently re-merging the per-surface 16-WebGL-context
 * budgets and glyph atlases this substrate exists to separate.
 *
 * Divergence from ProjectViewManager: no window-resize handler here. Project
 * views fill the window; surface views track grid-pane rects, and the
 * renderer's layout is the authority on those — it re-pushes bounds through
 * the paintSurface IPC namespace whenever the grid changes.
 */

import { WebContentsView, session } from "electron";
import path from "path";
import { randomBytes } from "crypto";
import type { BrowserWindow } from "electron";
import {
  registerProtocolsForSession,
  applyDaintreeAppCspToSession,
  getDistPath,
} from "../setup/protocols.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import {
  SURFACE_HOST_ARG,
  SURFACE_CRASH_LOOP_THRESHOLD,
  SURFACE_CRASH_LOOP_WINDOW_MS,
  surfaceViewPartition,
  type CreateSurfaceViewResult,
  type SurfaceViewBounds,
  type SurfaceViewCrashReport,
} from "../../shared/types/paintFabricSurface.js";
import { boundsAreValid, findBoundsConflicts } from "../../shared/utils/paintSurfaceGeometry.js";
import {
  resolveInitialColorSchemeId,
  resolveInitialCanvasBackgroundColor,
  resolveE2EPreloadArgs,
  INITIAL_COLOR_SCHEME_ARG,
} from "./skeletonCss.js";

const SURFACE_LOAD_TIMEOUT_MS = 10_000;

type SurfaceViewState = "loading" | "ready" | "crash-loop" | "destroyed";

interface SurfaceViewEntry {
  surfaceId: string;
  view: WebContentsView;
  partition: string;
  bounds: SurfaceViewBounds | null;
  crashTimestamps: number[];
  cleanupHandlers: () => void;
  // Settles an in-flight loadSurface promise immediately on destroy so a
  // destroyed surface never leaves the create call hanging on the timeout.
  cancelLoad: (() => void) | null;
  state: SurfaceViewState;
}

export interface SurfaceViewManagerDeps {
  win: BrowserWindow;
  /** Directory containing preload.cjs (same one ProjectViewManager uses). */
  dirname: string;
  /**
   * Crash observer. `reloaded` = single crash, the view auto-reloaded.
   * `crash-loop` = threshold hit inside the window; the manager stops
   * reloading and the caller must drive the compositor's retireSurface
   * (evacuate terminals to siblings, then destroySurface here). A headless
   * paint surface never loads the project views' recovery page.
   */
  onCrash?: (report: SurfaceViewCrashReport) => void;
  /**
   * Fires when a surface finishes loading again AFTER its initial create
   * (crash reload, navigation). The reload tore down the renderer context
   * that held the surface's pty-host port, so the caller re-brokers here.
   */
  onSurfaceReady?: (surfaceId: string) => void;
}

export class SurfaceViewManager {
  private readonly win: BrowserWindow;
  private readonly dirname: string;
  private readonly onCrash?: (report: SurfaceViewCrashReport) => void;
  private readonly onSurfaceReady?: (surfaceId: string) => void;
  private entries = new Map<string, SurfaceViewEntry>();
  private disposed = false;

  constructor(deps: SurfaceViewManagerDeps) {
    this.win = deps.win;
    this.dirname = deps.dirname;
    this.onCrash = deps.onCrash;
    this.onSurfaceReady = deps.onSurfaceReady;
  }

  surfaceCount(): number {
    return this.entries.size;
  }

  hasSurface(surfaceId: string): boolean {
    return this.entries.has(surfaceId);
  }

  getWebContents(surfaceId: string): Electron.WebContents | null {
    const entry = this.entries.get(surfaceId);
    if (!entry || entry.state === "destroyed") return null;
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  getPartitionForTests(surfaceId: string): string | null {
    return this.entries.get(surfaceId)?.partition ?? null;
  }

  getStateForTests(surfaceId: string): SurfaceViewState | null {
    return this.entries.get(surfaceId)?.state ?? null;
  }

  async createSurface(surfaceId: string): Promise<CreateSurfaceViewResult> {
    if (this.disposed) {
      throw new Error("SurfaceViewManager is disposed");
    }
    if (this.entries.has(surfaceId)) {
      throw new Error(`Surface view already exists: ${surfaceId}`);
    }
    if (this.win.isDestroyed()) {
      throw new Error("Cannot create a surface view on a destroyed window");
    }

    // Unique per surface AND per creation (nonce): a retired surface id that
    // gets re-created must not reuse the old in-memory session.
    const partition = surfaceViewPartition(
      this.win.id,
      surfaceId,
      randomBytes(8).toString("hex")
    );
    const ses = session.fromPartition(partition);
    // protocol.handle() only covers the default session — every custom
    // partition needs the app:// and daintree-file:// handlers registered.
    const distPath = getDistPath();
    if (distPath) {
      registerProtocolsForSession(ses, distPath);
    }
    // The partition stays classified "unknown" so security.ts's
    // session-created hook default-locks its permissions; the app CSP half of
    // the project-view hardening is applied explicitly here.
    applyDaintreeAppCspToSession(ses);

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(this.dirname, "preload.cjs"),
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        navigateOnDragDrop: false,
        // No webviewTag: a paint surface hosts terminals, nothing else.
        additionalArguments: [
          // The document URL stays static (same index.html as project views,
          // #9162); the surface-host role rides in argv like the instance
          // role (#10123) and makes src/main.tsx mount the minimal
          // surface-host root instead of the full app shell.
          `${SURFACE_HOST_ARG}${surfaceId}`,
          `${INITIAL_COLOR_SCHEME_ARG}=${resolveInitialColorSchemeId()}`,
          ...resolveE2EPreloadArgs(),
        ],
      },
    });
    view.setBackgroundColor(resolveInitialCanvasBackgroundColor());

    const entry: SurfaceViewEntry = {
      surfaceId,
      view,
      partition,
      bounds: null,
      crashTimestamps: [],
      cleanupHandlers: () => {},
      cancelLoad: null,
      state: "loading",
    };
    this.entries.set(surfaceId, entry);
    this.installHandlers(entry);

    // Direct sibling of the project view on the window's root contentView.
    // Hidden until the first bounds push — a surface with no band owns no
    // pixels and must not sit over the grid stealing input.
    this.win.contentView.addChildView(view);
    view.setVisible(false);

    try {
      await this.loadSurface(entry);
    } catch (error) {
      await this.destroySurface(surfaceId);
      throw error;
    }
    entry.state = "ready";

    return {
      surfaceId,
      webContentsId: view.webContents.id,
      partition,
    };
  }

  /**
   * Bounds protocol: the renderer pushes the window-relative rect of the
   * grid band this surface owns. Disjointness is a hard invariant — Electron
   * has no per-pixel input pass-through, so an overlapping surface would
   * steal its sibling's input in the overlap.
   */
  setSurfaceBounds(surfaceId: string, bounds: SurfaceViewBounds): void {
    const entry = this.requireEntry(surfaceId);
    if (!boundsAreValid(bounds)) {
      throw new Error(`Invalid surface bounds for ${surfaceId}`);
    }
    const placed = new Map<string, SurfaceViewBounds>();
    for (const [id, sibling] of this.entries) {
      if (sibling.bounds) placed.set(id, sibling.bounds);
    }
    const conflicts = findBoundsConflicts(bounds, placed, surfaceId);
    if (conflicts.length > 0) {
      throw new Error(
        `Surface bounds for ${surfaceId} overlap sibling surface(s): ${conflicts.join(", ")}`
      );
    }
    entry.bounds = bounds;
    entry.view.setBounds(bounds);
    entry.view.setVisible(bounds.width > 0 && bounds.height > 0);
  }

  /** Re-adding an attached view raises it to the top of the sibling stack. */
  raiseSurface(surfaceId: string): void {
    const entry = this.requireEntry(surfaceId);
    if (this.win.isDestroyed()) return;
    this.win.contentView.addChildView(entry.view);
  }

  hideSurface(surfaceId: string): void {
    const entry = this.requireEntry(surfaceId);
    entry.bounds = null;
    entry.view.setVisible(false);
  }

  async destroySurface(surfaceId: string): Promise<void> {
    const entry = this.entries.get(surfaceId);
    if (!entry || entry.state === "destroyed") return;
    entry.state = "destroyed";
    this.entries.delete(surfaceId);

    // Settle an in-flight create immediately instead of leaving it to the
    // load timeout.
    try {
      entry.cancelLoad?.();
    } catch (error) {
      console.error("[SurfaceViewManager] cancelLoad threw during destroy:", error);
    }

    // Listener detach must precede close(): close() does not remove JS
    // listeners, and a queued Chromium event landing after teardown would
    // read torn-down state (#6085).
    try {
      entry.cleanupHandlers();
    } catch (error) {
      console.error("[SurfaceViewManager] cleanupHandlers threw during destroy:", error);
    }

    if (!this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(entry.view);
      } catch {
        // The view may already have been detached by window teardown.
      }
    }

    const wc = entry.view.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.close();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const surfaceIds = Array.from(this.entries.keys());
    for (const surfaceId of surfaceIds) {
      await this.destroySurface(surfaceId);
    }
  }

  private requireEntry(surfaceId: string): SurfaceViewEntry {
    const entry = this.entries.get(surfaceId);
    if (!entry || entry.state === "destroyed") {
      throw new Error(`Unknown surface view: ${surfaceId}`);
    }
    return entry;
  }

  private installHandlers(entry: SurfaceViewEntry): void {
    const wc = entry.view.webContents;
    const surfaceId = entry.surfaceId;

    const handleWillNavigate = (event: Electron.Event, url: string) => {
      // A paint surface never navigates: it loads the trusted renderer
      // bundle once and hosts terminals. Anything else is blocked outright.
      if (!isTrustedRendererUrl(url)) {
        event.preventDefault();
      }
    };

    const handleWillRedirect = (event: Electron.Event, url: string) => {
      if (!isTrustedRendererUrl(url)) {
        event.preventDefault();
      }
    };

    const handleDidFinishLoad = () => {
      const current = this.entries.get(surfaceId);
      if (!current || current.state !== "ready") return;
      // Only post-create loads reach here (the initial load settles via
      // loadSurface before state flips to "ready"): a reload replaced the
      // renderer context that held the surface's pty-host port, so the
      // owner must re-broker.
      this.onSurfaceReady?.(surfaceId);
    };

    const handleRenderProcessGone = (
      _event: Electron.Event,
      details: Electron.RenderProcessGoneDetails
    ) => {
      if (details.reason === "clean-exit") return;
      // Resolve the entry at event time (#7589): the surface may have been
      // retired/re-created while this event sat in the queue.
      const current = this.entries.get(surfaceId);
      if (!current || current.state === "destroyed") return;

      const now = Date.now();
      const timestamps = current.crashTimestamps;
      while (timestamps.length > 0 && now - timestamps[0]! > SURFACE_CRASH_LOOP_WINDOW_MS) {
        timestamps.shift();
      }
      timestamps.push(now);

      if (timestamps.length >= SURFACE_CRASH_LOOP_THRESHOLD) {
        console.error(
          `[SurfaceViewManager] Crash loop on surface ${surfaceId}; deferring to retireSurface`
        );
        current.state = "crash-loop";
        this.onCrash?.({
          surfaceId,
          disposition: "crash-loop",
          reason: details.reason,
          exitCode: details.exitCode,
        });
        return;
      }

      console.warn(`[SurfaceViewManager] Surface ${surfaceId} crashed, auto-reloading`);
      this.onCrash?.({
        surfaceId,
        disposition: "reloaded",
        reason: details.reason,
        exitCode: details.exitCode,
      });
      setImmediate(() => {
        const live = this.entries.get(surfaceId);
        if (!live || live.state === "destroyed") return;
        const liveWc = live.view.webContents;
        if (liveWc && !liveWc.isDestroyed()) liveWc.reload();
      });
    };

    const handleUnresponsive = () => {
      const current = this.entries.get(surfaceId);
      if (!current || current.state === "destroyed") return;
      const liveWc = current.view.webContents;
      if (!liveWc || liveWc.isDestroyed()) return;
      // Never reload() an unresponsive renderer — it hangs waiting on unload
      // handlers a blocked event loop can't run. Force it through the
      // render-process-gone recovery path instead (#6280).
      console.warn(
        `[SurfaceViewManager] Surface ${surfaceId} unresponsive; forcing renderer crash`
      );
      liveWc.forcefullyCrashRenderer();
    };

    // A paint surface never opens child windows.
    wc.setWindowOpenHandler(() => ({ action: "deny" }));

    wc.on("will-navigate", handleWillNavigate);
    wc.on("will-redirect", handleWillRedirect);
    wc.on("did-finish-load", handleDidFinishLoad);
    wc.on("render-process-gone", handleRenderProcessGone);
    wc.on("unresponsive", handleUnresponsive);

    // Capture wc in the closure: post-destroy the view's webContents getter
    // may be undefined (Electron #50249). Idempotent so destroy paths can
    // race window teardown.
    let cleaned = false;
    entry.cleanupHandlers = () => {
      if (cleaned) return;
      cleaned = true;
      wc.removeListener("will-navigate", handleWillNavigate);
      wc.removeListener("will-redirect", handleWillRedirect);
      wc.removeListener("did-finish-load", handleDidFinishLoad);
      wc.removeListener("render-process-gone", handleRenderProcessGone);
      wc.removeListener("unresponsive", handleUnresponsive);
    };
  }

  private loadSurface(entry: SurfaceViewEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wc = entry.view.webContents;
      let settled = false;

      const cleanup = () => {
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
        wc.removeListener("preload-error", onPreloadError);
        wc.removeListener("render-process-gone", onProcessGone);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        entry.cancelLoad = null;
        fn();
      };

      entry.cancelLoad = () =>
        settle(() => reject(new Error("Surface view destroyed during load")));

      const timeout = setTimeout(() => {
        settle(() => reject(new Error("Surface view load timed out")));
      }, SURFACE_LOAD_TIMEOUT_MS);

      const onFinish = () => settle(() => resolve());
      const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) =>
        settle(() =>
          reject(new Error(`Surface view load failed: ${errorDescription} (${errorCode})`))
        );
      const onPreloadError = (_event: Electron.Event, _preloadPath: string, error: Error) =>
        settle(() => reject(error ?? new Error("Surface preload script failed")));
      const onProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
        settle(() =>
          reject(new Error(`Surface renderer gone during load: ${details.reason}`))
        );

      wc.once("did-finish-load", onFinish);
      wc.once("did-fail-load", onFail);
      wc.once("preload-error", onPreloadError);
      wc.once("render-process-gone", onProcessGone);

      const onLoadURLReject = (err: unknown) => {
        if (err instanceof Error && err.message.includes("ERR_ABORTED")) return;
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      };
      if (process.env.NODE_ENV === "development") {
        wc.loadURL(getDevServerUrl()).catch(onLoadURLReject);
      } else {
        wc.loadURL("app://daintree/index.html").catch(onLoadURLReject);
      }
    });
  }
}
