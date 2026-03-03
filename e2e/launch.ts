import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "module";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const ROOT = path.resolve(import.meta.dirname, "..");

export interface AppContext {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the Electron app with an isolated user-data directory
 * and wait for the main layout to be ready.
 */
export async function launchApp(): Promise<AppContext> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-"));

  const app = await electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, ROOT],
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 30_000,
  });

  // Log console errors for debugging
  app.on("close", () => console.log("[e2e] Electron app closed"));

  const window = await app.firstWindow();
  window.on("crash", () => console.error("[e2e] Renderer crashed"));
  window.on("console", (msg) => {
    if (msg.type() === "error") console.error("[e2e:console]", msg.text());
  });

  await window.waitForLoadState("domcontentloaded");

  // Wait for the toolbar to be ready — app startup can be slow
  await window
    .locator('[aria-label="Open settings"]')
    .waitFor({ state: "visible", timeout: 60_000 });

  return { app, window };
}

/**
 * Mock Electron's native dialog.showOpenDialog to return a predetermined path
 * instead of opening the OS file picker.
 */
export async function mockOpenDialog(
  app: ElectronApplication,
  directoryPath: string
): Promise<void> {
  await app.evaluate(async ({ dialog }, dirPath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dirPath] });
  }, directoryPath);
}
