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

/** Reorder one dock chip onto another through the product's pointer drag path. */
export async function pointerReorderDockChip(
  page: Page,
  source: Locator,
  target: Locator
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Dock chips must be visible before dragging");

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(T_SETTLE);
}
