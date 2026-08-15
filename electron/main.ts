// eager-import-allow: reads boot-critical config via store.get synchronously during main-process startup
// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

import nodeV8 from "node:v8";
import { app, BrowserWindow, crashReporter, protocol } from "electron";

// Ask V8 to auto-dump a heap snapshot when the main process is genuinely close
// to its heap limit. Complements the existing dev-only 600 MB RSS heuristic in
// ProcessMemoryMonitor, but works in packaged builds too. Snapshot files land
// in the process CWD (or wherever `--diagnostic-dir` points). count=2 caps
// lifetime auto-dumps so a thrashing process can't fill the disk.
nodeV8.setHeapSnapshotNearHeapLimit(2);
import { registerGlobalErrorHandlers } from "./setup/globalErrorHandlers.js";
import { startDevDiagnostics } from "./setup/devDiagnostics.js";
import { isE2EFaultMode, isE2EMode } from "./setup/runtimeFlags.js";
import path from "path";
import { fileURLToPath } from "url";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { getOsToAppBootMs, markPerformance } from "./utils/performance.js";
import { getCompileCacheMeta } from "./utils/hostPerformance.js";
import { startPerformanceTraceIfEnabled } from "./utils/performanceTrace.js";
import { enforceIpcSenderValidation, setupPermissionLockdown } from "./setup/security.js";
import {
  registerAppProtocol,
  registerDaintreeFileProtocol,
  registerDaintreeHtmlProtocol,
  registerDaintreePdfProtocol,
  registerDeepLinkProtocolClient,
  registerPluginProtocol,
  setupWebviewCSP,
} from "./setup/protocols.js";
import { activateDeepLinkHandler } from "./setup/deepLinkInstall.js";
import {
  extractDirectoryPaths,
  hasCliPathFlag,
  registerAppLifecycleHandlers,
  registerWindowSessionEndHandler,
} from "./lifecycle/appLifecycle.js";
import { resolveLaunchIntent, shouldRestoreWindowFleet } from "./lifecycle/launchIntent.js";
import {
  resolvePrimaryRestoreProjectId,
  restoreWindowFleet,
  type CreateWindowResult,
} from "./lifecycle/windowRestore.js";
import { registerShutdownHandler } from "./lifecycle/shutdown.js";
import {
  setMainWindow,
  getMainWindow,
  setWindowRegistry,
  setProjectViewManager,
  getProjectViewManager,
} from "./window/windowRef.js";
import { WindowRegistry } from "./window/WindowRegistry.js";
import { ProjectViewManager } from "./window/ProjectViewManager.js";
import { helpSessionService } from "./services/HelpSessionService.js";
import { effectiveCachedProjectViews } from "./utils/cachedProjectViews.js";
import { setupBrowserWindow } from "./window/createWindow.js";
import { distributePortsToView } from "./window/portDistribution.js";
import { toDisposable } from "./utils/lifecycle.js";
import {
  setupWindowServices,
  getPtyClient,
  setPtyClientRef,
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
  getCliAvailabilityServiceRef,
  getCleanupIpcHandlers,
  setCleanupIpcHandlers,
  getCleanupErrorHandlers,
  setCleanupErrorHandlers,
  getStopEventLoopLagMonitor,
  setStopEventLoopLagMonitor,
  getStopProcessMemoryMonitor,
  setStopProcessMemoryMonitor,
  getStopAppMetricsMonitor,
  setStopAppMetricsMonitor,
  getStopDiskSpaceMonitor,
  setStopDiskSpaceMonitor,
  getMainProcessWatchdogClientRef,
} from "./window/windowServices.js";
import { getResourceProfileService } from "./window/serviceRefs.js";
import {
  setupPowerMonitor,
  setupWindowFocusThrottle,
  registerWindowForFocusThrottle,
} from "./window/powerMonitor.js";
import {
  getProjectStatsService,
  getFleetSnapshotService,
} from "./ipc/handlers/projectCrud/index.js";
import { getIdleTerminalNotificationService } from "./services/IdleTerminalNotificationService.js";
import {
  getPendingOpenDirPaths,
  getPendingOpenFilePaths,
  isDemoMode,
  isSmokeTest,
  kickOffEarlyPathRefresh,
} from "./setup/environment.js";
import { store } from "./store.js";
import { initializeLogger, registerLoggerTransport, setLogLevelOverrides } from "./utils/logger.js";
import { broadcastToVisibleRenderers } from "./ipc/utils.js";
import {
  initializeCrashRecoveryService,
  getCrashRecoveryService,
} from "./services/CrashRecoveryService.js";
import { projectStore } from "./services/ProjectStore.js";
import { prefetchHydrateResult } from "./services/prefetchHydrateCache.js";
import { buildSwitchHydrateResult } from "./services/AppHydrationService.js";
import { initializeCrashLoopGuard, getCrashLoopGuard } from "./services/CrashLoopGuardService.js";
import { initializePanelSuspectLedger } from "./services/PanelSuspectLedgerService.js";
import { initializeGpuCrashMonitor } from "./services/GpuCrashMonitorService.js";
import {
  readLastActiveProjectIdSync,
  readOpenWindowsManifestSync,
  readSessionOpenProjectsSync,
} from "./services/persistence/readLastProjectId.js";
import { writeSessionOpenProjects } from "./services/persistence/sessionOpenProjectsStore.js";
import {
  flushSessionOpenProjects,
  initSessionOpenProjectsTracker,
} from "./services/sessionOpenProjectsTracker.js";
import {
  initOpenWindowsTracker,
  resumeOpenWindowsSaves,
  saveOpenWindowsNow,
  scheduleOpenWindowsSave,
  suppressOpenWindowsSaves,
} from "./window/openWindowsTracker.js";
import { emergencyLogMainFatal } from "./utils/emergencyLog.js";

// CRITICAL: Run IPC sender validation before any handlers are registered
enforceIpcSenderValidation();
{
  const osToAppBootMs = getOsToAppBootMs();
  // Attach compile-cache state (enabled flag, status, cacheFileCount) so the
  // cold-start aggregator can tell cache-cold from cache-warm runs and flag a
  // silently-disabled cache. bootstrap.ts ran enableCompileCache() before this
  // module evaluated, so the captured status is already available.
  const compileCacheMeta = getCompileCacheMeta();
  const bootMeta: Record<string, unknown> = { ...compileCacheMeta };
  if (osToAppBootMs !== null) bootMeta.osToAppBootMs = osToAppBootMs;
  markPerformance(
    PERF_MARKS.APP_BOOT_START,
    Object.keys(bootMeta).length > 0 ? bootMeta : undefined
  );
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
  {
    // corsEnabled lets the trusted renderer fetch() video bytes for blob-URL
    // playback (Chromium's custom-scheme media loader can't consume follow-up
    // range requests — electron#51442). It only makes the scheme *eligible*
    // for cross-origin fetch: reads still require the handler to echo
    // Access-Control-Allow-Origin, which it does solely for trusted app
    // origins (see daintreeFileCorsOrigin in setup/protocols.ts), so browser
    // panels hosting remote sites gain no access.
    scheme: "daintree-file",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    // Sandboxed HTML file preview (#11191). standard:true gives the scheme
    // hierarchical URLs + a real origin so the browser natively resolves a
    // rendered page's relative/root-relative assets against the document URL
    // (`daintree-html://<token>/<relpath>`). Deliberately kept off the
    // battle-tested daintree-file:// scheme so its consumers (markdown images,
    // WebAudio fetch, file viewer) are untouched. No supportFetchAPI/corsEnabled:
    // preview docs run under `connect-src 'none'` and load assets via tags only.
    scheme: "daintree-html",
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    // Inline PDF preview (#11427). Chromium's built-in PDFium viewer engages for
    // any custom-scheme response typed `application/pdf` — verified against
    // Electron 42 / Chromium 148 — so this scheme exists purely to give the
    // viewer a `frame-src` allowance that can never resolve to anything but a
    // PDF. Kept off daintree-file:// on purpose: that scheme serves arbitrary
    // repo files under extension-derived MIME types and a `sandbox` response
    // CSP, and a sandboxed document blocks PDFium (ERR_BLOCKED_BY_CLIENT).
    // Deliberately minimal privileges: no `standard` (an opaque origin is more
    // isolated, and the query-string URL shape needs no hierarchical parsing),
    // and no supportFetchAPI/corsEnabled — the iframe navigates here, it never
    // fetch()es.
    scheme: "daintree-pdf",
    privileges: {
      secure: true,
    },
  },
  {
    // standard:true makes new URL("plugin://id/path") parse the host segment
    // as `id`. codeCache enables V8 bytecode persistence for JS bundles (same
    // rationale as app://). bypassCSP intentionally omitted — defaults to false
    // (#3757: never opt back in; add `plugin:` to source directives if needed).
    scheme: "plugin",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

// V8 tuning for renderer processes: heap limits and GC exposure.
// Semi-space 16 MB: the young generation commits up to ~2× the semi-space per
// renderer, and with one renderer per project view the slack multiplies. 64 MB
// (up to ~128 MB committed nursery per view under terminal streaming) bought
// scavenge frequency we don't need — terminal churn is short-lived garbage
// with a tiny live set, so scavenges stay sub-millisecond at 16 MB.
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=768 --max-semi-space-size=16 --expose-gc"
);

// Allow autoplay without user gesture (voice input, media panels).
// Per-view CPU throttling for cached views is managed by ProjectViewManager
// via CDP Emulation.setCPUThrottlingRate (per-renderer; window-wide
// setBackgroundThrottling is unsuitable since Electron 28 — #8599).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// BackForwardCache wastes memory in an Electron app (no browser navigation history).
// Translate: Chrome's page-translate feature has no surface in Electron and we never
// invoke it — disabling skips its startup wiring. The feature is "Translate" (the
// old "TranslateUI" name was renamed in Chromium ~M86 and is a no-op now).
// (CalculateNativeWinOcclusion was considered and rejected: it's a runtime power
// lever, not a boot win, and disabling it fights the per-view CDP throttling
// ProjectViewManager already does.)
const disabledFeatures = ["BackForwardCache", "Translate"];
app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Acquire single-instance lock before any file I/O or service initialization.
// A second instance must not touch log files, telemetry, or crash reporters.
const gotTheLock = isSmokeTest || app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[MAIN] Another instance is already running. Quitting...");
  app.quit();
} else {
  initializeLogger(app.getPath("userData"));

  // Seed per-module level overrides from persisted store so main-process
  // logging filters correctly from the very first log line. Utility processes
  // receive the same map after their first `ready` event.
  setLogLevelOverrides(store.get("logLevelOverrides") ?? {});

  // Visible-only: log batches are high-frequency and replayable (LOGS_GET_ALL),
  // so cached/frozen project views skip them instead of queueing every flush.
  registerLoggerTransport(
    broadcastToVisibleRenderers,
    () => BrowserWindow.getAllWindows().length > 0
  );

  if (!isE2EMode) {
    crashReporter.start({ uploadToServer: false });
  }
  initializeCrashLoopGuard();
  registerGlobalErrorHandlers();

  if (!app.isPackaged) {
    startDevDiagnostics();
  }

  const distPath = path.join(__dirname, "../../dist");

  initializeCrashRecoveryService();
  // Fold the pending-crash panel summaries into the suspect ledger immediately
  // after CrashRecoveryService consumes the marker. Per-panel decay (clean
  // launches, TTL) is applied during this same call. The hydration handler
  // reads `getQuarantinedPanelIds()` to filter terminals out of the safe-mode
  // restore set; surfacing per-panel quarantine to the renderer.
  initializePanelSuspectLedger(getCrashRecoveryService().getPendingCrash());

  // DatabaseMaintenance.initialize() runs the SQLite probe + recovery and MUST
  // complete before getSharedDb() opens the file. Dynamic import removes
  // main.ts as a static-graph importer of this service; shutdown.ts and
  // globalServicesInit.ts still pull it in via their own eager paths, so the
  // module remains on the eager graph — the win is keeping the boot path
  // free of an additional static edge and the sync probe off the
  // top-of-module evaluation. The 200ms startMaintenance() timer + suspend
  // listener wiring is handled by the `database-maintenance` deferred task
  // in globalServicesInit. See #8817.
  const { initializeDatabaseMaintenance } =
    await import("./services/DatabaseMaintenanceService.js");
  // Pass the clean-exit signal so probeDb can skip the O(size) quick_check
  // on clean boots. CrashLoopGuard zeros its crash count on a clean exit and
  // accumulates it on crashes, so count === 0 is a reliable clean-boot signal.
  initializeDatabaseMaintenance(getCrashLoopGuard().getCrashCount() === 0);

  // GpuCrashMonitor must install its `child-process-gone` listener BEFORE the
  // GPU process spawns (first BrowserWindow creation), so it sees crashes in
  // the small window between createWindow() and renderer-first-interactive.
  // Deferring it to the post-first-interactive queue would silently drop GPU
  // crashes during startup. Static import is fine here — the service module
  // is already pulled into the eager graph via AppHydrationService,
  // CrashRecoveryService, and the ipc/handlers/app/* handlers.
  initializeGpuCrashMonitor();

  const windowRegistry = new WindowRegistry();
  setWindowRegistry(windowRegistry);
  windowRegistry.wireFocusTracking(app);
  // Re-persist the manifest when focus moves: its order IS the focus order, and
  // that order decides which window gets focus on the next launch and which get
  // trimmed by the cap. A second listener rather than a hook inside
  // wireFocusTracking so the registry's focus bookkeeping stays independent of
  // persistence — and it is registered after, so the registry has already
  // recorded the focus by the time this reads it. Debounced, so alt-tabbing
  // collapses to one write.
  app.on("browser-window-focus", () => scheduleOpenWindowsSave());

  // Read last-active projectId synchronously from SQLite BEFORE creating any window.
  // This allows the initial WebContentsView to use the correct session partition,
  // giving crash isolation and V8 code cache benefits from the first render.
  const lastActiveProjectId = readLastActiveProjectIdSync();

  let powerMonitorInitialized = false;

  async function createWindow(
    initialProjectPath?: string | null,
    initialProjectId?: string,
    opts?: { revealMode?: "show" | "showInactive" }
  ): Promise<CreateWindowResult> {
    const { win, appView, loadRenderer, smokeTestTimer, smokeRendererUnresponsive } =
      setupBrowserWindow(__dirname, {
        onRecreateWindow: () => createWindow(initialProjectPath, initialProjectId).then(() => {}),
        onCreateWindow: (projectPath?: string) => createWindow(projectPath).then(() => {}),
        projectPath: initialProjectPath,
        initialProjectId,
        revealMode: opts?.revealMode,
      });
    setMainWindow(win);
    const ctx = windowRegistry.register(win, { projectPath: initialProjectPath ?? undefined });

    // Keep the persisted window manifest in step with this window (#11492).
    // The save listens on `closed`, not `close`: WindowRegistry still holds the
    // window at `close`, so a manifest built there would re-persist the window
    // the user just closed. Registered after `register()` so it runs after the
    // registry's own `once("closed")` unregister hook.
    // `win.id` is unreadable on a destroyed BrowserWindow, so the id is taken
    // from the registry context captured here rather than read in the handler.
    const closedWindowId = ctx.windowId;
    scheduleOpenWindowsSave();
    win.on("closed", () => saveOpenWindowsNow(closedWindowId));
    windowRegistry.registerAppViewWebContents(ctx.windowId, appView.webContents.id);
    // Paint-fabric surface views load the same preload as project views; the
    // paintSurface IPC namespace builds its per-window manager lazily and
    // reads the path from here.
    ctx.services.preloadDirname = __dirname;

    const pvm = new ProjectViewManager(win, {
      dirname: __dirname,
      onRecreateWindow: () => createWindow(initialProjectPath, initialProjectId).then(() => {}),
      windowRegistry,
      // Resolve to the same value the IPC handler returns so the main-process
      // LRU cap and the renderer's Settings view agree on first boot. Invalid
      // persisted values fall through to the E2E override or RAM-based default
      // instead of leaking into ProjectViewManager.
      cachedProjectViews: effectiveCachedProjectViews(
        store.get("terminalConfig")?.cachedProjectViews
      ),
      // Lets the eviction policy keep a view whose assistant is still running
      // out of the routine LRU pool (#11157) — evicting it would run the
      // revoke-and-kill path below and take the assistant's sub-agents and
      // background shells with it. Injected here rather than imported by
      // electron/window/ so the eviction controller stays free of both services.
      // The static import is free: PtyClient already value-imports
      // HelpSessionService, so it is in the eager graph either way.
      assistantBackendForProject: (projectId) => helpSessionService.getAssistantBackend(projectId),
      // The liveness half. PtyClient's spawn registry is main-local and
      // synchronous — written by spawn() before the host round-trip, dropped on
      // exit and on kill — so it is authoritative from the assistant's first
      // instant. The pty-host's terminal snapshot is not a substitute: it is
      // async, and a shard that times out comes back as an empty list, which
      // would read as "the assistant is gone" and unprotect a live one.
      isTerminalLive: (terminalId) => getPtyClient()?.hasTerminal(terminalId) === true,
      onViewEvicted: (wcId) => {
        // Each cleanup is isolated: if removeDirectPort throws, the worktree
        // port must still close. Partial cleanup leaves a live producer
        // posting into a soon-to-be-destroyed renderer.
        try {
          getWorkspaceClientRef()?.removeDirectPort(wcId);
        } catch (err) {
          console.error("[main] removeDirectPort failed during eviction:", err);
        }
        try {
          getWorktreePortBrokerRef()?.closePortsForView(wcId);
        } catch (err) {
          console.error("[main] closePortsForView failed during eviction:", err);
        }
        // Revoke help-session tokens bound to this evicted WebContents view.
        // Done synchronously off the eviction hook (lesson #5009) so a
        // renderer-side cleanup IPC can't go missing on view destruction.
        import("./services/HelpSessionService.js")
          .then(({ helpSessionService }) => helpSessionService.revokeByWebContentsId(wcId))
          .catch((err) => {
            console.warn("[main] revokeByWebContentsId failed during eviction:", err);
          });
      },
      onViewCached: (wcId) => {
        // Same producer cleanup as eviction: a cached view becomes
        // freeze-eligible once CPU throttling lands. Live worktree/workspace
        // ports would otherwise queue messages into a frozen renderer
        // (#6273). Reactivation re-brokers a fresh port via
        // activateProjectView in projectCrud/switch.ts.
        // Each cleanup is isolated so a throw in one path can't leave the
        // other producer alive — that's the exact failure mode this PR
        // exists to prevent.
        try {
          getWorkspaceClientRef()?.removeDirectPort(wcId);
        } catch (err) {
          console.error("[main] removeDirectPort failed during cache:", err);
        }
        try {
          getWorktreePortBrokerRef()?.closePortsForView(wcId);
        } catch (err) {
          console.error("[main] closePortsForView failed during cache:", err);
        }
      },
      onViewCrashed: (wc) => {
        // Tear down the per-window PTY MessagePort on renderer crash so the
        // pty-host's PortQueueManager can drop stale queue accounting before
        // reload re-issues a fresh port. Without this, a stale port keeps the
        // safety-timeout pause loop wedged for the entire reload window (#6244).
        if (win.isDestroyed()) return;
        getPtyClient()?.disconnectMessagePort(win.id);
        // Revoke help-session tokens pinned to the crashed WebContents (#9151).
        // The renderer comes back with a brand-new (monotonic) WebContents id,
        // so the old pin is now a tombstone — every CallTool would return
        // SESSION_BINDING_GONE and the targeted tier-mismatch / revoked IPCs
        // would silently no-op against the dead id. Mirrors the synchronous
        // eviction-hook revoke (lesson #5009); `wc.id` is the dead id the
        // session pinned at provision time.
        const crashedWcId = wc.id;
        import("./services/HelpSessionService.js")
          .then(({ helpSessionService }) => helpSessionService.revokeByWebContentsId(crashedWcId))
          .catch((err) => {
            console.warn("[main] revokeByWebContentsId failed during crash:", err);
          });
      },
      onViewReady: (wc) => {
        // Re-distribute PTY MessagePort on every view load/reload.
        // This ensures terminals work after view creation, crash recovery, or DevTools refresh.
        if (win.isDestroyed() || wc.isDestroyed()) return;
        const wCtx = windowRegistry.getByWindowId(win.id);
        if (wCtx) {
          distributePortsToView(win, wCtx, wc, getPtyClient());
        }
        // Refresh workspace direct port (preload context is reset on reload)
        getWorkspaceClientRef()?.attachDirectPort(win.id, wc);

        // Re-broker worktree port (preload context is reset on reload)
        const broker = getWorktreePortBrokerRef();
        const wsClient = getWorkspaceClientRef();
        if (broker && wsClient) {
          // This window's own manager, not the process-global one: the global
          // points at the last-created window, so an older window's view
          // reload would broker no port at all (#11100).
          const projectId = pvm.getProjectIdForWebContents(wc.id);
          if (projectId) {
            // Find the project path from PVM to look up the host
            const viewEntry = pvm.getAllViews().find((v) => v.projectId === projectId);
            if (viewEntry) {
              const host = wsClient.getHostForProject(viewEntry.projectPath);
              if (host) {
                broker.brokerPort(host, wc);
              }
            }
          }
        }

        // Replay the plugin contributions snapshot to a freshly-loaded view
        // (cold start, LRU restore, crash reload, DevTools refresh) so its
        // renderer registry is current even if every push was emitted while
        // the previous V8 context was alive. The renderer's pull-on-mount is
        // a separate path; this is the push path that lets the existing
        // persistent listeners overtake a slow IPC pull. Dynamically imported
        // to avoid pulling PluginService into main.ts's static graph (#9285).
        const wcId = wc.id;
        import("./services/PluginService.js")
          .then(({ pluginService }) => pluginService.pushSnapshotTo(wc))
          .catch((err) => {
            console.warn(`[main] pushSnapshotTo failed for wc ${wcId}:`, err);
          });
        // Replay the run-history snapshot to the freshly-loaded view so a
        // cold-started / LRU-restored renderer's history store is current even
        // if every prior push fired against a previous V8 context (#9949).
        import("./services/runHistory/runHistoryService.js")
          .then(({ pushRunHistorySnapshotTo }) => pushRunHistorySnapshotTo(wc))
          .catch((err) => {
            console.warn(`[main] run-history pushSnapshotTo failed for wc ${wcId}:`, err);
          });
        // Replay the project status map for the same reason (#11452). The stats
        // service suppresses unchanged broadcasts, so a view that loads while
        // the fleet is static would otherwise show every project unbanded until
        // agent state next moved. Statically imported, so no dynamic import.
        getProjectStatsService()?.pushSnapshotTo(wc);
        // Same reasoning, same suppression, run-grained: a view attaching to a
        // quiet fleet would otherwise render an empty queue until something
        // moved — and a quiet fleet is exactly when the queue is worth reading.
        getFleetSnapshotService()?.pushSnapshotTo(wc);

        // #10815: cold switch-back auto-resume is driven entirely by the
        // renderer's pull-on-mount `help.peekPendingHibernation` peek (which
        // surfaces the in-memory `panelWasOpen` flag), not a main→renderer push:
        // the lazy HelpPanel subscribes long after `did-finish-load` fires, so a
        // one-shot push was dropped on a true cold restore. No push needed here.
      },
    });
    // Publish to this window's context immediately, not later in
    // setupWindowServices: the renderer starts loading inside that call, so
    // anything resolving the manager per-window (crash classification, the
    // directory-open menu action) would otherwise see no manager for a window
    // that has one, and fall back to a global or legacy path (#11100).
    // setupWindowServices reassigns the same instance.
    ctx.services.projectViewManager = pvm;
    setProjectViewManager(pvm);

    // Sync this window's fresh PVM to the live resource profile — the
    // service's applyProfile fans out only on transitions, so a window
    // created while the app sits in a non-balanced profile would otherwise
    // keep its DEFAULT_* balanced constants until the next transition.
    getResourceProfileService()?.applyCurrentProfileTo(pvm);

    // E2E hooks: expose PVM accessor and heap-snapshot writer so the
    // nightly evicted-view leak spec can read main-process state and
    // dump a v8 snapshot from app.evaluate(). Mirrors the
    // __daintreeResetRateLimits / __daintreeFaultRegistry pattern.
    if (isE2EMode) {
      (globalThis as Record<string, unknown>).__daintreeGetPvm = getProjectViewManager;
      (globalThis as Record<string, unknown>).__daintreeWriteHeapSnapshot = (filePath: string) =>
        nodeV8.writeHeapSnapshot(filePath);
    }

    // E2E hook: crash a window's workspace host to exercise the
    // WorktreePortBroker teardown → host auto-restart → port re-broker path
    // (#9599). Resolved lazily so the workspace client need not exist at
    // registration time. Gated on DAINTREE_E2E_FAULT_MODE — stricter than the
    // PVM accessor above — so this crash seam never ships in production.
    if (isE2EFaultMode) {
      (globalThis as Record<string, unknown>).__daintreeCrashWorkspaceHostForWindow = (
        windowId: number
      ): boolean => {
        const host = getWorkspaceClientRef()?.getHostForWindow(windowId);
        return host?._crashForTesting() ?? false;
      };
      (globalThis as Record<string, unknown>).__daintreeWorkspaceHostHasLiveChildForWindow = (
        windowId: number
      ): boolean => {
        const host = getWorkspaceClientRef()?.getHostForWindow(windowId);
        return host?._hasLiveChildForTesting() ?? false;
      };
      (globalThis as Record<string, unknown>).__daintreeWorktreeHasPort = (
        webContentsId: number
      ): boolean => {
        return getWorktreePortBrokerRef()?.hasPort(webContentsId) ?? false;
      };
    }

    // Clean up ProjectViewManager when the window's cleanup runs.
    // Registered before setupWindowServices so pvm.dispose() runs first —
    // views must close before per-window ports/event-buffer disconnect.
    ctx.cleanup.add(
      toDisposable(() => {
        pvm.dispose();
        setProjectViewManager(null);
      })
    );

    const servicesResult = await setupWindowServices(win, {
      loadRenderer,
      smokeTestTimer,
      smokeRendererUnresponsive,
      windowRegistry,
      initialProjectPath: initialProjectPath ?? undefined,
      initialProjectId,
      projectViewManager: pvm,
      initialAppView: appView,
    });

    // The process is exiting, or the window never reached the registry and has
    // no services. Either way stop here, so a restore fan-out doesn't keep
    // building windows into a dying process or count this one as restored.
    if (servicesResult !== "ok") return servicesResult;

    // Seed the eviction guard's agent-state cache from the pty-host registry.
    // hasActiveAgent() is read synchronously during LRU scoring, so it can't
    // await the host; this fire-and-forget seed + event subscription keeps an
    // instance-level cache fresh (#10054). Must run AFTER setupWindowServices,
    // which constructs the PtyClient — getPtyClient() returns null before then,
    // so seeding earlier would leave the cache permanently empty on first launch
    // and re-break the active-agent eviction guard this fix restores.
    const pvmPtyClient = getPtyClient();
    if (pvmPtyClient) void pvm.initAgentStateCache(pvmPtyClient);

    if (!powerMonitorInitialized) {
      powerMonitorInitialized = true;
      setupPowerMonitor({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
        getMainProcessWatchdogClient: getMainProcessWatchdogClientRef,
      });
      setupWindowFocusThrottle({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
        getProjectStatsService,
        getFleetSnapshotService,
        getIdleTerminalNotificationService: () => getIdleTerminalNotificationService(),
      });
    }

    registerWindowForFocusThrottle(win);
    registerWindowSessionEndHandler(win);

    return "ok";
  }

  registerAppLifecycleHandlers({
    onCreateWindow: () => createWindow().then(() => {}),
    onCreateWindowForPath: (cliPath) => createWindow(cliPath).then(() => {}),
    getMainWindow,
    getCliAvailabilityService: getCliAvailabilityServiceRef,
    windowRegistry,
  });

  registerShutdownHandler({
    getPtyClient,
    setPtyClient: setPtyClientRef,
    getWorkspaceClient: getWorkspaceClientRef,
    getCleanupIpcHandlers,
    setCleanupIpcHandlers,
    getCleanupErrorHandlers,
    setCleanupErrorHandlers,
    getStopEventLoopLagMonitor,
    setStopEventLoopLagMonitor,
    getStopProcessMemoryMonitor,
    setStopProcessMemoryMonitor,
    getStopAppMetricsMonitor,
    setStopAppMetricsMonitor,
    getStopDiskSpaceMonitor,
    setStopDiskSpaceMonitor,
    windowRegistry,
  });

  app.whenReady().then(async () => {
    try {
      // Self-start GPU/compositor tracing when the cold-start harness asked
      // for it (DAINTREE_PERF_TRACE=1). No-op for every normal run. Must run
      // first inside whenReady so the trace covers the full window-reveal
      // pipeline; the matching stop runs on `will-quit` below.
      await startPerformanceTraceIfEnabled();
      // Fire-and-forget the user-PATH refresh. Runs concurrently with the
      // rest of startup; the PtyClient creation site awaits it before
      // spawning the PTY host (#8625). Kicked off inside whenReady() so the
      // shell probe never spawns a child process pre-ready — that path leaks
      // zombies on macOS Finder-launched packaged builds.
      markPerformance(PERF_MARKS.EARLY_PATH_REFRESH_START);
      kickOffEarlyPathRefresh().finally(() => {
        markPerformance(PERF_MARKS.EARLY_PATH_REFRESH_COMPLETE);
      });
      setupPermissionLockdown();
      registerDeepLinkProtocolClient();
      registerAppProtocol(distPath, { allowDisplayCapture: isDemoMode });
      registerDaintreeFileProtocol();
      registerDaintreeHtmlProtocol();
      registerDaintreePdfProtocol();
      // Register `plugin://` with a placeholder resolver that 404s every
      // request, keeping the heavy ~2900-line PluginService module off the
      // first-paint critical path (#10322). The handler must exist before
      // `createWindow()` so `registerProtocolsForSession` wires per-session
      // handlers; the deferred `plugin-service` task later calls
      // `setPluginDirResolver()` to point it at the real `getPluginDir` and
      // drains queued `.dntr` paths via `activateOpenFileInstaller`. The
      // placeholder is unobservable because a renderer can only learn a
      // `plugin://` module URL from a panel-kind contribution, and those are
      // published by PluginService — which installs the live resolver as its
      // first act, before any plugin loads (#11728). Keep that ordering: a 404
      // served here is permanent for that specifier in the renderer's module map.
      registerPluginProtocol(() => undefined);
      // Wire the `daintree://` deep-link path (#9559): take over live macOS
      // `open-url` events and drain any cold-launch URL (queued `open-url` on
      // macOS, `process.argv` on Windows/Linux). Routed to the primary window
      // once it paints, where the Plugin Manager opens — installs still go
      // through the existing confirm/security gates, never silently.
      activateDeepLinkHandler(windowRegistry);
      setupWebviewCSP();
      const launchIntent = resolveLaunchIntent({
        argv: process.argv,
        hasCliPathFlag,
        extractDirectoryPaths,
        pendingOpenDirPaths: getPendingOpenDirPaths(),
        pendingOpenFilePaths: getPendingOpenFilePaths(),
        isSafeMode: getCrashLoopGuard().isSafeMode(),
        hasPendingCrash: getCrashRecoveryService().getPendingCrash() !== null,
      });

      // A recovery launch deliberately opens one window. It must not then
      // persist that as the window set, or safe mode would overwrite the user's
      // real fleet with the reduced one it opened to diagnose it (#11492). A
      // targeted launch is NOT read-only: opening one folder from the CLI or
      // Finder is a genuine one-window session the user asked for, so the
      // manifest should describe it.
      initOpenWindowsTracker({ registry: windowRegistry, readOnly: launchIntent === "recovery" });

      // Freeze the previous session's open projects before anything can join
      // this one's set (#11794). Read unconditionally — a targeted or recovery
      // launch still draws the dot for what the last session had open, it just
      // doesn't get to rewrite the checkpoint. This must precede every
      // `registerInitialView()` and `setCurrentProject()` below, which write
      // into the same key as the fleet comes up.
      initSessionOpenProjectsTracker({
        previousSessionProjectIds: readSessionOpenProjectsSync(),
        launchAtMs: Date.now(),
        readOnly: launchIntent === "recovery",
        write: writeSessionOpenProjects,
      });

      const { hadManifest, records: restoreRecords } = shouldRestoreWindowFleet(launchIntent)
        ? readOpenWindowsManifestSync()
        : { hadManifest: false, records: [] };

      // The window that gets focus is the manifest's most-recently-focused
      // record — not `lastActiveProjectId`, which tracks the last project
      // *switched to* anywhere and can name a different window entirely.
      const primaryRestoreProjectId = resolvePrimaryRestoreProjectId(
        restoreRecords,
        hadManifest,
        lastActiveProjectId ?? undefined
      );

      // Prime the hydrate prefetch cache for the window that will take focus so
      // the renderer's first `app:boot` invoke resolves as a cache hit instead
      // of doing an inline disk read. Fire-and-forget — overlaps with window
      // creation. Skipped when:
      //   - no project to restore (first run / project unset / picker window)
      //   - safe mode or pending crash recovery (terminals are suppressed and
      //     the panelFilter path layers extra constraints)
      //   - per-project state file doesn't exist yet (migration must run on
      //     the renderer-blocking handler path — `buildSwitchHydrateResult`
      //     intentionally skips the migration write)
      if (primaryRestoreProjectId && launchIntent !== "recovery") {
        void projectStore
          .getProjectState(primaryRestoreProjectId)
          .then((state) => {
            if (state === null) return;
            return prefetchHydrateResult(primaryRestoreProjectId, buildSwitchHydrateResult);
          })
          .catch((error) => {
            console.warn("[MAIN] Boot-prime hydrate prefetch failed:", error);
          });
      }

      await restoreWindowFleet({
        records: restoreRecords,
        hadManifest,
        fallbackProjectId: lastActiveProjectId ?? undefined,
        createWindow: (projectId, opts) => createWindow(undefined, projectId, opts),
        suppressSaves: suppressOpenWindowsSaves,
        resumeSaves: resumeOpenWindowsSaves,
        onBackgroundWindowFailed: (reason) => {
          console.error("[MAIN] Restoring a background window failed:", reason);
        },
      });

      // Every open/close already persists the checkpoint, so this only matters
      // for the session that opens nothing — picker window, then quit. Without
      // it the previous session's value would survive on disk and the launch
      // after would light up its projects a second time (#11794). Deliberately
      // here rather than before the fleet comes up: it writes whatever has
      // accumulated, so it needs no ordering guarantee, and running it after
      // keeps the shared DB (and its migrations) off the first-paint path.
      flushSessionOpenProjects();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      // Startup crashes hard-exit without running before-quit, which means
      // markCleanExit() never fires and the CrashLoopGuard counts this as a
      // crash. That is correct — but without an on-disk trace the next
      // session has no way to diagnose the loop, since main-crash.log never
      // captures this path (it only logs from globalErrorHandlers). Wire it
      // here so a repeating startup failure leaves a stack behind.
      try {
        emergencyLogMainFatal("STARTUP_FAILED", error);
      } catch {
        // best-effort
      }
      app.exit(1);
    }
  });
}
