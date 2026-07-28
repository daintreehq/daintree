import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import {
  createFixtureRepo,
  createMultiProjectFixture,
  removePathSync,
} from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { runTerminalCommand } from "../../helpers/terminal";
import { getGridPanelCount } from "../../helpers/panels";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import path from "path";

/* ------------------------------------------------------------------ */
/*  Terminal Exit Indicators                                          */
/* ------------------------------------------------------------------ */

test.describe.serial("Core: Error Recovery — Terminal Exit", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "error-recovery-exit" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Error Recovery Exit"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("terminal shows exit indicator and banner after exit 1", async () => {
    const { window } = ctx;

    // Spawn terminal without verifying prompt content — the user's shell PS1
    // may not echo the working directory name on cold start, which the older
    // assertion relied on.
    const panel = await spawnTerminalAndVerify(window);

    await runTerminalCommand(window, panel, "exit 1");

    // The [exit 1] badge appears in the panel header via role="status"
    const exitBadge = panel.getByRole("status").filter({ hasText: "[exit 1]" });
    await expect(exitBadge).toBeVisible({ timeout: T_LONG });

    // The restart banner shows "Session exited with code 1" via role="alert"
    const banner = panel.getByRole("alert");
    await expect(banner).toContainText("Session exited with code 1", { timeout: T_MEDIUM });
  });

  test("terminal exit 0 auto-trashes panel", async () => {
    const { window } = ctx;

    // Settle: the prior test left an exited terminal with focus and an active
    // restart banner. Without a brief pause, a freshly-spawned panel can drop
    // typed input — the residual focus/state bleed steals our keystrokes.
    await window.waitForTimeout(1500);

    const countBefore = await getGridPanelCount(window);

    const panel = await spawnTerminalAndVerify(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(countBefore + 1);

    await runTerminalCommand(window, panel, "exit 0");

    // Exit code 0 auto-trashes non-agent terminals — panel disappears from grid
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore);
  });
});

/* ------------------------------------------------------------------ */
/*  Missing Worktree Detection                                        */
/* ------------------------------------------------------------------ */

test.describe.serial("Core: Error Recovery — Missing Worktree", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "error-recovery-wt",
      withFeatureBranch: true,
    });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Error Recovery WT");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("detects externally deleted worktree", async () => {
    const { window } = ctx;

    const card = window.locator(SEL.worktree.card("feature/test-branch"));
    await expect(card).toBeVisible({ timeout: T_LONG });

    // Compute the worktree directory path (same formula as createFixtureRepo)
    const worktreeDir = path.join(
      fixtureDir,
      "..",
      path.basename(fixtureDir) + "-worktrees",
      "feature-test-branch"
    );
    removePathSync(worktreeDir);

    // After commit dfb7f1df2 the watcher-driven cadence relaxed the recursive
    // fallback poll to 5min — and macOS `fs.watch` doesn't reliably fire on
    // its own watch-target removal, so auto-detection can take minutes. Drive
    // detection deterministically by calling worktree.refresh(), which runs
    // `git worktree prune` inside discoverAndSyncWorktrees and clears the
    // phantom monitor. This mirrors core-worktree-external.spec.ts, which
    // refreshes after external git mutations for the same reason.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await window.evaluate(() => (window as any).electron.worktree.refresh());
    await expect(card).not.toBeVisible({ timeout: T_LONG });
  });
});

/* ------------------------------------------------------------------ */
/*  Missing Project Detection                                         */
/* ------------------------------------------------------------------ */

test.describe.serial("Core: Error Recovery — Missing Project", () => {
  let ctx: AppContext;
  let fixture: ReturnType<typeof createMultiProjectFixture>;

  test.beforeAll(async () => {
    fixture = createMultiProjectFixture();
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.repoA, "project-A");
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixture.repoB, "project-B");
    // Switch back to A so B is inactive (checkMissingProjects skips the active project)
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, "project-A");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("shows missing status for deleted project directory", async () => {
    const { window } = ctx;

    // Delete the inactive project B directory
    removePathSync(fixture.repoB);

    // Open project switcher — this triggers loadProjects → checkMissingProjects
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // The missing project shows "Directory not found" text
    await expect(palette.getByText("Directory not found")).toBeVisible({ timeout: T_LONG });

    const missingProjectRow = palette
      .getByRole("option")
      .filter({ hasText: "Directory not found" });
    await expect(missingProjectRow).not.toHaveAttribute("aria-disabled", "true");

    // Close palette
    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });
  });
});
