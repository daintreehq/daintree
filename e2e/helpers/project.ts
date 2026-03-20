import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { mockOpenDialog } from "./launch";

export async function openProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string
): Promise<void> {
  const isWindowsCI = process.env.CI && process.platform === "win32";
  await mockOpenDialog(app, projectPath);
  const openFolder = window.getByRole("button", { name: "Open Folder" });
  await expect(openFolder).toBeVisible({ timeout: isWindowsCI ? 30_000 : 10_000 });
  await openFolder.click();
}

export async function dismissTelemetryConsent(window: Page): Promise<void> {
  const dialog = window.getByRole("dialog", { name: "Crash reporting consent" });
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Disable" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  }
}

export async function completeOnboarding(window: Page, name: string): Promise<void> {
  const isWindowsCI = process.env.CI && process.platform === "win32";
  const visibleTimeout = isWindowsCI ? 45_000 : process.env.CI ? 20_000 : 10_000;
  const closeTimeout = isWindowsCI ? 20_000 : 5_000;

  const heading = window.locator("h2", { hasText: "Set up your project" });
  await expect(heading).toBeVisible({ timeout: visibleTimeout });

  const nameInput = window.getByRole("textbox", { name: "Project Name" });
  await nameInput.fill(name);

  await window.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(heading).not.toBeVisible({ timeout: closeTimeout });

  await dismissTelemetryConsent(window);
}

export async function openAndOnboardProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string,
  name: string
): Promise<void> {
  await openProject(app, window, projectPath);
  await completeOnboarding(window, name);
}
