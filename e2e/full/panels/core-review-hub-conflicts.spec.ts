/**
 * Core: Review Hub Conflict Resolution
 *
 * Covers the Review Hub's ConflictPanel against repos left mid-operation, and
 * checks the git state on disk after every step that changes it:
 *  - merge conflict over three files: one resolved via "Use incoming changes"
 *    (theirs), one via "Use current branch" (ours), one hand-edited and then
 *    "Mark resolved"; Continue stays gated until the last file, and clicking
 *    it concludes the merge (MERGE_HEAD gone, a two-parent merge commit, a
 *    clean tree, and each file holding the content chosen for it),
 *  - merge conflict: abort (cancel keeps the conflict, confirm discards it and
 *    restores the pre-merge HEAD),
 *  - rebase conflict: progress chip + sequence rail, resolve, then abort back
 *    to the original branch tip with no rebase state left behind.
 *
 * One app hosts every fixture, each opened as its own project. All conflicts
 * are deterministic (two branches edit the same line).
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createConflictFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

async function openConflictReviewHub(ctx: AppContext) {
  const { window } = ctx;

  // The card's inline "Open Review & Commit" button is gated on hasChanges,
  // which is 0 while a merge/rebase is in progress: WorktreeMonitor skips the
  // git status poll during an operation to avoid competing for index.lock
  // (WorktreeMonitor.ts:1421). The actions-menu Review ▸ "Review worktree" item
  // is only gated on the handler being wired, so it's the reliable entry point.
  const card = window.locator(SEL.worktree.mainCard);
  await expect(card).toBeVisible({ timeout: T_LONG });
  await card.locator(SEL.worktree.actionsMenu).click();

  const reviewTrigger = window.getByRole("menuitem", { name: "Review", exact: true });
  await expect(reviewTrigger).toBeVisible({ timeout: T_MEDIUM });
  // Radix SubTriggers open on hover, but a hover dropped by Linux CI never
  // mounts the child — click is the reliable fallback the rest of the suite
  // uses too.
  await reviewTrigger.hover();
  const reviewItem = window.getByRole("menuitem", { name: "Review worktree", exact: true });
  if (!(await reviewItem.isVisible().catch(() => false))) {
    await reviewTrigger.click();
  }
  await expect(reviewItem).toBeVisible({ timeout: T_MEDIUM });
  // Radix can remount the hovered submenu during the pointer-stability check.
  // Keyboard activation uses the same menu action without depending on its geometry.
  await reviewItem.press("Enter");

  const hub = window.locator(SEL.reviewHub.container);
  await expect(hub).toBeVisible({ timeout: T_MEDIUM });
  await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_LONG });
  return hub;
}

async function openSideAction(ctx: AppContext, file: string, source: string, side: string) {
  const { window } = ctx;
  await window
    .locator(SEL.reviewHub.container)
    .locator(SEL.reviewHub.conflictMoreActions(file))
    .click();
  return window.getByRole("menuitem", {
    name: `Use ${source} for ${file} (${side})`,
    exact: true,
  });
}

function openTheirsAction(ctx: AppContext, source: "incoming changes" | "incoming commit") {
  return openSideAction(ctx, "conflict.txt", source, "theirs");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Mid-operation state markers live in the fixture's own .git directory.
function gitStateMarkers(dir: string) {
  const gitDir = path.join(dir, ".git");
  return {
    mergeHead: existsSync(path.join(gitDir, "MERGE_HEAD")),
    rebaseMerge: existsSync(path.join(gitDir, "rebase-merge")),
    rebaseApply: existsSync(path.join(gitDir, "rebase-apply")),
  };
}

// Compared after LF normalisation so a checkout under core.autocrlf=true
// (a Windows runner's global config) still matches the chosen side.
function readWorkingFile(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
}

const THEIRS_CONTENT = "line one\nfeature edit\nline three\n";
const OURS_CONTENT = "line one\nmain edit\nline three\n";
const HAND_MERGED_CONTENT = "line one\nmain edit + feature edit, merged by hand\nline three\n";

// The first group onboards from the welcome screen; later groups add their
// fixture as another project. A group that runs on a relaunched worker (after a
// failure elsewhere) finds no project and onboards instead. The previous
// group's hub is a modal over the toolbar, so close it before switching.
async function openFixtureProject(ctx: AppContext, dir: string, name: string) {
  const hasProject = await ctx.window.evaluate(
    async () => (await globalThis.window.electron.project.getCurrent()) != null
  );
  if (!hasProject) return openAndOnboardProject(ctx.app, ctx.window, dir, name);
  const hub = ctx.window.locator(SEL.reviewHub.container);
  if (await hub.isVisible()) {
    await ctx.window.locator(SEL.reviewHub.close).click();
    await expect(hub).toBeHidden({ timeout: T_SHORT });
  }
  return addAndSwitchToProject(ctx.app, ctx.window, dir, name);
}

let ctx: AppContext;
const fixtureCleanups: Array<() => void> = [];

test.describe("Core: Review Hub Conflict Resolution", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  });

  test.describe.serial("Merge conflict — resolution and continue", () => {
    let dir: string;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge", "review-hub-conflict", {
        conflictFiles: ["conflict.txt", "kept.txt", "hand-merged.txt"],
      });
      fixtureCleanups.push(fixture.cleanup);
      dir = fixture.dir;
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Merge Conflict");
    });

    test("conflict panel lists every conflicted file", async () => {
      const hub = await openConflictReviewHub(ctx);
      for (const file of ["conflict.txt", "kept.txt", "hand-merged.txt"]) {
        await expect(hub.locator(SEL.reviewHub.conflictMoreActions(file))).toBeVisible({
          timeout: T_MEDIUM,
        });
      }
      await expect(await openTheirsAction(ctx, "incoming changes")).toBeVisible();
      await ctx.window.keyboard.press("Escape");
      // Continue is gated until every conflict is resolved.
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled({ timeout: T_SHORT });
    });

    test("Take theirs resolves one file while Continue stays gated", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await (await openTheirsAction(ctx, "incoming changes")).click();
      const checkoutDialog = window
        .getByRole("alertdialog")
        .filter({ hasText: "Use incoming changes" });
      await expect(checkoutDialog).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictMoreActions("conflict.txt"))).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect
        .poll(() => readWorkingFile(dir, "conflict.txt"), { timeout: T_MEDIUM })
        .toBe(THEIRS_CONTENT);
      await expect
        .poll(() => git(dir, "diff", "--name-only", "--diff-filter=U"), { timeout: T_MEDIUM })
        .toBe("hand-merged.txt\nkept.txt");
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled();
    });

    test("Take ours resolves a second file", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await (await openSideAction(ctx, "kept.txt", "current branch", "ours")).click();
      await expect(
        window.getByRole("alertdialog").filter({ hasText: "Use current branch" })
      ).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictMoreActions("kept.txt"))).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect
        .poll(() => readWorkingFile(dir, "kept.txt"), { timeout: T_MEDIUM })
        .toBe(OURS_CONTENT);
      await expect
        .poll(() => git(dir, "diff", "--name-only", "--diff-filter=U"), { timeout: T_MEDIUM })
        .toBe("hand-merged.txt");
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled();
    });

    test("Mark resolved stages a hand-edited file and enables Continue", async () => {
      const hub = ctx.window.locator(SEL.reviewHub.container);

      // Stands in for the user fixing the file in their editor: the marker
      // scan finds nothing left, so Mark resolved stages it without a prompt.
      writeFileSync(path.join(dir, "hand-merged.txt"), HAND_MERGED_CONTENT);
      await hub.locator(SEL.reviewHub.conflictMarkResolved("hand-merged.txt")).click();

      await expect(hub.locator(SEL.reviewHub.conflictMoreActions("hand-merged.txt"))).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect
        .poll(() => git(dir, "diff", "--name-only", "--diff-filter=U"), { timeout: T_MEDIUM })
        .toBe("");
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeEnabled({ timeout: T_MEDIUM });
    });

    test("Continue concludes the merge on disk", async () => {
      const hub = ctx.window.locator(SEL.reviewHub.container);
      const mainTip = git(dir, "rev-parse", "HEAD");
      const featureTip = git(dir, "rev-parse", "feature");

      await hub.locator(SEL.reviewHub.conflictContinue).click();

      // The editor is suppressed by the continue env overlay, so this settles
      // rather than hanging on a commit-message handshake.
      await expect
        .poll(() => gitStateMarkers(dir).mergeHead, {
          timeout: T_LONG,
          message: ".git/MERGE_HEAD should be gone once the merge is continued",
        })
        .toBe(false);
      await expect
        .poll(() => git(dir, "rev-list", "--parents", "-n1", "HEAD").split(" ").slice(1), {
          timeout: T_MEDIUM,
          message: "HEAD should be a merge commit of main and feature",
        })
        .toEqual([mainTip, featureTip]);
      await expect.poll(() => git(dir, "status", "--porcelain"), { timeout: T_MEDIUM }).toBe("");
      expect(git(dir, "log", "-1", "--format=%s")).toBe("Merge branch 'feature'");

      expect(readWorkingFile(dir, "conflict.txt")).toBe(THEIRS_CONTENT);
      expect(readWorkingFile(dir, "kept.txt")).toBe(OURS_CONTENT);
      expect(readWorkingFile(dir, "hand-merged.txt")).toBe(HAND_MERGED_CONTENT);
      expect(git(dir, "show", "HEAD:hand-merged.txt")).toBe(HAND_MERGED_CONTENT.trimEnd());

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Merge conflict — abort", () => {
    let dir: string;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanups.push(fixture.cleanup);
      dir = fixture.dir;
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Merge Conflict Abort");
      await openConflictReviewHub(ctx);
    });

    test("cancelling the abort dialog keeps the conflict", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      const abortDialog = window.getByRole("alertdialog").filter({ hasText: "Abort" });
      await expect(abortDialog).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(abortDialog).toBeHidden({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_SHORT });
      expect(gitStateMarkers(dir).mergeHead).toBe(true);
    });

    test("confirming the abort discards the merge", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);
      const preMergeHead = git(dir, "rev-parse", "HEAD");

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Abort" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });

      await expect.poll(() => gitStateMarkers(dir).mergeHead, { timeout: T_MEDIUM }).toBe(false);
      await expect.poll(() => git(dir, "status", "--porcelain"), { timeout: T_MEDIUM }).toBe("");
      expect(git(dir, "rev-parse", "HEAD")).toBe(preMergeHead);
    });
  });

  test.describe.serial("Rebase conflict — progress, resolution, abort", () => {
    let dir: string;
    // A rebase only moves the branch ref when it finishes, so mid-rebase
    // `feature` still names the tip HEAD sat on before the rebase started.
    let preRebaseHead: string;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("rebase");
      fixtureCleanups.push(fixture.cleanup);
      dir = fixture.dir;
      preRebaseHead = git(dir, "rev-parse", "refs/heads/feature");
      expect(git(dir, "rev-parse", "HEAD")).not.toBe(preRebaseHead);
      expect(gitStateMarkers(dir).rebaseMerge || gitStateMarkers(dir).rebaseApply).toBe(true);
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Rebase Conflict");
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

    test("Take theirs resolves the file and enables Continue", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await (await openTheirsAction(ctx, "incoming commit")).click();
      await expect(
        window.getByRole("alertdialog").filter({ hasText: "Use incoming commit" })
      ).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeEnabled({ timeout: T_MEDIUM });
      await expect
        .poll(() => git(dir, "diff", "--name-only", "--diff-filter=U"), { timeout: T_MEDIUM })
        .toBe("");
      // Mid-rebase, "theirs" is the commit being replayed: feature's edit.
      expect(git(dir, "show", ":conflict.txt")).toBe(THEIRS_CONTENT.trimEnd());
    });

    test("aborting discards the rebase", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Abort" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });

      await expect
        .poll(() => gitStateMarkers(dir), {
          timeout: T_MEDIUM,
          message: "no rebase state should survive the abort",
        })
        .toEqual({ mergeHead: false, rebaseMerge: false, rebaseApply: false });
      expect(git(dir, "rev-parse", "HEAD")).toBe(preRebaseHead);
      expect(git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
      await expect.poll(() => git(dir, "status", "--porcelain"), { timeout: T_MEDIUM }).toBe("");
    });
  });
});
