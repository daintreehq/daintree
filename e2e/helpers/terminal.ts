import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SEL } from "./selectors";

export async function getTerminalText(panelLocator: Locator): Promise<string> {
  const page = panelLocator.page();
  const panelId = await panelLocator.evaluate((el) => {
    const panel = el.closest("[data-panel-id]");
    return panel?.getAttribute("data-panel-id") ?? "";
  });

  if (!panelId) return "";

  // Try buffer API first (works with all renderers including WebGL)
  const bufferText = await page.evaluate((id) => {
    const reader = (window as unknown as Record<string, unknown>).__canopyReadTerminalBuffer;
    if (typeof reader === "function") return reader(id) as string;
    return null;
  }, panelId);

  if (bufferText !== null) return bufferText;

  // Fallback: read DOM text (only works with DOM renderer)
  return panelLocator.locator(SEL.terminal.xtermRows).innerText();
}

export async function waitForTerminalText(
  panelLocator: Locator,
  text: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(() => getTerminalText(panelLocator), { timeout, intervals: [500] })
    .toContain(text);
}

export async function runTerminalCommand(
  page: Page,
  panelLocator: Locator,
  command: string
): Promise<void> {
  const xterm = panelLocator.locator(SEL.terminal.xtermRows);
  await xterm.click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
