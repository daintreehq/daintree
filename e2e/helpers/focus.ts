import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { SEL } from "./selectors";
import { T_MEDIUM } from "./timeouts";

export async function expectTerminalFocused(
  panelLocator: Locator,
  timeout = T_MEDIUM
): Promise<void> {
  const textarea = panelLocator.locator(SEL.terminal.xtermHelperTextarea);
  await expect(textarea).toBeFocused({ timeout });
}

export async function expectInputBarFocused(
  panelLocator: Locator,
  timeout = T_MEDIUM
): Promise<void> {
  const cmContent = panelLocator.locator(SEL.terminal.cmEditor);
  await expect(cmContent).toBeFocused({ timeout });
}

const paletteSearchSelectors = {
  action: SEL.actionPalette.searchInput,
  quickSwitcher: SEL.quickSwitcher.searchInput,
  command: SEL.commandPicker.searchInput,
} as const;

export type PaletteType = keyof typeof paletteSearchSelectors;

export async function expectPaletteFocused(
  page: Page,
  paletteType: PaletteType,
  timeout = T_MEDIUM
): Promise<void> {
  const selector = paletteSearchSelectors[paletteType];
  await expect(page.locator(selector)).toBeFocused({ timeout });
}

export async function ensureWindowFocused(app: ElectronApplication): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error("No BrowserWindow found");
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.focus();
      });
      return;
    } catch (error) {
      // Under the combined 800+ test run, Playwright can briefly replace its
      // Electron inspector context between serial cases. Focusing is idempotent,
      // so retry only that transport turnover; missing windows and every other
      // application error still fail on the first attempt.
      const contextTurnedOver =
        error instanceof Error && error.message.includes("Execution context was destroyed");
      if (!contextTurnedOver || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
