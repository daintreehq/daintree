import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { clearAllFaults } from "../../helpers/ipcFaults";
import {
  connectGitHub,
  clearGitHubToken,
  refreshGitHubConfig,
  pushRateLimitBlocked,
  pushRateLimitClear,
  pushTokenHealthUnhealthy,
  pushTokenHealthHealthy,
  stubListIssues,
  restoreListIssues,
  makeFixtureIssue,
} from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM } from "../../helpers/timeouts";

// PR CI/merge gating is intentionally NOT covered here: the CI status dot only
// renders when a PR fixture carries a populated `ciStatus`, which the fault /
// stub injection paths cannot deliver without a success-fixture framework that
// does not exist in this codebase. That branch is exercised by the unit tests
// for `getPRCIStatusVisual` / `getPRCIStatusTooltip` instead.

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function openIssuesDropdown(window: Page): Promise<void> {
  const pill = window.locator(SEL.github.statPillIssues);
  await expect(pill).toBeVisible({ timeout: T_MEDIUM });
  await pill.scrollIntoViewIfNeeded();
  await pill.click();
}

test.describe.serial("Core: GitHub panels (dropdowns, rate-limit, token banner)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "github-panels" });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "GitHub Panels Test");
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    await restoreListIssues(ctx.app);
    await pushRateLimitClear(ctx.app);
    await pushTokenHealthHealthy(ctx.app);
    await clearGitHubToken(ctx.app);
    await refreshGitHubConfig(ctx.window);
    // Collapse any dropdown/dialog left open.
    await ctx.window.keyboard.press("Escape").catch(() => {});
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("issues dropdown shows the not-connected empty state without a token", async () => {
    const { window } = ctx;
    await clearGitHubToken(ctx.app);
    await refreshGitHubConfig(window);

    await openIssuesDropdown(window);

    await expect(window.locator(SEL.github.noTokenEmptyState)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("issues dropdown renders search and filter chrome when connected", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);

    await openIssuesDropdown(window);

    await expect(window.locator(SEL.github.searchIssues)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByRole("radiogroup", { name: "Filter by state" })).toBeVisible();
  });

  test("bulk-selecting issues opens the create-worktrees dialog", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubListIssues(ctx.app, [
      makeFixtureIssue(101, "E2E issue one"),
      makeFixtureIssue(102, "E2E issue two"),
      makeFixtureIssue(103, "E2E issue three"),
    ]);

    await openIssuesDropdown(window);

    // The select-all control only renders with a non-empty search query AND data.
    await window.locator(SEL.github.searchIssues).fill("e2e");
    await expect(window.locator(SEL.github.item(101))).toBeVisible({ timeout: T_MEDIUM });

    const selectAll = window
      .locator(SEL.github.selectionActions)
      .getByRole("button", { name: /Select all/ });
    await expect(selectAll).toBeVisible();
    await selectAll.click();

    await expect(window.locator(SEL.github.bulkActionBar)).toBeVisible();
    await window.locator(SEL.github.bulkCreateButton).click();

    await expect(window.locator(SEL.github.bulkCreateDialog)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("issues dropdown shows the paused state under a rate-limit block", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    // Empty list so the rate-limit empty-state (not a data row) is the surface.
    await stubListIssues(ctx.app, []);

    // Let the dropdown complete its initial (empty) fetch first. `fetchData`
    // skips entirely while a block is active and never flips `loading` off, so
    // blocking before the first fetch would strand the skeleton. Open, let it
    // settle, THEN push the block — exactly the production ordering (a live
    // session gets blocked after it was already showing results).
    await openIssuesDropdown(window);
    await expect(window.locator(SEL.github.searchIssues)).toBeVisible({ timeout: T_MEDIUM });

    await pushRateLimitBlocked(ctx.app);

    await expect(window.locator(SEL.github.rateLimitedEmptyState)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("token-health banner appears on an unhealthy push and clears when healthy", async () => {
    const { window } = ctx;

    await pushTokenHealthUnhealthy(ctx.app);
    await expect(window.locator(SEL.github.tokenExpiredBanner)).toBeVisible({ timeout: T_MEDIUM });

    await pushTokenHealthHealthy(ctx.app);
    await expect(window.locator(SEL.github.tokenExpiredBanner)).not.toBeVisible({
      timeout: T_MEDIUM,
    });
  });
});
