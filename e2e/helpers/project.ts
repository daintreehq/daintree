import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { mockOpenDialog } from "./launch";

export async function openProject(
  app: ElectronApplication,
  window: Page,
  projectPath: string
): Promise<void> {
  await mockOpenDialog(app, projectPath);
  await window.getByRole("button", { name: "Open Folder" }).click();
}

export async function completeOnboarding(window: Page, name: string): Promise<void> {
  const heading = window.locator("h2", { hasText: "Set up your project" });
  await expect(heading).toBeVisible({ timeout: 10_000 });

  const nameInput = window.getByRole("textbox", { name: "Project Name" });
  await nameInput.fill(name);

  await window.getByRole("button", { name: "Finish" }).click();
  await expect(heading).not.toBeVisible({ timeout: 5_000 });
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
