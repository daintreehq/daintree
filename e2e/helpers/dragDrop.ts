import type { Locator, Page } from "@playwright/test";
import { T_SETTLE } from "./timeouts";

/**
 * Perform a drag from one element to another using manual mouse events.
 * Playwright's built-in dragTo() is unreliable with @dnd-kit because it
 * doesn't generate enough intermediate pointermove events to satisfy the
 * MouseSensor's 8px activation constraint.
 */
export async function dragElementTo(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox) throw new Error("Source element has no bounding box (not visible?)");
  if (!targetBox) throw new Error("Target element has no bounding box (not visible?)");

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  try {
    // Move >8px to break MouseSensor activation threshold
    await page.mouse.move(startX, startY - 10, { steps: 5 });
    // Let dnd-kit register the drag start
    await page.waitForTimeout(100);
    // Move to target with enough intermediate events for collision detection
    await page.mouse.move(endX, endY, { steps: 10 });
    // Wait for dnd-kit's measuring cycle (150ms) to register final position
    await page.waitForTimeout(T_SETTLE);
  } finally {
    await page.mouse.up();
  }
}
