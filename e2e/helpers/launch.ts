import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, unlinkSync, readdirSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";
import { getDescendantPids } from "./stress";
import { removePathSync } from "./fixtures";
import {
  install as installTelemetry,
  beginAttempt,
  observeStderrLine,
  observeMainProcessExit,
  observeRendererCrash,
  writeSummary,
  dispose as disposeTelemetry,
} from "./launchTelemetry";

const ROOT = path.resolve(import.meta.dirname, "../..");

const fallbackGraceMs = 1_500;
const INITIAL_PROJECT_ID_EXPRESSION = "window.__DAINTREE_INITIAL_PROJECT__?.id ?? null";
const RENDERER_PROBE_TIMEOUT_MS = 1_000;
const E2E_MODE_ARG = "--daintree-e2e-mode";
const E2E_SKIP_FIRST_RUN_DIALOGS_ARG = "--daintree-e2e-skip-first-run-dialogs";
const E2E_FAULT_MODE_ARG = "--daintree-e2e-fault-mode";
const E2E_DEFER_RENDERER_LOAD_ARG = "--daintree-e2e-defer-renderer-load";
const E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE_ARG = "--daintree-e2e-disable-cached-view-cpu-throttle";
const E2E_CRASH_DUMPS_DIR_ARG = "--daintree-e2e-crash-dumps-dir=";
const E2E_SIDELOAD_PLUGIN_DIR_ARG = "--daintree-e2e-sideload-plugin-dir=";

export interface AppContext {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  userDataDir?: string;
  waitForSelector?: string;
  extraArgs?: string[];
  /**
   * When set to a digit 1-9, launches Electron with --force-device-scale-factor=N
   * so the renderer paints at NxCSS pixels. Used by the marketing-screenshot
   * pipeline to capture 4K-grade PNGs from a 1280x720 logical window on a
   * 1920x1080-capped CI display. Defaults to process.env.DAINTREE_SCREENSHOT_SCALE.
   */
  screenshotScale?: string;
  /**
   * Logical window size override. When unset, launchApp picks based on the
   * screen workArea (typically 1920x1080+). The screenshot pipeline uses
   * 1280x720 so scale=3 yields a 3840x2160 framebuffer.
   */
  windowSize?: { width: number; height: number };
  /**
   * Opt out of the default `DAINTREE_DISABLE_WEBGL=1` so the WebGL renderer
   * (and its addon) actually loads. Required by the nightly xterm memory-leak
   * regression — the WebglRenderer-side leak only materializes when the WebGL
   * addon is attached. Also suppresses the CI `--disable-gpu` /
   * `--disable-software-rasterizer` flags (which would kill WebGL context
   * creation). Defaults to `false` so every existing spec keeps WebGL off.
   * Only meaningful on a host with a real GPU; callers should skip on
   * `process.env.CI` runners where GPU is unavailable.
   */
  enableWebgl?: boolean;
}

function cleanupWindowsElectronProcesses(): void {
  if (process.platform !== "win32") return;
  try {
    execSync('taskkill /F /IM "electron.exe" /T', { stdio: "ignore" });
  } catch {
    // Ignore "no instance running" errors.
  }
}

function cleanupMacElectronE2eProcesses(): void {
  if (process.platform !== "darwin") return;
  try {
    // Kill only e2e-launched Electron processes (matched on `daintree-e2e`
    // user-data-dir). Production Daintree.app and dev sessions are untouched.
    // The -f full-command-line match catches every helper type (GPU, Renderer,
    // network-service utility, crashpad_handler) since they all inherit the
    // --user-data-dir argument.
    execSync('pkill -f "node_modules/electron.*daintree-e2e"', { stdio: "ignore" });
  } catch {
    // Ignore "no matching process" errors.
  }
}

let exitCleanupHandlersRegistered = false;

// Synchronously reap orphaned e2e Electron helpers. The macOS path matches a
// daintree-e2e-specific pkill pattern so it's always safe to run; the Windows
// path is a broad `taskkill /IM electron.exe` with no e2e filter, so restrict
// it to CI to avoid killing a developer's local dev session.
function reapOrphanedE2eProcesses(): void {
  cleanupMacElectronE2eProcesses();
  if (process.env.CI) cleanupWindowsElectronProcesses();
}

// Reap orphaned e2e Electron helpers when the Playwright worker is killed
// before closeApp runs — CI timeout (SIGTERM) or Ctrl+C (SIGINT). Playwright's
// globalTeardown and worker-fixture teardowns do NOT run on signal-driven
// termination, so this is the only reliable orphan-reaping path on abnormal
// exit; without it the network-service, GPU, renderer, and crashpad helpers
// leak. We deliberately do NOT reap on the normal `exit` event: a clean worker
// exit already ran closeApp's teardown, and broadcasting a system-wide pkill
// there could race a sibling project's live Electron when the `full` meta-suite
// runs buckets concurrently (e2eWorkers:2). Registered once per worker process;
// the boolean guard makes repeated launchApp calls no-ops.
export function registerExitCleanupHandlers(): void {
  if (exitCleanupHandlersRegistered) return;
  exitCleanupHandlersRegistered = true;

  // A caught signal does not terminate Node on its own — reap, then re-exit
  // with the conventional 128+signal code so the worker dies with an
  // identifiable status. process.once means a second Ctrl+C falls through to
  // Node's default handler and force-terminates.
  process.once("SIGINT", () => {
    reapOrphanedE2eProcesses();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    reapOrphanedE2eProcesses();
    process.exit(143);
  });
}

// Test-only: reset the one-time guard so unit tests can re-exercise
// registration. Not used by the harness itself.
export function __resetExitCleanupHandlersForTest(): void {
  exitCleanupHandlersRegistered = false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPageInitialProjectId(page: Page): Promise<string | null> {
  return await page
    .evaluate(() => {
      const initialProject = (
        window as unknown as {
          __DAINTREE_INITIAL_PROJECT__?: { id?: unknown };
        }
      ).__DAINTREE_INITIAL_PROJECT__;
      return typeof initialProject?.id === "string" ? initialProject.id : null;
    })
    .catch(() => null);
}

interface AttachedProjectInfo {
  projectId: string | null;
  url: string | null;
}

async function getAttachedProjectInfo(
  app: ElectronApplication,
  windowId?: number
): Promise<AttachedProjectInfo> {
  try {
    return await app.evaluate(
      async ({ BrowserWindow }, payload) => {
        const win =
          typeof payload.windowId === "number"
            ? BrowserWindow.fromId(payload.windowId)
            : BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return { projectId: null, url: null };

        const views = win.contentView?.children ?? [];
        let fallbackUrl: string | null = null;
        // The welcome appView is permanently added to contentView and is
        // typically first. Project views are added on top — iterate from
        // last to first and prefer the topmost project-id-bearing view.
        for (let i = views.length - 1; i >= 0; i--) {
          const wc = (views[i] as Electron.WebContentsView).webContents;
          if (!wc || wc.isDestroyed()) continue;

          const url = wc.getURL();
          if (fallbackUrl === null) fallbackUrl = url;

          const projectId = await Promise.race([
            wc.executeJavaScript(payload.projectIdExpression, true).catch(() => null),
            new Promise<null>((resolve) => setTimeout(resolve, payload.probeTimeoutMs)),
          ]);
          if (typeof projectId === "string" && projectId.length > 0) {
            return { projectId, url };
          }
        }
        return { projectId: null, url: fallbackUrl };
      },
      {
        windowId: windowId ?? null,
        projectIdExpression: INITIAL_PROJECT_ID_EXPRESSION,
        probeTimeoutMs: RENDERER_PROBE_TIMEOUT_MS,
      }
    );
  } catch {
    return { projectId: null, url: null };
  }
}

async function pollForAppWindow(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  // Prefer a project view when it appears — this handles session-2 relaunches
  // where the previously-active project auto-opens into a separate
  // WebContentsView. Modern project views use a static URL and expose their
  // identity through preload; keep the URL query fallback for older views.
  // Falls back to any app page after a short grace period so first-run launches
  // (no projects) still succeed.
  const deadline = Date.now() + timeoutMs;
  let fallbackSeenAt = 0;
  while (Date.now() < deadline) {
    let fallback: Page | null = null;
    for (const w of app.windows()) {
      const url = w.url();
      if (url.startsWith("app://daintree/") || url.includes("localhost")) {
        if (url.includes("projectId=") || (await getPageInitialProjectId(w))) return w;
        fallback = w;
      }
    }
    if (fallback) {
      if (fallbackSeenAt === 0) fallbackSeenAt = Date.now();
      if (Date.now() - fallbackSeenAt >= fallbackGraceMs) return fallback;
    } else {
      fallbackSeenAt = 0;
    }
    await wait(200);
  }
  const urls = app.windows().map((w) => w.url());
  throw new Error(`App WebContentsView page not found. Available pages: ${urls.join(", ")}`);
}

export async function launchApp(options: LaunchOptions = {}): Promise<AppContext> {
  // Windows CI can be slow during Playwright's electron.launch handshake even
  // when the app process is already running. Use fewer, longer attempts so a
  // slow-but-longer-than-expected first launch is not killed just before it
  // becomes ready.
  // macOS local dev: first 1–2 launches per Playwright worker can hang at
  // electron.launch's CDP handshake even though the app reaches steady-state
  // (deferred services finish starting). Subsequent launches
  // in the same worker succeed immediately. Allow a single retry so a flaky
  // first launch doesn't fail the spec.
  const isCI = Boolean(process.env.CI);
  const isWindowsCI = isCI && process.platform === "win32";
  const isNonWindowsCI = isCI && process.platform !== "win32";
  const isMacOSLocal = process.platform === "darwin" && !process.env.CI;
  const launchTimeout = isWindowsCI ? 75_000 : isNonWindowsCI ? 120_000 : 60_000;
  const maxAttempts = isWindowsCI ? 3 : isMacOSLocal ? 3 : 1;
  // On macOS local dev, the first 1–2 launches in a Playwright worker can
  // hang through the full launch window before recovering on retry. Cap each
  // attempt at 50s — long enough for cold-start CDP handshake, short enough
  // that all three attempts fit inside the bumped 240s test timeout
  // (50 + 1 + 50 + 1 + 50 = 152s, leaves ~88s for test work).
  const attemptTimeout = (_attempt: number) => (isMacOSLocal ? 50_000 : launchTimeout);
  let lastError: unknown = null;

  registerExitCleanupHandlers();
  installTelemetry();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    beginAttempt(attempt, maxAttempts);
    const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), "daintree-e2e-"));
    const args = [`--user-data-dir=${userDataDir}`, ROOT];
    args.unshift(E2E_MODE_ARG);
    if (options.env?.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS !== "0") {
      args.unshift(E2E_SKIP_FIRST_RUN_DIALOGS_ARG);
    }
    if (options.env?.DAINTREE_E2E_FAULT_MODE === "1") {
      args.unshift(E2E_FAULT_MODE_ARG);
    }
    if (options.env?.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR) {
      args.unshift(`${E2E_SIDELOAD_PLUGIN_DIR_ARG}${options.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR}`);
    }
    if (isCI) {
      args.unshift(E2E_DEFER_RENDERER_LOAD_ARG);
    }
    if (isWindowsCI) {
      args.unshift(E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE_ARG);
    }

    if (process.env.CI) {
      // CI runners lack real GPUs — disable GPU to prevent hangs.
      // Force scale factor 1 so the window uses full pixel resolution
      // (prevents display scaling from shrinking effective toolbar width).
      // When enableWebgl is requested, keep the GPU on: --disable-gpu would
      // prevent WebGL context creation and make the WebGL leak test inert.
      args.unshift(
        ...(options.enableWebgl ? [] : ["--disable-gpu", "--disable-software-rasterizer"]),
        "--noerrdialogs",
        "--force-device-scale-factor=1"
      );

      if (process.platform === "linux") {
        // Linux CI needs --no-sandbox and shared memory workaround
        args.unshift("--no-sandbox", "--disable-dev-shm-usage");
      }
    }
    if (isWindowsCI) {
      // Prevent Windows occlusion/background throttling from stalling startup.
      // Keep Chromium sandbox defaults on Windows; forcing --no-sandbox regressed
      // startup stability and correlated with 0xC0000005 main-process crashes.
      args.unshift(
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion"
      );
      cleanupWindowsElectronProcesses();
    }
    // macOS local: reap any leftover e2e Electron processes from prior specs
    // before each fresh launch. Zombie crashpad helpers from a closed app can
    // hold Mach ports and contribute to first-launch flakes.
    if (isMacOSLocal) cleanupMacElectronE2eProcesses();
    if (isMacOSLocal && !options.enableWebgl) {
      // Local macOS Electron E2E can hit Crashpad/GPU-process FATALs during
      // restart-heavy specs. Mirror the screenshot harness mitigation for
      // ordinary non-WebGL E2E launches; WebGL leak tests opt back into GPU.
      args.unshift("--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs");
    }

    if (options.extraArgs?.length) {
      args.unshift(...options.extraArgs);
    }

    // Marketing screenshot pipeline: when DAINTREE_SCREENSHOT_SCALE is set,
    // render the framebuffer at NxCSS pixels so page.screenshot captures
    // device-pixel output. windows-latest GitHub runners cap the OS display
    // at 1920x1080, so render-side scaling is the only path to 4K-grade PNGs.
    const screenshotScale = options.screenshotScale ?? process.env.DAINTREE_SCREENSHOT_SCALE;
    if (screenshotScale && /^[1-9]$/.test(screenshotScale)) {
      const scaleIdx = args.findIndex((a) => a.startsWith("--force-device-scale-factor"));
      if (scaleIdx >= 0) {
        args[scaleIdx] = `--force-device-scale-factor=${screenshotScale}`;
      } else {
        args.unshift(`--force-device-scale-factor=${screenshotScale}`);
      }
    }

    let app: ElectronApplication | null = null;
    try {
      const launchEnv = {
        ...process.env,
        ...options.env,
        NODE_ENV: "production",
        DAINTREE_E2E_MODE: "1",
        DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS:
          options.env?.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS ?? "1",
        DAINTREE_DISABLE_WEBGL: options.enableWebgl ? "0" : "1",
        // CI E2E keeps the BrowserWindow sentinel as the only early CDP target
        // until Playwright's electron.launch handshake resolves. Under runner
        // load, concurrent WebContentsView target creation can leave launch
        // waiting even after the app reaches steady state.
        ...(isCI
          ? {
              DAINTREE_E2E_DEFER_RENDERER_LOAD: "1",
            }
          : {}),
        ...(isWindowsCI
          ? {
              // Playwright already owns CDP sessions for WebContentsView
              // targets on Windows CI. Cached-view CPU throttling is a memory
              // optimization only; skip it in e2e so LRU tests don't collide
              // with Playwright's debugger attachment.
              DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE: "1",
            }
          : {}),
      };
      delete launchEnv.ELECTRON_RUN_AS_NODE;
      delete launchEnv.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

      // Route crash dumps and Chromium logs into workspace-relative paths so
      // CI artifact upload captures them. Per-launch uniqueness avoids
      // collisions across parallel Playwright workers and retry attempts.
      //
      // crashDumps are redirected via app.setPath("crashDumps") in
      // electron/setup/environment.ts (reads DAINTREE_E2E_CRASH_DUMPS_DIR).
      // Chromium logging goes to a file via --enable-logging=file --log-file.
      // Main-process stdout/stderr is teed to a separate file below.
      const artifactRoot = path.join(ROOT, "daintree-e2e-artifacts");
      const launchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const crashDumpsDir = path.join(artifactRoot, "crash-dumps", launchId);
      const logsDir = path.join(artifactRoot, "logs");
      const logFile = path.join(logsDir, `electron-main-${launchId}.log`);
      const teeFile = path.join(logsDir, `electron-main-${launchId}-tee.log`);
      mkdirSync(crashDumpsDir, { recursive: true });
      mkdirSync(logsDir, { recursive: true });
      launchEnv.DAINTREE_E2E_CRASH_DUMPS_DIR = crashDumpsDir;
      args.unshift(`${E2E_CRASH_DUMPS_DIR_ARG}${crashDumpsDir}`);
      args.push("--enable-logging=file", `--log-file=${logFile}`);

      // Do not pass executablePath here. Playwright only injects its Electron
      // loader on the default path; the loader holds app.whenReady() until the
      // Node and browser CDP sessions are attached. Supplying the path manually
      // lets Daintree create WebContentsView targets while launch is still
      // connecting, which flakes under release-runner fanout.
      app = await electron.launch({
        args,
        env: launchEnv,
        timeout: attemptTimeout(attempt),
      });

      app.on("close", () => console.log("[e2e] Electron app closed"));
      // DIAGNOSTIC: forward stdout/stderr so we can see main-process logs
      try {
        const proc = app.process();
        proc.stdout?.on("data", (chunk: Buffer) => {
          process.stderr.write(`[E2E_STDOUT] ${chunk.toString()}`);
          try {
            appendFileSync(teeFile, `[STDOUT] ${chunk.toString()}`);
          } catch {
            /* best-effort file tee */
          }
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          observeStderrLine(chunk.toString());
          process.stderr.write(`[E2E_STDERR] ${chunk.toString()}`);
          try {
            appendFileSync(teeFile, `[STDERR] ${chunk.toString()}`);
          } catch {
            /* best-effort file tee */
          }
        });
        proc.on("exit", (code: number | null, signal: string | null) => {
          observeMainProcessExit(code, signal);
          process.stderr.write(`[E2E_EXIT] code=${code} signal=${signal}\n`);
        });
      } catch {
        /* best-effort diagnostic */
      }

      // After WebContentsView migration, firstWindow() returns the BW sentinel page.
      // Poll for the real app page loaded in the WebContentsView.
      const window = await pollForAppWindow(app, launchTimeout);
      window.on("crash", () => {
        observeRendererCrash();
        console.error("[e2e] Renderer crashed");
      });
      window.on("console", (msg) => {
        if (msg.type() === "error") console.error("[e2e:console]", msg.text());
      });

      // Set a minimum window size so toolbar overflow doesn't hide buttons.
      // Skip for restart tests to preserve persisted window state.
      if (!options.userDataDir) {
        const explicitSize = options.windowSize;
        await app.evaluate(({ BrowserWindow, screen }, payload) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return;
          if (payload) {
            win.setSize(payload.width, payload.height);
            win.center();
            return;
          }
          const { width, height } = screen.getPrimaryDisplay().workAreaSize;
          const targetW = Math.max(width, 1920);
          const targetH = Math.max(height, 1080);
          win.setSize(targetW, targetH);
          win.center();
          if (width >= targetW && height >= targetH) {
            win.maximize();
          }
        }, explicitSize ?? null);
      }

      await window.waitForLoadState("domcontentloaded");

      // Use sidebar toggle as ready indicator — it has priority 1 and is
      // always visible regardless of toolbar overflow or window size.
      const readySelector = options.waitForSelector ?? '[aria-label="Toggle Sidebar"]';
      await window.locator(readySelector).waitFor({ state: "visible", timeout: launchTimeout });

      disposeTelemetry();
      return { app, window, userDataDir };
    } catch (error) {
      lastError = error;
      if (app) {
        await closeApp(app);
      }
      if (!options.userDataDir) {
        try {
          removePathSync(userDataDir);
        } catch {
          // Best-effort cleanup for failed launch attempts.
        }
      }
      if (attempt < maxAttempts) {
        writeSummary();
        console.warn(`[e2e] Launch attempt ${attempt}/${maxAttempts} failed, retrying...`);
        if (isWindowsCI) cleanupWindowsElectronProcesses();
        if (isMacOSLocal) cleanupMacElectronE2eProcesses();
        // macOS local retry needs to fit inside the 120s test timeout.
        // Keep the retry-prep wait short so the retry attempt has its full budget.
        await wait(isMacOSLocal ? 1000 : 2000 * attempt);
      }
    }
  }

  writeSummary();
  disposeTelemetry();
  throw lastError instanceof Error ? lastError : new Error("Failed to launch Electron app");
}

/**
 * Re-acquire the active app window after a project switch.
 * The ProjectViewManager creates new WebContentsViews, so the Playwright
 * page reference from launchApp() becomes stale. This returns the latest
 * app page, matching project views by their preload-seeded project identity.
 */
export interface GetActiveAppWindowOptions {
  /**
   * If true, wait the full timeout for a project view identity to appear before
   * returning. Use this after operations that should result in a project view
   * being created/activated (e.g., onboarding, project switch).
   */
  requireProject?: boolean;
}

function getRefreshTimeout(): number {
  const isWindowsCI = process.env.CI && process.platform === "win32";
  return isWindowsCI ? 60_000 : process.env.CI ? 30_000 : 20_000;
}

export async function getActiveAppWindow(
  app: ElectronApplication,
  timeoutMsOrOptions: number | GetActiveAppWindowOptions = 10_000,
  maybeOptions: GetActiveAppWindowOptions = {}
): Promise<Page> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : 10_000;
  const options = typeof timeoutMsOrOptions === "number" ? maybeOptions : timeoutMsOrOptions;
  const requireProject = options.requireProject ?? false;

  const deadline = Date.now() + timeoutMs;
  // Grace period before returning a non-project fallback: after a project
  // operation, the project WebContentsView may take a moment to expose its
  // preload-seeded identity. Returning the welcome page too early causes tests
  // to grab the wrong renderer.
  let fallback: Page | null = null;
  let fallbackSeenAt = 0;
  while (Date.now() < deadline) {
    fallback = null;
    const fallbackCandidates: Page[] = [];
    const activeProjectId = (await getAttachedProjectInfo(app)).projectId;
    let projectFallback: Page | null = null;
    let projectPageCount = 0;

    for (const w of app.windows()) {
      const url = w.url();
      if (!(url.startsWith("app://daintree/") || url.includes("localhost"))) continue;

      const pageProjectId = await getPageInitialProjectId(w);

      // Best match: a project view that the main process currently has attached
      // to the BrowserWindow.
      if (activeProjectId && pageProjectId === activeProjectId) {
        return w;
      }

      if (pageProjectId) {
        projectPageCount++;
        if (projectFallback === null) projectFallback = w;
      } else {
        fallback = w;
        fallbackCandidates.push(w);
      }
    }

    if (projectFallback && (!requireProject || (!activeProjectId && projectPageCount === 1))) {
      return projectFallback;
    }

    if (fallback) {
      if (requireProject) {
        if (activeProjectId) {
          for (const candidate of fallbackCandidates) {
            if (await pageLooksLikeProjectView(candidate)) return candidate;
          }
          await wait(200);
          continue;
        }
        // With Playwright's Electron loader, the active WebContentsView can be
        // exposed as app://daintree/index.html even after project state hydrates.
        // Treat it as a project page only after the renderer reports a project.
        // For scoped static-URL views, project:get-current can briefly return
        // null while the visible toolbar already reflects the hydrated project.
        for (const candidate of fallbackCandidates) {
          if (await pageLooksLikeProjectView(candidate)) return candidate;
        }
      } else {
        for (const candidate of fallbackCandidates) {
          if (await pageLooksLikeProjectView(candidate)) return candidate;
        }
        if (fallbackSeenAt === 0) fallbackSeenAt = Date.now();
        if (Date.now() - fallbackSeenAt >= fallbackGraceMs) return fallback;
      }
    } else {
      fallbackSeenAt = 0;
    }
    await wait(200);
  }
  if (fallback && !requireProject) return fallback;
  const urls = app.windows().map((w) => w.url());
  throw new Error(`No active app window found. Available pages: ${urls.join(", ")}`);
}

const registeredPages = new WeakSet<Page>();

async function pageLooksLikeProjectView(page: Page): Promise<boolean> {
  const projectName = await getCurrentProjectName(page);
  if (projectName) return true;
  const projectLabel = await getProjectSwitcherLabel(page);
  if (projectLabel) return true;
  return await page
    .locator(
      '[aria-label="Toggle Sidebar"], [data-worktree-branch], [data-worktree-is-main="true"], [aria-label="Worktrees"]'
    )
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}

async function getCurrentProjectName(page: Page): Promise<string | null> {
  return await page
    .evaluate(async () => {
      const electronApi = (
        window as unknown as {
          electron?: {
            project?: {
              getCurrent?: () => Promise<{ name?: unknown } | null>;
            };
          };
        }
      ).electron;
      const project = await electronApi?.project?.getCurrent?.();
      return typeof project?.name === "string" ? project.name : null;
    })
    .catch(() => null);
}

async function getProjectSwitcherLabel(page: Page): Promise<string | null> {
  return await page
    .locator('[data-testid="project-switcher-trigger"]')
    .textContent({ timeout: 500 })
    .catch(() => null);
}

export async function waitForActiveProject(
  app: ElectronApplication,
  page: Page,
  projectName: string,
  timeoutMs = getRefreshTimeout()
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let current = page;
  let lastName: string | null = null;
  let lastLabel: string | null = null;
  let lastUrl = current.url();

  while (Date.now() < deadline) {
    const remaining = Math.max(1_000, Math.min(2_000, deadline - Date.now()));
    const candidate = await getActiveAppWindow(app, remaining, { requireProject: true }).catch(
      () => null
    );
    if (candidate) {
      current = candidate;
      lastUrl = current.url();
      lastName = await getCurrentProjectName(current);
      lastLabel = await getProjectSwitcherLabel(current);
      if (lastLabel?.includes(projectName) && (lastName?.includes(projectName) ?? true)) {
        const ready = await refreshActiveWindow(app);
        const readyName = await getCurrentProjectName(ready);
        const readyLabel = await getProjectSwitcherLabel(ready);
        if (readyLabel?.includes(projectName) && (readyName?.includes(projectName) ?? true)) {
          return ready;
        }
        current = ready;
        lastName = readyName;
        lastLabel = readyLabel;
        lastUrl = ready.url();
      }
    }
    await wait(250);
  }

  throw new Error(
    `Timed out waiting for active project "${projectName}". Last active project: ${
      lastName ?? "unknown"
    }; last toolbar label: ${lastLabel ?? "unknown"}; last URL: ${lastUrl}`
  );
}

/**
 * Re-acquire the active app window and wait for it to be ready.
 * Use after any operation that may create a new WebContentsView
 * (project open, onboarding, empty-grid transition, etc.).
 * If the page hasn't changed, this is a no-op that just confirms readiness.
 */
export async function refreshActiveWindow(app: ElectronApplication, oldPage?: Page): Promise<Page> {
  // After a project op (open/onboard/switch) the new project WebContentsView
  // may take a moment to load its URL. Wait for the project view rather than
  // returning the welcome page early.
  //
  // When called with an `oldPage`, also wait until the currently-attached
  // WebContents differs from oldPage's URL — otherwise we may snapshot the
  // attached view *before* the main process has finished swapping it out and
  // return the still-active outgoing view.
  const refreshTimeout = getRefreshTimeout();

  const oldProjectId = oldPage ? await getPageInitialProjectId(oldPage) : null;

  if (oldProjectId) {
    const deadline = Date.now() + refreshTimeout;
    while (Date.now() < deadline) {
      const activeProjectId = (await getAttachedProjectInfo(app)).projectId;
      if (activeProjectId && activeProjectId !== oldProjectId) break;
      await wait(150);
    }
  }

  const newWindow = await getActiveAppWindow(app, refreshTimeout, { requireProject: true });

  if (!registeredPages.has(newWindow)) {
    registeredPages.add(newWindow);
    newWindow.on("crash", () => console.error("[e2e] Renderer crashed"));
    newWindow.on("console", (msg) => {
      if (msg.type() === "error") console.error("[e2e:console]", msg.text());
    });
  }

  await newWindow
    .locator('[aria-label="Toggle Sidebar"]')
    .waitFor({ state: "visible", timeout: refreshTimeout });

  // <Sidebar> mounts only after currentProject hydrates — best-effort gate
  // before the worktree poll. Use attached not visible: a gesture-hidden
  // sidebar is aria-hidden/inert but still in the DOM.
  await newWindow
    .locator('aside[aria-label="Sidebar"]')
    .waitFor({ state: "attached", timeout: refreshTimeout })
    .catch(() => {});

  // Wait for the project's active worktree to finish loading. Without this,
  // shortcuts like Cmd+Alt+T fire with `activeWorktreeId=undefined`, which
  // creates an orphan panel that never renders (worktree-filtered out) — the
  // root cause of the original "Cmd+Alt+T opens a new terminal" flake.
  await newWindow
    .locator(
      '[data-worktree-branch], [data-worktree-is-main="true"], [aria-label="Worktrees"] a, [aria-label="Worktrees"] [role="button"], .worktree-item'
    )
    .first()
    .waitFor({ state: "attached", timeout: refreshTimeout })
    .catch(() => {});

  // After WebContentsView creation, the new view's renderer may not receive
  // keyboard events from Playwright's CDP `Input.dispatchKeyEvent` until the
  // view has been focused by the main process, the CDP target brought to
  // front, and a click inside the document has landed. Without all three,
  // the first `keyboard.press` after a project switch can be silently
  // dropped — manifesting as flaky/failed shortcut tests.
  try {
    // 1. Tell the main process to focus this project's WebContentsView.
    const projectId = await newWindow
      .evaluate(() => {
        const initialProject = (
          window as unknown as {
            __DAINTREE_INITIAL_PROJECT__?: { id?: unknown };
          }
        ).__DAINTREE_INITIAL_PROJECT__;
        return typeof initialProject?.id === "string" ? initialProject.id : null;
      })
      .catch(() => null);
    if (projectId) {
      await app.evaluate(
        async ({ BrowserWindow }, payload) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win || win.isDestroyed()) return;
          win.focus();
          const views = win.contentView?.children ?? [];
          for (const child of views) {
            const wc = (child as Electron.WebContentsView).webContents;
            if (!wc || wc.isDestroyed()) continue;
            const childProjectId = await Promise.race([
              wc.executeJavaScript(payload.projectIdExpression, true).catch(() => null),
              new Promise<null>((resolve) => setTimeout(resolve, payload.probeTimeoutMs)),
            ]);
            if (childProjectId === payload.projectId) {
              wc.focus();
              break;
            }
          }
        },
        {
          projectId,
          projectIdExpression: INITIAL_PROJECT_ID_EXPRESSION,
          probeTimeoutMs: RENDERER_PROBE_TIMEOUT_MS,
        }
      );
    }

    // 2. Bring the Playwright CDP target for this page to the front so that
    // `Input.dispatchKeyEvent` events are routed to this WebContents.
    await newWindow.bringToFront().catch(() => {});

    // 3. Click inside the document to give the browser keyboard focus to a
    // real node, then poll `document.hasFocus()` and retry a few times if
    // the document isn't claiming focus yet.
    const grid = newWindow.locator('[data-grid-container="true"]').first();
    const clickTarget = (await grid.isVisible({ timeout: 2_000 }).catch(() => false))
      ? grid
      : newWindow.locator("body");
    for (let attempt = 0; attempt < 5; attempt++) {
      await clickTarget.click({ position: { x: 5, y: 5 }, force: true });
      const hasFocus = await newWindow.evaluate(() => document.hasFocus()).catch(() => false);
      if (hasFocus) break;
      await wait(200);
    }

    // 4. Warm up the CDP keyboard input pipeline. The very first
    // `Input.dispatchKeyEvent` to a freshly-created WebContentsView can be
    // silently dropped on macOS even when the document has focus. Pressing
    // and releasing a harmless modifier here ensures the input channel is
    // primed before tests send their real shortcut presses. Avoid bare Shift:
    // the app intentionally treats double-Shift as the Action Palette toggle.
    await newWindow.keyboard.press("Control").catch(() => {});
  } catch {
    // Best-effort focus; tests can still proceed.
  }

  return newWindow;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  // app.process() throws on Playwright >=1.58 if the underlying child process
  // has already exited (e.g., a launch attempt crashed during startup before
  // the WebContentsView appeared). Without this guard, closeApp throws inside
  // launchApp's retry-cleanup path and prevents descendant processes from
  // being reaped — turning a single launch flake into a zombie-process leak.
  let pid: number | undefined;
  try {
    pid = app.process()?.pid;
  } catch {
    pid = undefined;
  }

  // Collect all descendant PIDs BEFORE closing — once the parent dies,
  // children get reparented to PID 1 and we can no longer find them via ppid.
  const descendantPids = pid ? getDescendantPids(pid) : [];

  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 10_000)),
    ]);
  } catch {
    // Force-kill if close() hangs (zombie process prevention)
    forceKillProcessTree(pid);
  }

  // Kill any lingering descendant processes (PTY host, workspace host, shells).
  // These may have been reparented to PID 1 after the main process exited.
  for (const childPid of descendantPids) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /PID ${childPid} /T 2>nul`, { stdio: "ignore" });
      } else {
        process.kill(childPid, "SIGKILL");
      }
    } catch {
      // Already dead
    }
  }
}

function forceKillProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: "ignore" });
    } else {
      try {
        execSync(`pkill -9 -P ${pid}`, { stdio: "ignore" });
      } catch {
        // No children or pkill not available
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process group kill failed
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  } catch {
    // Already dead
  }
}

export async function waitForProcessExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await wait(100);
        continue;
      }
      return;
    }
    await wait(100);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

export function removeSingletonFiles(userDataDir: string): void {
  try {
    const entries = readdirSync(userDataDir);
    for (const entry of entries) {
      if (entry.startsWith("Singleton")) {
        try {
          unlinkSync(path.join(userDataDir, entry));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // directory may not exist yet
  }
}

export async function mockOpenDialog(
  app: ElectronApplication,
  directoryPath: string
): Promise<void> {
  await app.evaluate(async ({ dialog }, dirPath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dirPath] });
  }, directoryPath);
}

export interface WindowHandle {
  page: Page;
  windowId: number;
}

async function listKnownWindowIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => w.id);
  });
}

/**
 * Resolve the active appView Page for a specific BrowserWindow id.
 * Use after opening a second window — the global `getActiveAppWindow`
 * targets `BrowserWindow.getAllWindows()[0]`, which is Z-ordered and may
 * return the wrong window once more than one exists.
 */
export async function getWindowPage(
  app: ElectronApplication,
  windowId: number,
  timeoutMs = getRefreshTimeout()
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | null = null;
  let lastProjectId: string | null = null;
  while (Date.now() < deadline) {
    const attached = await getAttachedProjectInfo(app, windowId);
    lastUrl = attached.url;
    lastProjectId = attached.projectId;

    if (attached.projectId) {
      for (const w of app.windows()) {
        if ((await getPageInitialProjectId(w)) === attached.projectId) return w;
      }
    } else if (attached.url?.includes("projectId=")) {
      for (const w of app.windows()) {
        if (w.url() === attached.url) return w;
      }
    }
    await wait(150);
  }
  const urls = app.windows().map((w) => w.url());
  throw new Error(
    `No project view found for windowId=${windowId}. Last attached project: ${
      lastProjectId ?? "none"
    }. Last attached URL: ${lastUrl ?? "none"}. Available pages: ${urls.join(", ")}`
  );
}

/**
 * Open a second BrowserWindow via `window.electron.window.openNew(projectPath?)`
 * and return its handle (page + windowId). When `projectPath` is provided,
 * the new window auto-opens that project via `handleDirectoryOpen` — the
 * same path the `app.newWindow` action takes when invoked with args.
 *
 * Captures the BrowserWindow id-snapshot before the call so the newly-created
 * window can be identified without relying on the Z-ordered `getAllWindows()`
 * array order (which is unstable in Electron 41).
 *
 * The returned `page` is the BW sentinel page (`data:` URL). For the active
 * project view, call `getWindowPage(app, handle.windowId)` after the
 * project finishes loading.
 */
export async function openSecondWindow(
  app: ElectronApplication,
  driverPage: Page,
  options: { projectPath?: string; timeoutMs?: number } = {}
): Promise<WindowHandle> {
  const timeoutMs = options.timeoutMs ?? getRefreshTimeout();
  const knownIds = new Set(await listKnownWindowIds(app));

  await driverPage.evaluate(async (projectPath?: string) => {
    const api = (
      window as unknown as {
        electron?: { window?: { openNew?: (p?: string) => Promise<void> } };
      }
    ).electron?.window;
    if (!api?.openNew) {
      throw new Error("window.electron.window.openNew is not available");
    }
    await api.openNew(projectPath);
  }, options.projectPath);

  const idDeadline = Date.now() + timeoutMs;
  let newWindowId: number | null = null;
  while (Date.now() < idDeadline) {
    const ids = await listKnownWindowIds(app);
    const fresh = ids.filter((id) => !knownIds.has(id));
    if (fresh.length > 0) {
      newWindowId = fresh[fresh.length - 1];
      break;
    }
    await wait(150);
  }
  if (newWindowId === null) {
    throw new Error(`Second BrowserWindow did not appear within ${timeoutMs}ms after openNew`);
  }

  const pageDeadline = Date.now() + timeoutMs;
  let sentinelPage: Page | null = null;
  while (Date.now() < pageDeadline) {
    const sentinelUrl = await app
      .evaluate(({ BrowserWindow }, id) => {
        const win = BrowserWindow.fromId(id);
        if (!win || win.isDestroyed()) return null;
        return win.webContents.getURL();
      }, newWindowId)
      .catch(() => null);

    if (sentinelUrl) {
      for (const w of app.windows()) {
        if (w.url() === sentinelUrl) {
          sentinelPage = w;
          break;
        }
      }
      if (sentinelPage) break;
    }
    await wait(150);
  }

  if (!sentinelPage) {
    throw new Error(`Second window sentinel page did not appear within ${timeoutMs}ms`);
  }

  return { page: sentinelPage, windowId: newWindowId };
}

/**
 * Focus a specific BrowserWindow + its project view so CDP keyboard input
 * routes to that page. Mirrors the warm-up sequence in `refreshActiveWindow`
 * but scoped to a windowId rather than the Z-ordered `getAllWindows()[0]`.
 */
export async function focusWindow(
  app: ElectronApplication,
  windowId: number,
  page: Page
): Promise<void> {
  try {
    const projectId = await getPageInitialProjectId(page);

    await app.evaluate(
      async ({ BrowserWindow }, payload) => {
        const win = BrowserWindow.fromId(payload.id);
        if (!win || win.isDestroyed()) return;
        win.focus();
        if (!payload.projectId) return;
        const views = win.contentView?.children ?? [];
        for (const child of views) {
          const wc = (child as Electron.WebContentsView).webContents;
          if (!wc || wc.isDestroyed()) continue;
          const childProjectId = await Promise.race([
            wc.executeJavaScript(payload.projectIdExpression, true).catch(() => null),
            new Promise<null>((resolve) => setTimeout(resolve, payload.probeTimeoutMs)),
          ]);
          if (childProjectId === payload.projectId) {
            wc.focus();
            break;
          }
        }
      },
      {
        id: windowId,
        projectId,
        projectIdExpression: INITIAL_PROJECT_ID_EXPRESSION,
        probeTimeoutMs: RENDERER_PROBE_TIMEOUT_MS,
      }
    );

    await page.bringToFront().catch(() => {});

    const grid = page.locator('[data-grid-container="true"]').first();
    const clickTarget = (await grid.isVisible({ timeout: 2_000 }).catch(() => false))
      ? grid
      : page.locator("body");
    for (let attempt = 0; attempt < 5; attempt++) {
      await clickTarget.click({ position: { x: 5, y: 5 }, force: true });
      const hasFocus = await page.evaluate(() => document.hasFocus()).catch(() => false);
      if (hasFocus) break;
      await wait(200);
    }

    await page.keyboard.press("Control").catch(() => {});
  } catch {
    // Best-effort focus; tests can still proceed.
  }
}

/**
 * Close a specific BrowserWindow by id and wait until it's destroyed.
 * Used by multi-window specs that need to verify per-window cleanup
 * without tearing down the entire ElectronApplication.
 */
export async function closeWindow(
  app: ElectronApplication,
  windowId: number,
  timeoutMs = getRefreshTimeout()
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    if (win && !win.isDestroyed()) win.close();
  }, windowId);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillAlive = await app.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id);
      return !!win && !win.isDestroyed();
    }, windowId);
    if (!stillAlive) return;
    await wait(150);
  }
  throw new Error(`Window ${windowId} did not close within ${timeoutMs}ms`);
}
