import type { Locator, Page } from "@playwright/test";
import { SEL } from "./selectors";

const mod = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Click a toolbar button, handling the case where it may be hidden
 * in the overflow menu on small displays (e.g., Windows CI).
 * Checks direct visibility first, then falls back to the overflow menu.
 */
export async function clickToolbarButton(
  page: Page,
  selector: string,
  timeout = 5000
): Promise<void> {
  const button = page.locator(selector);

  // Try direct click first — Playwright auto-waits for visibility
  try {
    await button.click({ timeout: 3000, noWaitAfter: true });
    return;
  } catch {
    // Button not clickable — might be in overflow menu
  }

  // Button might be in the overflow menu — look for and open it
  const overflowTrigger = page.locator('[aria-label*="more toolbar items"]').first();
  if (await overflowTrigger.isVisible({ timeout: 1000 }).catch(() => false)) {
    await overflowTrigger.click();

    // Extract the aria-label from the selector to find the menu item
    const labelMatch = selector.match(/aria-label="([^"]+)"/);
    if (labelMatch) {
      const menuItem = page.getByRole("menuitem", { name: labelMatch[1] });
      await menuItem.click({ timeout });
      return;
    }
  }

  // Last resort: try clicking with longer timeout
  await button.click({ timeout, noWaitAfter: true });
}

/**
 * Open settings via keyboard shortcut (Cmd/Ctrl+,).
 * More reliable than clicking the toolbar button, which may be
 * hidden in the overflow menu on small displays (e.g., Windows CI).
 */
export async function openSettings(page: Page, timeout = 10000): Promise<void> {
  const heading = page.locator(SEL.settings.heading);

  // Try keyboard shortcut first (works regardless of toolbar overflow)
  await page.keyboard.press(`${mod}+,`);
  try {
    await heading.waitFor({ state: "visible", timeout: 3000 });
    return;
  } catch {
    // Shortcut may not have registered — try clicking the toolbar button
  }

  // Fall back to clicking the settings button (handles overflow via menu)
  await clickToolbarButton(page, SEL.toolbar.openSettings);
  await heading.waitFor({ state: "visible", timeout });
}

/**
 * Open a new terminal panel. Clicks toolbar button if visible,
 * otherwise falls back to keyboard shortcut.
 */
export async function openTerminal(page: Page): Promise<void> {
  await clickToolbarButton(page, SEL.toolbar.openTerminal);
}

/**
 * Open a new browser panel. Clicks toolbar button if visible,
 * otherwise falls back to keyboard shortcut.
 */
export async function openBrowser(page: Page): Promise<void> {
  await clickToolbarButton(page, SEL.toolbar.openBrowser);
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
