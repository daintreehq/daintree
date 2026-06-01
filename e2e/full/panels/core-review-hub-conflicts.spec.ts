/**
 * Core: Review Hub Conflict Resolution
 *
 * Covers the Review Hub's ConflictPanel against repos left mid-operation:
 *  - merge conflict: resolve a file via "Take theirs" then continue,
 *  - merge conflict: abort (cancel keeps the conflict, confirm discards it),
 *  - rebase conflict: progress chip + sequence rail, resolve then continue.
 *
 * Each describe block owns a fresh fixture so the in-progress git state is
 * isolated. All conflicts are deterministic (two branches edit the same line).
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createConflictFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

async function openConflictReviewHub(ctx: AppContext) {
  const reviewBtn = ctx.window.locator(SEL.worktree.reviewHubButton);
  await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
  await reviewBtn.first().click();

  const hub = ctx.window.locator(SEL.reviewHub.container);
  await expect(hub).toBeVisible({ timeout: T_MEDIUM });
  await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_MEDIUM });
  return hub;
}

test.describe.serial("Core: Review Hub Conflict Resolution", () => {
  test.describe.serial("Merge conflict — resolve and continue", () => {
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Merge Conflict");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
    });

    test("conflict panel lists the conflicted file", async () => {
      const hub = await openConflictReviewHub(ctx);
      await expect(hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("resolving via Take theirs then Continue finishes the merge", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Continue is gated until every conflict is resolved.
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled({ timeout: T_SHORT });

      await hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt")).click();
      const checkoutDialog = window.getByRole("alertdialog").filter({ hasText: "Take theirs" });
      await expect(checkoutDialog).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      const continueBtn = hub.locator(SEL.reviewHub.conflictContinue);
      await expect(continueBtn).toBeEnabled({ timeout: T_MEDIUM });
      await continueBtn.click();

      // The merge completes — the conflict panel unmounts and the tree is clean.
      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Merge conflict — abort", () => {
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Merge Abort");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
    });

    test("cancelling the abort dialog keeps the conflict", async () => {
      const hub = await openConflictReviewHub(ctx);
      const { window } = ctx;

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      const abortDialog = window.getByRole("alertdialog").filter({ hasText: "Abort" });
      await expect(abortDialog).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(abortDialog).toBeHidden({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_SHORT });
    });

    test("confirming the abort discards the merge", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Abort" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
    });
  });

  test.describe.serial("Rebase conflict — progress and continue", () => {
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("rebase");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Rebase Conflict");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
    });

    test("rebase conflict shows progress chip and sequence rail", async () => {
      const hub = await openConflictReviewHub(ctx);
      await expect(hub.locator(SEL.reviewHub.conflictRebaseProgress)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.conflictRebaseSequence)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("resolving then continuing finishes the rebase", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt")).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Take theirs" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      const continueBtn = hub.locator(SEL.reviewHub.conflictContinue);
      await expect(continueBtn).toBeEnabled({ timeout: T_MEDIUM });
      await continueBtn.click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
    });
  });
});
