import { test, expect, type Locator, type Page } from "@playwright/test";
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

async function expectAlignedColumn(items: Locator, count: number): Promise<void> {
  await expect(items).toHaveCount(count);
  await expect
    .poll(
      async () =>
        items.evaluateAll((elements) => {
          const boxes = elements.map((element) => element.getBoundingClientRect());
          if (boxes.some((box) => box.width === 0 || box.height === 0)) return 1_000_000;
          const xs = boxes.map((box) => box.x);
          return Math.max(...xs) - Math.min(...xs);
        }),
      { timeout: T_MEDIUM }
    )
    .toBeLessThan(0.5);
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

    await window.locator(SEL.github.searchIssues).fill("e2e");
    await expect(window.locator(SEL.github.item(101))).toBeVisible({ timeout: T_LONG });

    // Bulk presets moved behind the fixed-size selection trigger so typing no
    // longer grows the header. Open that popover before choosing the preset.
    await window.getByRole("button", { name: "Select issues" }).click();

    const selectAll = window
      .locator(SEL.github.selectionActions)
      .getByRole("button", { name: /Select all/ });
    await expect(selectAll).toBeVisible();
    // The provider can finish resolving while Radix's popover is animating,
    // remounting the content before Playwright's pointer-stability gate clears.
    // Keyboard activation is the same supported button path and is not tied to
    // the transient popover geometry.
    await selectAll.press("Enter");

    await expect(window.locator(SEL.github.bulkActionBar)).toBeVisible();
    await window.locator(SEL.github.bulkCreateButton).click();

    const dialog = window.locator(SEL.github.bulkCreateDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    // The dialog must carry the selected issues, not open empty/stale.
    await expect(dialog.locator('text="E2E issue one"')).toBeVisible({ timeout: T_MEDIUM });
  });

  test("keeps every row's assignee avatar in one column", async () => {
    // The reported defect: the trailing rail was a right-anchored flex row of
    // conditional slots, so a neighbour appearing to the RIGHT of the avatar
    // — a worktree glyph, or the "+N" more-assignees count — pushed it ~20px
    // left and the avatars stopped lining up down the list. jsdom cannot see
    // that: a DOM-order test still passes if a width or a gap changes. This is
    // the assertion that actually measures the column.
    const { window } = ctx;
    await connectGitHub(ctx.app, window);
    await stubRepoStats(ctx.app, { issueCount: 3, prCount: 0, commitCount: 5 }, window);
    await stubListIssues(ctx.app, [
      makeFixtureIssue(201, "One assignee", {
        assignees: [{ login: "alice", avatarUrl: "" }],
      }),
      makeFixtureIssue(202, "Three assignees, so the row also carries a +2", {
        assignees: [
          { login: "alice", avatarUrl: "" },
          { login: "bob", avatarUrl: "" },
          { login: "carol", avatarUrl: "" },
        ],
      }),
      makeFixtureIssue(203, "One assignee and a long title that will truncate hard", {
        assignees: [{ login: "dave", avatarUrl: "" }],
        labels: [{ name: "bug", color: "d73a4a" }],
        commentCount: 12,
      }),
    ]);

    await openIssuesDropdown(window);
    await expect(window.locator(SEL.github.item(201))).toBeVisible({ timeout: T_LONG });

    const slots = window.locator('[role="img"][aria-label^="Assigned to"]');
    // Measure the complete column in one render frame and poll through the
    // dropdown's entry/layout transition. Sequential boundingBox() calls can
    // otherwise mix frames or observe an element while it is briefly hidden.
    await expectAlignedColumn(slots, 3);

    // And the anchor they hang off — the actions menu — is itself a column.
    const menus = window.locator('[aria-label^="Actions for #"]');
    await expectAlignedColumn(menus, 3);
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
