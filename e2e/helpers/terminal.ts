import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { dismissBlockingPalette } from "./overlays";
import { SEL } from "./selectors";
import { T_SHORT } from "./timeouts";

type TerminalBridge = {
  getInfo?: (terminalId: string) => Promise<{ hasPty?: boolean } | null | undefined>;
  setActivityTier?: (terminalId: string, tier: "active" | "background") => void;
  wake?: (terminalId: string) => Promise<{ state: string | null; warnings?: string[] }>;
  write?: (terminalId: string, data: string) => void;
  submit?: (terminalId: string, text: string) => Promise<void>;
};

const WINDOWS_COMMAND_ECHO_TIMEOUT_MS = 7_500;
const WINDOWS_COMMAND_ECHO_RETRIES = 2;
const WINDOWS_COMMAND_ECHO_MAX_CHARS = 320;
const WINDOWS_COMMAND_SUBMIT_SETTLE_MS = 1_000;

async function getPanelId(panelLocator: Locator): Promise<string> {
  return panelLocator.evaluate((el) => {
    const panel = el.closest("[data-panel-id]");
    return panel?.getAttribute("data-panel-id") ?? "";
  });
}

function compactTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "");
}

function splitCommandForSubmit(command: string): { body: string; enterSuffix: string } {
  let body = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let enterCount = 0;
  while (body.endsWith("\n")) {
    body = body.slice(0, -1);
    enterCount++;
  }
  if (enterCount === 0) enterCount = 1;
  return { body, enterSuffix: "\r".repeat(enterCount) };
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

export async function getTerminalTextById(page: Page, panelId: string): Promise<string> {
  if (!panelId) return "";

  const bufferText = await page.evaluate((id) => {
    const reader = (window as unknown as Record<string, unknown>).__daintreeReadTerminalBuffer;
    if (typeof reader === "function") return reader(id) as string;
    return null;
  }, panelId);

  if (bufferText !== null) return bufferText;

  const panelLocator = page.locator(`[data-panel-id="${panelId}"]`);
  if (!(await panelLocator.isVisible().catch(() => false))) return "";
  return panelLocator.locator(SEL.terminal.xtermRows).innerText();
}

export async function waitForTerminalText(
  panelLocator: Locator,
  text: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(() => getTerminalText(panelLocator), { timeout, intervals: [200, 500, 1000] })
    .toContain(text);
}

export async function waitForTerminalTextById(
  page: Page,
  panelId: string,
  text: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(() => getTerminalTextById(page, panelId), { timeout, intervals: [200, 500, 1000] })
    .toContain(text);
}

export async function waitForTerminalTextIgnoringLineBreaks(
  panelLocator: Locator,
  text: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(async () => compactTerminalText(await getTerminalText(panelLocator)), {
      timeout,
      intervals: [200, 500, 1000],
    })
    .toContain(compactTerminalText(text));
}

export async function waitForTerminalPty(
  page: Page,
  panelLocator: Locator,
  timeout = 10_000
): Promise<void> {
  const panelId = await getPanelId(panelLocator);
  if (!panelId) throw new Error("Could not resolve panel ID for terminal PTY");

  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const api = (
            window as unknown as {
              electron?: { terminal?: TerminalBridge };
            }
          ).electron?.terminal;
          if (typeof api?.getInfo !== "function") return false;
          try {
            const info = await api.getInfo(id);
            return info?.hasPty === true;
          } catch {
            return false;
          }
        }, panelId),
      { timeout, intervals: [100, 250, 500] }
    )
    .toBe(true);
}

export async function waitForTerminalReady(
  page: Page,
  panelLocator: Locator,
  timeout = 10_000
): Promise<void> {
  await waitForTerminalPty(page, panelLocator, timeout);

  await expect
    .poll(
      async () => {
        const text = await getTerminalText(panelLocator);
        return text.trim().length > 0;
      },
      { timeout, intervals: [100, 250, 500] }
    )
    .toBe(true);
}

async function activateTerminal(page: Page, panelId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (
      window as unknown as {
        electron?: { terminal?: TerminalBridge };
      }
    ).electron?.terminal;

    if (typeof api?.wake === "function") {
      await api.wake(id);
      return;
    }

    api?.setActivityTier?.(id, "active");
  }, panelId);
}

export async function writeTerminalInput(
  page: Page,
  panelLocator: Locator,
  data: string
): Promise<void> {
  const panelId = await getPanelId(panelLocator);
  if (!panelId) throw new Error("Could not resolve panel ID for terminal input");

  await waitForTerminalPty(page, panelLocator);
  await activateTerminal(page, panelId);

  const wrote = await page.evaluate(
    ({ id, input }) => {
      const api = (
        window as unknown as {
          electron?: { terminal?: TerminalBridge };
        }
      ).electron?.terminal;
      if (typeof api?.write !== "function") return false;
      api.write(id, input);
      return true;
    },
    { id: panelId, input: data }
  );

  if (!wrote) throw new Error(`terminal.write bridge unavailable for panel ${panelId}`);
}

async function runWindowsEchoGuardedCommand(
  page: Page,
  panelLocator: Locator,
  command: string
): Promise<boolean> {
  if (process.platform !== "win32") return false;

  const { body, enterSuffix } = splitCommandForSubmit(command);
  if (
    body.length === 0 ||
    body.length > WINDOWS_COMMAND_ECHO_MAX_CHARS ||
    body.includes("\n") ||
    body.startsWith("/")
  ) {
    return false;
  }

  for (let attempt = 1; attempt <= WINDOWS_COMMAND_ECHO_RETRIES; attempt++) {
    await writeTerminalInput(page, panelLocator, body);

    try {
      await expect
        .poll(
          async () => {
            const text = await getTerminalText(panelLocator);
            return compactTerminalText(text);
          },
          {
            timeout: WINDOWS_COMMAND_ECHO_TIMEOUT_MS,
            intervals: [100, 250, 500],
          }
        )
        .toContain(compactTerminalText(body));

      await writeTerminalInput(page, panelLocator, enterSuffix);
      await page.waitForTimeout(WINDOWS_COMMAND_SUBMIT_SETTLE_MS);
      return true;
    } catch {
      if (attempt < WINDOWS_COMMAND_ECHO_RETRIES) {
        await writeTerminalInput(page, panelLocator, "\u0003");
        await page.waitForTimeout(250);
      }
    }
  }

  await writeTerminalInput(page, panelLocator, "\u0003");
  await page.waitForTimeout(250);
  return false;
}

export async function runTerminalCommand(
  page: Page,
  panelLocator: Locator,
  command: string,
  options: { readyTimeout?: number } = {}
): Promise<void> {
  await expect(panelLocator).toBeVisible({ timeout: 5_000 });
  const panelId = await getPanelId(panelLocator);
  if (!panelId) throw new Error("Could not resolve panel ID for terminal command");

  await waitForTerminalPty(page, panelLocator, options.readyTimeout);
  await activateTerminal(page, panelId);

  if (await runWindowsEchoGuardedCommand(page, panelLocator, command)) {
    return;
  }

  const payload = command.endsWith("\n") ? command : `${command}\n`;
  const submitted = await page.evaluate(
    async ({ id, input }) => {
      const api = (
        window as unknown as {
          electron?: { terminal?: TerminalBridge };
        }
      ).electron?.terminal;
      if (typeof api?.submit !== "function") return false;
      await api.submit(id, input);
      return true;
    },
    { id: panelId, input: payload }
  );

  if (!submitted) {
    await writeTerminalInput(page, panelLocator, `${command}\r`);
  }

  if (process.platform === "win32") {
    await page.waitForTimeout(WINDOWS_COMMAND_SUBMIT_SETTLE_MS);
  }
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

export async function getTerminalDimensions(
  panelLocator: Locator
): Promise<{ cols: number; rows: number } | null> {
  const page = panelLocator.page();
  const panelId = await getPanelId(panelLocator);
  if (!panelId) return null;

  return page.evaluate((id) => {
    const fn = (window as unknown as Record<string, unknown>).__daintreeGetTerminalDimensions;
    if (typeof fn === "function") return fn(id) as { cols: number; rows: number } | null;
    return null;
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

async function isContextMenuVisible(page: Page, timeout = 750): Promise<boolean> {
  return page
    .locator(SEL.contextMenu.content)
    .isVisible({ timeout })
    .catch(() => false);
}

async function dispatchXtermContextMenu(xterm: Locator): Promise<boolean> {
  return xterm.evaluate((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + (rect.width > 2 ? Math.min(24, rect.width / 2) : 1);
    const clientY = rect.top + (rect.height > 2 ? Math.min(24, rect.height / 2) : 1);

    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX,
        clientY,
      })
    );

    return true;
  });
}

async function dispatchTerminalTriggerContextMenu(
  page: Page,
  panelLocator: Locator,
  xterm: Locator
): Promise<boolean> {
  const panelId = await getPanelId(panelLocator);
  if (!panelId) return false;

  const trigger = page.locator(`[data-context-trigger="${panelId}"]`).first();
  return trigger.evaluate((el, selector) => {
    if (!(el instanceof HTMLElement)) return false;
    const xtermEl = document.querySelector(selector);
    const rect =
      xtermEl instanceof HTMLElement ? xtermEl.getBoundingClientRect() : el.getBoundingClientRect();
    const clientX = rect.left + (rect.width > 2 ? Math.min(24, rect.width / 2) : 1);
    const clientY = rect.top + (rect.height > 2 ? Math.min(24, rect.height / 2) : 1);

    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX,
        clientY,
      })
    );

    return true;
  }, SEL.terminal.xtermRows);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function openTerminalContextMenu(
  panelLocator: Locator,
  { preserveSelection = false }: { preserveSelection?: boolean } = {}
): Promise<void> {
  const page = panelLocator.page();
  const menu = page.locator(SEL.contextMenu.content);
  const xterm = panelLocator.locator(SEL.terminal.xtermRows);
  await expect(xterm).toBeVisible({ timeout: T_SHORT });

  for (let attempt = 0; attempt < 4; attempt++) {
    await dismissBlockingPalette(page);
    // Skip Escape when preserveSelection is true: xterm.js calls clearSelection()
    // synchronously in _keyDown for non-browser-handled keys (including Escape),
    // so sending Escape while xterm has focus destroys any prior selectAll() call.
    if (!preserveSelection) {
      await page.keyboard.press("Escape").catch(() => undefined);
    } else {
      await selectAllTerminalText(panelLocator);
    }

    if (preserveSelection && attempt === 0) {
      await dispatchTerminalTriggerContextMenu(page, panelLocator, xterm).catch(() => false);
    } else if (preserveSelection && attempt === 1) {
      await dispatchXtermContextMenu(xterm).catch(() => false);
    } else if (attempt === 0) {
      await xterm.click({ button: "right", timeout: 5_000 }).catch(() => undefined);
    } else if (attempt === 1) {
      const box = await xterm.boundingBox();
      if (box) {
        await page.mouse.click(
          box.x + (box.width > 2 ? Math.min(24, box.width / 2) : 1),
          box.y + (box.height > 2 ? Math.min(24, box.height / 2) : 1),
          { button: "right" }
        );
      }
    } else if (attempt === 2) {
      await dispatchTerminalTriggerContextMenu(page, panelLocator, xterm).catch(() => false);
    } else {
      await dispatchXtermContextMenu(xterm).catch(() => false);
    }

    if (await isContextMenuVisible(page, 1_500)) {
      return;
    }
  }

  await expect(menu).toBeVisible({ timeout: T_SHORT });
}

export async function clickTerminalContextMenuItem(
  panelLocator: Locator,
  name: string
): Promise<void> {
  const page = panelLocator.page();
  const menu = page.locator(SEL.contextMenu.content);
  const itemName = new RegExp(`^${escapeRegExp(name)}\\b`, "i");
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isContextMenuVisible(page, 500))) {
      await openTerminalContextMenu(panelLocator);
    }

    const item = page.getByRole("menuitem", { name: itemName, exact: false }).first();

    try {
      await expect(item).toBeVisible({ timeout: T_SHORT });
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => undefined);
      await expect(menu)
        .not.toBeVisible({ timeout: T_SHORT })
        .catch(() => undefined);
      continue;
    }

    try {
      await item.click({ timeout: 3_000, force: attempt > 0 });
      return;
    } catch (error) {
      lastError = error;
      if (!(await isContextMenuVisible(page, 500))) {
        continue;
      }

      try {
        await item.click({ force: true, timeout: 3_000 });
        return;
      } catch (forceError) {
        lastError = forceError;
        if (!(await isContextMenuVisible(page, 500))) {
          continue;
        }

        try {
          await item.focus({ timeout: 1_000 });
          await page.keyboard.press("Enter");
          if (!(await isContextMenuVisible(page, 1_000))) return;
        } catch (keyboardError) {
          lastError = keyboardError;
        }

        await page.keyboard.press("Escape").catch(() => undefined);
        await expect(menu)
          .not.toBeVisible({ timeout: T_SHORT })
          .catch(() => undefined);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to click terminal context menu item "${name}"`);
}
