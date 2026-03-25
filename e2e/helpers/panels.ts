import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SEL } from "./selectors";

const mod = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Open settings via keyboard shortcut (Cmd/Ctrl+,).
 * More reliable than clicking the toolbar button, which may be
 * hidden in the overflow menu on small displays (e.g., Windows CI).
 */
export async function openSettings(page: Page, timeout = 5000): Promise<void> {
  await page.keyboard.press(`${mod}+,`);
  await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout });
}

export function getFirstGridPanel(page: Page): Locator {
  return page.locator(SEL.panel.gridPanel).first();
}

export async function getGridPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.gridPanel).count();
}

export async function getDockPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.dockPanel).count();
}

export async function getGridPanelIds(page: Page): Promise<string[]> {
  return page
    .locator(SEL.panel.gridPanel)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-id") ?? "").filter(Boolean));
}

export async function getDockPanelIds(page: Page): Promise<string[]> {
  return page
    .locator(SEL.panel.dockPanel)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-id") ?? "").filter(Boolean));
}

export function getPanelById(page: Page, id: string): Locator {
  return page.locator(`[data-panel-id="${id}"]`);
}

export function getPanelDragHandle(panel: Locator): Locator {
  return panel.locator(".cursor-grab").first();
}

export async function getFocusedPanelId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement?.closest("[data-panel-id]");
    if (active) return active.getAttribute("data-panel-id");
    const selected = document.querySelector(".terminal-selected[data-panel-id]");
    return selected?.getAttribute("data-panel-id") ?? null;
  });
}
