import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SEL } from "./selectors";

export async function getTerminalText(panelLocator: Locator): Promise<string> {
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
