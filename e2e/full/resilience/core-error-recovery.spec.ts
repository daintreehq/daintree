import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createMultiProjectFixture, removePathSync } from "../../helpers/fixtures";
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

// One launch covers every scenario: terminal exits and the deleted worktree
// run in project A, then project B is added and deleted while inactive.
test.describe.serial("Core: Error Recovery", () => {
  let ctx: AppContext;
  let fixture: ReturnType<typeof createMultiProjectFixture>;

  test.beforeAll(async () => {
    fixture = createMultiProjectFixture({ withFeatureBranch: true });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.repoA, "project-A");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
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

    const countBefore = await getGridPanelCount(window);

    const panel = await spawnTerminalAndVerify(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(countBefore + 1);

    await runTerminalCommand(window, panel, "exit 0");

    // Exit code 0 auto-trashes non-agent terminals — panel disappears from grid
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore);
  });

  test("detects externally deleted worktree", async () => {
    const { window } = ctx;

    const card = window.locator(SEL.worktree.card("feature/test-branch"));
    await expect(card).toBeVisible({ timeout: T_LONG });

    // Compute the worktree directory path (same formula as createFixtureRepo)
    const worktreeDir = path.join(
      fixture.repoA,
      "..",
      path.basename(fixture.repoA) + "-worktrees",
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

  test("shows missing status for deleted project directory", async () => {
    // B is added only now, then A re-selected: checkMissingProjects skips the
    // active project, so B must be the inactive one when its directory goes.
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixture.repoB, "project-B");
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, "project-A");
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
