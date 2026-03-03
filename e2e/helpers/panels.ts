import type { Locator, Page } from "@playwright/test";
import { SEL } from "./selectors";

export function getFirstGridPanel(page: Page): Locator {
  return page.locator(SEL.panel.gridPanel).first();
}

export async function getGridPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.gridPanel).count();
}

export async function getDockPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.dockPanel).count();
}
