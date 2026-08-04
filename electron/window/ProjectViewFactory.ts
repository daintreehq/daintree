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
import { AppError, isAppError } from "../utils/errorTypes.js";
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

/**
 * Two-phase load timing, captured per call. The soft bound is observability
 * only — it logs that the load is far outside the measured distribution and
 * keeps waiting. The hard bound is the absolute ceiling that abandons the
 * switch. See `DEFAULT_VIEW_LOAD_*_MS` in ProjectViewManager.ts for the
 * defaults and `RESOURCE_PROFILE_CONFIGS` for the per-profile values.
 */
export interface LoadViewTimings {
  softMs: number;
  hardMs: number;
}

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

/**
 * Which stage of the cold start a `loadView` rejection happened in. Carried in
 * the error's `context` so a production report can tell "the page never
 * navigated" apart from "the page loaded but the renderer never answered the
 * bootstrap eval" — one hard budget spans both, so the bare message could not
 * distinguish them (#11458).
 */
type LoadPhase = "navigation" | "bootstrap";

/**
 * True when a `loadView` rejection was settled by the `destroyed` listener
 * rather than by a load event. Purely diagnostic: it feeds the `cancelled`
 * field of the `projectview.coldstart.abandoned` log. Rollback and user-facing
 * error reporting are keyed on host liveness ALONE, never on this predicate
 * (see ProjectViewSwitchController's catch).
 *
 * Keyed on the code alone: `loadView` is the only producer of `CANCELLED` here,
 * and every other rejection path — including anything thrown by the bootstrap
 * eval — is wrapped as `INTERNAL` with the original attached as `cause`.
 */
export function isViewLoadCancelled(error: unknown): boolean {
  return isAppError(error) && error.code === "CANCELLED";
}

export function loadView(
  view: WebContentsView,
  projectId: string,
  timings: LoadViewTimings
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Captured once: `view.webContents` reads back undefined once the view is
    // destroyed (electron#50249), and every path below — including the
    // teardown listener — must keep working past that point.
    const wc = view.webContents;
    let settled = false;
    let phase: LoadPhase = "navigation";

    const failure = (message: string, cause?: Error) =>
      new AppError({
        code: "INTERNAL",
        message,
        context: { phase, projectId },
        cause,
      });

    const softMs = timings.softMs;
    // Guarantee hard >= soft so the soft warning always precedes the hard
    // rejection, regardless of how the two resource-profile setters are
    // ordered. Mirrors the paint gate's clamp in waitForPaint().
    const hardMs = Math.max(timings.hardMs, softMs);

    const cleanup = () => {
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      wc.removeListener("preload-error", onPreloadError);
      wc.removeListener("render-process-gone", onProcessGone);
      wc.removeListener("dom-ready", onDomReady);
      wc.removeListener("destroyed", onDestroyed);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimeout);
      clearTimeout(hardTimeout);
      try {
        cleanup();
      } catch {
        // Electron can throw from removeListener once the WebContents is torn
        // down (same hazard webContentsRegistry guards). The teardown path is
        // the one that always cleans up against a destroyed webContents, and
        // `settled` is already latched here — letting a throw escape would
        // skip the settle callback below and strand the promise pending
        // FOREVER, which is strictly worse than the hard-bound stall being
        // fixed.
      }
      fn();
    };

    // Soft tail: log only. A cold load runs ~141ms at p50 and ~454ms at the
    // observed max, so crossing this bound means something is genuinely
    // wrong — but "wrong" is not "dead", and abandoning here is what lost
    // the switch in #11459. Keep waiting for a real event or the hard bound.
    const armedAt = performance.now();
    const softTimeout = setTimeout(() => {
      logWarn("projectview.load.softtimeout", {
        projectId,
        waitedMs: softMs,
        hardMs,
        // How much later than scheduled this callback actually ran. A large
        // value means the main process was blocked (concurrent agent CLIs,
        // git enumeration) rather than the renderer being slow — the two are
        // indistinguishable from the elapsed time alone, and which one it is
        // decides whether the fix is here or upstream. Clamped because the
        // fake timers used in unit tests advance virtual time only.
        timerLateByMs: Math.max(0, Math.round(performance.now() - armedAt - softMs)),
      });
    }, softMs);

    // Hard ceiling: the load is presumed wedged. Deliberately never extended
    // by progress signals — the main-process stall that delays the load
    // delays any event that would reset it, so a wall-clock backstop is the
    // only bound that holds.
    const hardTimeout = setTimeout(() => {
      settle(() =>
        reject(
          failure(
            phase === "bootstrap"
              ? "View load timed out: project bootstrap never reported"
              : "View load timed out: page never finished loading"
          )
        )
      );
    }, hardMs);

    const onFinish = () => {
      // Flipped synchronously, before the eval's first await, so a timeout
      // landing during the round trip is attributed to the bootstrap phase
      // rather than to navigation. The hard budget deliberately stays
      // end-to-end — restarting it here would double the worst-case cold start.
      phase = "bootstrap";
      void verifyProjectBootstrap(wc, projectId).then(
        () => settle(() => resolve()),
        // Always re-wrapped, never passed through: `CANCELLED` must be
        // reachable only from `onDestroyed`, which is the invariant
        // `isViewLoadCancelled` keys on.
        (error: unknown) =>
          settle(() =>
            reject(
              failure(
                formatErrorMessage(error, "Project view bootstrap verification failed"),
                error instanceof Error ? error : undefined
              )
            )
          )
      );
    };
    const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) =>
      settle(() => reject(failure(`View load failed: ${errorDescription} (${errorCode})`)));
    const onPreloadError = (_event: Electron.Event, _preloadPath: string, error: Error) =>
      settle(() =>
        reject(failure(formatErrorMessage(error, "Preload script failed"), error ?? undefined))
      );
    const onProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
      settle(() => reject(failure(`Renderer process gone during load: ${details.reason}`)));
    // Fifth race participant (#11458). Teardown closes the webContents without
    // firing any of the four load events above, so before this the promise sat
    // until the full hard timeout and then reported a timeout that never
    // happened — surfacing a spurious error toast long after an ordinary window
    // close, and the wait got longer once #11459 widened the hard bound.
    // `destroyed` is the right granularity: a merely *deactivated*
    // (cached) view stays alive and must not cancel its own pending load, while
    // every real teardown path routes through `cleanupEntry` → `wc.close()`.
    const onDestroyed = () =>
      settle(() =>
        reject(
          new AppError({
            code: "CANCELLED",
            message: "Project view load cancelled — view was destroyed",
            context: { phase, projectId },
          })
        )
      );

    // Paint the skeleton on `dom-ready`, NOT before `loadURL`. `insertCSS`
    // and `executeJavaScript` are scoped to the live document, and the
    // navigation that `loadURL` kicks off discards anything injected into the
    // prior (about:blank) context — so injecting here pre-navigation was a
    // silent no-op. Mirrors the `dom-ready` wiring in createWindow.ts. `once`
    // is correct because each cold start creates a fresh WebContentsView.
    // Re-read the project inside the handler rather than closing over a value
    // captured now, so the freshest name/emoji/color is painted (#9162).
    // Named (not inline) so `cleanup` can detach it: `webContents.close()`
    // does not remove JS listeners, so a load that fails before dom-ready
    // would otherwise leave this bound to a view that is being torn down.
    // Removing it on settle is safe — on the success path dom-ready always
    // precedes did-finish-load, so it has already fired and self-removed.
    const onDomReady = () => {
      if (wc.isDestroyed()) return;
      const project = projectStore.getProjectById(projectId);
      // instantReveal drops index.html's 400ms Doherty entry delay: a cold
      // switch reveals on APP_SKELETON_PARSED (~150ms), which lands inside
      // that delay, so without this the revealed view shows a blank themed
      // canvas instead of the skeleton until ~480ms. The gate stays in place
      // for the initial app launch (createWindow.ts), where it belongs.
      injectSkeletonCss(wc, project, { instantReveal: true });
      injectSkeletonProjectIdentity(wc, project);
    };

    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    wc.once("preload-error", onPreloadError);
    wc.once("render-process-gone", onProcessGone);
    wc.once("dom-ready", onDomReady);
    wc.once("destroyed", onDestroyed);

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

/**
 * `__DAINTREE_INITIAL_PROJECT__` is contextBridge-exposed by the preload, which
 * attaches to whatever document the navigation committed — so on its own it
 * proves the right preload ran, never that the right document rendered. A
 * `Response` with `status: 404` from the app:// handler is a transport-complete
 * navigation: it commits, fires did-finish-load, never fires did-fail-load, and
 * carries the preload intact, so the id probe passed on a bare "Not Found" body
 * and the switch was accepted (#11635).
 *
 * `#root` is the document-owned half of the answer: static markup in
 * index.html that no other document can produce. It stays in the DOM for the
 * life of the page, unlike `#startup-skeleton`, which main.tsx removes once
 * React mounts — probing for that would reject a healthy view whenever React
 * won the race to did-finish-load.
 */
const BOOTSTRAP_PROBE = `({
  projectId: globalThis.__DAINTREE_INITIAL_PROJECT__?.id ?? null,
  hasAppRoot: document.getElementById("root") !== null,
})`;

async function verifyProjectBootstrap(wc: Electron.WebContents, projectId: string): Promise<void> {
  const probe = await wc.executeJavaScript(BOOTSTRAP_PROBE);
  // The production expression above always returns an object. Some unit-test
  // WebContents mocks return undefined for unmodelled scripts; leave those
  // legacy mocks neutral while still rejecting real missing bootstrap state.
  if (probe === undefined) return;
  const { projectId: loadedProjectId, hasAppRoot } = (probe ?? {}) as {
    projectId?: string | null;
    hasAppRoot?: boolean;
  };
  // Checked before the id: a wrong document can still carry the right id, and
  // reporting it as a bootstrap mismatch would point diagnosis at the project
  // plumbing instead of at the failed asset read that actually caused it.
  if (hasAppRoot !== true) {
    throw new Error(
      `Project view loaded a non-application document for ${projectId}; app root missing`
    );
  }
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
