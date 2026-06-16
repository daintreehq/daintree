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
  stubRepoStats,
  restoreRepoStats,
} from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";

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
  // A token-error pill routes clicks to Settings instead of opening the
  // dropdown (#10347), and `isTokenError` only clears once the stats hook
  // re-fetches with the freshly seeded token — wait out that propagation
  // window before clicking.
  await expect(pill).not.toHaveAccessibleName(/Configure/, { timeout: T_MEDIUM });
  await pill.scrollIntoViewIfNeeded();
  await pill.click();
}

test.describe.serial("Core: GitHub panels (dropdowns, rate-limit, token banner)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "github-panels", withGitHubRemote: true });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "GitHub Panels Test");
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    await restoreListIssues(ctx.app);
    await restoreRepoStats(ctx.app);
    await pushRateLimitClear(ctx.app);
    await pushTokenHealthHealthy(ctx.app);
    await clearGitHubToken(ctx.app);
    // Guard cleanup against a torn-down window so an afterEach error never
    // shadows the real test failure (same rationale as the Escape catch below).
    await refreshGitHubConfig(ctx.window).catch(() => {});
    // Collapse any dropdown/dialog left open.
    await ctx.window.keyboard.press("Escape").catch(() => {});
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("clicking the issues pill without a token routes to forge settings", async () => {
    const { window } = ctx;
    await clearGitHubToken(ctx.app);
    await refreshGitHubConfig(window);

    // Token-error pills don't open the dropdown — the click routes to
    // Settings → Code Forge so the user lands on the fix, not a dead list
    // (ForgeStatsToolbarButton onClick, #10347 forge-neutral rework). Pin the
    // stats state to a token error so the routing decision is deterministic.
    const pill = window.locator(SEL.github.statPillIssues);
    await expect(pill).toBeVisible({ timeout: T_MEDIUM });
    await stubRepoStats(
      ctx.app,
      {
        issueCount: null,
        prCount: null,
        error: "GitHub token not configured",
      },
      window
    );
    await expect(pill).toHaveAccessibleName(/Configure/, { timeout: T_MEDIUM });
    await pill.click();

    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.github.tokenBlock)).toBeVisible({ timeout: T_MEDIUM });
    await window.locator(SEL.settings.closeButton).click();
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("bulk-selecting issues opens the create-worktrees dialog", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubRepoStats(ctx.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);
    await stubListIssues(ctx.app, [
      makeFixtureIssue(101, "E2E issue one"),
      makeFixtureIssue(102, "E2E issue two"),
      makeFixtureIssue(103, "E2E issue three"),
    ]);

    await openIssuesDropdown(window);

    // The select-all control only renders with a non-empty search query AND data.
    await window.locator(SEL.github.searchIssues).fill("e2e");
    await expect(window.locator(SEL.github.item(101))).toBeVisible({ timeout: T_LONG });

    const selectAll = window
      .locator(SEL.github.selectionActions)
      .getByRole("button", { name: /Select all/ });
    await expect(selectAll).toBeVisible();
    await selectAll.click();

    await expect(window.locator(SEL.github.bulkActionBar)).toBeVisible();
    await window.locator(SEL.github.bulkCreateButton).click();

    const dialog = window.locator(SEL.github.bulkCreateDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    // The dialog must carry the selected issues, not open empty/stale.
    await expect(dialog.locator('text="E2E issue one"')).toBeVisible({ timeout: T_MEDIUM });
  });

  test("issues dropdown renders search and filter chrome when connected", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubRepoStats(ctx.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);
    // The fake E2E token can't satisfy a real list fetch — without a stub the
    // dropdown falls back to its not-connected surface instead of the chrome.
    await stubListIssues(ctx.app, [makeFixtureIssue(201, "E2E chrome issue")]);

    await openIssuesDropdown(window);

    // The per-type search input only renders for the connected (token present)
    // dropdown surface — its presence proves we cleared the no-token gate.
    await expect(window.locator(SEL.github.searchIssues)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("issues dropdown shows the paused state under a rate-limit block", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubRepoStats(ctx.app, { issueCount: 0, prCount: 0, commitCount: 5 }, window);
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

    await expect(window.getByRole("status", { name: /GitHub rate limit/ })).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Clearing the block lifts the paused surface — the toolbar resumes.
    await pushRateLimitClear(ctx.app);
    await expect(window.getByRole("status", { name: /GitHub rate limit/ })).not.toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("PR dropdown renders search chrome when connected", async () => {
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubRepoStats(ctx.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);

    const pill = window.locator(SEL.github.statPillPrs);
    await expect(pill).toBeVisible({ timeout: T_MEDIUM });
    // Same token-error propagation wait as openIssuesDropdown.
    await expect(pill).not.toHaveAccessibleName(/Configure/, { timeout: T_MEDIUM });
    await pill.scrollIntoViewIfNeeded();
    await pill.click();

    await expect(window.locator(SEL.github.searchPrs)).toBeVisible({ timeout: T_MEDIUM });
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
