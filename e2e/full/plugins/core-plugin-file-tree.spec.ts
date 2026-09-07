import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { closeApp, launchApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { FILE_TREE_PLUGIN_ID, SAMPLE_PLUGINS_DIR, activateE2EPlugin } from "../../helpers/plugins";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import type { ActionDispatchResult } from "../../../shared/types/actions";

/**
 * The file-listing surface, exercised the way a plugin author reaches it.
 *
 * Daintree's own file browser shares the tree model, but it imports the package
 * source by relative path — so all 650 of its unit tests would still pass with
 * `@daintreehq/plugin-sdk/files` unexported, unbuilt, or exporting something
 * that does not resolve. The sample plugin driven here bundles the SDK through
 * the published `exports` boundary and gets its data from
 * `host.fs.readdir(dir, { detail: true })`, so this is the one place the pairing
 * of those two features is proven against a real filesystem.
 *
 * Every assertion names a specific fixture entry. An absence-only check ("no
 * `.git` row") passes just as well when nothing rendered at all, which is the
 * failure mode most likely here — so each one is paired with a presence check
 * on an entry that must be there.
 */

/** The fixture `withMultipleFiles` builds, which every assertion below names. */
const ROOT_FILE = "README.md";
const ROOT_DIR = "src";
const NESTED_FILE = "src/index.ts";
const DOTFILE = ".env.local";

function row(page: Page, path: string) {
  return page.getByTestId(`file-tree-row-${path}`);
}

async function dispatchAction<Result = unknown>(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<ActionDispatchResult<Result>> {
  return page.evaluate(
    async (payload) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            a?: unknown,
            opts?: { source: string }
          ) => Promise<ActionDispatchResult<Result>>;
        }
      ).__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("__daintreeDispatchAction is not available");
      }
      return dispatch(payload.actionId, payload.args, { source: "menu" });
    },
    { actionId, args }
  );
}

/** Open the sample's panel and wait for the root listing to paint. */
async function openExplorer(page: Page): Promise<void> {
  const result = await dispatchAction(page, "panel.openPluginPanel", {
    kind: `${FILE_TREE_PLUGIN_ID}.explorer`,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await expect(page.getByTestId("file-tree-view")).toBeVisible({ timeout: T_LONG });
  // A named entry, not "any row": the root listing has genuinely arrived only
  // once something the fixture is known to contain is on screen.
  await expect(row(page, ROOT_FILE)).toBeVisible({ timeout: T_LONG });
}

test.describe("plugin file-tree sample", () => {
  let ctx: AppContext;
  let cleanupRepo: () => void;

  test.beforeEach(async () => {
    // Its own launch rather than `launchWithSamplePlugin`, which builds a
    // bare fixture: these assertions need the known `src/` subtree and a
    // committed dotfile.
    ctx = await launchApp({ env: { DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR } });
    const fixture = createFixtureRepo({ name: "plugin-file-tree", withMultipleFiles: true });
    cleanupRepo = fixture.cleanup;
    // The fixture ships no ordinary dotfile, and `.git` is on the sample's
    // always-hidden list — so without this the dotfile-filter test would have
    // nothing to reveal and would pass whatever the filter did.
    writeFileSync(path.join(fixture.dir, DOTFILE), "TOKEN=example\n");
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "plugin-file-tree");
    await activateE2EPlugin(ctx.app, FILE_TREE_PLUGIN_ID);
  });

  test.afterEach(async () => {
    await closeApp(ctx);
    cleanupRepo();
  });

  test("lists a real directory through host.fs.readdir with detail", async () => {
    const page = ctx.window;
    await openExplorer(page);

    // Both a file and a directory from the fixture, so the detailed listing
    // survived the worker round trip with its kind flags intact.
    await expect(row(page, ROOT_FILE)).toBeVisible();
    await expect(row(page, ROOT_DIR)).toBeVisible();
    await expect(row(page, ROOT_DIR)).toHaveAttribute("aria-expanded", "false");

    // `.git` is in the sample's always-hidden list: not rendered, but counted.
    // The count is asserted non-zero rather than exact, because the hidden set
    // is whatever git leaves in the fixture.
    await expect(row(page, ".git")).toHaveCount(0);
    await expect(page.getByTestId("file-tree-hidden-count")).not.toHaveText("0 hidden");
  });

  test("expands a directory lazily and restores it on remount", async () => {
    const page = ctx.window;
    await openExplorer(page);

    // Absent first: the model only asks for children on expansion, so this is
    // what makes the appearance below mean something.
    await expect(row(page, NESTED_FILE)).toHaveCount(0);

    await row(page, ROOT_DIR).click();
    await expect(row(page, ROOT_DIR)).toHaveAttribute("aria-expanded", "true", {
      timeout: T_MEDIUM,
    });
    await expect(row(page, NESTED_FILE)).toBeVisible({ timeout: T_MEDIUM });

    // Tearing the view down without closing the panel is the case the panel
    // record exists for. A reload destroys all React state and the default
    // expanded set is empty, so the directory coming back open can only have
    // come from `persistState` → `initialArgs`.
    await page.reload();
    await expect(page.getByTestId("file-tree-view")).toBeVisible({ timeout: T_LONG });
    await expect(row(page, ROOT_DIR)).toHaveAttribute("aria-expanded", "true", {
      timeout: T_LONG,
    });
    // And the child is listed again — `aria-expanded` alone is derived from the
    // restored set and would still be "true" with the replay load broken.
    await expect(row(page, NESTED_FILE)).toBeVisible({ timeout: T_LONG });
  });

  test("moves the selection with the arrow keys", async () => {
    const page = ctx.window;
    await openExplorer(page);

    // Start from a known selection rather than from nothing: with a null cursor
    // the first ArrowDown selects the top row, which would look like movement
    // whether or not the key resolution works.
    await row(page, ROOT_DIR).click();
    await expect(row(page, ROOT_DIR)).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tree").focus();
    await page.keyboard.press("ArrowDown");

    // `src` sorts before `README.md` (directories first), so the next row down
    // is the expanded directory's first child.
    await expect(row(page, ROOT_DIR)).toHaveAttribute("aria-selected", "false", {
      timeout: T_MEDIUM,
    });
    await expect(page.locator('[data-testid^="file-tree-row-"][aria-selected="true"]')).toHaveCount(
      1
    );
  });

  test("reveals dotfiles without revealing always-hidden entries", async () => {
    const page = ctx.window;
    await openExplorer(page);

    // A specific dotfile, so "revealed" is a presence assertion on a known
    // name rather than a row count that could move for any reason.
    await expect(row(page, DOTFILE)).toHaveCount(0);

    await page.getByTestId("file-tree-toggle-dotfiles").click();

    await expect(row(page, DOTFILE)).toBeVisible({ timeout: T_MEDIUM });
    // The two controls are separate, with separate recoveries: turning off the
    // dotfile filter must not also reveal the always-hidden list.
    await expect(row(page, ".git")).toHaveCount(0);
  });
});
