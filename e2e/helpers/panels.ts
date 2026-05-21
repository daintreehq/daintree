import type { Locator, Page } from "@playwright/test";
import { dismissBlockingPalette } from "./overlays";
import { SEL } from "./selectors";

const mod = process.platform === "darwin" ? "Meta" : "Control";

const toolbarOverflowLabels: Record<string, string> = {
  "Open Terminal": "Terminal",
  "Open Browser": "Browser",
  "Open settings": "Settings",
  "Copy Context": "Copy Context",
};

const toolbarButtonIds: Record<string, string> = {
  "Open Terminal": "terminal",
  "Open Browser": "browser",
  "Open settings": "settings",
  "Copy Context": "copy-tree",
};

const toolbarShortcuts: Record<string, string> = {
  "Open Terminal": `${mod}+Alt+t`,
  "Open Browser": `${mod}+Alt+b`,
  "Open settings": `${mod}+,`,
  "Copy Context": `${mod}+Shift+c`,
};

function extractExactAriaLabel(selector: string): string | null {
  return selector.match(/aria-label="([^"]+)"/)?.[1] ?? null;
}

type ToolbarCommandReachability = "visible" | "overflow" | "missing";

async function getToolbarCommandReachability(
  page: Page,
  selector: string,
  label: string | null
): Promise<ToolbarCommandReachability> {
  const toolbarButtonId = label ? (toolbarButtonIds[label] ?? null) : null;

  return page.evaluate(
    ({ selector, toolbarButtonId }) => {
      const isVisibleElement = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= window.innerHeight ||
          rect.left >= window.innerWidth
        ) {
          return false;
        }

        let current: Element | null = element;
        while (current) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") {
            return false;
          }
          const style = window.getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          current = current.parentElement;
        }

        return true;
      };

      const queryVisible = (root: ParentNode, cssSelector: string): boolean => {
        try {
          return Array.from(root.querySelectorAll(cssSelector)).some(isVisibleElement);
        } catch {
          return false;
        }
      };

      const toolbars = Array.from(
        document.querySelectorAll<HTMLElement>('[role="toolbar"][aria-label="Main toolbar"]')
      ).filter(isVisibleElement);

      for (const toolbar of toolbars) {
        if (queryVisible(toolbar, selector)) {
          return "visible";
        }

        if (!toolbarButtonId) continue;

        const wrappers = Array.from(
          toolbar.querySelectorAll<HTMLElement>("[data-toolbar-button-id]")
        ).filter((wrapper) => wrapper.getAttribute("data-toolbar-button-id") === toolbarButtonId);

        if (wrappers.some((wrapper) => queryVisible(wrapper, "button"))) {
          return "visible";
        }

        const hasRegisteredToolbarButton = wrappers.some(
          (wrapper) => wrapper.getAttribute("data-toolbar-placeholder") !== "true"
        );
        const hasVisibleOverflowTrigger = queryVisible(toolbar, "[data-toolbar-overflow-trigger]");

        if (hasRegisteredToolbarButton && hasVisibleOverflowTrigger) {
          return "overflow";
        }
      }

      return "missing";
    },
    { selector, toolbarButtonId }
  );
}

async function clickFirstVisible(
  locator: Locator,
  clickTimeout = 3000,
  visibilityTimeout = 250
): Promise<boolean> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible({ timeout: visibilityTimeout }).catch(() => false))) {
      continue;
    }
    if (
      !(await candidate
        .click({ timeout: visibilityTimeout, trial: true })
        .then(() => true)
        .catch(() => false))
    ) {
      continue;
    }

    try {
      await candidate.click({ timeout: clickTimeout, noWaitAfter: true });
    } catch {
      // Linux CI can time out after Playwright has reached the "performing click
      // action" phase. Retrying alternate locators or shortcuts can fire
      // non-idempotent toolbar actions twice, so stop after one actionable click.
    }
    return true;
  }
  return false;
}

async function hasVisible(locator: Locator, visibilityTimeout = 250): Promise<boolean> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    if (
      await locator
        .nth(i)
        .isVisible({ timeout: visibilityTimeout })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

function getToolbarButtonLocators(toolbar: Locator, selector: string, label: string | null) {
  const locators: Locator[] = [];

  if (label) {
    const toolbarButtonId = toolbarButtonIds[label];
    if (toolbarButtonId) {
      locators.push(toolbar.locator(`[data-toolbar-button-id="${toolbarButtonId}"] button`));
    }

    locators.push(toolbar.getByRole("button", { name: label, exact: true }));
  }

  locators.push(toolbar.locator(selector));
  return locators;
}

async function clickToolbarOverflowItem(
  page: Page,
  toolbar: Locator,
  label: string,
  timeout: number
): Promise<boolean> {
  const menuLabel = toolbarOverflowLabels[label] ?? label;
  const overflowTriggers = toolbar.locator("[data-toolbar-overflow-trigger]");
  const count = await overflowTriggers.count();

  for (let i = 0; i < count; i++) {
    const trigger = overflowTriggers.nth(i);
    if (!(await trigger.isVisible({ timeout: 1000 }).catch(() => false))) {
      continue;
    }

    try {
      await trigger.click({ timeout: 1000 });
      const menuItem = page.getByRole("menuitem", { name: menuLabel, exact: true });
      if (await menuItem.isVisible({ timeout: 500 }).catch(() => false)) {
        const isActionable = await menuItem
          .click({ timeout: 1000, trial: true })
          .then(() => true)
          .catch(() => false);
        if (!isActionable) {
          await page.keyboard.press("Escape").catch(() => undefined);
          continue;
        }
        try {
          await menuItem.click({ timeout });
        } catch {
          // Same ambiguity as direct toolbar buttons: once the menu item was
          // actionable, do not retry the same non-idempotent command elsewhere.
        }
        return true;
      }
    } catch {
      // Another toolbar layout pass may have changed which overflow menu owns the item.
    }

    await page.keyboard.press("Escape").catch(() => undefined);
  }

  return false;
}

async function hasToolbarOverflowItem(
  page: Page,
  toolbar: Locator,
  label: string
): Promise<boolean> {
  const menuLabel = toolbarOverflowLabels[label] ?? label;
  const overflowTriggers = toolbar.locator("[data-toolbar-overflow-trigger]");
  const count = await overflowTriggers.count();

  for (let i = 0; i < count; i++) {
    const trigger = overflowTriggers.nth(i);
    if (!(await trigger.isVisible({ timeout: 250 }).catch(() => false))) {
      continue;
    }

    try {
      await trigger.click({ timeout: 1000 });
      const menuItem = page.getByRole("menuitem", { name: menuLabel, exact: true });
      const visible = await menuItem.isVisible({ timeout: 500 }).catch(() => false);
      await page.keyboard.press("Escape").catch(() => undefined);
      if (visible) {
        return true;
      }
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  return false;
}

/**
 * Click a toolbar button, handling the case where it may be hidden
 * in the overflow menu on small displays (e.g., Windows CI).
 * Checks direct visibility first, then falls back to the overflow menu.
 */
export async function clickToolbarButton(
  page: Page,
  selector: string,
  timeout = 5000
): Promise<void> {
  await dismissBlockingPalette(page);

  const toolbar = page.getByRole("toolbar", { name: "Main toolbar" });
  const label = extractExactAriaLabel(selector);

  for (const candidate of getToolbarButtonLocators(toolbar, selector, label)) {
    if (await clickFirstVisible(candidate, 3000, 1000)) {
      return;
    }
  }

  if (label && (await clickToolbarOverflowItem(page, toolbar, label, timeout))) {
    return;
  }

  if (label && toolbarShortcuts[label]) {
    await page.keyboard.press(toolbarShortcuts[label]);
    return;
  }

  throw new Error(`Toolbar button ${label ?? selector} was not visible or present`);
}

/**
 * Assert that a toolbar command can be reached either as a visible button or
 * through the overflow menu. Use this for toolbar responsiveness checks where
 * direct button visibility depends on CI viewport width.
 */
export async function expectToolbarButtonReachable(
  page: Page,
  selector: string,
  timeout = 5000
): Promise<void> {
  await dismissBlockingPalette(page);

  const toolbar = page.getByRole("toolbar", { name: "Main toolbar" });
  const label = extractExactAriaLabel(selector);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const reachability = await getToolbarCommandReachability(page, selector, label);
    if (reachability !== "missing") {
      return;
    }

    for (const candidate of getToolbarButtonLocators(toolbar, selector, label)) {
      if (await hasVisible(candidate)) {
        return;
      }
    }

    if (label && (await hasToolbarOverflowItem(page, toolbar, label))) {
      return;
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`Toolbar button ${label ?? selector} was not reachable`);
}

/**
 * Open settings via keyboard shortcut (Cmd/Ctrl+,).
 * More reliable than clicking the toolbar button, which may be
 * hidden in the overflow menu on small displays (e.g., Windows CI).
 */
export async function openSettings(page: Page, timeout = 10000): Promise<void> {
  const heading = page.locator(SEL.settings.heading);
  const shortcutTimeout = process.env.CI && process.platform === "win32" ? 7000 : 3000;

  // Try keyboard shortcut first (works regardless of toolbar overflow)
  await page.keyboard.press(`${mod}+,`);
  try {
    await heading.waitFor({ state: "visible", timeout: Math.min(timeout, shortcutTimeout) });
    return;
  } catch {
    // Shortcut may not have registered — try clicking the toolbar button
  }

  if (await heading.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  // Fall back to clicking the settings button (handles overflow via menu)
  await clickToolbarButton(page, SEL.toolbar.openSettings);
  await heading.waitFor({ state: "visible", timeout });
}

/**
 * Open a new terminal panel. Clicks toolbar button if visible,
 * otherwise falls back to keyboard shortcut.
 */
export async function openTerminal(page: Page): Promise<void> {
  await clickToolbarButton(page, SEL.toolbar.openTerminal);
}

/**
 * Open a new browser panel. Clicks toolbar button if visible,
 * otherwise falls back to keyboard shortcut.
 */
export async function openBrowser(page: Page): Promise<void> {
  await clickToolbarButton(page, SEL.toolbar.openBrowser);
}

export function getFirstGridPanel(page: Page): Locator {
  return page.locator(SEL.panel.gridPanel).first();
}

export async function getGridPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.gridPanel).count();
}

export async function getDockPanelCount(page: Page): Promise<number> {
  return page.locator(SEL.panel.dockPanel).count();
}

export async function getGridPanelIds(page: Page): Promise<string[]> {
  return page
    .locator(SEL.panel.gridPanel)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-id") ?? "").filter(Boolean));
}

export async function getDockPanelIds(page: Page): Promise<string[]> {
  return page
    .locator(SEL.panel.dockPanel)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-id") ?? "").filter(Boolean));
}

export function getPanelById(page: Page, id: string): Locator {
  return page.locator(`[data-panel-id="${id}"]`);
}

export function getPanelDragHandle(panel: Locator): Locator {
  return panel.locator(".cursor-grab").first();
}

export async function getFocusedPanelId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement?.closest("[data-panel-id]");
    if (active) return active.getAttribute("data-panel-id");
    const selected = document.querySelector(".terminal-selected[data-panel-id]");
    return selected?.getAttribute("data-panel-id") ?? null;
  });
}
