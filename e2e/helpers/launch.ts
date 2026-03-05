import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "module";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import path from "path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const ROOT = path.resolve(import.meta.dirname, "../..");
const SCREENSHOT_DIR = path.join(ROOT, "test-results");

export interface AppContext {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  userDataDir?: string;
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
      // CI runners lack real GPUs — disable GPU to prevent hangs
      args.unshift("--disable-gpu", "--disable-software-rasterizer", "--noerrdialogs");

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

    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({
        executablePath: electronPath,
        args,
        env: { ...process.env, ...options.env, NODE_ENV: "production" },
        timeout: launchTimeout,
      });

      app.on("close", () => console.log("[e2e] Electron app closed"));

      const window = await app.firstWindow();
      window.on("crash", () => console.error("[e2e] Renderer crashed"));
      window.on("console", (msg) => {
        if (msg.type() === "error") console.error("[e2e:console]", msg.text());
      });

      console.log("[e2e] Waiting for domcontentloaded...");
      await window.waitForLoadState("domcontentloaded");
      console.log("[e2e] domcontentloaded reached");

      // Dismiss agent setup/selection wizards so they don't block the UI
      await window.evaluate(() => {
        localStorage.setItem("canopy:agent-setup-complete", "true");
        localStorage.setItem("canopy:agent-selection-dismissed", "true");
      });
      console.log("[e2e] Agent wizard dismissal keys set in localStorage");

      // Take an early screenshot for CI diagnostics
      try {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const screenshotPath = path.join(
          SCREENSHOT_DIR,
          `launch-early-${process.platform}-${Date.now()}.png`
        );
        await window.screenshot({ path: screenshotPath });
        console.log("[e2e] Early screenshot saved:", screenshotPath);
      } catch (err) {
        console.warn("[e2e] Early screenshot failed:", err);
      }

      console.log("[e2e] Waiting for settings button to appear...");
      await window
        .locator('[aria-label="Open settings"]')
        .waitFor({ state: "visible", timeout: launchTimeout });
      console.log("[e2e] Settings button visible — app ready");

      // Take a post-ready screenshot for CI diagnostics
      try {
        const screenshotPath = path.join(
          SCREENSHOT_DIR,
          `launch-ready-${process.platform}-${Date.now()}.png`
        );
        await window.screenshot({ path: screenshotPath });
        console.log("[e2e] Ready screenshot saved:", screenshotPath);
      } catch (err) {
        console.warn("[e2e] Ready screenshot failed:", err);
      }

      return { app, window, userDataDir };
    } catch (error) {
      console.error(`[e2e] Launch attempt ${attempt}/${maxAttempts} failed:`, error);
      lastError = error;
      // Try to capture a failure screenshot before closing
      if (app) {
        try {
          const failWindow = await app.firstWindow().catch(() => null);
          if (failWindow) {
            mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const screenshotPath = path.join(
              SCREENSHOT_DIR,
              `launch-failure-${process.platform}-attempt${attempt}-${Date.now()}.png`
            );
            await failWindow.screenshot({ path: screenshotPath });
            console.log("[e2e] Failure screenshot saved:", screenshotPath);
          }
        } catch {
          // Best-effort screenshot capture
        }
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
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 10_000)),
    ]);
  } catch {
    // Force-kill if close() hangs (zombie process prevention)
    try {
      if (process.platform === "win32") {
        const pid = app.process().pid;
        if (pid) execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: "ignore" });
      } else {
        app.process().kill("SIGKILL");
      }
    } catch {
      // Already dead
    }
  }

  // On Windows CI, wait for the OS to fully release named pipes, file handles,
  // and single-instance lock resources before the next launch attempt.
  if (process.env.CI && process.platform === "win32") {
    await wait(3000);
    cleanupWindowsElectronProcesses();
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
