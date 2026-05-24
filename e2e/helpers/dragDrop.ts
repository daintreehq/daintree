import type { Locator, Page } from "@playwright/test";
import { T_SETTLE } from "./timeouts";

/**
 * Reorder a dnd-kit sortable item through its keyboard sensor.
 *
 * Pointer collision targets are sensitive to headless Linux geometry. Keyboard
 * reorder still exercises the same DndContext/handleDragEnd path while using
 * dnd-kit's deterministic sortableKeyboardCoordinates resolver.
 */
export async function keyboardReorderElement(
  page: Page,
  source: Locator,
  keys: string[]
): Promise<void> {
  await source.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(T_SETTLE);

  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(T_SETTLE);
  }

  await page.keyboard.press("Space");
  await page.waitForTimeout(T_SETTLE);
}
