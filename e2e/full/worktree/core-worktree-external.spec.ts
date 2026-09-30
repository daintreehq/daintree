import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openSettings } from "../../helpers/panels";
import { switchWorktree } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { execSync } from "child_process";
import path from "path";
import { existsSync, writeFileSync } from "fs";

const FEATURE_BRANCH = "feature/test-branch";
const EXTERNAL_BRANCH = "feature/external-added";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let featureWorktreePath: string;
let externalWorktreePath: string;

/**
 * Git activity performed outside the app — file edits, commits, and
 * `git worktree add/remove` — must reach the sidebar through the workspace
 * host's watchers alone. Nothing here asks the app to refresh.
 */
test.describe.serial("Core: External Git and Worktree Detection", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "worktree-external",
      withFeatureBranch: true,
    }));

    const worktreesDir = path.join(
      path.dirname(fixtureDir),
      path.basename(fixtureDir) + "-worktrees"
    );
    featureWorktreePath = path.join(worktreesDir, "feature-test-branch");
    externalWorktreePath = path.join(worktreesDir, "feature-external-added");

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Worktree External");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);

    // Best-effort cleanup of any leftover worktrees
    try {
      if (existsSync(externalWorktreePath)) {
        execSync("git worktree remove --force " + JSON.stringify(externalWorktreePath), {
          cwd: fixtureDir,
          stdio: "ignore",
        });
      }
      execSync("git worktree prune", { cwd: fixtureDir, stdio: "ignore" });
    } catch {
      // ignore cleanup errors
    }

    fixtureCleanup?.();
  });

  test("initial state shows main and feature worktree cards", async () => {
    const { window } = ctx;

    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_LONG });

    await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
      timeout: T_LONG,
    });

    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect(featureCard).toBeVisible({ timeout: T_LONG });
  });

  test("initial state shows clean main worktree with initial commit", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    await expect(mainCard).toBeVisible({ timeout: T_LONG });
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should not have uncommitted changes",
      })
      .not.toContain("has uncommitted changes");

    await expect(mainCard).toContainText("initial commit", { timeout: T_LONG });
  });

  test("detects external file creation as uncommitted changes", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    writeFileSync(path.join(fixtureDir, "external-change.txt"), "hello\n");

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should detect uncommitted changes from external file",
      })
      .toContain("has uncommitted changes");
  });

  test("detects external commit and updates last commit message", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    execSync('git add -A && git commit -m "external-commit"', {
      cwd: fixtureDir,
      stdio: "ignore",
    });

    await expect(mainCard).toContainText("external-commit", { timeout: T_LONG });

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Card should be clean after committing all changes",
      })
      .not.toContain("has uncommitted changes");
  });

  test("detects external worktree removal and auto-switches to main", async () => {
    const { window } = ctx;

    // Switch to the feature worktree so it's active
    await switchWorktree(window, FEATURE_BRANCH);

    // Remove the worktree externally via git CLI
    execSync("git worktree remove --force " + JSON.stringify(featureWorktreePath), {
      cwd: fixtureDir,
      stdio: "ignore",
    });

    // Feature card should disappear
    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect
      .poll(() => featureCard.count(), {
        timeout: T_LONG,
        message: "Feature worktree card should disappear after external removal",
      })
      .toBe(0);

    // Main row should become current (auto-switch)
    await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
      timeout: T_LONG,
    });
  });

  test("detects external worktree addition without a manual refresh", async () => {
    const { window } = ctx;

    // Add a new worktree externally via git CLI
    execSync(
      `git worktree add -b ${EXTERNAL_BRANCH} ${JSON.stringify(externalWorktreePath)} main`,
      { cwd: fixtureDir, stdio: "ignore" }
    );

    // No refresh: TopologyWatcher sees `.git/worktrees/` change on its own.
    // New worktree card should appear
    const externalCard = window.locator(SEL.worktree.card(EXTERNAL_BRANCH));
    await expect
      .poll(() => externalCard.count(), {
        timeout: T_LONG,
        message: "Externally added worktree card should appear via the topology watcher",
      })
      .toBe(1);
  });

  test("app remains stable after external worktree operations", async () => {
    const { window } = ctx;

    // No crash recovery dialog
    const crashDialog = window.locator(SEL.crashRecovery.dialog);
    await expect(crashDialog).toHaveCount(0);

    // Main card still visible and functional
    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });

    // Settings are accessible (UI is responsive), even when the toolbar
    // moves the button into overflow on narrower Linux runners.
    await openSettings(window, T_MEDIUM);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  });
});
