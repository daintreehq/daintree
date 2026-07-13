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

/**
 * Reorder a dock-rail chip by a single step through the keyboard sensor.
 *
 * Dock chips are sortable through the global `DndProvider`, which — unlike
 * `DockedTabGroup`'s own `DndContext` (PointerSensor/TouchSensor only) —
 * registers a `KeyboardSensor`. A single arrow step avoids the autoscroll-driven
 * source unmount that long keyboard drags can hit (#8478).
 */
export async function keyboardReorderDockChip(
  page: Page,
  chip: Locator,
  direction: "ArrowRight" | "ArrowLeft" = "ArrowRight"
): Promise<void> {
  await keyboardReorderElement(page, chip, [direction]);
}
