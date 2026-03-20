import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { switchWorktree } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { execSync } from "child_process";
import path from "path";
import { existsSync, rmSync } from "fs";

const FEATURE_BRANCH = "feature/test-branch";
const EXTERNAL_BRANCH = "feature/external-added";

let ctx: AppContext;
let fixtureDir: string;
let featureWorktreePath: string;
let externalWorktreePath: string;

test.describe.serial("Core: External Worktree Detection", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "worktree-external", withFeatureBranch: true });

    const worktreesDir = path.join(
      path.dirname(fixtureDir),
      path.basename(fixtureDir) + "-worktrees"
    );
    featureWorktreePath = path.join(worktreesDir, "feature-test-branch");
    externalWorktreePath = path.join(worktreesDir, "feature-external-added");

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Worktree External");
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
  });

  test("initial state shows main and feature worktree cards", async () => {
    const { window } = ctx;

    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_LONG });

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should be selected",
      })
      .toContain("selected");

    const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
    await expect(featureCard).toBeVisible({ timeout: T_LONG });
  });

  test("detects external worktree removal and auto-switches to main", async () => {
    const { window } = ctx;

    // Switch to the feature worktree so it's active
    await switchWorktree(window, FEATURE_BRANCH);

    // Wait for monitor's self-trigger cooldown to expire
    await window.waitForTimeout(2000);

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

    // Main card should become selected (auto-switch)
    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should become selected after active worktree is removed",
      })
      .toContain("selected");
  });

  test("detects external worktree addition after refresh", async () => {
    const { window } = ctx;

    // Wait for monitor's self-trigger cooldown to expire
    await window.waitForTimeout(2000);

    // Add a new worktree externally via git CLI
    execSync(
      `git worktree add -b ${EXTERNAL_BRANCH} ${JSON.stringify(externalWorktreePath)} main`,
      { cwd: fixtureDir, stdio: "ignore" }
    );

    // Trigger refresh so the app discovers the new worktree
    await window.evaluate(() => (window as any).electron.worktree.refresh());

    // New worktree card should appear
    const externalCard = window.locator(SEL.worktree.card(EXTERNAL_BRANCH));
    await expect
      .poll(() => externalCard.count(), {
        timeout: T_LONG,
        message: "Externally added worktree card should appear after refresh",
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

    // Settings button accessible (UI is responsive)
    const settingsBtn = window.locator(SEL.toolbar.openSettings);
    await expect(settingsBtn).toBeVisible({ timeout: T_MEDIUM });
  });
});
