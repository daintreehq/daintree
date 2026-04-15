import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "module";
import { mkdtempSync, rmSync, unlinkSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const ROOT = path.resolve(import.meta.dirname, "../..");

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
}

function cleanupWindowsElectronProcesses(): void {
  if (process.platform !== "win32") return;
  try {
    execSync('taskkill /F /IM "electron.exe" /T', { stdio: "ignore" });
  } catch {
    // Ignore "no instance running" errors.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForAppWindow(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  // Prefer a project view (URL with `projectId=`) when it appears — this handles
  // session-2 relaunches where the previously-active project auto-opens into a
  // separate WebContentsView. Falls back to any app page after a short grace
  // period so first-run launches (no projects) still succeed.
  const deadline = Date.now() + timeoutMs;
  const fallbackGraceMs = 1_500;
  let fallbackSeenAt = 0;
  while (Date.now() < deadline) {
    let fallback: Page | null = null;
    for (const w of app.windows()) {
      const url = w.url();
      if (url.startsWith("app://canopy/") || url.includes("localhost")) {
        if (url.includes("projectId=")) return w;
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
  // Windows CI can hang during Playwright's electron.launch handshake even when
  // the app process is already running. Keep attempts high, but fail fast.
  const isWindowsCI = process.env.CI && process.platform === "win32";
  const launchTimeout = isWindowsCI ? 45_000 : 60_000;
  const maxAttempts = isWindowsCI ? 5 : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), "canopy-e2e-"));
    const args = [`--user-data-dir=${userDataDir}`, ROOT];

    if (process.env.CI) {
      // CI runners lack real GPUs — disable GPU to prevent hangs.
      // Force scale factor 1 so the window uses full pixel resolution
      // (prevents display scaling from shrinking effective toolbar width).
      args.unshift(
        "--disable-gpu",
        "--disable-software-rasterizer",
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

    if (options.extraArgs?.length) {
      args.unshift(...options.extraArgs);
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
        DAINTREE_DISABLE_WEBGL: "1",
        ...(isWindowsCI
          ? {
              DAINTREE_E2E_DEFER_RENDERER_LOAD: "1",
            }
          : {}),
      };
      delete launchEnv.ELECTRON_RUN_AS_NODE;
      delete launchEnv.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

      app = await electron.launch({
        executablePath: electronPath,
        args,
        env: launchEnv,
        timeout: launchTimeout,
      });

      app.on("close", () => console.log("[e2e] Electron app closed"));

      // After WebContentsView migration, firstWindow() returns the BW sentinel page.
      // Poll for the real app page loaded in the WebContentsView.
      const window = await pollForAppWindow(app, launchTimeout);
      window.on("crash", () => console.error("[e2e] Renderer crashed"));
      window.on("console", (msg) => {
        if (msg.type() === "error") console.error("[e2e:console]", msg.text());
      });

      // Set a minimum window size so toolbar overflow doesn't hide buttons.
      // Skip for restart tests to preserve persisted window state.
      if (!options.userDataDir) {
        await app.evaluate(({ BrowserWindow, screen }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return;
          const { width, height } = screen.getPrimaryDisplay().workAreaSize;
          const targetW = Math.max(width, 1920);
          const targetH = Math.max(height, 1080);
          win.setSize(targetW, targetH);
          win.center();
          // Only maximize when the display is large enough — on macOS,
          // maximize (zoom) shrinks the window to the work area, which
          // can be narrower than the 1920px we need for toolbar tests.
          if (width >= targetW && height >= targetH) {
            win.maximize();
          }
        });
      }

      await window.waitForLoadState("domcontentloaded");

      // Use sidebar toggle as ready indicator — it has priority 1 and is
      // always visible regardless of toolbar overflow or window size.
      const readySelector = options.waitForSelector ?? '[aria-label="Toggle Sidebar"]';
      await window.locator(readySelector).waitFor({ state: "visible", timeout: launchTimeout });

      return { app, window, userDataDir };
    } catch (error) {
      lastError = error;
      if (app) {
        await closeApp(app);
      }
      if (!options.userDataDir) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup for failed launch attempts.
        }
      }
      if (attempt < maxAttempts) {
        console.warn(`[e2e] Launch attempt ${attempt}/${maxAttempts} failed, retrying...`);
        if (isWindowsCI) cleanupWindowsElectronProcesses();
        await wait(2000 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to launch Electron app");
}

/**
 * Re-acquire the active app window after a project switch.
 * The ProjectViewManager creates new WebContentsViews, so the Playwright
 * page reference from launchApp() becomes stale. This returns the latest
 * app page (preferring one with a projectId query param).
 */
export interface GetActiveAppWindowOptions {
  /**
   * If true, wait the full timeout for a project view (URL with `projectId=`)
   * to appear before returning. Use this after operations that should result
   * in a project view being created/activated (e.g., onboarding, project switch).
   */
  requireProject?: boolean;
}

export async function getActiveAppWindow(
  app: ElectronApplication,
  timeoutMsOrOptions: number | GetActiveAppWindowOptions = 10_000,
  maybeOptions: GetActiveAppWindowOptions = {}
): Promise<Page> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : 10_000;
  const options = typeof timeoutMsOrOptions === "number" ? maybeOptions : timeoutMsOrOptions;
  const requireProject = options.requireProject ?? false;

  // Ask the main process for the URL of the WebContentsView currently
  // attached to the BrowserWindow's contentView tree (the visible project
  // view). With more than one cached project view alive at a time, URL
  // matching alone is ambiguous — Playwright's `app.windows()` returns all
  // alive pages including cached/inactive views.
  const getActiveAttachedUrl = async (): Promise<string | null> => {
    try {
      return await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return null;
        const views = win.contentView?.children ?? [];
        // The welcome appView is permanently added to contentView and is
        // typically first. Project views are added on top — iterate from
        // last to first and prefer the topmost projectId-bearing view.
        // Fall back to the welcome view URL only if no project view is found.
        let fallbackUrl: string | null = null;
        for (let i = views.length - 1; i >= 0; i--) {
          const wc = (views[i] as Electron.WebContentsView).webContents;
          if (!wc || wc.isDestroyed()) continue;
          const url = wc.getURL();
          if (url.includes("projectId=")) return url;
          if (fallbackUrl === null) fallbackUrl = url;
        }
        return fallbackUrl;
      });
    } catch {
      return null;
    }
  };

  const deadline = Date.now() + timeoutMs;
  // Grace period before returning a non-project fallback: after a project
  // operation, the project WebContentsView may take a moment to load its
  // URL. Returning the welcome page too early causes tests to grab the
  // wrong renderer.
  const fallbackGraceMs = 1_500;
  let fallback: Page | null = null;
  let fallbackSeenAt = 0;
  while (Date.now() < deadline) {
    fallback = null;
    const activeUrl = await getActiveAttachedUrl();
    let projectFallback: Page | null = null;

    for (const w of app.windows()) {
      const url = w.url();
      if (!(url.startsWith("app://canopy/") || url.includes("localhost"))) continue;

      // Best match: a project view that the main process currently has
      // attached to the BrowserWindow.
      if (activeUrl && url === activeUrl && url.includes("projectId=")) {
        return w;
      }

      if (url.includes("projectId=")) {
        if (projectFallback === null) projectFallback = w;
      } else {
        fallback = w;
      }
    }

    if (projectFallback) return projectFallback;

    if (fallback) {
      if (!requireProject) {
        if (fallbackSeenAt === 0) fallbackSeenAt = Date.now();
        if (Date.now() - fallbackSeenAt >= fallbackGraceMs) return fallback;
      }
    } else {
      fallbackSeenAt = 0;
    }
    await wait(200);
  }
  if (fallback) return fallback;
  const urls = app.windows().map((w) => w.url());
  throw new Error(`No active app window found. Available pages: ${urls.join(", ")}`);
}

const registeredPages = new WeakSet<Page>();

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
  const oldUrl = oldPage?.url() ?? null;
  if (oldUrl && oldUrl.includes("projectId=")) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const attached = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win || win.isDestroyed()) return null;
          const views = win.contentView?.children ?? [];
          // The welcome appView is permanently added to contentView and is
          // typically first. Project views are added on top — iterate from
          // last to first and prefer the topmost projectId-bearing view.
          for (let i = views.length - 1; i >= 0; i--) {
            const wc = (views[i] as Electron.WebContentsView).webContents;
            if (wc && !wc.isDestroyed()) {
              const url = wc.getURL();
              if (url.includes("projectId=")) return url;
            }
          }
          return null;
        });
        if (attached && attached !== oldUrl) break;
      } catch {
        // ignore and retry
      }
      await wait(150);
    }
  }

  const newWindow = await getActiveAppWindow(app, 10_000, { requireProject: true });

  if (!registeredPages.has(newWindow)) {
    registeredPages.add(newWindow);
    newWindow.on("crash", () => console.error("[e2e] Renderer crashed"));
    newWindow.on("console", (msg) => {
      if (msg.type() === "error") console.error("[e2e:console]", msg.text());
    });
  }

  await newWindow
    .locator('[aria-label="Toggle Sidebar"]')
    .waitFor({ state: "visible", timeout: 10_000 });

  // Wait for the project's active worktree to finish loading. Without this,
  // shortcuts like Cmd+Alt+T fire with `activeWorktreeId=undefined`, which
  // creates an orphan panel that never renders (worktree-filtered out) — the
  // root cause of the original "Cmd+Alt+T opens a new terminal" flake.
  // The worktree sidebar heading stops showing "Loading worktrees..." once
  // the first worktree entry is in the DOM.
  await newWindow
    .locator('[aria-label="Worktrees"] a, [aria-label="Worktrees"] [role="button"], .worktree-item')
    .first()
    .waitFor({ state: "attached", timeout: 10_000 })
    .catch(async () => {
      // Fallback: just wait for the loading text to disappear.
      await newWindow
        .locator("text=Loading worktrees...")
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
    });

  // After WebContentsView creation, the new view's renderer may not receive
  // keyboard events from Playwright's CDP `Input.dispatchKeyEvent` until the
  // view has been focused by the main process, the CDP target brought to
  // front, and a click inside the document has landed. Without all three,
  // the first `keyboard.press` after a project switch can be silently
  // dropped — manifesting as flaky/failed shortcut tests.
  try {
    // 1. Tell the main process to focus this project's WebContentsView.
    const url = newWindow.url();
    const match = url.match(/[?&]projectId=([^&]+)/);
    const projectId = match ? decodeURIComponent(match[1]) : null;
    if (projectId) {
      await app.evaluate(({ BrowserWindow }, pid) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return;
        win.focus();
        const views = win.contentView?.children ?? [];
        for (const child of views) {
          const wc = (child as Electron.WebContentsView).webContents;
          if (!wc || wc.isDestroyed()) continue;
          if (wc.getURL().includes(`projectId=${encodeURIComponent(pid)}`)) {
            wc.focus();
            break;
          }
        }
      }, projectId);
    }

    // 2. Bring the Playwright CDP target for this page to the front so that
    // `Input.dispatchKeyEvent` events are routed to this WebContents.
    await newWindow.bringToFront().catch(() => {});

    // 3. Click inside the document to give the browser keyboard focus to a
    // real node, then poll `document.hasFocus()` and retry a few times if
    // the document isn't claiming focus yet.
    const grid = newWindow.locator('[role="grid"][aria-label="Panel grid"]').first();
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
    // primed before tests send their real shortcut presses.
    await newWindow.keyboard.press("Shift").catch(() => {});
  } catch {
    // Best-effort focus; tests can still proceed.
  }

  return newWindow;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;

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
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
}

function getDescendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const result = execSync(`pgrep -P ${pid}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const children = result
      .trim()
      .split("\n")
      .map(Number)
      .filter((n) => n > 0);
    const all = [...children];
    for (const child of children) {
      all.push(...getDescendantPids(child));
    }
    return all;
  } catch {
    return [];
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
