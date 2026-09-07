import path from "path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp, type AppContext } from "./launch";
import { createFixtureRepo } from "./fixtures";
import { openAndOnboardProject } from "./project";
import { SEL } from "./selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "./timeouts";

const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * The sample `hello-daintree` plugin, copied here by `scripts/build-main.mjs`
 * (lines 124-162) during the main build. The sideload backdoor
 * `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` points the headless host at this dir; the
 * env-var-stripped production binary ignores it. Loaded with `isBuiltin: true`
 * (the only way a reserved `daintree.*` namespace passes manifest validation),
 * so the sample appears under the manager's "Built-in" group.
 */
export const SAMPLE_PLUGINS_DIR = path.join(ROOT, "dist-electron/plugins/sample");

/** Display label the sample plugin's manifest resolves to. */
export const SAMPLE_PLUGIN_LABEL = "Hello Daintree";

/**
 * Display label for the capability- and settings-rich sample (#9592). Loaded
 * from the same sideload dir as `hello-daintree`, so both appear under the
 * manager's "Built-in" group in the same session.
 */
export const RICH_PLUGIN_LABEL = "Rich Daintree";

/**
 * Display label for the file-browser sample. Unlike the other two, this one is
 * a working feature rather than a fixture: it exists so the file-listing
 * surface a plugin author would build a browser on is exercised end to end,
 * through the published package boundary rather than through the app's own
 * relative imports.
 */
export const FILE_TREE_PLUGIN_LABEL = "File Tree Sample";

/** Manifest id of the file-browser sample. */
export const FILE_TREE_PLUGIN_ID = "daintree.filetree";

const PLUGIN_READY_TIMEOUT = process.env.CI ? 60_000 : T_LONG;

async function getPluginActionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const actions = await window.electron.plugin.getActions();
    return actions.map((action) => action.id);
  });
}

/** Activate a loaded plugin by id through the E2E-only main-process hook. */
export async function activateE2EPlugin(app: ElectronApplication, pluginId: string): Promise<void> {
  await app.evaluate(async (_modules, id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E hook
    const activate = (globalThis as any).__daintreeActivateE2EPlugin as
      ((pluginId: string) => Promise<void>) | undefined;
    if (!activate) {
      throw new Error("E2E plugin activation hook not available");
    }
    await activate(id);
  }, pluginId);
}

/** IDs of toolbar buttons contributed by loaded plugins (main-process truth). */
export async function getPluginToolbarButtonIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const buttons = await window.electron.plugin.toolbarButtons();
    return buttons.map((button) => button.id);
  });
}

/**
 * Poll until the sample plugin has activated and registered its `greet` action.
 * Activation is async (the host spins up after the renderer mounts), so specs
 * must gate on this before asserting against the plugin's contributions.
 */
export async function waitForSamplePluginReady(page: Page): Promise<void> {
  await expect
    .poll(() => getPluginActionIds(page), { timeout: PLUGIN_READY_TIMEOUT })
    .toContain("daintree.hello.greet");
}

/**
 * Poll until the rich sample plugin has activated and registered its sentinel
 * `ready` action. The rich plugin sideloads alongside `hello-daintree`, but its
 * activation is independent — specs that assert against its capabilities or
 * settings must gate on this rather than `waitForSamplePluginReady`.
 */
export async function waitForRichPluginReady(app: ElectronApplication, page: Page): Promise<void> {
  await activateE2EPlugin(app, "daintree.rich");
  await expect
    .poll(() => getPluginActionIds(page), { timeout: PLUGIN_READY_TIMEOUT })
    .toContain("daintree.rich.ready");
}

/**
 * Launch the app with the sample plugin sideloaded, onboard a throwaway repo,
 * and wait for the plugin to activate. Returns the context plus the fixture
 * cleanup the caller must invoke in `afterAll`.
 */
export async function launchWithSamplePlugin(
  name: string
): Promise<{ ctx: AppContext; cleanup: () => void }> {
  const ctx = await launchApp({
    env: { DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR },
  });
  const { dir, cleanup } = createFixtureRepo({ name });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, name);
  await activateE2EPlugin(ctx.app, "daintree.hello");
  await waitForSamplePluginReady(ctx.window);
  return { ctx, cleanup };
}

/**
 * Open the plugin manager overlay and wait for it to paint. The `app.pluginManager`
 * action dispatches a `daintree:open-plugin-manager` CustomEvent; firing it
 * directly is more reliable than driving the action palette and exercises the
 * same code path.
 */
export async function openPluginManager(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager")));
  await expect(page.locator(SEL.plugin.manager)).toBeVisible({ timeout: T_MEDIUM });
}

/** Close the manager via its header close button and wait for it to unmount. */
export async function closePluginManager(page: Page): Promise<void> {
  await page.locator(SEL.plugin.close).click();
  await expect(page.locator(SEL.plugin.manager)).not.toBeVisible({ timeout: T_SHORT });
}
