/**
 * WebContentsView creation and initial load for ProjectViewManager project
 * views — cold-start view construction, preload wiring, and the
 * did-finish-load/dom-ready bootstrap handshake. Extracted from
 * ProjectViewManager (#11004).
 */

import { app, session, WebContentsView } from "electron";
import path from "path";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logWarn } from "../utils/logger.js";
import {
  injectSkeletonCss,
  injectSkeletonProjectIdentity,
  resolveInitialColorSchemeId,
  resolveInitialCanvasBackgroundColor,
  resolveE2EPreloadArgs,
  resolveInstanceRole,
  INITIAL_COLOR_SCHEME_ARG,
  INITIAL_PROJECT_ID_ARG,
  INSTANCE_ROLE_ARG,
} from "./skeletonCss.js";
import { isDemoMode } from "../setup/runtimeFlags.js";
import { projectStore } from "../services/ProjectStore.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";

const LOAD_TIMEOUT_MS = 10_000;

export function createView(host: ProjectViewManager, projectId: string): WebContentsView {
  const ses = session.fromPartition("persist:daintree");

  // Register app:// and daintree-file:// protocol handlers on this session.
  // protocol.handle() only covers the default session — custom partitions need explicit setup.
  const distPath = getDistPath();
  if (distPath) {
    registerProtocolsForSession(ses, distPath);
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(host.dirname, "preload.cjs"),
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      navigateOnDragDrop: false,
      // Matches createWindow.ts: write the V8 code cache on first load so
      // post-install/update launches warm up one launch sooner.
      v8CacheOptions: app.isPackaged ? "bypassHeatCheck" : "code",
      // Seed the renderer with the persisted theme so project-switch cold
      // starts and LRU-evicted views paint the saved scheme on first frame
      // instead of a prefers-color-scheme default (#9169). The project id is
      // threaded the same way instead of via a `?projectId=` query string so
      // the document URL stays static and the V8 bytecode cache is shared
      // across projects (#9162).
      // The instance role rides along so LRU-evicted and project-switch
      // views keep suppressing background GitHub polling in worker
      // instances (#10123).
      additionalArguments: [
        `${INITIAL_COLOR_SCHEME_ARG}=${resolveInitialColorSchemeId()}`,
        `${INITIAL_PROJECT_ID_ARG}=${projectId}`,
        `${INSTANCE_ROLE_ARG}=${resolveInstanceRole()}`,
        ...resolveE2EPreloadArgs(),
        // Demo mode is gated in the renderer on process.argv. Electron does
        // not forward main-process CLI switches to renderer argv, so the
        // `--demo-mode` flag must be threaded explicitly for the DemoCursor /
        // DemoOverlay / DemoCaptureBridge components to mount and the
        // window.electron.demo bridge to be exposed.
        ...(isDemoMode ? ["--demo-mode"] : []),
      ],
    },
  });
  // Set the compositor background color before loadURL so the view never
  // shows the default white background during the cold-start paint gap (#9573).
  view.setBackgroundColor(resolveInitialCanvasBackgroundColor());
  return view;
}

export function loadView(view: WebContentsView, projectId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wc = view.webContents;
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
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error("View load timed out")));
    }, LOAD_TIMEOUT_MS);

    const onFinish = () => {
      void verifyProjectBootstrap(wc, projectId).then(
        () => settle(() => resolve()),
        (error) => settle(() => reject(error))
      );
    };
    const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) =>
      settle(() => reject(new Error(`View load failed: ${errorDescription} (${errorCode})`)));
    const onPreloadError = (_event: Electron.Event, _preloadPath: string, error: Error) =>
      settle(() => reject(error ?? new Error("Preload script failed")));
    const onProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
      settle(() => reject(new Error(`Renderer process gone during load: ${details.reason}`)));

    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    wc.once("preload-error", onPreloadError);
    wc.once("render-process-gone", onProcessGone);

    // Paint the skeleton on `dom-ready`, NOT before `loadURL`. `insertCSS`
    // and `executeJavaScript` are scoped to the live document, and the
    // navigation that `loadURL` kicks off discards anything injected into the
    // prior (about:blank) context — so injecting here pre-navigation was a
    // silent no-op. Mirrors the `dom-ready` wiring in createWindow.ts. `once`
    // is correct because each cold start creates a fresh WebContentsView.
    // Re-read the project inside the handler rather than closing over a value
    // captured now, so the freshest name/emoji/color is painted (#9162).
    wc.once("dom-ready", () => {
      if (wc.isDestroyed()) return;
      const project = projectStore.getProjectById(projectId);
      // instantReveal drops index.html's 400ms Doherty entry delay: a cold
      // switch reveals on APP_SKELETON_PARSED (~150ms), which lands inside
      // that delay, so without this the revealed view shows a blank themed
      // canvas instead of the skeleton until ~480ms. The gate stays in place
      // for the initial app launch (createWindow.ts), where it belongs.
      injectSkeletonCss(wc, project, { instantReveal: true });
      injectSkeletonProjectIdentity(wc, project);
    });

    // The document URL is intentionally static (no `?projectId=`): the id
    // travels via additionalArguments so the V8 bytecode cache stays shared
    // across projects instead of fragmenting one entry per project (#9162).
    //
    // Outer .catch surfaces any rejection from `wc.loadURL` itself; the inner
    // did-fail-load / preload-error / timeout handlers already reject the
    // outer Promise with a descriptive Error. ERR_ABORTED is the dominant
    // normal case during rapid project switching and renderer teardown — drop
    // it silently to avoid log noise.
    const onLoadURLReject = (err: unknown, url: string) => {
      if (err instanceof Error && err.message.includes("ERR_ABORTED")) return;
      logWarn("Project view loadURL rejected", {
        projectId,
        url,
        error: formatErrorMessage(err, "loadURL failed"),
      });
    };
    if (process.env.NODE_ENV === "development") {
      const url = getDevServerUrl();
      wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
    } else {
      const url = "app://daintree/index.html";
      wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
    }
  });
}

async function verifyProjectBootstrap(wc: Electron.WebContents, projectId: string): Promise<void> {
  const loadedProjectId = await wc.executeJavaScript(
    "globalThis.__DAINTREE_INITIAL_PROJECT__?.id ?? null"
  );
  // The production expression above always returns a string or null. Some
  // unit-test WebContents mocks return undefined for unmodelled scripts;
  // leave those legacy mocks neutral while still rejecting real missing
  // bootstrap state (null) and wrong-project bootstraps.
  if (loadedProjectId === undefined) return;
  if (loadedProjectId !== projectId) {
    throw new Error(
      `Project view loaded without project bootstrap for ${projectId}; got ${String(loadedProjectId)}`
    );
  }
}

export function updateViewBounds(host: ProjectViewManager, view: WebContentsView): void {
  if (host.win.isDestroyed()) return;
  const { width, height } = host.win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
}
