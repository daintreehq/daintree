/**
 * Core: Review Hub Staging Edge Cases
 *
 * Tests selective staging, unstaging, bulk operations, empty commit
 * message validation, and post-commit worktree card clean state.
 *
 * Uses a fixture repo with 3 uncommitted files for multi-file scenarios.
 * Tests are serial — each builds on the state left by the previous test.
 */

import { writeFileSync } from "fs";
import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

test.describe.serial("Core: Review Hub Staging Edge Cases", () => {
  let ctx: AppContext;
  let fixtureDir: string;

  test.describe.serial("Selective staging and unstaging", () => {
    test.beforeAll(async () => {
      fixtureDir = createFixtureRepo({
        name: "review-hub-staging",
        withUncommittedChanges: true,
      });
      writeFileSync(path.join(fixtureDir, "extra-a.txt"), "Extra file A\n");
      writeFileSync(path.join(fixtureDir, "extra-b.txt"), "Extra file B\n");

      ctx = await launchApp();
      await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Staging Test");

      // Open Review Hub
      const reviewBtn = ctx.window.locator(SEL.worktree.reviewHubButton);
      await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
      await reviewBtn.first().click();
      await expect(ctx.window.locator(SEL.reviewHub.container)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
    });

    test("shows 3 files in Changes section", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // All 3 files should have stage buttons
      await expect(hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-a.txt"))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-b.txt"))).toBeVisible({
        timeout: T_SHORT,
      });

      // No staged files placeholder visible
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({ timeout: T_SHORT });

      // Stage all button visible
      await expect(hub.locator(SEL.reviewHub.stageAllButton)).toBeVisible({ timeout: T_SHORT });
    });

    test("selective staging moves one file to Staged", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Stage extra-a.txt
      await hub.locator(SEL.reviewHub.stageButton("extra-a.txt")).click();

      // Unstage button appears (file is now staged)
      await expect(hub.locator(SEL.reviewHub.unstageButton("extra-a.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Other 2 files still in Changes
      await expect(hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-b.txt"))).toBeVisible({
        timeout: T_SHORT,
      });

      // No staged files placeholder should be gone
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeHidden({ timeout: T_SHORT });

      // Commit button shows count 1
      await expect(hub.locator(SEL.reviewHub.commitButton(1))).toBeVisible({ timeout: T_SHORT });
    });

    test("staging a second file updates counts", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Stage extra-b.txt
      await hub.locator(SEL.reviewHub.stageButton("extra-b.txt")).click();

      await expect(hub.locator(SEL.reviewHub.unstageButton("extra-b.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      // 2 staged, 1 in changes
      await expect(hub.locator(SEL.reviewHub.unstageButton("extra-a.txt"))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_SHORT,
      });

      // Both bulk buttons visible
      await expect(hub.locator(SEL.reviewHub.stageAllButton)).toBeVisible({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.unstageAllButton)).toBeVisible({ timeout: T_SHORT });

      // Commit count 2
      await expect(hub.locator(SEL.reviewHub.commitButton(2))).toBeVisible({ timeout: T_SHORT });
    });

    test("unstaging moves file back to Changes", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Unstage extra-a.txt
      await hub.locator(SEL.reviewHub.unstageButton("extra-a.txt")).click();

      // Stage button returns (file back in Changes)
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-a.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Commit count back to 1
      await expect(hub.locator(SEL.reviewHub.commitButton(1))).toBeVisible({ timeout: T_SHORT });
    });

    test("Stage all moves remaining files to Staged", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.stageAllButton).click();

      // All 3 files should have unstage buttons
      await expect(hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.unstageButton("extra-a.txt"))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(hub.locator(SEL.reviewHub.unstageButton("extra-b.txt"))).toBeVisible({
        timeout: T_SHORT,
      });

      // No unstaged changes placeholder visible
      await expect(hub.locator(SEL.reviewHub.noUnstagedChanges)).toBeVisible({ timeout: T_SHORT });

      // Stage all button should be gone
      await expect(hub.locator(SEL.reviewHub.stageAllButton)).toBeHidden({ timeout: T_SHORT });

      // Commit count 3
      await expect(hub.locator(SEL.reviewHub.commitButton(3))).toBeVisible({ timeout: T_SHORT });
    });

    test("Unstage all moves all files back to Changes", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.unstageAllButton).click();

      // All 3 files should have stage buttons
      await expect(hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-a.txt"))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(hub.locator(SEL.reviewHub.stageButton("extra-b.txt"))).toBeVisible({
        timeout: T_SHORT,
      });

      // No staged files placeholder visible
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({ timeout: T_SHORT });

      // Unstage all button should be gone
      await expect(hub.locator(SEL.reviewHub.unstageAllButton)).toBeHidden({ timeout: T_SHORT });
    });
  });

  test.describe.serial("Commit validation and post-commit state", () => {
    test.beforeAll(async () => {
      fixtureDir = createFixtureRepo({
        name: "review-hub-commit",
        withUncommittedChanges: true,
      });
      writeFileSync(path.join(fixtureDir, "extra-a.txt"), "Extra file A\n");
      writeFileSync(path.join(fixtureDir, "extra-b.txt"), "Extra file B\n");

      ctx = await launchApp();
      await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Commit Test");

      // Open Review Hub
      const reviewBtn = ctx.window.locator(SEL.worktree.reviewHubButton);
      await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
      await reviewBtn.first().click();
      await expect(ctx.window.locator(SEL.reviewHub.container)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
    });

    test("commit button disabled with empty message", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Stage all files
      await hub.locator(SEL.reviewHub.stageAllButton).click();
      await expect(hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Commit button visible but disabled (no message)
      const commitBtn = hub.locator(SEL.reviewHub.commitButton(3));
      await expect(commitBtn).toBeVisible({ timeout: T_SHORT });
      await expect(commitBtn).toBeDisabled({ timeout: T_SHORT });

      // Whitespace-only message still keeps it disabled
      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.fill("   ");
      await expect(commitBtn).toBeDisabled({ timeout: T_SHORT });
    });

    test("commit button enabled with valid message", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.fill("test: staging edge cases");

      const commitBtn = hub.locator(SEL.reviewHub.commitButton(3));
      await expect(commitBtn).toBeEnabled({ timeout: T_SHORT });
    });

    test("commit succeeds and shows clean state", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const commitBtn = hub.locator(SEL.reviewHub.commitButton(3));
      await commitBtn.click();

      // Commit button disappears after commit
      await expect(commitBtn).toBeHidden({ timeout: T_LONG });

      // Clean state message appears
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });

      // Commit textarea hidden
      await expect(hub.locator(SEL.reviewHub.commitMessageInput)).toBeHidden({
        timeout: T_SHORT,
      });
    });

    test("worktree card no longer shows uncommitted changes", async () => {
      const { window } = ctx;

      // Close the Review Hub
      await window.locator(SEL.reviewHub.close).click();
      await expect(window.locator(SEL.reviewHub.container)).not.toBeVisible({
        timeout: T_SHORT,
      });

      // Worktree card aria-label should no longer contain "has uncommitted changes"
      const mainCard = window.locator(SEL.worktree.mainCard);
      await expect
        .poll(() => mainCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Main card should no longer indicate uncommitted changes",
        })
        .not.toContain("has uncommitted changes");
    });
  });
});
