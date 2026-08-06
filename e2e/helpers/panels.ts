import type { Locator, Page } from "@playwright/test";
import { dismissBlockingPalette } from "./overlays";
import { SEL } from "./selectors";

const mod = process.platform === "darwin" ? "Meta" : "Control";

const toolbarOverflowLabels: Record<string, string> = {
  "Open terminal": "Terminal",
  "Open browser": "Browser",
  "Open settings": "Settings",
  "Open dev preview": "Dev preview",
  "Copy context": "Copy context",
  Notifications: "Notifications",
};

const toolbarButtonIds: Record<string, string> = {
  "Open terminal": "terminal",
  "Open browser": "browser",
  "Open settings": "settings",
  "Open dev preview": "dev-server",
  "Copy context": "copy-tree",
  Notifications: "notification-center",
};

/**
 * Toolbar commands that live in the panel tray (#11667).
 *
 * `browser` and `dev-server` left the default toolbar in v13, so on a fresh
 * profile — which is every e2e profile — they have no direct button and no
 * overflow row of their own. The tray dropdown is their route. Keyed by the
 * button's aria-label, valued by the tray row's item id.
 */
// The launcher offers panels straight from the kind registry now (#11691), so a
// row is found by the kind's own name rather than a toolbar button id.
const toolbarPanelTrayItemNames: Record<string, string> = {
  "Open browser": "Browser",
  "Open dev preview": "Dev Preview",
  "Browse files": "File Browser",
};

/**
 * A launcher row, matched on the leading segment of its accessible name. The
 * rows are `role="option"` inside a search-first popover — there are no menu
 * items or per-row test ids to key off any more.
 */
function launcherRow(page: Page, name: string): Locator {
  return page.locator(`[role="option"][aria-label^="${name},"]`);
}

const toolbarShortcuts: Record<string, string> = {
  "Open terminal": `${mod}+Alt+t`,
  "Open browser": `${mod}+Alt+b`,
  "Open settings": `${mod}+,`,
  "Copy context": `${mod}+Shift+c`,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toolbarOverflowMenuItem(page: Page, menuLabel: string): Locator {
  return page.getByRole("menuitem", {
    name: new RegExp(`^${escapeRegExp(menuLabel)}(?:\\s|$)`),
  });
}

function extractToolbarLabel(selector: string): string | null {
  return selector.match(/aria-label(?:\^)?="([^"]+)"/)?.[1] ?? null;
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
      const menuItem = toolbarOverflowMenuItem(page, menuLabel);
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

/**
 * Open the panel tray and activate one of its rows.
 *
 * Sits between the overflow attempt and the keyboard fallback in
 * `clickToolbarButton`: when the tray is itself in overflow its rows are inlined
 * and the overflow path already found them, so this only runs for the case the
 * overflow path can't cover — a visible tray whose items have no button of their
 * own.
 */
async function clickPanelTrayItem(
  page: Page,
  toolbar: Locator,
  label: string,
  timeout: number
): Promise<boolean> {
  const itemName = toolbarPanelTrayItemNames[label];
  if (!itemName) return false;

  const tray = toolbar.locator('[data-toolbar-button-id="launcher"] button');
  if (!(await clickFirstVisible(tray, 1000, 500))) return false;

  // The caller's timeout, not a fixed second: the popover primitives are
  // lazy-loaded, so the first launcher open on a cold release runner can be
  // slower than any menu this suite has already warmed.
  const row = launcherRow(page, itemName);
  if (!(await row.isVisible({ timeout }).catch(() => false))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  try {
    await row.click({ timeout });
  } catch {
    // Same ambiguity as a direct toolbar button: once the row was there, don't
    // retry a non-idempotent command through another route.
  }
  return true;
}

async function hasPanelTrayItem(page: Page, toolbar: Locator, label: string): Promise<boolean> {
  const itemName = toolbarPanelTrayItemNames[label];
  if (!itemName) return false;

  const tray = toolbar.locator('[data-toolbar-button-id="launcher"] button');
  if (!(await clickFirstVisible(tray, 1000, 250))) return false;

  const visible = await launcherRow(page, itemName)
    .isVisible({ timeout: 500 })
    .catch(() => false);
  await page.keyboard.press("Escape").catch(() => undefined);
  return visible;
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
      const menuItem = toolbarOverflowMenuItem(page, menuLabel);
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
  const label = extractToolbarLabel(selector);

  for (const candidate of getToolbarButtonLocators(toolbar, selector, label)) {
    if (await clickFirstVisible(candidate, 3000, 1000)) {
      return;
    }
  }

  if (label && (await clickToolbarOverflowItem(page, toolbar, label, timeout))) {
    return;
  }

  if (label && (await clickPanelTrayItem(page, toolbar, label, timeout))) {
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
  const label = extractToolbarLabel(selector);
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

    if (label && (await hasPanelTrayItem(page, toolbar, label))) {
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

/**
 * Open the dev preview panel.
 *
 * Always route through here rather than clicking `SEL.toolbar.openDevPreview`
 * directly: since #11667 `dev-server` is not a default toolbar button, so on a
 * fresh profile — which every e2e profile is — that locator matches nothing and
 * the panel is reached through the panel tray instead. A direct click would
 * fail, and a direct `isVisible()` probe guarding a `test.skip()` would skip
 * forever while still reporting green.
 */
export async function openDevPreview(page: Page): Promise<void> {
  await clickToolbarButton(page, SEL.toolbar.openDevPreview);
}

/**
 * Whether a toolbar command can be reached at all — as a direct button, an
 * overflow row, or a launcher panel row. The boolean sibling of
 * `expectToolbarButtonReachable`, for specs that legitimately skip when an entry
 * point is absent in a given launch state rather than failing.
 */
export async function isToolbarButtonReachable(
  page: Page,
  selector: string,
  timeout = 5000
): Promise<boolean> {
  try {
    await expectToolbarButtonReachable(page, selector, timeout);
    return true;
  } catch {
    return false;
  }
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
