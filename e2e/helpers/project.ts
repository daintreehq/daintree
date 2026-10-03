import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "path";
import { mockOpenDialog, refreshActiveWindow, waitForActiveProject } from "./launch";
import { dismissBlockingPalette } from "./overlays";

export async function openProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string
): Promise<void> {
  const isWindowsCI = process.env.CI && process.platform === "win32";
  await mockOpenDialog(app, projectPath);
  const openFolder = window.getByRole("button", { name: "Open project", exact: true });
  await expect(openFolder).toBeVisible({ timeout: isWindowsCI ? 30_000 : 10_000 });
  await openFolder.click();
}

export async function openAndOnboardProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string,
  _name?: string
): Promise<Page> {
  await openProject(app, window, projectPath);
  const projectBasename = path.basename(projectPath);
  const newWindow = await waitForActiveProject(
    app,
    await refreshActiveWindow(app, window),
    projectBasename
  );
  await dismissBlockingPalette(newWindow);
  return newWindow;
}
