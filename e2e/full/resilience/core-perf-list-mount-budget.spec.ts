/**
 * Core: ReviewHub large-list virtualization
 *
 * Opens ReviewHub on a worktree with 1000 unstaged files, unstages the
 * auto-staged set, and expands the changes list from collapsed. The list must
 * mount its first row, stay virtualized (fewer rows in the DOM than files),
 * and reveal its middle and last rows through the shared scroll container.
 *
 * The DOM-delta and long-animation-frame budgets for the same mount are an
 * opt-in benchmark: e2e/perf/list-mount-budget-perf.spec.ts.
 */

import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const FILE_COUNT = 1000;

// Allow cold-runner setup and virtualized row reveals; elapsed time is not
// what this test asserts.
const T_LIST_MOUNT = T_LONG * 3;

const clickReviewHubSetupButton = async (locator: Locator) => {
  await expect(locator).toBeVisible({ timeout: T_LONG });
  await expect(locator).toBeEnabled({ timeout: T_LONG });
  await locator.evaluate(
    (element) => {
      (element as HTMLElement).click();
    },
    undefined,
    { timeout: 120_000 }
  );
};

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: ReviewHub large-list virtualization", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "list-virtualization",
      unstagedFileCount: FILE_COUNT,
    });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "List Virtualization Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("ReviewHub working-tree list mounts virtualized and reveals its middle and last rows", async () => {
    const { window } = ctx;

    const firstFileName = "bulk-unstaged/file-0001.txt";
    const lastFileName = `bulk-unstaged/file-${FILE_COUNT}.txt`;
    const midFileName = `bulk-unstaged/file-0500.txt`;

    // PR #7890 auto-stages all unstaged files when the hub is launched from a
    // worktree card, and the file list is expanded on open. Unstage and
    // collapse first so the expand below mounts the full unstaged list from a
    // known-collapsed start.
    await test.step("Open ReviewHub, unstage, and collapse the list", async () => {
      const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
      await reviewBtn.first().click();

      const hub = window.locator(SEL.reviewHub.container);
      await expect(hub).toBeVisible({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).not.toBeVisible({ timeout: T_SHORT });

      // Opening the hub auto-stages the fixture; unstage before measuring the
      // collapsed-to-expanded mount of its changes section.
      const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
      await expect(fileListToggle).toBeVisible({ timeout: T_LIST_MOUNT });
      await expect(fileListToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_LIST_MOUNT,
      });

      const unstageAllButton = hub.locator(SEL.reviewHub.unstageAllButton);
      await expect(unstageAllButton).toBeVisible({ timeout: T_LIST_MOUNT });
      await clickReviewHubSetupButton(unstageAllButton);
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({
        timeout: T_LIST_MOUNT,
      });

      await clickReviewHubSetupButton(fileListToggle);
      await expect(fileListToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: T_MEDIUM,
      });
    });

    await test.step("Expand file list and verify the initial viewport mounts", async () => {
      const hub = window.locator(SEL.reviewHub.container);
      const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);

      await clickReviewHubSetupButton(fileListToggle);
      await expect(fileListToggle).toHaveAttribute("aria-expanded", "true", { timeout: T_MEDIUM });

      await expect(hub.locator(SEL.reviewHub.stageButton(firstFileName))).toBeVisible({
        timeout: T_LIST_MOUNT,
      });
      await expect.poll(() => hub.getByRole("option").count()).toBeLessThan(FILE_COUNT);
    });

    await test.step("Scroll to the middle and end of the virtualized list", async () => {
      const hub = window.locator(SEL.reviewHub.container);
      const scroller = hub.getByTestId("review-hub-scroll-container");

      // Offscreen rows intentionally have no DOM nodes. Reveal them through
      // the shared scroll container.
      // toBeInViewport, not isVisible: a mounted row in Virtuoso's overscan
      // is "visible" while still clipped outside the scroller.
      await expect(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
        });
        await expect(hub.locator(SEL.reviewHub.stageButton(midFileName))).toBeInViewport({
          timeout: T_SHORT,
        });
      }).toPass({ timeout: T_LIST_MOUNT });

      // Revealing new rows updates Virtuoso's estimated height. Keep following
      // the live extent until the actual last file mounts, not the old bottom.
      await expect(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(hub.locator(SEL.reviewHub.stageButton(lastFileName))).toBeInViewport({
          timeout: T_SHORT,
        });
      }).toPass({ timeout: T_LIST_MOUNT });
      await expect.poll(() => hub.getByRole("option").count()).toBeLessThan(FILE_COUNT);
    });
  });
});
