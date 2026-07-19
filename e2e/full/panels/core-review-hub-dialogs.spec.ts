/**
 * Core: Review Hub Git Confirm Dialogs
 *
 * Covers the Review Hub's git confirmation surfaces against a local-only
 * fixture whose `origin` remote has diverged from the local branch:
 *  - the per-file diff modal,
 *  - the empty-commit-message guard on the "Commit & Push" path (#7880),
 *  - commit-message history navigation (ArrowUp/ArrowDown),
 *  - the push confirm preview dialog (D2 shared-state safeguard),
 *  - the push-rejection recovery banner, and its
 *  - "Pull and rebase" and "Force push" confirm dialogs.
 *
 * All git traffic targets a `file://` bare remote — no real network. Tests are
 * serial: each builds on the state left by the previous one, and the push test
 * (which commits + diverges) runs after every test that needs a stageable file.
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createDivergedRemoteFixture } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

test.describe.serial("Core: Review Hub Git Confirm Dialogs", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const fixture = createDivergedRemoteFixture();
    fixtureCleanup = fixture.cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Dialogs Test");

    const reviewBtn = ctx.window.locator(SEL.worktree.reviewHubButton);
    await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
    await reviewBtn.first().click();

    const hub = ctx.window.locator(SEL.reviewHub.container);
    await expect(hub).toBeVisible({ timeout: T_MEDIUM });

    // Expand the file list (collapsed by default since #7890) so the per-file
    // diff trigger is mountable. The card-launched flow auto-stages the single
    // uncommitted file, so "Commit & Push (1)" is the expected primary action.
    const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
    await expect(fileListToggle).toBeVisible({ timeout: T_MEDIUM });
    if ((await fileListToggle.getAttribute("aria-expanded")) !== "true") {
      await fileListToggle.click();
    }
    await expect(hub.locator(SEL.reviewHub.commitAndPushButton(1))).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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

    const dialog = window.getByRole("alertdialog").filter({ hasText: "Pull and rebase" });
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(dialog).toContainText("main");

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
