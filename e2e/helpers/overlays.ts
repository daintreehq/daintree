import { expect, type Page } from "@playwright/test";
import { SEL } from "./selectors";
import { T_SHORT } from "./timeouts";

const BLOCKING_PALETTE_SELECTORS = [
  SEL.actionPalette.dialog,
  '[role="dialog"][aria-label="New terminal palette"]',
  '[role="dialog"][aria-label="Panel palette"]',
  SEL.projectSwitcher.palette,
  '[role="dialog"][aria-label="Worktree palette"]',
  SEL.worktree.quickCreatePalette,
  SEL.quickSwitcher.dialog,
];

async function visibleBlockingPalette(page: Page) {
  const palettes = page.locator(BLOCKING_PALETTE_SELECTORS.join(", "));
  const count = await palettes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const palette = palettes.nth(index);
    if (await palette.isVisible().catch(() => false)) return palette;
  }
  return null;
}

export async function dismissBlockingPalette(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const palette = await visibleBlockingPalette(page);
    if (!palette) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    if (!(await palette.isVisible({ timeout: 500 }).catch(() => false))) return;
  }

  const palette = await visibleBlockingPalette(page);
  if (!palette) return;
  await page.mouse.click(10, 10).catch(() => undefined);
  await expect(palette).not.toBeVisible({ timeout: T_SHORT });
}
