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
        CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS: options.env?.CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS ?? "1",
        CANOPY_DISABLE_WEBGL: "1",
        ...(isWindowsCI
          ? {
              CANOPY_E2E_DEFER_RENDERER_LOAD: "1",
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

      const window = await app.firstWindow();
      window.on("crash", () => console.error("[e2e] Renderer crashed"));
      window.on("console", (msg) => {
        if (msg.type() === "error") console.error("[e2e:console]", msg.text());
      });

      // Maximize window so toolbar overflow doesn't hide buttons.
      // Skip for restart tests to preserve persisted window state.
      if (!options.userDataDir) {
        await app.evaluate(({ BrowserWindow, screen }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return;
          // On CI with small virtual displays, maximize may still be too
          // small. Use the primary display work area to set the largest
          // possible size, then maximize for good measure.
          const { width, height } = screen.getPrimaryDisplay().workAreaSize;
          win.setSize(Math.max(width, 1920), Math.max(height, 1080));
          win.center();
          win.maximize();
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
