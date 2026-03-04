import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "module";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
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
}

export async function launchApp(options: LaunchOptions = {}): Promise<AppContext> {
  const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), "canopy-e2e-"));

  const args = [`--user-data-dir=${userDataDir}`, ROOT];

  if (process.env.CI) {
    // CI runners lack real GPUs — disable GPU to prevent hangs
    args.unshift(
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-sandbox",
      "--noerrdialogs"
    );

    if (process.platform === "linux") {
      args.unshift("--disable-dev-shm-usage");
    }
  }

  // Windows CI runners are significantly slower to start Electron
  const isWindowsCI = process.env.CI && process.platform === "win32";
  const launchTimeout = isWindowsCI ? 240_000 : process.env.CI ? 120_000 : 60_000;

  const app = await electron.launch({
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

  await window.waitForLoadState("domcontentloaded");

  await window
    .locator('[aria-label="Open settings"]')
    .waitFor({ state: "visible", timeout: launchTimeout });

  return { app, window, userDataDir };
}

export async function mockOpenDialog(
  app: ElectronApplication,
  directoryPath: string
): Promise<void> {
  await app.evaluate(async ({ dialog }, dirPath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dirPath] });
  }, directoryPath);
}
