import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SEL } from "./selectors";
import { T_SHORT } from "./timeouts";

async function getPanelId(panelLocator: Locator): Promise<string> {
  return panelLocator.evaluate((el) => {
    const panel = el.closest("[data-panel-id]");
    return panel?.getAttribute("data-panel-id") ?? "";
  });
}

export async function getTerminalText(panelLocator: Locator): Promise<string> {
  const page = panelLocator.page();
  const panelId = await getPanelId(panelLocator);

  if (!panelId) return "";

  // Try buffer API first (works with all renderers including WebGL)
  const bufferText = await page.evaluate((id) => {
    const reader = (window as unknown as Record<string, unknown>).__daintreeReadTerminalBuffer;
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
  // Wait for xterm's helper textarea to receive focus before typing —
  // typing too early can drop the leading characters of the command.
  await expect(panelLocator.locator(SEL.terminal.xtermHelperTextarea)).toBeFocused({
    timeout: 5_000,
  });
  // Small settle delay so xterm's internal data handler is wired before we
  // type. Without this, the renderer can swallow leading characters on the
  // first click into a freshly opened terminal.
  await page.waitForTimeout(150);
  // Type with a small per-key delay; PTY can drop bursts on cold-start.
  await page.keyboard.type(command, { delay: 15 });
  await page.keyboard.press("Enter");
}

export async function getTerminalBufferLength(panelLocator: Locator): Promise<number> {
  const page = panelLocator.page();
  const panelId = await getPanelId(panelLocator);
  if (!panelId) return 0;

  return page.evaluate((id) => {
    const fn = (window as unknown as Record<string, unknown>).__daintreeGetTerminalBufferLength;
    if (typeof fn === "function") return fn(id) as number;
    return 0;
  }, panelId);
}

export async function selectAllTerminalText(panelLocator: Locator): Promise<void> {
  const page = panelLocator.page();
  const panelId = await getPanelId(panelLocator);
  if (!panelId) throw new Error("Could not resolve panel ID for selectAll");
  const ok = await page.evaluate((id) => {
    const fn = (window as unknown as Record<string, unknown>).__daintreeSelectTerminalAll;
    if (typeof fn === "function") return fn(id) as boolean;
    return false;
  }, panelId);
  if (!ok) throw new Error(`selectAllTerminalText failed for panel ${panelId}`);
}

export async function triggerTerminalLink(panelLocator: Locator, url: string): Promise<string> {
  const page = panelLocator.page();
  const panelId = await getPanelId(panelLocator);
  if (!panelId) return "missing-panel";
  return page.evaluate(
    ({ id, linkUrl }) => {
      const fn = (window as unknown as Record<string, unknown>).__daintreeTriggerTerminalLink;
      if (typeof fn === "function") return fn(id, linkUrl) as string;
      return "missing-bridge";
    },
    { id: panelId, linkUrl: url }
  );
}

export async function openTerminalContextMenu(panelLocator: Locator): Promise<void> {
  const page = panelLocator.page();
  const xterm = panelLocator.locator(SEL.terminal.xtermRows);
  await xterm.click({ button: "right" });
  await expect(page.locator(SEL.contextMenu.content)).toBeVisible({ timeout: T_SHORT });
}
