import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { openPluginManager, closePluginManager } from "../../helpers/plugins";
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
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Longer than an IPC broadcast takes to reach and render in the renderer.
const TOKEN_HEALTH_DWELL_MS = 1_000;

async function expectForgeSegmentRegistered(
  locator: ReturnType<AppContext["window"]["locator"]>,
  label: RegExp
): Promise<void> {
  await expect(locator).toHaveCount(1, { timeout: T_MEDIUM });
  await expect(locator).toHaveAttribute("aria-label", label);
}

// PR CI/merge gating is intentionally NOT covered here: the CI status dot only
// renders when a PR fixture carries a populated `ciStatus`, which the fault /
// stub injection paths cannot deliver without a success-fixture framework that
// does not exist in this codebase. That branch is exercised by the unit tests
// for `getPRCIStatusVisual` / `getPRCIStatusTooltip` instead.

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

/**
 * Forge stats pill lifecycle across the two paths that regressed when plugin
 * loading moved into the post-first-interactive deferred queue (#10346) and
 * forge resolution became plugin-registry-backed (#10343/#10347):
 *
 * 1. Cold boot with a PERSISTED project — the toolbar mounts and resolves the
 *    forge provider before the deferred `PluginService.initialize()` populates
 *    the registry. Without the `waitForInit()` gate on `forge:resolve-provider`
 *    the renderer caches `{entry: null}` for the session and the pill never
 *    appears. (The other GitHub specs onboard their project AFTER boot, which
 *    re-resolves on projectId change and so never exercised this path.)
 *
 * 2. Live disable → enable of `daintree.github` — built-ins transition live
 *    (#9304): the toggle must tear down / re-register the forge provider and
 *    broadcast `plugin:provenance-changed`, flipping the pill off and back on
 *    without a restart.
 *
 * The fixture remote points at github.com so hostname matching resolves the
 * provider; no token is seeded — pill VISIBILITY is gated only on provider
 * resolution, never on auth or fetched counts.
 *
 * Both sessions run in fault mode: it only installs test seams, and the
 * relaunched session also hosts the GitHub dropdown/rate-limit/token tests,
 * which stub forge IPC through those seams against the same GitHub-remote
 * project. The remote-less project switch runs last.
 */
const FAULT_MODE_ENV = { DAINTREE_E2E_FAULT_MODE: "1" };

test.describe.serial("Panels: Forge stats pill lifecycle", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: () => void;
  let noForgeCleanup: (() => void) | undefined;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-forge-stats-"));
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "forge-stats",
      withGitHubRemote: true,
    }));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
    noForgeCleanup?.();
  });

  test("pill appears after onboarding a GitHub-remote project", async () => {
    ctx = await launchApp({ userDataDir, env: FAULT_MODE_ENV });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Forge Stats");

    await expectForgeSegmentRegistered(ctx.window.locator(SEL.github.statPillIssues), /issues/i);
  });

  test("pill disappears and reappears across a live plugin disable/enable", async () => {
    // Built-ins transition LIVE (#9304) — drive the real Settings toggle, not
    // bare IPC, so the whole user path is covered: switch → plugin:set-enabled
    // → _applyEnabledToggle (unload/re-register + activate) → provenance
    // broadcast → every mounted useResolvedForgeProvider instance re-resolves.
    const window = ctx!.window;
    const pill = window.locator(SEL.github.statPillIssues);
    const toggle = window.getByRole("switch", { name: "Enable GitHub" });

    await openPluginManager(window);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    // Live transition: no restart gate for built-ins.
    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible();
    await closePluginManager(window);
    await expect(pill).toHaveCount(0, { timeout: T_MEDIUM });
    // Issue/PR segments are forge data and collapse with the plugin; the
    // commit count is local git, so the commits-only pill stays.
    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillCommits), /commits/i);

    await openPluginManager(window);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await closePluginManager(window);
    await expectForgeSegmentRegistered(pill, /issues/i);
  });

  test("pill appears on cold boot with a persisted project (no interaction)", async () => {
    // Close session 1; relaunch against the same userDataDir so the project
    // restores at boot and the toolbar resolves the provider at mount time —
    // the exact ordering that races the deferred plugin initialize().
    const pid = ctx!.app.process().pid;
    await closeApp(ctx!.app);
    if (pid) await waitForProcessExit(pid).catch(() => {});

    ctx = await launchApp({ userDataDir, env: FAULT_MODE_ENV });
    const window = ctx.window;

    await expect(window.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText("forge-stats", {
      timeout: T_LONG,
    });
    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillIssues), /issues/i);
  });

  test.describe("GitHub panels (dropdowns, rate-limit, token banner)", () => {
    test.afterEach(async () => {
      if (!ctx) return;
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

    test("clicking the issues pill without a token routes to forge settings", async () => {
      const window = ctx!.window;
      await clearGitHubToken(ctx!.app);
      await refreshGitHubConfig(window);

      // Token-error pills don't open the dropdown — the click routes to
      // Settings → Code Forge so the user lands on the fix, not a dead list
      // (ForgeStatsToolbarButton onClick, #10347 forge-neutral rework). Pin the
      // stats state to a token error so the routing decision is deterministic.
      const pill = window.locator(SEL.github.statPillIssues);
      await expect(pill).toBeVisible({ timeout: T_MEDIUM });
      await stubRepoStats(
        ctx!.app,
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
      const window = ctx!.window;
      await connectGitHub(ctx!.app, window);
      await stubRepoStats(ctx!.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);
      await stubListIssues(ctx!.app, [makeFixtureIssue(100, "Unfiltered issue")]);
      await openIssuesDropdown(window);
      await expect(window.locator(SEL.github.item(100))).toBeVisible({ timeout: T_LONG });

      // Wait for a result unique to the searched response. An unfiltered row
      // can still be visible before the debounce clears the list and its menu.
      await stubListIssues(ctx!.app, [
        makeFixtureIssue(101, "E2E issue one"),
        makeFixtureIssue(102, "E2E issue two"),
        makeFixtureIssue(103, "E2E issue three"),
      ]);

      await window.locator(SEL.github.searchIssues).fill("e2e");
      await expect(window.locator(SEL.github.item(101))).toBeVisible({ timeout: T_LONG });

      // Bulk presets moved behind the fixed-size selection trigger so typing no
      // longer grows the header. Open that popover before choosing the preset.
      await window.getByRole("button", { name: "Select issues" }).click();

      const selectAll = window
        .locator(SEL.github.selectionActions)
        .getByRole("menuitem", { name: /Select all/ });
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
      const window = ctx!.window;
      await connectGitHub(ctx!.app, window);
      await stubRepoStats(ctx!.app, { issueCount: 3, prCount: 0, commitCount: 5 }, window);
      await stubListIssues(ctx!.app, [
        makeFixtureIssue(201, "One assignee", {
          assignees: [{ login: "alice", avatarUrl: "", rawData: null }],
        }),
        makeFixtureIssue(202, "Three assignees, so the row also carries a +2", {
          assignees: [
            { login: "alice", avatarUrl: "", rawData: null },
            { login: "bob", avatarUrl: "", rawData: null },
            { login: "carol", avatarUrl: "", rawData: null },
          ],
        }),
        makeFixtureIssue(203, "One assignee and a long title that will truncate hard", {
          assignees: [{ login: "dave", avatarUrl: "", rawData: null }],
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
      const window = ctx!.window;
      await connectGitHub(ctx!.app, window);
      await stubRepoStats(ctx!.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);
      // The fake E2E token can't satisfy a real list fetch — without a stub the
      // dropdown falls back to its not-connected surface instead of the chrome.
      await stubListIssues(ctx!.app, [makeFixtureIssue(201, "E2E chrome issue")]);

      await openIssuesDropdown(window);

      // The per-type search input only renders for the connected (token present)
      // dropdown surface — its presence proves we cleared the no-token gate.
      await expect(window.locator(SEL.github.searchIssues)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("issues dropdown shows the paused state under a rate-limit block", async () => {
      const window = ctx!.window;
      await connectGitHub(ctx!.app, window);
      await stubRepoStats(ctx!.app, { issueCount: 0, prCount: 0, commitCount: 5 }, window);
      // Empty list so the rate-limit empty-state (not a data row) is the surface.
      await stubListIssues(ctx!.app, []);

      // Let the dropdown complete its initial (empty) fetch first. `fetchData`
      // skips entirely while a block is active and never flips `loading` off, so
      // blocking before the first fetch would strand the skeleton. Open, let it
      // settle, THEN push the block — exactly the production ordering (a live
      // session gets blocked after it was already showing results).
      await openIssuesDropdown(window);
      await expect(window.locator(SEL.github.searchIssues)).toBeVisible({ timeout: T_MEDIUM });
      // The search field exists while the initial fetch is still loading. Wait
      // for the empty result before blocking requests, so the test exercises a
      // live session becoming paused rather than a cold fetch that never starts.
      await expect(
        window.locator(SEL.github.listIssues).getByRole("status").filter({ hasText: "No issues" })
      ).toBeVisible({ timeout: T_MEDIUM });

      await pushRateLimitBlocked(ctx!.app);

      const pausedStatus = window
        .getByRole("status")
        .filter({ hasText: "GitHub requests are paused" });
      await expect(pausedStatus).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Clearing the block lifts the paused surface — the toolbar resumes.
      await pushRateLimitClear(ctx!.app);
      await expect(pausedStatus).not.toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("PR dropdown renders search chrome when connected", async () => {
      const window = ctx!.window;
      await connectGitHub(ctx!.app, window);
      await stubRepoStats(ctx!.app, { issueCount: 3, prCount: 2, commitCount: 5 }, window);

      const pill = window.locator(SEL.github.statPillPrs);
      await expect(pill).toBeVisible({ timeout: T_MEDIUM });
      // Same token-error propagation wait as openIssuesDropdown.
      await expect(pill).not.toHaveAccessibleName(/Configure/, { timeout: T_MEDIUM });
      await pill.scrollIntoViewIfNeeded();
      await pill.click();

      await expect(window.locator(SEL.github.searchPrs)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("a token-health push alone raises neither a global banner nor the pill callout", async () => {
      const window = ctx!.window;

      // The background probe feeds the inbox, not the UI: only a failed request
      // for this project's stats points the callout at the pill (#12831).
      await pushTokenHealthUnhealthy(ctx!.app);
      // A late banner would still pass an instant absence check, so sample every
      // frame for a window long enough for the broadcast to be consumed.
      const firstSeen = await window.evaluate(
        ({ calloutSelector, dwellMs }) =>
          new Promise<string | null>((resolve) => {
            const start = performance.now();
            const tick = () => {
              if (document.querySelector(calloutSelector)) return resolve("pill callout");
              if (document.body.innerText.includes("GitHub token expired")) {
                return resolve("token-expired banner");
              }
              if (performance.now() - start >= dwellMs) return resolve(null);
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        { calloutSelector: SEL.github.tokenCallout, dwellMs: TOKEN_HEALTH_DWELL_MS }
      );
      expect(firstSeen, "token-health push must not surface UI").toBeNull();
      await expect(window.getByText("GitHub token expired")).toHaveCount(0, { timeout: T_MEDIUM });
      await expect(window.locator(SEL.github.tokenCallout)).toHaveCount(0);

      await pushTokenHealthHealthy(ctx!.app);
    });
  });

  test("a repo with no forge remote shows the commits-only pill", async () => {
    // No origin at all: provider resolution settles to null, the issue/PR
    // segments never render, and the commit count (local git) carries the
    // pill alone. This is also the shape remote-less E2E fixtures get.
    const { dir, cleanup } = createFixtureRepo({ name: "no-forge" });
    noForgeCleanup = cleanup;
    ctx!.window = await addAndSwitchToProject(ctx!.app, ctx!.window, dir, "no-forge");
    const window = ctx!.window;

    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillCommits), /commits/i);
    await expect(window.locator(SEL.github.statPillIssues)).toHaveCount(0);
    await expect(window.locator(SEL.github.statPillPrs)).toHaveCount(0);
  });
});
