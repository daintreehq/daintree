import path from "path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { activateE2EPlugin, SAMPLE_PLUGIN_LABEL } from "../../helpers/plugins";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLE_PLUGINS_DIR = path.join(ROOT, "dist-electron/plugins/sample");
const PLUGIN_READY_TIMEOUT = process.env.CI ? 60_000 : T_LONG;

async function invokeHelloPing(page: Page): Promise<unknown> {
  return page.evaluate(() => window.electron.plugin.invoke("daintree.hello", "ping"));
}

async function getPluginActionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const actions = await window.electron.plugin.getActions();
    return actions.map((action) => action.id);
  });
}

async function waitForSamplePluginReady(page: Page): Promise<void> {
  await expect
    .poll(() => getPluginActionIds(page), { timeout: PLUGIN_READY_TIMEOUT })
    .toContain("daintree.hello.greet");
}

async function isNotificationInboxVisible(notificationInbox: Locator): Promise<boolean> {
  return notificationInbox.isVisible({ timeout: 500 }).catch(() => false);
}

async function waitForNotificationInboxVisible(
  notificationInbox: Locator,
  timeout = T_SHORT
): Promise<boolean> {
  return expect(notificationInbox)
    .toBeVisible({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForNotificationInboxHidden(
  notificationInbox: Locator,
  timeout = T_SHORT
): Promise<boolean> {
  return expect(notificationInbox)
    .not.toBeVisible({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function clickVisibleNotificationToolbarButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
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
        if (style.display === "none" || style.visibility === "hidden") return false;
        current = current.parentElement;
      }

      return true;
    };

    const selectors = [
      '[role="toolbar"][aria-label="Main toolbar"] [data-toolbar-button-id="notification-center"] button',
      '[role="toolbar"][aria-label="Main toolbar"] button[aria-label^="Notifications"]',
    ];

    for (const selector of selectors) {
      const button = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        isVisibleElement
      );
      if (button) {
        button.click();
        return true;
      }
    }

    return false;
  });
}

async function openNotificationInbox(page: Page): Promise<Locator> {
  const notificationInbox = page.getByRole("button", { name: "Pause notifications" });
  if (await isNotificationInboxVisible(notificationInbox)) return notificationInbox;

  if (await clickVisibleNotificationToolbarButton(page)) {
    if (await waitForNotificationInboxVisible(notificationInbox)) return notificationInbox;
  }

  await page.keyboard.press(`${mod}+Shift+N`);
  await expect(notificationInbox).toBeVisible({ timeout: T_SHORT });
  return notificationInbox;
}

async function closeNotificationInbox(page: Page, notificationInbox: Locator): Promise<void> {
  if (!(await isNotificationInboxVisible(notificationInbox))) return;

  if (await clickVisibleNotificationToolbarButton(page)) {
    if (await waitForNotificationInboxHidden(notificationInbox)) return;
  }

  await page.keyboard.press(`${mod}+Shift+N`);
  await expect(notificationInbox).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * Plugin host-contract harness (#9286). Sideloads the `hello-daintree` sample
 * plugin through `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` (the env-var-stripped
 * production binary ignores this), then exercises three host-API surfaces
 * end-to-end:
 *
 *   1. `host.registerHandler` during `activate()` → renderer IPC round-trip
 *   2. `host.registerAction` → action visible in the action palette
 *   3. dispatch from the palette → handler's `host.showToast` → inbox entry
 *
 * Inbox-based assertions are chosen over live toast assertions because the
 * inbox is durable: `notify()` writes to history regardless of toast
 * suppression / dismiss timing, so the spec is not racing the toast queue.
 */

test.describe.serial("Core: Plugin host-contract harness", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    ctx = await launchApp({
      env: { DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR },
    });
    const { dir, cleanup } = createFixtureRepo({ name: "plugin-host-contract" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Plugin Host Contract");
    await activateE2EPlugin(ctx.app, "daintree.hello");
    await waitForSamplePluginReady(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("activation registers the sample plugin IPC handler", async () => {
    const { window } = ctx;
    await expect(invokeHelloPing(window)).resolves.toEqual(
      expect.objectContaining({ pluginId: "daintree.hello" })
    );
  });

  test("registerAction surfaces the action in the action palette", async () => {
    const { window } = ctx;
    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Hello: Greet");

    const greetOption = window
      .locator(SEL.actionPalette.options)
      .filter({ hasText: "Hello: Greet" });
    await expect(greetOption.first()).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    await searchInput.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
  });

  test("dispatching the action through the palette fires showToast end-to-end", async () => {
    const { window } = ctx;
    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Hello: Greet");
    const greetOption = window
      .locator(SEL.actionPalette.options)
      .filter({ hasText: "Hello: Greet" });
    await expect(greetOption.first()).toBeVisible({ timeout: T_MEDIUM });
    await greetOption.first().click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // The handler calls host.showToast — its human-readable provenance prefix applies.
    const notificationInbox = await openNotificationInbox(window);
    await expect(
      window.locator(`text=${SAMPLE_PLUGIN_LABEL}: Hello from the greet action`).first()
    ).toBeVisible({ timeout: T_LONG });

    await closeNotificationInbox(window, notificationInbox);
  });
});
