/**
 * Core: Review Hub Workflow
 *
 * One app, three fixtures, each opened as its own project and each driven as
 * a serial journey (every step builds on the state the previous one left):
 *
 * - Commit lifecycle on a single untracked file: status badge, staging,
 *   commit gating and the post-commit clean state, the diff-mode toggle
 *   (base-branch view disabled on a main-only repo), and closing the hub.
 * - Staging edge cases on three changed files: selective stage/unstage and
 *   the primary button's count, Stage all / Unstage all, empty-message
 *   validation, committing, and the worktree card dropping its
 *   "uncommitted changes" label.
 * - Git confirm dialogs against a local-only fixture whose `file://` origin
 *   has diverged: the per-file diff modal, the empty-message guard on
 *   "Commit & Push" (#7880), commit-message history, the push confirm
 *   preview, the push-rejection banner, and its pull-rebase / force-push
 *   dialogs. No real network.
 */

import { writeFileSync } from "fs";
import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createDivergedRemoteFixture, createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

let ctx: AppContext;
const fixtureCleanups: Array<() => void> = [];

// Git read/preview channels are rate limited per channel app-wide (10 per
// 10 s), so a group's hub traffic must not eat into the next group's budget.
async function resetRateLimits() {
  await ctx.app.evaluate(() => {
    const reset = (globalThis as Record<string, unknown>).__daintreeResetRateLimits;
    if (typeof reset !== "function") {
      throw new Error("Rate limit reset unavailable — launch with DAINTREE_E2E_FAULT_MODE=1");
    }
    (reset as () => void)();
  });
}

// The first group onboards from the welcome screen; later groups add their
// fixture as another project. A group that runs on a relaunched worker (after a
// failure elsewhere) finds no project and onboards instead. The previous
// group's hub is a modal over the toolbar, so close it before switching.
async function openFixtureProject(dir: string, name: string) {
  await resetRateLimits();
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

async function openReviewHubFromCard() {
  const reviewBtn = ctx.window.locator(SEL.worktree.reviewHubButton);
  await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
  await reviewBtn.first().click();
  const hub = ctx.window.locator(SEL.reviewHub.container);
  await expect(hub).toBeVisible({ timeout: T_MEDIUM });

  // The file list is expanded on open, but gate on the toggle rather than
  // assume it, so per-file selectors are mountable either way.
  const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
  await expect(fileListToggle).toBeVisible({ timeout: T_MEDIUM });
  if ((await fileListToggle.getAttribute("aria-expanded")) !== "true") {
    await fileListToggle.click();
  }
  return hub;
}

test.describe("Core: Review Hub Workflow", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  });

  test.describe.serial("Commit lifecycle", () => {
    test.beforeAll(async () => {
      const fixture = createFixtureRepo({
        name: "review-hub-workflow",
        withUncommittedChanges: true,
      });
      fixtureCleanups.push(fixture.cleanup);
      ctx.window = await openFixtureProject(fixture.dir, "Review Hub Test");
    });

    test("worktree card Review & Commit button opens the hub overlay", async () => {
      const { window } = ctx;

      const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
      await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
      await reviewBtn.first().click();

      const hub = window.locator(SEL.reviewHub.container);
      await expect(hub).toBeVisible({ timeout: T_MEDIUM });

      // PR #7890 auto-stages everything when the hub is launched from a worktree
      // card. The file list is expanded on open, but gate on the toggle rather
      // than assume it, so the Changes-section assertions in subsequent tests can
      // locate file rows; then unstage so they start from the unstaged baseline.
      const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
      await expect(fileListToggle).toBeVisible({ timeout: T_MEDIUM });
      if ((await fileListToggle.getAttribute("aria-expanded")) !== "true") {
        await fileListToggle.click();
      }
      await expect(hub.locator(SEL.reviewHub.unstageAllButton)).toBeVisible({ timeout: T_MEDIUM });
      await hub.locator(SEL.reviewHub.unstageAllButton).click();
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("file list shows uncommitted.txt in Changes section", async () => {
      const { window } = ctx;

      const hub = window.locator(SEL.reviewHub.container);

      // Wait for the IPC-loaded file list — stage button proves it loaded, and a
      // "Stage" affordance (vs "Unstage") proves the row is in the unstaged
      // Changes section, not Staged.
      const stageBtn = hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"));
      await expect(stageBtn).toBeVisible({ timeout: T_MEDIUM });
      await expect(hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"))).toBeHidden();

      // "Changes" section header should be visible.
      await expect(hub.locator("text=Changes")).toBeVisible({ timeout: T_SHORT });

      // The row carries the untracked status badge ("?") and the file name.
      const fileRow = hub.locator('[data-testid="file-stage-row-uncommitted.txt"]');
      await expect(fileRow).toContainText("uncommitted.txt", { timeout: T_SHORT });
      await expect(fileRow).toContainText("?", { timeout: T_SHORT });
    });

    test("staging a file moves it to the Staged section", async () => {
      const { window } = ctx;

      const hub = window.locator(SEL.reviewHub.container);

      // Click the stage button for uncommitted.txt
      const stageBtn = hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"));
      await stageBtn.click();

      // Wait for the file to move: unstage button appears (proves it's now staged)
      const unstageBtn = hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"));
      await expect(unstageBtn).toBeVisible({ timeout: T_MEDIUM });

      // Stage button should be gone
      await expect(stageBtn).toBeHidden({ timeout: T_MEDIUM });

      // Unstaged section should show empty placeholder
      await expect(hub.locator(SEL.reviewHub.noUnstagedChanges)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("commit message input appears and commit button becomes actionable", async () => {
      const { window } = ctx;

      const hub = window.locator(SEL.reviewHub.container);

      // CommitPanel renders when totalChanges > 0 in working-tree mode
      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await expect(textarea).toBeVisible({ timeout: T_MEDIUM });
      await textarea.fill("");
      await expect(textarea).toHaveValue("", { timeout: T_SHORT });

      // Blocked buttons stay focusable so their tooltip can explain what is missing.
      const commitBtn = hub.locator(SEL.reviewHub.commitButton(1));
      await expect(commitBtn).toBeVisible({ timeout: T_SHORT });
      await expect(commitBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_MEDIUM });

      // Type a commit message
      await textarea.fill("test: add uncommitted file");

      await expect(commitBtn).not.toHaveAttribute("aria-disabled", "true", { timeout: T_MEDIUM });
    });

    test("committing clears file list and shows clean state", async () => {
      const { window } = ctx;

      const hub = window.locator(SEL.reviewHub.container);

      // Click the commit button
      const commitBtn = hub.locator(SEL.reviewHub.commitButton(1));
      await commitBtn.click();

      // Wait for commit to complete — commit button disappears (totalChanges drops to 0)
      await expect(commitBtn).toBeHidden({ timeout: T_LONG });

      // Clean state message should appear
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });

      // CommitPanel should unmount (textarea gone)
      await expect(hub.locator(SEL.reviewHub.commitMessageInput)).toBeHidden({ timeout: T_SHORT });
    });

    test("diff mode toggle disables base-branch view on a main-only repo", async () => {
      const { window } = ctx;

      const diffModeGroup = window.locator(SEL.reviewHub.diffMode);
      await expect(diffModeGroup).toBeVisible({ timeout: T_SHORT });

      // "Working tree" segment is checked initially.
      const workingTreeBtn = diffModeGroup.getByRole("radio", { name: "Working tree" });
      await expect(workingTreeBtn).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });

      // This fixture is opened on its main worktree, so the current branch IS the
      // base branch — you can't diff a branch against itself. The "vs <branch>"
      // button must be present but disabled, and clicking it must NOT switch modes.
      const baseBranchBtn = diffModeGroup.getByRole("radio", { name: /^vs / });
      await expect(baseBranchBtn).toBeVisible({ timeout: T_SHORT });
      await expect(baseBranchBtn).toBeDisabled({ timeout: T_SHORT });
      await expect(baseBranchBtn).toHaveAttribute("aria-checked", "false", { timeout: T_SHORT });

      // A force-click on the disabled control is inert: working-tree mode stays
      // active and the clean state stays visible.
      await baseBranchBtn.click({ force: true });
      await expect(workingTreeBtn).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });

      const hub = window.locator(SEL.reviewHub.container);
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("close button dismisses the hub", async () => {
      const { window } = ctx;

      const closeBtn = window.locator(SEL.reviewHub.close);
      await closeBtn.click();

      await expect(window.locator(SEL.reviewHub.container)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  test.describe.serial("Staging edge cases", () => {
    test.beforeAll(async () => {
      const fixture = createFixtureRepo({
        name: "review-hub-staging",
        withUncommittedChanges: true,
      });
      fixtureCleanups.push(fixture.cleanup);
      writeFileSync(path.join(fixture.dir, "extra-a.txt"), "Extra file A\n");
      writeFileSync(path.join(fixture.dir, "extra-b.txt"), "Extra file B\n");
      ctx.window = await openFixtureProject(fixture.dir, "Staging Test");

      // PR #7890 auto-stages all unstaged files for the card-launched flow;
      // unstage everything to restore the baseline these steps exercise.
      const hub = await openReviewHubFromCard();
      await expect(hub.locator(SEL.reviewHub.unstageAllButton)).toBeVisible({ timeout: T_MEDIUM });
      await hub.locator(SEL.reviewHub.unstageAllButton).click();
      await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({ timeout: T_MEDIUM });
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

    test("commit button blocked with empty message", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      // Stage all files
      await hub.locator(SEL.reviewHub.stageAllButton).click();
      await expect(hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.click();
      await textarea.press(selectAllShortcut);
      await textarea.press("Backspace");
      await expect.poll(() => textarea.inputValue(), { timeout: T_SHORT }).toBe("");

      // Blocked buttons stay focusable so their tooltip can explain what is missing.
      const commitBtn = hub.locator(SEL.reviewHub.commitButton(3));
      await expect(commitBtn).toBeVisible({ timeout: T_SHORT });
      await expect(commitBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });

      // Whitespace-only message still keeps it blocked.
      await textarea.fill("   ");
      await expect(commitBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });
    });

    test("commit button enabled with valid message", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.fill("test: staging edge cases");

      const commitBtn = hub.locator(SEL.reviewHub.commitButton(3));
      await expect(commitBtn).not.toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });
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

  test.describe.serial("Git confirm dialogs", () => {
    test.beforeAll(async () => {
      const fixture = createDivergedRemoteFixture();
      fixtureCleanups.push(fixture.cleanup);
      ctx.window = await openFixtureProject(fixture.dir, "Dialogs Test");

      // The card-launched flow auto-stages the single uncommitted file, so
      // "Commit & push" with one staged file is the expected primary action.
      const hub = await openReviewHubFromCard();
      await expect(hub.locator(SEL.reviewHub.commitAndPushButton(1))).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("per-file diff modal opens from a changed-file row", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.fileDiffButton("local-change.txt")).first().click();

      // The diff layers ABOVE the review rather than replacing it (#11243), so
      // both are `panel-dialog` — scope to the diff, and assert the review is
      // still mounted underneath. The serial tests after this one depend on it.
      const dialog = window.locator(SEL.reviewHub.diffDialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(hub).toBeVisible();

      await window.locator(SEL.reviewHub.diffDialogClose).first().click();
      await expect(dialog).toBeHidden({ timeout: T_SHORT });
      await expect(hub).toBeVisible();
    });

    test("empty commit message blocks Commit & Push", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.click();
      await textarea.press(selectAllShortcut);
      await textarea.press("Backspace");
      await expect.poll(() => textarea.inputValue(), { timeout: T_SHORT }).toBe("");

      // Blocked buttons stay focusable so their tooltip can explain what's missing.
      const pushBtn = hub.locator(SEL.reviewHub.commitAndPushButton(1));
      await expect(pushBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });

      // Whitespace-only message keeps it blocked.
      await textarea.fill("   ");
      await expect(pushBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });
    });

    test("commit message history navigation cycles previous messages", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.click();
      await textarea.fill("");
      await expect.poll(() => textarea.inputValue(), { timeout: T_SHORT }).toBe("");

      // First ArrowUp triggers an async history fetch (git.listCommits). With an
      // empty draft the caret is at offset 0, so the history key fires.
      await textarea.press("ArrowUp");
      await expect
        .poll(() => textarea.inputValue(), { timeout: T_MEDIUM })
        .toContain("chore: scaffold baseline");

      // Subsequent presses resolve synchronously against the cached history.
      await textarea.press("ArrowUp");
      await expect
        .poll(() => textarea.inputValue(), { timeout: T_SHORT })
        .toContain("initial commit");

      // ArrowDown walks back toward the original (empty) draft.
      await textarea.press("ArrowDown");
      await expect
        .poll(() => textarea.inputValue(), { timeout: T_SHORT })
        .toContain("chore: scaffold baseline");

      await textarea.fill("");
    });

    test("ArrowUp does not load history when the caret is not at the start", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      const draftMessage = "draft: in-progress message";
      await textarea.fill(draftMessage);
      await expect(textarea).toHaveValue(draftMessage, { timeout: T_SHORT });
      await textarea.evaluate(
        (node, offset) =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              const textareaNode = node as HTMLTextAreaElement;
              textareaNode.focus();
              textareaNode.setSelectionRange(offset, offset);
              resolve();
            });
          }),
        4
      );
      await expect
        .poll(() => textarea.evaluate((node) => (node as HTMLTextAreaElement).selectionStart), {
          timeout: T_SHORT,
        })
        .toBe(4);
      await textarea.press("ArrowUp");
      await expect(textarea).toHaveValue(draftMessage, { timeout: T_SHORT });

      await textarea.fill("");
    });

    test("Commit & Push opens push confirm dialog with message preview", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
      await textarea.fill("test: review hub push confirm flow");

      await hub.locator(SEL.reviewHub.commitAndPushButton(1)).click();

      // The dialog renders in a portal — locate on `window`, not the hub.
      const message = window.locator(SEL.reviewHub.pushConfirmMessage);
      await expect(message).toBeVisible({ timeout: T_MEDIUM });
      await expect(message).toContainText("test: review hub push confirm flow");
      await expect(window.locator(SEL.reviewHub.pushConfirmBranch)).toContainText("main");
      await expect(window.locator(SEL.reviewHub.pushConfirmDontAsk)).toBeVisible({
        timeout: T_SHORT,
      });

      // Cancelling leaves the commit unpushed and the primary action intact.
      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(message).toBeHidden({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.commitAndPushButton(1))).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("push rejection surfaces the recovery banner with pull-rebase and force-push CTAs", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.commitAndPushButton(1)).click();
      await expect(window.locator(SEL.reviewHub.pushConfirmMessage)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      // The local commit lands, then the push is rejected as non-fast-forward
      // because origin/main advanced past the local branch.
      const banner = hub.locator(SEL.reviewHub.pushError);
      await expect(banner).toBeVisible({ timeout: T_LONG });
      await expect(banner).toHaveAttribute("data-reason", "push-rejected-outdated", {
        timeout: T_SHORT,
      });

      await expect(hub.locator(SEL.reviewHub.pushErrorCta)).toHaveAttribute(
        "data-cta-kind",
        "pull-rebase",
        { timeout: T_SHORT }
      );
      await expect(hub.locator(SEL.reviewHub.pushErrorSecondaryCta)).toHaveAttribute(
        "data-cta-kind",
        "force-push",
        { timeout: T_SHORT }
      );
    });

    test("pull-and-rebase confirm dialog opens from the recovery banner", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.pushErrorCta).click();

      const dialog = window.getByRole("dialog", { name: "Pull and rebase local commits?" });
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Commits to replay");
      await expect(dialog).toContainText("test: review hub push confirm flow");
      await expect(dialog).toContainText("1 incoming");

      // Cancel — confirming would rewrite local history. The banner stays so the
      // user can still choose force-push.
      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(dialog).toBeHidden({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.pushError)).toBeVisible({ timeout: T_SHORT });
    });

    test("force-push confirm dialog previews the remote commits it would discard", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.pushErrorSecondaryCta).click();

      // The dialog loads the discard preview via git.listRemoteCommits.
      await expect(window.locator(SEL.reviewHub.forcePushCommitsLoading)).toBeHidden({
        timeout: T_LONG,
      });
      const rows = window.locator(SEL.reviewHub.forcePushCommitRow);
      await expect(rows.first()).toBeVisible({ timeout: T_MEDIUM });
      expect(await rows.count()).toBeGreaterThan(0);

      // Cancel — assert the safeguard preview without rewriting the remote.
      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(rows.first()).toBeHidden({ timeout: T_SHORT });
    });
  });
});
